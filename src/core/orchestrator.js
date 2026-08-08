// The run loop. Ties chunker + API + export + folder together. UI-agnostic (emits via hooks).
// Own run loop — no dependency on the base extension's builders, subscription gate, or capture hooks.
import { SOURCES, ALL_STATUSES } from '../api/sources.js';
import { tokenStatus } from './token.js';
import { buildUrl, apiGet, probeCount, fetchAllRows, fetchDetails, fetchPdf, mapLimit } from '../api/client.js';
import { buildChunks } from './chunker.js';
import { safeName } from './time.js';
import { renderWorkbook, XLSX_MIME } from '../export/xlsx.js';
import { resolveReferenceNumbers } from './refs.js';
import * as store from './store.js';
import * as fs from './fs.js';
import * as keepalive from './keepalive.js';
import { createSessionKeeper } from './session.js';
import { bridgeRequest } from './registration.js';
import { bumpStats } from './stats.js';
import { t } from './i18n.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONC = { invoices: 40, receipts: 30 };
const PDF_CONC = 8;   // official PDFs are larger; fetch fewer at once
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
  const { onStatus = () => {}, onProgress = () => {}, onPlan = () => {}, onToken = () => {}, onCount = () => {}, onChunk = () => {}, guard = async () => true } = hooks;
  // onStatus(msg, meta) — meta { level:'ok'|'err'|'warn'|'wait'|'run'|'info', terminal?, kind? } lets the UI
  // classify without string-sniffing; kind marks high-frequency lines the run log coalesces (rate/page/probe).
  const rate = (w) => onStatus(t('orch.rateWait', { s: Math.round(w / 1000) }), { level: 'wait', kind: 'rate' });
  let dirHandle = null, running = false, currentCtrl = null;
  const flags = { paused: false, halted: false };
  // SPEC-009 — keeps the portal SESSION host alive for the length of a run (see session.js). The
  // run itself only ever talks to the API host, which is exactly why the session idles out.
  const session = createSessionKeeper({
    warm: () => bridgeRequest('portal-warm'),
    renew: async () => { onStatus(t('orch.sessionRenew'), { level: 'wait' }); await bridgeRequest('portal-renew'); },
  });

  function statusPlan(sel, SRC) {
    if (!sel || !sel.length || sel.length === ALL_STATUSES.length) return { statusParam: null, filterSet: null, mode: 'all' };
    if (sel.length === 1 && SRC.statusServer) return { statusParam: sel[0], filterSet: null, mode: 'single' };
    return { statusParam: null, filterSet: new Set(sel), mode: 'multi' };
  }
  const stop = (v) => { flags.paused = flags.paused || v === 'pause'; flags.halted = flags.halted || v === 'halt'; currentCtrl?.abort(); };

  async function pickFolder() { dirHandle = await fs.pickFolder(); await fs.ensurePermission(dirHandle); try { await fs.idbSet('dh_last', dirHandle); } catch {} return dirHandle.name; }
  function setFolder(h) { dirHandle = h; }
  const folderName = () => dirHandle?.name || null;

  async function plan(sel) {
    const SRC = SOURCES[sel.source] || SOURCES.invoices;
    const from = sel.from || (sel.year === '2020' ? '2020-11-15' : `${sel.year}-01-01`);
    const to = sel.to || `${sel.year}-12-31`;
    const sp = statusPlan(sel.statuses, SRC);
    flags.paused = false; flags.halted = false;
    currentCtrl = new AbortController();
    const probe = (f, t, subF, subT) => probeCount(SRC, f, t, sel.dir, sel.field, sp.statusParam, subF, subT, { signal: currentCtrl.signal, onRate: rate });
    const detectMaxSub = async (issF, issT) => {
      try { const j = await apiGet(buildUrl(SRC, issF, issT, sel.dir, sel.field, 1, 1, sp.statusParam, null, null, true), { signal: currentCtrl.signal, onRate: rate }); return (j[SRC.resultKey] || [])[0]?.source?.submissionDate || null; } catch { return null; }
    };
    onStatus(t('orch.probing', { label: SRC.label }), { level: 'run' });
    const chunks = await buildChunks(SRC, from, to, sel.field, { probe, detectMaxSub, onProgress: (n, m) => onStatus(t('orch.probe', { n, m }), { level: 'run', kind: 'probe' }), stopped: () => flags.paused || flags.halted });
    const totalRows = chunks.reduce((s, c) => s + c.count, 0);
    const biggest = chunks.reduce((m, c) => Math.max(m, c.count), 0);
    const p = {
      v: 1, key: store.runKey(sel.source, sel.year, sel.dir, sel.field, from, to), source: sel.source, createdAt: new Date().toISOString(),
      year: sel.year, dir: sel.dir, dateField: sel.field, downloadDetails: sel.downloadDetails !== false, statuses: sel.statuses || ALL_STATUSES,
      from, to, cap: SRC.cap, totalRows, biggest, chunks, doneIds: [], failedIds: [], excludeColumns: sel.excludeColumns || [], downloadPdf: !!sel.downloadPdf,
    };
    store.saveState(p);
    if (dirHandle) await store.writeProgress(dirHandle, p, 'planned');
    onPlan(p);
    return p;
  }

  async function start(plan) {
    if (running || !plan?.chunks) return;
    if (!window.ExcelJS) { onStatus(t('orch.noExcel'), { level: 'err' }); return; }
    if (!dirHandle) { onStatus(t('orch.pickFolder'), { level: 'warn' }); return; }
    if (!(await fs.ensurePermission(dirHandle))) { onStatus(t('orch.permLost'), { level: 'err' }); return; }
    running = true; keepalive.start(); session.start();
    const SRC = SOURCES[plan.source] || SOURCES.invoices;
    const sp = statusPlan(plan.statuses, SRC);
    const opts = { columns: Object.fromEntries((plan.excludeColumns || []).map((k) => [k, false])), combineAll: true, taxColumns: true, discountColumns: true, negativeCredit: true, validOnly: false };   // SPEC-007: credit notes always export negative — no UI switch
    // SPEC-008: run-level uuid→invoice-number cache for credit/debit note references. Shared across
    // chunks on purpose — one original is resolved once however many notes point at it.
    if (plan.source === 'invoices') opts.refNumbers = new Map();
    const done = new Set(plan.doneIds || []); const failed = new Set(plan.failedIds || []);
    let rowsFetched = plan.chunks.filter((c) => done.has(c.id)).reduce((s, c) => s + Math.min(c.count, plan.cap || 1e12), 0);
    onCount(rowsFetched, plan.totalRows);   // seed from already-completed chunks (resume-aware)
    const rowsAtStart = rowsFetched;        // usage counters count only THIS session's new rows (resumes never double-count)
    flags.paused = false; flags.halted = false; let consec = 0;
    const droppedByChunk = new Map();   // chunkId → count; per-chunk so a chunk retry overwrites, never double-counts
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
        if (flags.halted) { onStatus(t('orch.halted'), { level: 'err', terminal: true }); await store.writeProgress(dirHandle, plan, 'halted'); return; }
        if (flags.paused) { onStatus(t('orch.pausedAt', { i: i + 1, n: plan.chunks.length }), { level: 'wait', terminal: true }); await store.writeProgress(dirHandle, plan, 'paused'); return; }
        const c = plan.chunks[i];
        if (done.has(c.id)) { onProgress(done.size, failed.size, plan.chunks.length - done.size); continue; }
        const tk = tokenStatus(); onToken(tk);
        // A near-expiry token is NOT a problem (the portal renews it silently; every request reads the
        // current one) — only an actually missing/expired token stops us, and even then we wait for
        // the silent renewal and continue on our own instead of demanding a re-login.
        if (!tk.ok) {
          onStatus(t('orch.tokenLapsed'), { level: 'wait' });   // "lapsed", not "expired" — the drawer styles /expired/ as a terminal error and this state self-heals
          await store.writeProgress(dirHandle, plan, 'auth_expired');
          const fresh = await waitForFreshToken();
          if (!fresh) {
            if (flags.halted) { onStatus(t('orch.halted'), { level: 'err', terminal: true }); await store.writeProgress(dirHandle, plan, 'halted'); return; }
            onStatus(t('orch.pausedNoToken', { i: i + 1, n: plan.chunks.length }), { level: 'wait', terminal: true });
            flags.paused = true; await store.writeProgress(dirHandle, plan, 'auth_expired'); return;
          }
          onToken(fresh); onStatus(t('orch.tokenRenewed'), { level: 'run' });
          await store.writeProgress(dirHandle, plan, 'running');
        }
        // verify the logged-in taxpayer still matches the registered one — never export another entity's data
        if (!(await guard())) { onStatus(t('orch.rinMismatch'), { level: 'err', terminal: true }); flags.halted = true; await store.writeProgress(dirHandle, plan, 'halted'); return; }
        currentCtrl = new AbortController();
        let ok = false, lastErr = null, authRetries = 0;
        for (let attempt = 0; attempt < 3 && !ok && !flags.paused && !flags.halted; attempt++) {
          try {
            const rows = await fetchAllRows(SRC, c, plan.dir, plan.dateField, sp.statusParam, sp.filterSet,
              { signal: currentCtrl.signal, onRate: rate, onPage: (g, tt) => { onStatus(t('orch.chunkFetch', { i: i + 1, n: plan.chunks.length, g, t: tt }), { level: 'run', kind: 'page' }); onCount(rowsFetched + g, plan.totalRows); onChunk({ i: i + 1, n: plan.chunks.length, phase: 'search', cur: g, max: tt }); } });
            if (!rows.length) { ok = true; break; }
            if (c.warn) {   // this span holds ≥ cap documents and can't be split finer → surplus beyond cap is unreachable
              onStatus(t('orch.overCap', { i: i + 1, cap: SRC.cap, got: rows.length }), { level: 'warn' });
              try { await fs.appendText(dirHandle, 'eta_failures.jsonl', JSON.stringify({ at: new Date().toISOString(), chunk: c.id, kind: 'over_cap', warn: c.warn, fetched: rows.length, cap: SRC.cap }) + '\n'); } catch {}
            }
            onStatus(t('orch.chunkDetails', { i: i + 1, n: plan.chunks.length, count: rows.length }), { level: 'run' });
            let dDone = 0; const dTotal = rows.length;
            const getDetails = (list) => mapLimit(list, CONC[SRC.key] || 30, async (row) => {
              try { const d = await fetchDetails(SRC, SRC.rowUuid(row), { signal: currentCtrl.signal, onRate: rate }); return { ok: { search: SRC.rowSearch(row), detail: d } }; }
              catch (e) { if (e.code === 'AUTH' || e.code === 'STOPPED') throw e; return { fail: { row, uuid: SRC.rowUuid(row), err: String(e?.message || e) } }; }
              finally { dDone++; onChunk({ i: i + 1, n: plan.chunks.length, phase: 'details', cur: Math.min(dDone, dTotal), max: dTotal }); }
            });
            let outcomes = await getDetails(rows);
            let records = outcomes.filter((o) => o.ok).map((o) => o.ok);
            let failedRows = outcomes.filter((o) => o.fail).map((o) => o.fail);
            if (failedRows.length) {   // one bounded retry pass for stragglers that outlasted apiGet's own 7 retries
              onStatus(t('orch.detailsRetry', { count: failedRows.length, i: i + 1 }), { level: 'warn' });
              outcomes = await getDetails(failedRows.map((f) => f.row));
              records = records.concat(outcomes.filter((o) => o.ok).map((o) => o.ok));
              failedRows = outcomes.filter((o) => o.fail).map((o) => o.fail);
            }
            // Never silently drop: a total failure fails the whole chunk (so resume retries it, no empty file).
            if (failedRows.length && !records.length) throw new Error(t('orch.allDetailsFailed', { count: rows.length, i: i + 1 }));
            if (plan.downloadPdf) {   // official signed PDFs FIRST — before the xlsx exists, so an interrupted PDF
              // phase (Pause/token-expiry) leaves no chunk file and resume re-runs the whole chunk incl. its PDFs.
              onStatus(t('orch.chunkPdfs', { i: i + 1, n: plan.chunks.length, count: rows.length }), { level: 'run' });
              const pdfDir = await fs.subdir(dirHandle, 'pdfs');
              let pDone = 0;
              const pdfFails = (await mapLimit(rows, PDF_CONC, async (row) => {
                const uuid = SRC.rowUuid(row);
                try { const blob = await fetchPdf(SRC, uuid, { signal: currentCtrl.signal, onRate: rate }); await fs.writeBlob(pdfDir, safeName(row.internalID || row.receiptNumber || uuid) + '.pdf', blob); return null; }
                catch (e) { if (e.code === 'AUTH' || e.code === 'STOPPED') throw e; return { uuid, err: String(e?.message || e) }; }
                finally { pDone++; onChunk({ i: i + 1, n: plan.chunks.length, phase: 'pdf', cur: pDone, max: rows.length }); }
              })).filter(Boolean);
              pdfSaved += rows.length - pdfFails.length;
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
            onStatus(t('orch.chunkXlsx', { i: i + 1, n: plan.chunks.length, count: records.length }), { level: 'run' });
            const r = renderWorkbook(window.ExcelJS, records, plan.source, opts);
            const buf = await r.workbook.xlsx.writeBuffer();
            const chunkName = store.chunkFile(plan, c);
            await fs.writeBlob(dirHandle, chunkName, new Blob([buf], { type: XLSX_MIME }));
            onChunk({ i: i + 1, n: plan.chunks.length, phase: 'write', cur: 1, max: 1 });
            if (failedRows.length) {
              // The xlsx file now exists, so resume() (via scanDoneFromFolder) would count this chunk as
              // done. Record the dropped documents DURABLY first; if the log can't be written (e.g. the
              // user has eta_failures.jsonl open and it's locked), delete the chunk file and fail the
              // chunk so resume retries the whole thing — nothing vanishes silently.
              const lines = failedRows.map((f) => JSON.stringify({ at: new Date().toISOString(), chunk: c.id, source: plan.source, uuid: f.uuid, err: f.err })).join('\n') + '\n';
              try { await fs.appendText(dirHandle, 'eta_failures.jsonl', lines); }
              catch (logErr) { try { await fs.remove(dirHandle, chunkName); } catch {} throw new Error(t('orch.dropLogFailed', { count: failedRows.length, msg: String(logErr?.message || logErr) })); }
              droppedByChunk.set(c.id, failedRows.length);
              onStatus(t('orch.docsDropped', { count: failedRows.length, i: i + 1, written: records.length, total: rows.length }), { level: 'warn' });
            }
            rowsFetched += rows.length; onCount(rowsFetched, plan.totalRows);
            ok = true; consec = 0;
          } catch (e) {
            lastErr = e; const msg = String(e?.message || e);
            if (e.code === 'AUTH') {
              // token died mid-chunk — same wait-for-renewal as the boundary guard, then retry the
              // chunk (attempt-- so the renewal itself doesn't burn one of the 3 attempts)
              onStatus(t('orch.tokenLapsedMid'), { level: 'wait' });
              await store.writeProgress(dirHandle, plan, 'auth_expired');
              const fresh = ++authRetries > 2 ? null : await waitForFreshToken();   // a "fresh" token the API still rejects → real auth problem, stop retrying
              if (!fresh) {
                if (flags.halted) { onStatus(t('orch.halted'), { level: 'err', terminal: true }); await store.writeProgress(dirHandle, plan, 'halted'); return; }
                onStatus(t('orch.pausedNoToken2'), { level: 'wait', terminal: true });
                flags.paused = true; await store.writeProgress(dirHandle, plan, 'auth_expired'); return;
              }
              onToken(fresh); onStatus(t('orch.tokenRenewedRetry'), { level: 'run' });
              await store.writeProgress(dirHandle, plan, 'running');
              attempt--; continue;
            }
            // Pause/Halt aborts the in-flight request → STOPPED. Emit an authoritative status here (the immediate
            // return bypasses the next-chunk-boundary check) so the footer/tracker don't stay frozen on the last
            // "▶ fetching…" line during a multi-hour run.
            if (e.code === 'STOPPED') {
              if (flags.halted) { onStatus(t('orch.halted'), { level: 'err', terminal: true }); await store.writeProgress(dirHandle, plan, 'halted'); }
              else { onStatus(t('orch.pausedAt', { i: i + 1, n: plan.chunks.length }), { level: 'wait', terminal: true }); await store.writeProgress(dirHandle, plan, 'paused'); }
              return;
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
        store.saveState(plan); await store.writeProgress(dirHandle, plan, 'running');
        onProgress(done.size, failed.size, plan.chunks.length - done.size);
        if (consec >= 3) { onStatus(t('orch.haltedRepeated'), { level: 'err', terminal: true }); flags.halted = true; await store.writeProgress(dirHandle, plan, 'halted'); return; }
        await sleep(1000 + Math.floor(Math.random() * 500));
      }
      onChunk({ i: plan.chunks.length, n: plan.chunks.length, phase: 'idle', cur: 0, max: 0 });
      const complete = done.size === plan.chunks.length;
      try { bumpStats({ runs: 1, docs: rowsFetched - rowsAtStart, pdfs: pdfSaved }); } catch {}   // only the run-finished path — paused/halted returns don't bump
      const droppedTotal = [...droppedByChunk.values()].reduce((a, b) => a + b, 0);
      const dropMsg = droppedTotal ? t('orch.dropTail', { n: droppedTotal }) : '';
      const pdfMsg = pdfDropped ? t('orch.pdfTail', { n: pdfDropped }) : '';
      onStatus(t('orch.doneSummary', { word: t(complete ? 'orch.doneOk' : 'orch.doneIncomplete'), done: done.size, n: plan.chunks.length, failed: failed.size, drops: dropMsg, pdfs: pdfMsg }), { level: complete && !failed.size ? 'ok' : 'warn', terminal: true, kind: 'done' });   // kind:'done' + level:'ok' = clean finish (drawer zeroes the timer & closes the persisted log)
      await store.writeProgress(dirHandle, plan, complete ? 'done' : 'incomplete');
    } finally { running = false; keepalive.stop(); session.stop(); }
  }

  async function resume() {
    if (running) { onStatus(t('orch.runInProgress'), { level: 'warn' }); return null; }
    if (!dirHandle && window.showDirectoryPicker) { try { await pickFolder(); } catch {} }
    if (!dirHandle) { onStatus(t('orch.pickResume'), { level: 'warn' }); return null; }
    // A folder handle restored from IndexedDB after a reload comes back in 'prompt' state — re-request within
    // the click gesture BEFORE reading it, else dir.entries() throws NotAllowedError and wedges the UI.
    if (!(await fs.ensurePermission(dirHandle))) { onStatus(t('orch.permResume'), { level: 'warn' }); return null; }
    const prog = await store.readProgress(dirHandle);
    if (!prog?.chunks) { onStatus(t('orch.noProgress'), { level: 'warn' }); return null; }
    const SRC = SOURCES[prog.source] || SOURCES.invoices;
    const p = {
      v: 1, key: prog.key, source: prog.source, year: prog.year, dir: prog.dir, dateField: prog.field, downloadDetails: true,
      statuses: prog.statuses, from: prog.from, to: prog.to, cap: SRC.cap, totalRows: prog.totalRows,
      chunks: prog.chunks, doneIds: prog.doneIds || [], failedIds: prog.failedIds || [],
      excludeColumns: prog.excludeColumns || [], downloadPdf: !!prog.downloadPdf,
    };
    try { const fileDone = await store.scanDoneFromFolder(dirHandle, p); p.doneIds = [...new Set([...p.doneIds, ...fileDone])]; } catch {}
    store.saveState(p); onPlan(p);
    onStatus(t('orch.resumed', { done: p.doneIds.length, n: p.chunks.length }), { level: 'info' });
    return p;
  }

  return {
    pickFolder, setFolder, folderName, plan, start, resume,
    pause: () => stop('pause'), halt: () => stop('halt'), tokenStatus, SOURCES,
    dir: () => dirHandle, ensureDir: async () => { if (!dirHandle) await pickFolder(); return dirHandle; },
  };
}
