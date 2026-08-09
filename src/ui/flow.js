// SPEC-018 Part A — the Download flow, as a pure module.
//
// Everything the drawer needs to turn "press Download, press Start" into the exact `sel` object
// orchestrator.plan() expects lives here, with no DOM and no network, so the one rule that matters
// is testable: a user who never opens Advanced must get the SAME documents as a fully-configured
// run of the old three-card form. See test/flow.test.mjs (T-163…T-170).
import { SOURCES, ALL_STATUSES } from '../api/sources.js';
import { EN, AR, t } from '../core/i18n.js';
import { lsGet, lsSet } from '../core/ls.js';
import { runKey } from '../core/store.js';

// ── kind → (source, direction) ────────────────────────────────────────────────────────────────────
// Sales / Purchases / Receipts replaces the source toggle AND the direction select. The pairs are
// the two controls' old first-choice values, so the tab a user picks names a real export, not a
// preference they then have to configure.
export const KINDS = ['sales', 'purchases', 'receipts'];
export const KIND_SEL = {
  sales: { source: 'invoices', dir: 'Sent' },
  purchases: { source: 'invoices', dir: 'Received' },
  // Receipts has its own direction vocabulary — 'Submitted', not 'Sent'. Read from SOURCES so the
  // two can never drift apart.
  receipts: { source: 'receipts', dir: SOURCES.receipts.dirs[0][0] },
};
export const selOfKind = (kind) => KIND_SEL[kind] || KIND_SEL.sales;
export const sourceOfKind = (kind) => selOfKind(kind).source;
// Display only. A stored plan may carry a direction no tab maps to ('all'); such a plan is run
// verbatim and this is used purely to label it, never to rebuild its selection.
export const kindOf = (source, dir) => (source === 'receipts' ? 'receipts' : dir === 'Received' ? 'purchases' : 'sales');

// ── default range: the current calendar year, 1 Jan → today ──────────────────────────────────────
export const defaultRange = (today) => ({ from: String(today).slice(0, 4) + '-01-01', to: String(today) });

// The old gather()'s year label, reproduced verbatim: it feeds store.runKey and every chunk
// filename, so a different rule here would orphan an in-progress run's files.
export function yearLabel(from, to) {
  const fY = (from || '').slice(0, 4), tY = (to || '').slice(0, 4);
  return (fY && tY) ? (fY === tY ? fY : fY + '-' + tY) : (from || to || '2025').slice(0, 4);
}

// ── Advanced ─────────────────────────────────────────────────────────────────────────────────────
// Collapsed by default and remembered between sessions. THE DEFAULTS ARE NOT A NEW OPINION: each one
// is the value the old form rendered before anybody touched it — the first <select> option, every
// status chip checked, every column checked, PDFs off.
export function defaultAdvanced(kind) {
  const src = SOURCES[sourceOfKind(kind)];
  return {
    field: src.dateFields[0][0],   // the option the old <select> marked selected
    statuses: [...ALL_STATUSES],   // all statuses — no server-side filter, no client-side filter
    excludeColumns: [],            // every column kept
    downloadPdf: false,            // official PDFs off (they are slow and most runs don't want them)
  };
}

// Anything unrecognised falls back to the default rather than through. A stored value that no longer
// exists (a renamed date field, a dropped column) must not be able to narrow an export.
export function normalizeAdvanced(kind, raw) {
  const d = defaultAdvanced(kind);
  const r = (raw && typeof raw === 'object') ? raw : {};
  const fields = SOURCES[sourceOfKind(kind)].dateFields.map(([v]) => v);
  const statuses = Array.isArray(r.statuses) ? ALL_STATUSES.filter((s) => r.statuses.includes(s)) : d.statuses;
  return {
    field: fields.includes(r.field) ? r.field : d.field,
    // An empty status set is not a narrower export, it is a broken one — the orchestrator already
    // reads [] as "all" (statusPlan), so say so explicitly instead of storing a trap.
    statuses: statuses.length ? statuses : d.statuses,
    excludeColumns: Array.isArray(r.excludeColumns) ? r.excludeColumns.map(String) : d.excludeColumns,
    downloadPdf: !!r.downloadPdf,
  };
}

const ADV_KEY = 'flowAdv';   // etaBulk_flowAdv → { sales:{…}, purchases:{…}, receipts:{…} }
export function loadAdvanced(kind) { const all = lsGet(ADV_KEY); return normalizeAdvanced(kind, all && all[kind]); }
export function saveAdvanced(kind, adv) {
  const all = { ...(lsGet(ADV_KEY) || {}) };
  all[kind] = normalizeAdvanced(kind, adv);
  lsSet(ADV_KEY, all);
  return all[kind];
}
// "· 2 changed" for the collapsed summary — a user must be able to see that Advanced is no longer
// at its defaults without opening it.
export function advancedChanges(kind, adv) {
  const d = defaultAdvanced(kind), a = normalizeAdvanced(kind, adv);
  let n = 0;
  if (a.field !== d.field) n++;
  if (a.statuses.length !== d.statuses.length) n++;
  if (a.excludeColumns.length) n++;
  if (a.downloadPdf) n++;
  return n;
}

// ── the selection ────────────────────────────────────────────────────────────────────────────────
// The whole point of the flow: kind + range + (optional) advanced → the object orchestrator.plan()
// takes. Shape and key order match the old gather() exactly.
export function buildSel(kind, range, adv) {
  const { source, dir } = selOfKind(kind);
  const a = normalizeAdvanced(kind, adv);
  const from = (range && range.from) || '', to = (range && range.to) || '';
  return {
    source,
    year: yearLabel(from, to),
    dir,
    field: a.field,
    from,
    to,
    statuses: a.statuses,
    downloadDetails: true,        // details were always fetched; the old checkbox only labelled the plan
    downloadPdf: a.downloadPdf,
    excludeColumns: [...a.excludeColumns],
  };
}

// ── /register refusals ───────────────────────────────────────────────────────────────────────────
// SPEC-019 gave the device cap its own `reason`, and a reason exists to be read. Flattening
// `reason:'device_limit'` into the generic server-error line would tell a user holding four browsers
// on a one-device plan only that "something went wrong", which is the one reading that makes them
// re-register — the exact action that cannot help and the exact fear the message must answer.
//
// Pure on purpose: it takes the parsed /register body and returns the line to show, so the two
// counts and the wording are testable without a drawer. `held`/`allowed` are coerced here because
// they arrive as JSON and a missing count must read as 0, never as "undefined devices".
//
// Any other refusal returns null — the caller keeps whatever it already said. A refusal this module
// does not recognise is not this module's to phrase.
export function registerRefusal(res) {
  const r = res && typeof res === 'object' ? res : {};
  if (r.ok || r.reason !== 'device_limit') return null;
  const held = Math.max(0, Math.trunc(Number(r.held) || 0));
  const allowed = Math.max(0, Math.trunc(Number(r.allowed) || 0));
  return { reason: 'device_limit', held, allowed, text: t('reg.deviceLimit', { held, allowed }) };
}

// ── the rejection tab gate ───────────────────────────────────────────────────────────────────────
// The /session verdict carries `features`. Absent → the tab is hidden and one line says why.
export const rejectionAllowed = (features) => Array.isArray(features) && features.includes('auto-reject');

// ── resume ───────────────────────────────────────────────────────────────────────────────────────
// /job/resumable returns newest-first; the drawer offers one entry, not a list. Anything malformed
// yields null, which is the same as "no interrupted run" — an entry that cannot be resumed must
// never be shown.
export function resumeEntry(res) {
  const jobs = (res && res.ok && Array.isArray(res.jobs)) ? res.jobs : [];
  const j = jobs.find((x) => x && x.id);
  if (!j) return null;
  return {
    id: String(j.id),
    state: String(j.state || ''),
    kind: kindOf(j.source, j.dir),
    from: j.from_iso || '', to: j.to_iso || '',
    done: j.done_count | 0, total: j.total_chunks | 0, rows: j.total_rows | 0,
  };
}

const parseStatuses = (v) => {
  if (Array.isArray(v)) return ALL_STATUSES.filter((s) => v.includes(s));
  try { const j = JSON.parse(String(v || '[]')); return Array.isArray(j) ? ALL_STATUSES.filter((s) => j.includes(s)) : []; } catch { return []; }
};

// /job/plan → an orchestrator plan. The server stores the chunks and the range; it does NOT store
// the column/PDF choices, so those come back at their defaults here. The folder's own progress file
// carries them and is preferred when it matches — see the drawer's resume handler.
export function planFromJob(res) {
  if (!res || !res.ok || !Array.isArray(res.chunks) || !res.chunks.length) return null;
  const j = res.job || {};
  const source = j.source === 'receipts' ? 'receipts' : 'invoices';
  const SRC = SOURCES[source];
  const from = j.from_iso || '', to = j.to_iso || '';
  const year = yearLabel(from, to);
  const dir = j.dir || selOfKind(kindOf(source, j.dir)).dir;
  const field = j.date_field || SRC.dateFields[0][0];
  const statuses = parseStatuses(j.statuses);
  const chunks = res.chunks.map((c) => ({
    id: c.id, fromISO: c.fromISO, toISO: c.toISO,
    subF: c.subF || null, subT: c.subT || null,
    label: c.label, count: c.count | 0, warn: c.warn || null,
  }));
  return {
    v: 1, jobId: String(j.id || ''), key: runKey(source, year, dir, field, from, to), source,
    createdAt: j.created_at || new Date().toISOString(),
    year, dir, dateField: field, downloadDetails: true,
    statuses: statuses.length ? statuses : [...ALL_STATUSES],
    from, to, cap: SRC.cap,
    totalRows: chunks.reduce((s, c) => s + c.count, 0),
    biggest: chunks.reduce((m, c) => Math.max(m, c.count), 0),
    chunks, doneIds: [], failedIds: [], excludeColumns: [], downloadPdf: false,
  };
}

// ── end of run ───────────────────────────────────────────────────────────────────────────────────
// The orchestrator's terminal line carries kind:'done' when the FETCH LOOP finished (complete or
// not) and level:'ok' only when every chunk landed. Merge follows the first; the 'done' checkpoint —
// which purges the plan server-side — follows only the second. Checkpointing a partial run as done
// would delete the plan the user still needs to finish it.
export const runFinished = (meta) => !!(meta && meta.terminal && meta.kind === 'done');
export const runClean = (meta) => !!(meta && meta.terminal && meta.kind === 'done' && meta.level === 'ok');

// repair.js fixes illegal XML characters in files produced by OTHER tools. The only moment that
// evidence exists is when merge reports a file it could not read, so that message is the only place
// the offer appears. Matched against the catalog itself (both languages) rather than a copied
// literal, so a translation edit can't silently switch the detection off.
const markOf = (s) => String(s || '').split('{')[0].trim();
export const MERGE_SKIP_MARKS = [markOf(EN['merge.skipped']), markOf(AR['merge.skipped'])].filter(Boolean);
export const isUnreadableSkip = (msg) => MERGE_SKIP_MARKS.some((m) => String(msg == null ? '' : msg).includes(m));

/**
 * The last phase of a run: merge, then checkpoint. Kept here — away from the DOM — because the
 * ordering is the contract (T-168) and the repair offer is a consequence of what merge said (T-169).
 *
 * merge(onMsg)  → performs the merge, calling onMsg for every status line it emits.
 * checkpoint()  → sends the 'done' checkpoint; pass null to skip it (an incomplete run).
 */
export async function finishRun({ merge, checkpoint = null, onStatus = () => {} } = {}) {
  let repair = false;
  try {
    await merge((m) => { if (isUnreadableSkip(m)) repair = true; onStatus(m); });
  } catch (e) {
    return { merged: false, checkpointed: false, repair, error: e };
  }
  let checkpointed = false;
  // Best-effort, exactly like every other checkpoint: a backend blip must not turn a finished
  // export into a failed one. The output already exists on disk.
  if (checkpoint) { try { await checkpoint(); checkpointed = true; } catch {} }
  return { merged: true, checkpointed, repair, error: null };
}
