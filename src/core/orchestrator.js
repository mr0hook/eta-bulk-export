// The run loop. Ties chunker + API + export + folder together. UI-agnostic (emits via hooks).
// Own run loop — no dependency on the base extension's builders, subscription gate, or capture hooks.
import { SOURCES, ALL_STATUSES } from '../api/sources.js';
import { tokenStatus, profileStamp, profileInfo } from './token.js';
import { buildUrl, apiGet, probeCount, fetchAllRows, fetchDetails, fetchPdf, mapLimit, mapAdaptive, makeGovernor, switchTaxpayer } from '../api/client.js';
import { planViaServer, planUuidList } from './planclient.js';   // SPEC-016: the server decides where to cut; chunker.js is now test-only
import { listKey, rinMatch, rinIdsOf } from './listinput.js';   // SPEC-022: pasted-list runs
import { pruneFailureLines } from './failures.js';   // SPEC-035: a retry run prunes what it recovered
import { safeName } from './time.js';
import { buildRows, renderFromRows, XLSX_MIME } from '../export/xlsx.js';
import { createDetailSink } from '../export/chunkparts.js';   // SPEC-027/032
import { refreshMapping } from '../export/mapsync.js';   // SPEC-021: column mapping served by the worker, bundled fallback
import { resolveReferenceNumbers } from './refs.js';
import * as store from './store.js';
import * as folder from './folder.js';
import { createFolderLog } from './folderlog.js';
import { createLogShip } from './logship.js';
import { taxpayerId, taxpayerName, EXT_VERSION, jobCheckpoint, jobLog } from './registration.js';
import * as fs from './fs.js';
import * as keepalive from './keepalive.js';
import { createSessionKeeper } from './session.js';
import { bridgeRequest } from './registration.js';
import { bumpStats } from './stats.js';
import { t } from './i18n.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SPEC-025: these are now the CEILING for the details governor, not a fixed pool size. A live
// run on 2026-08-19 proved 40 fixed workers draw a portal 429 storm (77 rate-hits/81s) that
// stalls all 40 in lockstep; the governor starts low and discovers the portal's real ceiling.
const CONC = { invoices: 40, receipts: 30 };
const DETAIL_START = { invoices: 12, receipts: 10 };
const PDF_CONC = 8;   // official PDFs are larger; fetch fewer at once
// SPEC-029: a chunk is processed in document batches — raw detail JSONs never accumulate past one
// batch (~1GB at 2,000 line-heavy received invoices, measured live 2026-08-19), so chunk size is
// no longer bounded by tab memory and the planner's cap can stay at 10k for every direction.
const BATCH_DOCS = 2000;
// SPEC-030: at/above this many FORBIDDEN rows AND this share of the chunk's processed documents,
// a chunk is treated as an entity-flip casualty and FAILED — never completed thin. Genuine
// per-document 403s (intermediary/marketplace submissions) arrive in ones and fives, far under it.
//
// 2026-08-20: the share was HALF, and a real flip missed it by a hair — chunk 31 lost 3,484 of
// 7,391 documents (47.1%) to a flip that the renewal restore fixed 90 seconds later, and because
// 47% < 50% the chunk was written "thin" with 3,907 rows and marked done. A quarter is still an
// order of magnitude above anything organic, and a chunk shedding a quarter of its documents to
// 403s is never healthy.
const MASS_FORBIDDEN_MIN = 25;
const MASS_FORBIDDEN_SHARE = 0.25;
// SPEC-031: the SESSION host — the origin this content script runs on, and a different host from
// the API the run talks to. Pinned as a constant (never read from location) so the warm can only
// ever hit the portal.
const PORTAL_ORIGIN = 'https://invoicing.eta.gov.eg';
// Token handling: the portal silently renews the access token for as long as a portal tab is open
// (overnight runs on the original tool proved this), and every request reads the CURRENT token from
// localStorage — so a token whose exp is near is normal steady state, NOT a coming failure. We
// therefore never pause on time-left. The only case worth handling is an actual missing/expired
// token (a real 401 / logged-out session): wait for the portal to renew it — a fresh token appears in
// localStorage whenever any portal tab (re)loads, and localStorage is shared across tabs — and
// continue automatically; hard-pause only if none appears.
const TOKEN_FRESH_MIN_MS = 2 * 60 * 1000;      // a renewed token must have at least this left to count
const TOKEN_WAIT_POLL_MS = 15 * 1000;          // how often to re-read the token while waiting
// SPEC-009: this was 60 (~15 min). A session that dies at 01:00 then left the run paused since
// 01:15 and the whole night was lost. 1920 polls = 8 hours, so the run instead sits waiting and
// resumes by itself the moment the user logs back in the next morning. Pause/Halt still break the
// wait on the next poll, and progress is written before we start waiting.
const TOKEN_WAIT_MAX_POLLS = 1920;

export function createOrchestrator(hooks = {}) {
  const { onStatus: rawStatus = () => {}, onProgress = () => {}, onPlan = () => {}, onToken = () => {}, onCount = () => {}, onChunk = () => {}, guard = async () => true, confirmFolder = async () => false, planner = planViaServer } = hooks;
  // SPEC-011: every user-visible line already funnels through onStatus, so mirroring the run log to
  // the folder needs exactly one interception point. It must never be able to break a run, hence the
  // swallow — a logger that aborts the export it documents is worse than no logger.
  // SPEC-018 Part B adds the second consumer at the SAME point: the batched shipper to the portal.
  // Order matters — the folder log is the authoritative record and is written first; the shipper is
  // a convenience copy and is fire-and-forget. Neither can reach rawStatus's arguments to change
  // them, and neither can stop the drawer from being told what happened.
  let fLog = null;
  const ship = createLogShip({ send: (body) => jobLog(body), ...(hooks.logShip || {}) });
  const onStatus = (msg, meta) => { try { fLog?.push(msg, meta); } catch {} try { ship.push(msg, meta); } catch {} rawStatus(msg, meta); };
  // onStatus(msg, meta) — meta { level:'ok'|'err'|'warn'|'wait'|'run'|'info', terminal?, kind? } lets the UI
  // classify without string-sniffing; kind marks high-frequency lines the run log coalesces (rate/page/probe).
  const rate = (w) => onStatus(t('orch.rateWait', { s: Math.round(w / 1000) }), { level: 'wait', kind: 'rate' });
  let dirHandle = null, running = false, currentCtrl = null, folderOk = null;
  let pinnedProfile = null;   // SPEC-030: the entity the CURRENT run belongs to (null outside runs)
  const flags = { paused: false, halted: false };
  // SPEC-031 — the renewal fetch hold. A rescue renewal boots the portal SPA, and that boot is what
  // can flip the active company; every document fetched in those seconds would come back 403 under
  // the wrong entity (the 2026-08-19 chunk-7 incident: 974 of 1,086 dropped). So document fetches
  // park here for the few seconds a renewal takes and resume once the company has been re-pinned.
  let renewHold = null, renewRelease = null;
  const holdRenew = () => { if (!renewHold) renewHold = new Promise((r) => { renewRelease = r; }); };
  const releaseRenew = () => { const r = renewRelease; renewHold = null; renewRelease = null; try { r?.(); } catch {} };
  // SPEC-009 — keeps the portal SESSION host alive for the length of a run (see session.js). The
  // run itself only ever talks to the API host, which is exactly why the session idles out.
  //
  // SPEC-030 afterRenew: the renewal's background tab boots the portal SPA — a cold load that can
  // re-select the login's DEFAULT entity server-side. That is THE flip vector: it fired at the
  // same second as the 2026-08-19 chunk-7 flip ("session running low" + "company changed" in one
  // log line pair). So the check happens immediately after EVERY renewal instead of waiting for
  // the next chunk boundary to discover 403 carnage: if the stamp moved, switch straight back and
  // re-boot once more so localStorage carries the corrected profile. Best-effort by contract.
  const session = createSessionKeeper({
    // SPEC-031: warm from the PAGE. This code runs inside the portal tab, so a request to the
    // portal origin is FIRST-PARTY and carries the session cookie whatever its SameSite setting.
    // The service-worker warm (kept as the fallback) is cross-site, and a Lax/Strict cookie
    // legitimately does not ride along with it — which is the only reason the old design needed a
    // tab boot to slide the session at all.
    warm: async () => {
      try { await fetch(PORTAL_ORIGIN + '/', { method: 'GET', credentials: 'include', cache: 'no-store' }); return; }
      catch { /* CSP/offline — fall through to the worker */ }
      try { await bridgeRequest('portal-warm'); } catch {}
    },
    onSelfRenew: () => onStatus(t('orch.tokenSelfRenew'), { level: 'ok', kind: 'token' }),
    renew: async () => { holdRenew(); onStatus(t('orch.sessionRenew'), { level: 'wait' }); await bridgeRequest('portal-renew'); },
    // Runs after EVERY renewal attempt (session.js guarantees it, even on failure) — so the hold is
    // always released and a flip is always corrected before fetching resumes.
    afterRenew: async () => {
      try {
        if (!running || !pinnedProfile?.taxId) return;
        if (profileStamp() === pinnedProfile.stamp) return;
        onStatus(t('orch.renewFlipped'), { level: 'wait' });
        if (await switchTaxpayer(pinnedProfile.taxId)) {
          await bridgeRequest('portal-renew');   // direct (gap-exempt): re-mint under the restored entity
          onStatus(t('orch.renewPinned'), { level: 'ok' });
        }
      } catch { /* the chunk-boundary restore is the enforcing layer; this one just acts sooner */ }
      finally { releaseRenew(); }
    },
  });

  function statusPlan(sel, SRC) {
    if (!sel || !sel.length || sel.length === ALL_STATUSES.length) return { statusParam: null, filterSet: null, mode: 'all' };
    if (sel.length === 1 && SRC.statusServer) return { statusParam: sel[0], filterSet: null, mode: 'single' };
    return { statusParam: null, filterSet: new Set(sel), mode: 'multi' };
  }
  const stop = (v) => { flags.paused = flags.paused || v === 'pause'; flags.halted = flags.halted || v === 'halt'; currentCtrl?.abort(); };

  async function pickFolder() { dirHandle = await fs.pickFolder(); await fs.ensurePermission(dirHandle); try { await fs.idbSet('dh_last', dirHandle); } catch {} return dirHandle.name; }
  function setFolder(h) { dirHandle = h; folderOk = null; }

  // SPEC-010: an export folder belongs to ONE taxpayer. This must gate every path that writes —
  // and it lives here rather than in pickFolder() because drawer.js restores the last handle from
  // IndexedDB through setFolder(), which never goes near pickFolder(). Cached per handle so a
  // multi-hour run doesn't re-read the stamp on every chunk.
  async function folderAllowed({ allowUnverified = false } = {}) {
    if (!dirHandle) return false;
    if (folderOk === dirHandle) return true;
    const rin = taxpayerId(), company = taxpayerName();
    let v;
    try { v = await folder.verify(dirHandle, rin); }
    catch (e) { onStatus(t('folder.checkFailed', { msg: String(e?.message || e) }), { level: 'err' }); return false; }
    if (v.state === 'fresh') { try { await folder.claim(dirHandle, rin, company); } catch {} v = { state: 'ok' }; }
    else if (v.state === 'needsConfirm') {
      const yes = await confirmFolder({ rin, company });
      if (!yes) { onStatus(t('folder.declined'), { level: 'warn' }); return false; }
      try { await folder.claim(dirHandle, rin, company); } catch {}
      v = { state: 'ok' };
    }
    if (v.state === 'blocked') {
      onStatus(t('folder.blocked', { company: v.company || t('folder.unnamed'), rin: v.owner }), { level: 'err', terminal: true });
      return false;
    }
    if (v.state === 'unverified') {
      // Merge reads files the user already has and writes only derived output, so it must stay
      // usable while logged out — but only on a folder someone has already claimed, and it says so.
      // Deliberately NOT cached: the next call re-checks once the user logs back in.
      if (allowUnverified && v.owner) { onStatus(t('folder.mergeUnverified'), { level: 'warn' }); return true; }
      onStatus(t('folder.unverified'), { level: 'warn' }); return false;
    }
    folderOk = dirHandle;
    return true;
  }
  const folderName = () => dirHandle?.name || null;

  async function plan(sel) {
    const SRC = SOURCES[sel.source] || SOURCES.invoices;
    // SPEC-022b: a standalone RIN export spans the whole e-invoicing era — the mandate's first
    // rollout date to today — because the user gave identities, not dates.
    const from = sel.era ? '2020-11-15' : sel.from || (sel.year === '2020' ? '2020-11-15' : `${sel.year}-01-01`);
    const to = sel.era ? new Date().toISOString().slice(0, 10) : sel.to || `${sel.year}-12-31`;
    const rins = (sel.rinFilter || []).map(String).filter(Boolean);
    const sp = statusPlan(sel.statuses, SRC);
    flags.paused = false; flags.halted = false;
    currentCtrl = new AbortController();
    // SPEC-022b: with exactly ONE RIN the portal's own Query param narrows the search server-side,
    // so probes count only that party's documents and the plan collapses to their real volume.
    // Multiple RINs keep the plain plan (the portal takes one query) and filter client-side.
    const rinQuery = (sel.rinFilter || []).length === 1 ? String(sel.rinFilter[0]) : null;
    const probe = (f, t, subF, subT) => probeCount(SRC, f, t, sel.dir, sel.field, sp.statusParam, subF, subT, { signal: currentCtrl.signal, onRate: rate, query: rinQuery });
    const detectMaxSub = async (issF, issT) => {
      try { const j = await apiGet(buildUrl(SRC, issF, issT, sel.dir, sel.field, 1, 1, sp.statusParam, null, null, true, rinQuery), { signal: currentCtrl.signal, onRate: rate }); return (j[SRC.resultKey] || [])[0]?.source?.submissionDate || null; } catch { return null; }
    };
    onStatus(t('orch.probing', { label: SRC.label }), { level: 'run' });
    // SPEC-016: the extension probes; the SERVER decides where to cut and mints the job. There is no
    // local fallback by design — without an authorised plan there is nothing to export.
    const { jobId, chunks } = await planner({
      source: sel.source || 'invoices', field: sel.field, from, to,
      dir: sel.dir, statuses: sel.statuses || ALL_STATUSES,
      rin: taxpayerId(), version: EXT_VERSION,
    }, {
      probe, detectMaxSub,
      onStatus,
      stopped: () => flags.paused || flags.halted,
    });
    // SPEC-018: shipping only starts once a job EXISTS. The probing lines above were buffered and
    // go out with the first flush — losing the beginning of every run would defeat the point.
    ship.setJob(jobId);
    const totalRows = chunks.reduce((s, c) => s + c.count, 0);
    const biggest = chunks.reduce((m, c) => Math.max(m, c.count), 0);
    const p = {
      // A RIN-filtered run keys (and so files, progress, resume) separately from the unfiltered
      // run over the same range — its chunk files hold a SUBSET and must never masquerade as done
      // chunks of a full export.
      v: 1, jobId, key: store.runKey(sel.source, sel.era ? 'era' : sel.year, sel.dir, sel.field, from, to) + (rins.length ? `_rin${listKey(rins)}` : ''), source: sel.source, createdAt: new Date().toISOString(),
      year: sel.era ? 'era' : sel.year, dir: sel.dir, dateField: sel.field, downloadDetails: sel.downloadDetails !== false, statuses: sel.statuses || ALL_STATUSES,
      rinFilter: rins,
      from, to, cap: SRC.cap, totalRows, biggest, chunks, doneIds: [], failedIds: [], excludeColumns: sel.excludeColumns || [], downloadPdf: !!sel.downloadPdf,
    };
    store.saveState(p);
    if (dirHandle && await folderAllowed()) await store.writeProgress(dirHandle, p, 'planned');
    onPlan(p);
    return p;
  }

  // SPEC-022 — plan a pasted-UUID-list export. No probing: the server is sent the COUNT, gates it
  // exactly like /plan/start, and answers with its batching; each chunk here carries its slice of
  // the actual list, which then lives ONLY in this device's progress file (the server never sees a
  // document identifier). Shaped like plan()'s result so start()/resume()/merge run unchanged.
  async function planUuids(sel) {
    const uuids = sel.uuids || [];
    flags.paused = false; flags.halted = false;
    currentCtrl = new AbortController();
    const { jobId, chunks } = await planUuidList(uuids, { rin: taxpayerId(), version: EXT_VERSION }, {
      onStatus, stopped: () => flags.paused || flags.halted,
    });
    ship.setJob(jobId);
    const p = {
      v: 1, mode: 'uuids', jobId, key: 'uuids_' + listKey(uuids), source: 'invoices', createdAt: new Date().toISOString(),
      year: String(new Date().getFullYear()), dir: 'uuids', dateField: 'Uuid', downloadDetails: true, statuses: ALL_STATUSES,
      from: '', to: '', cap: SOURCES.invoices.cap, totalRows: uuids.length,
      biggest: chunks.reduce((m, c) => Math.max(m, c.count), 0), chunks, doneIds: [], failedIds: [],
      excludeColumns: sel.excludeColumns || [], downloadPdf: !!sel.downloadPdf,
    };
    store.saveState(p);
    if (dirHandle && await folderAllowed()) await store.writeProgress(dirHandle, p, 'planned');
    onPlan(p);
    return p;
  }

  // Local run status → job state. The folder file stays the resume source of truth; the server
  // checkpoint is best-effort and must never fail a run — a backend blip should not stop an export.
  // 'done' here means the FETCH finished, which is not the same as the job being done: the output
  // does not exist until merge has run, so the job sits at 'merging' and stays resumable until then.
  const JOB_STATE = { planned: 'planned', running: 'running', paused: 'paused', auth_expired: 'paused', halted: 'halted', incomplete: 'incomplete', done: 'merging' };
  // `runningId` is the chunk in flight, if any — it is what puts a live square on the admin timeline.
  async function mark(p, status, runningId = null) {
    await store.writeProgress(dirHandle, p, status);
    if (!p || !p.jobId) return;
    try {
      await jobCheckpoint({
        jobId: p.jobId, state: JOB_STATE[status] || 'running',
        done: (p.doneIds || []).length, failed: (p.failedIds || []).length,
        chunkStates: store.chunkStates(p, runningId),
      });
    } catch {}
  }

  async function start(plan) {
    if (running || !plan?.chunks) return;
    if (!window.ExcelJS) { onStatus(t('orch.noExcel'), { level: 'err' }); return; }
    if (!dirHandle) { onStatus(t('orch.pickFolder'), { level: 'warn' }); return; }
    if (!(await fs.ensurePermission(dirHandle))) { onStatus(t('orch.permLost'), { level: 'err' }); return; }
    if (!(await folderAllowed())) return;   // SPEC-010: never write into another taxpayer's folder
    // SPEC-022: a uuid job's list exists ONLY in its folder's progress file (the server holds a
    // count). A plan that arrived without it — e.g. adopted from /job/plan alone — must refuse
    // loudly rather than run zero-row chunks that would look like a clean, empty export.
    if (plan.mode === 'uuids' && plan.chunks.some((c) => !Array.isArray(c.uuids) || c.uuids.length !== c.count)) {
      onStatus(t('orch.uuidListMissing'), { level: 'err', terminal: true });
      return;
    }
    // SPEC-011: start the folder log only once the folder is known AND allowed, so a refused folder
    // never gets written to. rotate() keeps one generation back for last-night/tonight comparisons.
    fLog = createFolderLog(dirHandle, plan.key);
    try { await fLog.rotate(); } catch {}
    // A resumed plan carries the jobId it was minted with; a plan without one (an older progress
    // file) ships nothing at all rather than appending this run's lines to a previous job's log.
    if (plan.jobId) ship.setJob(plan.jobId); else ship.reset();
    running = true; keepalive.start(); session.start();
    const SRC = SOURCES[plan.source] || SOURCES.invoices;
    const sp = statusPlan(plan.statuses, SRC);
    const isUuids = plan.mode === 'uuids';
    // SPEC-022b: counterparty filter, applied to SEARCH rows — before the expensive /details and
    // PDF fetches, so a filtered run costs details only for matches. Correctness never depends on
    // any server-side narrowing (there is none in v1); this predicate is the filter.
    const rinPred = (!isUuids && plan.rinFilter?.length) ? rinMatch(plan.rinFilter) : null;
    // Single RIN → the same server-side Query the plan's probes used, so the pages fetched are the
    // pages counted. The client-side rinPred still runs: Query matches fragments across several
    // fields, so it can over-match — never under-match a full exact RIN (portal-documented).
    const rinQuery = (!isUuids && plan.rinFilter?.length === 1) ? String(plan.rinFilter[0]) : null;
    const opts = { columns: Object.fromEntries((plan.excludeColumns || []).map((k) => [k, false])), combineAll: true, taxColumns: true, discountColumns: true, negativeCredit: true, validOnly: false };   // SPEC-007: credit notes always export negative — no UI switch
    // SPEC-008: run-level uuid→invoice-number cache for credit/debit note references. Shared across
    // chunks on purpose — one original is resolved once however many notes point at it.
    if (plan.source === 'invoices') opts.refNumbers = new Map();
    // SPEC-021: confirm the column mapping with the worker ONCE per run, before the first sheet is
    // built, so every chunk of one export uses the same headers. Best-effort by contract: if the
    // server is unreachable the bundled mapping renders a correct export and we say so rather than
    // failing the run. (The plan, by contrast, HARD-requires the server — see planclient.js.)
    const map = await refreshMapping(plan.source);
    if (map.origin !== 'server') onStatus(t('orch.mapBundled'), { level: 'warn' });
    else if (!map.fetched) onStatus(t('orch.mapCached'), { level: 'warn' });
    const done = new Set(plan.doneIds || []); const failed = new Set(plan.failedIds || []);
    let rowsFetched = plan.chunks.filter((c) => done.has(c.id)).reduce((s, c) => s + Math.min(c.count, plan.cap || 1e12), 0);
    onCount(rowsFetched, plan.totalRows);   // seed from already-completed chunks (resume-aware)
    const rowsAtStart = rowsFetched;        // usage counters count only THIS session's new rows (resumes never double-count)
    flags.paused = false; flags.halted = false; let consec = 0;
    const prof0 = profileInfo();   // the entity this run belongs to — stamp + TaxId, see token.js
    pinnedProfile = prof0;         // SPEC-030: lets afterRenew re-pin the entity the moment a renewal flips it
    let restores = 0;              // SPEC-023: auto-restores this run; past 3 a human is fighting us — pause
    const droppedByChunk = new Map();   // chunkId → count; per-chunk so a chunk retry overwrites, never double-counts
    // SPEC-025: one AIMD governor for the whole run's details phase — a 429 halves the pool
    // (floor 3), 25 clean fetches grow it by 1 back toward the old static maximum. Run-scoped on
    // purpose: what the portal taught us on chunk 1 is still true on chunk 13.
    const detGov = makeGovernor({ start: DETAIL_START[SRC.key] || 10, min: 3, max: CONC[SRC.key] || 30 });
    const recovered = new Set();   // SPEC-035: uuids this run exported — pruned from eta_failures.jsonl at the end
    let pdfDropped = 0;   // official-PDF fetch failures (supplementary, best-effort — never fails the chunk)
    let pdfSaved = 0;     // PDFs actually written this session (usage counter)
    // Poll localStorage for a renewed token (portal renews from its session; another portal tab shares
    // localStorage). Returns the fresh status, or null if the user paused/halted or the wait timed out.
    const waitForFreshToken = async () => {
      for (let n = 0; n < TOKEN_WAIT_MAX_POLLS; n++) {
        if (flags.paused || flags.halted) return null;
        const tk = tokenStatus(); onToken(tk);
        if (tk.ok && (tk.left === 0 || tk.left >= TOKEN_FRESH_MIN_MS)) return tk;   // left=0 = valid token with unknown exp
        // SPEC-009: don't just watch localStorage and hope — ask for a renewal. The keeper's own
        // rate limit means this is at most one background tab per 5 min however long we wait, so
        // an unattended run keeps trying all night instead of dying 15 minutes in.
        await session.renewNow();
        await sleep(TOKEN_WAIT_POLL_MS);
      }
      return null;
    };
    try {
      for (let i = 0; i < plan.chunks.length; i++) {
        if (flags.halted) { onStatus(t('orch.halted'), { level: 'err', terminal: true }); await mark(plan, 'halted'); return; }
        if (flags.paused) { onStatus(t('orch.pausedAt', { i: i + 1, n: plan.chunks.length }), { level: 'wait', terminal: true }); await mark(plan, 'paused'); return; }
        const c = plan.chunks[i];
        if (done.has(c.id)) { onProgress(done.size, failed.size, plan.chunks.length - done.size); continue; }
        // Checkpoint BEFORE the work, not only after it. Until this existed the first checkpoint of a
        // run landed when its first chunk finished, so a resumed export left the portal showing the
        // state the run was interrupted in — "paused" for however long that chunk took — and the
        // stuck detector had a stale updated_at to judge it by. It is also the only place a chunk is
        // reported as 'running', which is what the admin timeline needs to point at where a run is.
        await mark(plan, 'running', c.id);
        const tk = tokenStatus(); onToken(tk);
        // A near-expiry token is NOT a problem (the portal renews it silently; every request reads the
        // current one) — only an actually missing/expired token stops us, and even then we wait for
        // the silent renewal and continue on our own instead of demanding a re-login.
        if (!tk.ok) {
          onStatus(t('orch.tokenLapsed'), { level: 'wait' });   // "lapsed", not "expired" — the drawer styles /expired/ as a terminal error and this state self-heals
          await mark(plan, 'auth_expired');
          const fresh = await waitForFreshToken();
          if (!fresh) {
            if (flags.halted) { onStatus(t('orch.halted'), { level: 'err', terminal: true }); await mark(plan, 'halted'); return; }
            onStatus(t('orch.pausedNoToken', { i: i + 1, n: plan.chunks.length }), { level: 'wait', terminal: true });
            flags.paused = true; await mark(plan, 'auth_expired'); return;
          }
          onToken(fresh); onStatus(t('orch.tokenRenewed'), { level: 'run' });
          await mark(plan, 'running', c.id);
        }
        // verify the logged-in taxpayer still matches the registered one — never export another entity's data
        if (!(await guard())) { onStatus(t('orch.rinMismatch'), { level: 'err', terminal: true }); flags.halted = true; await mark(plan, 'halted'); return; }
        // …and that the ACTIVE IDENTITY is still the one the run started under. The guard above
        // only asks whether the logged-in RIN is one the device is ENTITLED to — an account
        // holding several entities passes it after a switch to any of them, and the portal then
        // answers for the wrong entity: empty searches and per-document 403s, not errors.
        // SPEC-023: our OWN session renewal (SPEC-009, every ~30 min) is the usual cause of the
        // flip on a multi-entity account, so first try to switch BACK with the portal's own
        // endpoint and re-mint the token; only when that fails does the run pause — the user
        // switches the portal back and resumes exactly where the run stopped.
        if (profileStamp() !== prof0.stamp) {
          let restored = false;
          if (++restores <= 3 && prof0.taxId) {
            onStatus(t('orch.profileRestoring'), { level: 'wait' });
            if (await switchTaxpayer(prof0.taxId)) {
              await session.renewNow();   // the mechanism that flips is also what mints the corrected token
              for (let w = 0; w < 30 && !flags.paused && !flags.halted; w++) {
                if (profileStamp() === prof0.stamp) { restored = true; break; }
                await sleep(2000);
              }
            }
          }
          if (restored) { onStatus(t('orch.profileRestored'), { level: 'ok' }); }
          else {
            onStatus(t('orch.profileSwitched'), { level: 'err', terminal: true });
            flags.paused = true; await mark(plan, 'paused'); return;
          }
        }
        currentCtrl = new AbortController();
        let ok = false, lastErr = null, authRetries = 0;
        for (let attempt = 0; attempt < 3 && !ok && !flags.paused && !flags.halted; attempt++) {
          try {
            // SPEC-022 uuid mode: the batch IS the row list — no search. A synthetic row carries
            // only the uuid; every exported column renders from /details (xlsx.js reads invoices
            // from `detail` alone), and rowUuid()/rowSearch() read the synthetic shape natively.
            let rows = isUuids
              ? c.uuids.map((u) => ({ source: { uuid: u } }))
              : await fetchAllRows(SRC, c, plan.dir, plan.dateField, sp.statusParam, sp.filterSet,
                { signal: currentCtrl.signal, onRate: rate, query: rinQuery, onPage: (g, tt) => { onStatus(t('orch.chunkFetch', { i: i + 1, n: plan.chunks.length, g, t: tt }), { level: 'run', kind: 'page' }); onCount(rowsFetched + g, plan.totalRows); onChunk({ i: i + 1, n: plan.chunks.length, phase: 'search', cur: g, max: tt }); } });
            // 2026-08-19 incident guard: a live run marked 192 chunks "done" with ZERO rows and no
            // files — the portal answered 200 with an empty result for every page while probes
            // (and manual requests) returned data. An unfiltered chunk was PLANNED because its
            // window probed >0 documents; fetching none is a contradiction, never a completion.
            // Fail the chunk (resume retries it) and re-probe the window once so the log shows
            // whether the portal currently claims 0 (data visibility) or still claims the count
            // (response-shape / request problem). Filtered runs are exempt: their empties are legit.
            if (!isUuids && !sp.filterSet && !rinPred && !rows.length && (c.count | 0) > 0) {
              let re = '?';
              try { re = String(await probeCount(SRC, c.fromISO, c.toISO, plan.dir, plan.dateField, sp.statusParam, c.subF, c.subT, { signal: currentCtrl.signal, onRate: rate })); } catch {}
              throw new Error(t('orch.emptyChunk', { i: i + 1, count: c.count, re }));
            }
            if (rinPred && rows.length) {
              // If NO row in the chunk carries a recognisable counterparty id, the portal's search
              // shape has drifted from what rinIdsOf() knows. Filtering would drop everything and
              // the run would end looking like "this counterparty has no documents" — the one
              // failure mode this feature must never have. Fail the chunk loudly instead.
              if (!rows.some((r) => rinIdsOf(SRC.rowSearch(r)).length)) throw new Error(t('orch.rinIdsMissing'));
              const seen = rows.length;
              rows = rows.filter((r) => rinPred(SRC.rowSearch(r)));
              onStatus(t('orch.rinMatched', { kept: rows.length, seen, i: i + 1, n: plan.chunks.length }), { level: 'run' });
            }
            if (!rows.length) { ok = true; break; }
            if (c.warn) {   // this span holds ≥ cap documents and can't be split finer → surplus beyond cap is unreachable
              onStatus(t('orch.overCap', { i: i + 1, cap: SRC.cap, got: rows.length }), { level: 'warn' });
              try { await fs.appendText(dirHandle, 'eta_failures.jsonl', JSON.stringify({ at: new Date().toISOString(), chunk: c.id, kind: 'over_cap', warn: c.warn, fetched: rows.length, cap: SRC.cap }) + '\n'); } catch {}
            }
            onStatus(t('orch.chunkDetails', { i: i + 1, n: plan.chunks.length, count: rows.length }), { level: 'run' });
            let dDone = 0; const dTotal = rows.length;
            // SPEC-025: adaptive pool. A real 429 (onRate's second arg) shrinks it before the
            // herd retries; each clean fetch votes to grow it back.
            const getDetails = (list) => mapAdaptive(list, detGov, async (row) => {
              try {
                if (renewHold) await renewHold;   // SPEC-031: never fetch while the entity may be flipped
                const d = await fetchDetails(SRC, SRC.rowUuid(row), { signal: currentCtrl.signal, onRate: (w, isRate) => { if (isRate) detGov.slow(); rate(w); } });
                detGov.ok();
                return { ok: { search: SRC.rowSearch(row), detail: d } };
              }
              catch (e) { if (e.code === 'AUTH' || e.code === 'STOPPED') throw e; return { fail: { row, uuid: SRC.rowUuid(row), err: String(e?.message || e) } }; }
              finally { dDone++; onChunk({ i: i + 1, n: plan.chunks.length, phase: 'details', cur: Math.min(dDone, dTotal), max: dTotal }); }
            });
            // Order is load-bearing (SPEC-027): stale parts swept, parts written, summary LAST —
            // the summary file is what scanDoneFromFolder treats as "chunk done", so a crash
            // mid-chunk never looks complete.
            const chunkName = store.chunkFile(plan, c);
            const partEsc = chunkName.replace(/\.xlsx$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            try { for (const stale of await fs.listFiles(dirHandle, new RegExp('^' + partEsc + '_det_p\\d+\\.xlsx$', 'i'))) { try { await fs.remove(dirHandle, stale); } catch {} } } catch {}

            // One batch of documents: details (with one bounded retry pass for stragglers that
            // outlasted apiGet's own retries), then this batch's PDFs and reference numbers.
            const doBatch = async (batchRows) => {
              let outcomes = await getDetails(batchRows);
              let records = outcomes.filter((o) => o.ok).map((o) => o.ok);
              let failedRows = outcomes.filter((o) => o.fail).map((o) => o.fail);
              if (failedRows.length) {
                onStatus(t('orch.detailsRetry', { count: failedRows.length, i: i + 1 }), { level: 'warn' });
                outcomes = await getDetails(failedRows.map((f) => f.row));
                records = records.concat(outcomes.filter((o) => o.ok).map((o) => o.ok));
                failedRows = outcomes.filter((o) => o.fail).map((o) => o.fail);
              }
              if (plan.downloadPdf) {   // official signed PDFs FIRST — before the xlsx exists, so an interrupted PDF
                // phase (Pause/token-expiry) leaves no chunk file and resume re-runs the whole chunk incl. its PDFs.
                onStatus(t('orch.chunkPdfs', { i: i + 1, n: plan.chunks.length, count: batchRows.length }), { level: 'run' });
                const pdfDir = await fs.subdir(dirHandle, 'pdfs');
                let pDone = 0;
                const pdfFails = (await mapLimit(batchRows, PDF_CONC, async (row) => {
                  const uuid = SRC.rowUuid(row);
                  try { const blob = await fetchPdf(SRC, uuid, { signal: currentCtrl.signal, onRate: rate }); await fs.writeBlob(pdfDir, safeName(row.internalID || row.receiptNumber || uuid) + '.pdf', blob); return null; }
                  catch (e) { if (e.code === 'AUTH' || e.code === 'STOPPED') throw e; return { uuid, err: String(e?.message || e) }; }
                  finally { pDone++; onChunk({ i: i + 1, n: plan.chunks.length, phase: 'pdf', cur: pDone, max: batchRows.length }); }
                })).filter(Boolean);
                pdfSaved += batchRows.length - pdfFails.length;
                if (pdfFails.length) {
                  pdfDropped += pdfFails.length;
                  const lines = pdfFails.map((f) => JSON.stringify({ at: new Date().toISOString(), chunk: c.id, kind: 'pdf', uuid: f.uuid, err: f.err })).join('\n') + '\n';
                  try { await fs.appendText(dirHandle, 'eta_failures.jsonl', lines); } catch {}
                  onStatus(t('orch.pdfsUnavailable', { count: pdfFails.length, i: i + 1 }), { level: 'warn' });
                }
              }
              // SPEC-008: resolve each note's reference UUIDs to the original's invoice number. Free
              // for originals already in this export; only the genuinely-missing ones cost a lookup.
              // AUTH/STOPPED propagate into the catch below, which owns renewal and pause.
              if (opts.refNumbers) await resolveReferenceNumbers(records, { SRC }, opts.refNumbers, {
                signal: currentCtrl.signal, onRate: rate,
                onLookup: (n2) => onStatus(t('orch.refLookup', { i: i + 1, n: plan.chunks.length, n2 }), { level: 'run' }),
              });
              // SPEC-035: remember what this run actually got, so a retry can prune the failures log.
              for (const r of records) { const u = r?.detail?.uuid || SRC.rowUuid(r?.search) || ''; if (u) recovered.add(u); }
              return { records, failedRows };
            };
            // SPEC-030: a flood of per-document 403s is an entity flip's signature, not a property
            // of the documents — fail the chunk so the boundary restore heals and the whole chunk
            // refetches, instead of completing thin (2026-08-19 chunk-7: 974/1086 dropped).
            const massForbidden = (failed, processed) => {
              const forb = failed.filter((f) => f.err === 'FORBIDDEN').length;
              if (forb >= MASS_FORBIDDEN_MIN && forb >= processed * MASS_FORBIDDEN_SHARE) throw new Error(t('orch.massForbidden', { n: forb, total: processed }));
            };

            // SPEC-029 + SPEC-032: documents are processed in batches so raw detail JSONs never
            // accumulate past one batch (~1GB at 2,000 line-heavy docs — what makes the 10k cap
            // safe), while the detail SINK decides file layout by the finished row count, not by
            // batch boundaries: an ordinary chunk lands in ONE workbook exactly as before, and
            // only a chunk that outgrows the inline budget spills into part files.
            const sink = createDetailSink(dirHandle, (pi) => store.chunkDetailFile(plan, c, pi));
            const unionCols = (into, cols) => { if (!into) return cols.slice(); const have = new Set(into.map((x) => x.key)); for (const col of cols) if (!have.has(col.key)) { into.push(col); have.add(col.key); } return into; };
            let allFailed = [], written = 0, sumRows = [], sumCols = null, cfg0 = null, processed = 0;
            for (let b0 = 0; b0 < rows.length; b0 += BATCH_DOCS) {
              const { records, failedRows } = await doBatch(rows.slice(b0, b0 + BATCH_DOCS));
              allFailed.push(...failedRows);
              processed += records.length + failedRows.length;
              massForbidden(allFailed, processed);
              const built = buildRows(records, plan.source, { ...opts, serialBase: written });
              written += records.length;
              cfg0 = built.cfg;
              sumRows.push(...built.summaryRows);
              sumCols = unionCols(sumCols, built.summaryCols);
              await sink.add(built);
            }
            // Never silently drop: a total failure fails the whole chunk (so resume retries it, no
            // empty file). Uuid-mode exception: NOT_FOUND is a conclusive answer about a pasted id
            // (mistyped, deleted, or another taxpayer's) — a batch of all-missing uuids is a valid
            // outcome that lands on the Missed sheet, while any OTHER kind of total failure (API
            // down, auth flapping) still fails the chunk so resume retries it.
            if (allFailed.length && !written && (!isUuids || allFailed.some((f) => f.err !== 'NOT_FOUND'))) throw new Error(t('orch.allDetailsFailed', { count: rows.length, i: i + 1 }));
            const det = await sink.finish();
            if (det.mode === 'parts') onStatus(t('orch.chunkParts', { i: i + 1, parts: det.parts.length, count: rows.length }), { level: 'run' });
            onStatus(t('orch.chunkXlsx', { i: i + 1, n: plan.chunks.length, count: written }), { level: 'run' });
            const r = renderFromRows(window.ExcelJS, {
              summaryCols: sumCols || [], lineCols: det.cols, summaryRows: sumRows,
              lineRows: det.mode === 'inline' ? det.rows : [],
              cfg: cfg0 || buildRows([], plan.source, opts).cfg,
            }, { includeLines: det.mode === 'inline' });
            // SPEC-022: a pasted uuid that could not be fetched must be VISIBLE in the deliverable,
            // not only in eta_failures.jsonl — a third sheet, which merge (worksheets[0]/[1]) and
            // scanDoneFromFolder both ignore by construction.
            if (isUuids && allFailed.length) {
              const ws = r.workbook.addWorksheet('Missed');
              ws.addRow(['UUID', 'Error']);
              allFailed.forEach((f) => ws.addRow([f.uuid, f.err]));
              ws.getColumn(1).width = 30; ws.getColumn(2).width = 44;
            }
            const buf = await r.workbook.xlsx.writeBuffer();
            await fs.writeBlob(dirHandle, chunkName, new Blob([buf], { type: XLSX_MIME }));
            onChunk({ i: i + 1, n: plan.chunks.length, phase: 'write', cur: 1, max: 1 });
            if (allFailed.length) {
              // The xlsx file now exists, so resume() (via scanDoneFromFolder) would count this chunk as
              // done. Record the dropped documents DURABLY first; if the log can't be written (e.g. the
              // user has eta_failures.jsonl open and it's locked), delete the chunk file and fail the
              // chunk so resume retries the whole thing — nothing vanishes silently.
              const lines = allFailed.map((f) => JSON.stringify({ at: new Date().toISOString(), chunk: c.id, source: plan.source, uuid: f.uuid, err: f.err })).join('\n') + '\n';
              try { await fs.appendText(dirHandle, 'eta_failures.jsonl', lines); }
              catch (logErr) { try { await fs.remove(dirHandle, chunkName); } catch {} throw new Error(t('orch.dropLogFailed', { count: allFailed.length, msg: String(logErr?.message || logErr) })); }
              droppedByChunk.set(c.id, allFailed.length);
              onStatus(t('orch.docsDropped', { count: allFailed.length, i: i + 1, written, total: rows.length }), { level: 'warn' });
            }
            rowsFetched += rows.length; onCount(rowsFetched, plan.totalRows);
            ok = true; consec = 0;
          } catch (e) {
            lastErr = e; const msg = String(e?.message || e);
            if (e.code === 'AUTH') {
              // token died mid-chunk — same wait-for-renewal as the boundary guard, then retry the
              // chunk (attempt-- so the renewal itself doesn't burn one of the 3 attempts)
              onStatus(t('orch.tokenLapsedMid'), { level: 'wait' });
              await mark(plan, 'auth_expired');
              const fresh = ++authRetries > 2 ? null : await waitForFreshToken();   // a "fresh" token the API still rejects → real auth problem, stop retrying
              if (!fresh) {
                if (flags.halted) { onStatus(t('orch.halted'), { level: 'err', terminal: true }); await mark(plan, 'halted'); return; }
                onStatus(t('orch.pausedNoToken2'), { level: 'wait', terminal: true });
                flags.paused = true; await mark(plan, 'auth_expired'); return;
              }
              onToken(fresh); onStatus(t('orch.tokenRenewedRetry'), { level: 'run' });
              await mark(plan, 'running', c.id);
              attempt--; continue;
            }
            // Pause/Halt aborts the in-flight request → STOPPED. Emit an authoritative status here (the immediate
            // return bypasses the next-chunk-boundary check) so the footer/tracker don't stay frozen on the last
            // "▶ fetching…" line during a multi-hour run.
            if (e.code === 'STOPPED') {
              if (flags.halted) { onStatus(t('orch.halted'), { level: 'err', terminal: true }); await mark(plan, 'halted'); return; }
              if (flags.paused) { onStatus(t('orch.pausedAt', { i: i + 1, n: plan.chunks.length }), { level: 'wait', terminal: true }); await mark(plan, 'paused'); return; }
              // STOPPED with NEITHER flag set: nobody asked to stop. The 2026-08-19 phantom-pause
              // incident — a request deadline firing mid-body surfaces as AbortError and used to
              // masquerade as Pause, silently parking multi-hour runs. The client now keys STOPPED
              // on the caller's signal, and this guard keeps ANY future spurious abort inside the
              // ordinary retry path instead of a pause no one requested.
            }
            const wait = 60000 * (attempt + 1); onStatus(t('orch.chunkBackoff', { i: i + 1, a: attempt + 1, msg, m: Math.round(wait / 60000) }), { level: 'wait', kind: 'backoff' });
            // Abort-aware backoff: poll the pause/halt flags so a Pause/Halt during a 1–2 min failure backoff is
            // honored promptly instead of after the full wait (the plain sleep ignored the abort signal).
            for (let w = 0; w < wait && !flags.paused && !flags.halted; w += 500) await sleep(Math.min(500, wait - w));
          }
        }
        if (ok) { done.add(c.id); failed.delete(c.id); }
        else if (!flags.paused && !flags.halted) { failed.add(c.id); consec++; }   // a Pause/Halt mid-attempt must not mark the chunk failed
        plan.doneIds = [...done]; plan.failedIds = [...failed];
        store.saveState(plan); await mark(plan, 'running');
        onProgress(done.size, failed.size, plan.chunks.length - done.size);
        if (consec >= 3) { onStatus(t('orch.haltedRepeated'), { level: 'err', terminal: true }); flags.halted = true; await mark(plan, 'halted'); return; }
        await sleep(1000 + Math.floor(Math.random() * 500));
      }
      onChunk({ i: plan.chunks.length, n: plan.chunks.length, phase: 'idle', cur: 0, max: 0 });
      const complete = done.size === plan.chunks.length;
      try { bumpStats({ runs: 1, docs: rowsFetched - rowsAtStart, pdfs: pdfSaved }); } catch {}   // only the run-finished path — paused/halted returns don't bump
      const droppedTotal = [...droppedByChunk.values()].reduce((a, b) => a + b, 0);
      const dropMsg = droppedTotal ? t(isUuids ? 'orch.uuidMissedTail' : 'orch.dropTail', { n: droppedTotal }) : '';
      const pdfMsg = pdfDropped ? t('orch.pdfTail', { n: pdfDropped }) : '';
      // SPEC-035: a retry run recovered some of the documents listed in eta_failures.jsonl — take
      // exactly those lines out, so the file keeps meaning "still missing" instead of "ever
      // failed", and the next Load-failed-UUIDs does not hand back documents already exported.
      // Documents dropped by THIS run were appended during it and are correctly absent from
      // `recovered`, so they survive the prune. Best-effort: never fail a finished run over it.
      if (recovered.size) {
        try {
          const before = await fs.readText(dirHandle, 'eta_failures.jsonl');
          const pruned = pruneFailureLines(before, recovered);
          if (pruned.text !== null) {
            await fs.writeText(dirHandle, 'eta_failures.jsonl', pruned.text);
            onStatus(t('orch.failuresPruned', { n: pruned.removed, left: pruned.kept }), { level: 'ok' });
          }
        } catch {}
      }
      onStatus(t('orch.doneSummary', { word: t(complete ? 'orch.doneOk' : 'orch.doneIncomplete'), done: done.size, n: plan.chunks.length, failed: failed.size, drops: dropMsg, pdfs: pdfMsg }), { level: complete && !failed.size ? 'ok' : 'warn', terminal: true, kind: 'done' });   // kind:'done' + level:'ok' = clean finish (drawer zeroes the timer & closes the persisted log)
      // mark(), not writeProgress(): every other terminal path checkpoints and this one did not, so
      // a run that fetched cleanly stayed 'running' on the portal until the user got around to
      // merging — long enough to trip the stuck detector on a job that had in fact finished.
      // JOB_STATE maps this to 'merging', which is the honest state: the output does not exist yet.
      await mark(plan, complete ? 'done' : 'incomplete');
    } finally {
      running = false; pinnedProfile = null; keepalive.stop(); session.stop();
      // Every terminal path returns from inside the loop, so the last lines — including the halt or
      // pause reason a user reads the next morning — only reach disk because of this flush.
      try { await fLog?.flush(); } catch {}
      fLog = null;
      // Deliberately NOT awaited. Every terminal line already flushed on its way through onStatus;
      // this is a belt-and-braces kick for the non-terminal tail, and making the end of a run wait
      // on a backend round-trip is exactly the "never slow a run" the contract forbids.
      try { ship.flush(); } catch {}
    }
  }

  async function resume() {
    if (running) { onStatus(t('orch.runInProgress'), { level: 'warn' }); return null; }
    if (!dirHandle && window.showDirectoryPicker) { try { await pickFolder(); } catch {} }
    if (!dirHandle) { onStatus(t('orch.pickResume'), { level: 'warn' }); return null; }
    // A folder handle restored from IndexedDB after a reload comes back in 'prompt' state — re-request within
    // the click gesture BEFORE reading it, else dir.entries() throws NotAllowedError and wedges the UI.
    if (!(await fs.ensurePermission(dirHandle))) { onStatus(t('orch.permResume'), { level: 'warn' }); return null; }
    // Before readProgress/scanDoneFromFolder — those are the exact calls that would adopt another
    // taxpayer's plan and mark their chunk files as ours (SPEC-010).
    if (!(await folderAllowed())) return null;
    const prog = await store.readProgress(dirHandle);
    if (!prog?.chunks) { onStatus(t('orch.noProgress'), { level: 'warn' }); return null; }
    const SRC = SOURCES[prog.source] || SOURCES.invoices;
    const p = {
      // jobId comes back off the progress file. A resume driven by the drawer overwrites it with the
      // server's own answer (/job/plan), but this path is also reachable on its own — and without it
      // mark() sees no jobId and the resumed run never checkpoints again.
      v: 1, key: prog.key, jobId: prog.jobId || '', source: prog.source, year: prog.year, dir: prog.dir, dateField: prog.field, downloadDetails: true,
      // SPEC-022: uuid batches ride inside prog.chunks; mode/rinFilter restore the run's identity.
      mode: prog.mode || 'range', rinFilter: prog.rinFilter || [],
      statuses: prog.statuses, from: prog.from, to: prog.to, cap: SRC.cap, totalRows: prog.totalRows,
      chunks: prog.chunks, doneIds: prog.doneIds || [], failedIds: prog.failedIds || [],
      excludeColumns: prog.excludeColumns || [], downloadPdf: !!prog.downloadPdf,
    };
    try {
      const fileDone = await store.scanDoneFromFolder(dirHandle, p);
      // For an UNFILTERED range run the chunk file is the ground truth: every done chunk had
      // count>0 and no client-side filter, so completion always produced a file. Progress-file
      // doneIds that have no file behind them are the residue of the 2026-08-19 empty-page
      // incident (chunks marked done with zero rows) — drop them so resume re-fetches the data.
      // Filtered runs and uuid runs keep the union: their legitimately-empty chunks have no file.
      const filtered = (Array.isArray(p.statuses) && p.statuses.length > 0 && p.statuses.length < ALL_STATUSES.length) || (p.rinFilter && p.rinFilter.length);
      p.doneIds = (p.mode !== 'uuids' && !filtered) ? fileDone : [...new Set([...p.doneIds, ...fileDone])];
    } catch {}
    store.saveState(p); onPlan(p);
    onStatus(t('orch.resumed', { done: p.doneIds.length, n: p.chunks.length }), { level: 'info' });
    return p;
  }

  return {
    pickFolder, setFolder, folderName, plan, planUuids, start, resume,
    pause: () => stop('pause'), halt: () => stop('halt'), tokenStatus, SOURCES,
    dir: () => dirHandle,
    ensureDir: async (opts) => { if (!dirHandle) await pickFolder(); return (await folderAllowed(opts)) ? dirHandle : null; },
  };
}
