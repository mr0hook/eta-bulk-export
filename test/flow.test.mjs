// SPEC-018 Part A — the Download flow (T-163…T-170).
//
// The rule this file exists for is T-164. Every control the old three-card form exposed now has a
// default, and a default that silently narrows an export is the worst failure this tool can have —
// so the defaults are asserted against what the old form actually rendered, field by field, rather
// than against themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCES, ALL_STATUSES } from '../src/api/sources.js';
import { EN, AR, setLang } from '../src/core/i18n.js';
import {
  KINDS, selOfKind, kindOf, defaultRange, defaultAdvanced, normalizeAdvanced,
  loadAdvanced, saveAdvanced, advancedChanges, buildSel, yearLabel,
  rejectionAllowed, resumeEntry, planFromJob, isUnreadableSkip, finishRun, runFinished, runClean,
  registerRefusal, chunkMap, CHUNK_MAP_MAX, runGuarded, restoreLog, persistLog, clearedLog,
  folderAction, abandonCheckpoint,
} from '../src/ui/flow.js';

const DRAWER = readFileSync(new URL('../src/ui/drawer.js', import.meta.url), 'utf8');

// A localStorage that behaves like the browser's, for the persistence cases. ls.js swallows a
// missing global, so tests that don't install this simply see the defaults.
function withStorage(fn) {
  const bag = new Map();
  globalThis.localStorage = {
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem: (k, v) => bag.set(k, String(v)),
    removeItem: (k) => bag.delete(k),
  };
  try { return fn(bag); } finally { delete globalThis.localStorage; }
}

// ── T-163 ────────────────────────────────────────────────────────────────────────────────────────
test('T-163 Sales/Purchases/Receipts maps to the right source+direction pair', () => {
  assert.deepEqual(selOfKind('sales'), { source: 'invoices', dir: 'Sent' });
  assert.deepEqual(selOfKind('purchases'), { source: 'invoices', dir: 'Received' });
  // Receipts speaks its own direction vocabulary — 'Submitted', not 'Sent'.
  assert.deepEqual(selOfKind('receipts'), { source: 'receipts', dir: 'Submitted' });
  assert.equal(SOURCES.receipts.dirs[0][0], 'Submitted', 'receipts default direction comes from SOURCES');

  // Every kind's pair must be a direction the API actually accepts for that source.
  for (const k of KINDS) {
    const { source, dir } = selOfKind(k);
    assert.ok(SOURCES[source].dirs.some(([v]) => v === dir), `${k} → ${source}/${dir} is not a valid direction`);
  }
  // …and the mapping round-trips for the three pairs the flow can produce.
  assert.equal(kindOf('invoices', 'Sent'), 'sales');
  assert.equal(kindOf('invoices', 'Received'), 'purchases');
  assert.equal(kindOf('receipts', 'Submitted'), 'receipts');
});

// ── T-164 — the one that matters ─────────────────────────────────────────────────────────────────
// What the OLD drawer's gather() returned with nobody touching anything:
//   dir     = the first <option> of SOURCES[source].dirs        (marked selected)
//   field   = the first <option> of SOURCES[source].dateFields  (marked selected)
//   statuses= every status chip checked                          → ALL_STATUSES
//   columns = every column chip checked                          → excludeColumns []
//   pdf     = unchecked                                          → downloadPdf false
//   details = checked                                            → downloadDetails true
// Derived from SOURCES rather than copied as literals, so a change to the API contract fails here
// instead of quietly re-defining "the default".
const legacyDefaults = (source) => ({
  source,
  dir: SOURCES[source].dirs[0][0],
  field: SOURCES[source].dateFields[0][0],
  statuses: ALL_STATUSES,
  downloadDetails: true,
  downloadPdf: false,
  excludeColumns: [],
});

test('T-164 Download with untouched Advanced produces the same selection as today’s configured run', () => {
  const range = { from: '2026-01-01', to: '2026-08-09' };

  // Sales is the landing state: the old form opened on Invoices with Direction=Sent.
  const sales = buildSel('sales', range, undefined);
  assert.deepEqual(sales, {
    ...legacyDefaults('invoices'),
    year: '2026', from: range.from, to: range.to,
  });

  // Receipts: the old form's Receipts tab defaulted to Submitted / DateTimeReceived.
  const receipts = buildSel('receipts', range, undefined);
  assert.deepEqual(receipts, {
    ...legacyDefaults('receipts'),
    year: '2026', from: range.from, to: range.to,
  });

  // Purchases is the one pair the old form needed a second click for; everything else is identical.
  const purchases = buildSel('purchases', range, undefined);
  assert.deepEqual(purchases, { ...sales, dir: 'Received' });

  // Nothing is narrowed, stated separately so a regression names itself.
  for (const sel of [sales, purchases, receipts]) {
    assert.deepEqual(sel.statuses, ALL_STATUSES, 'every status must still be exported');
    assert.deepEqual(sel.excludeColumns, [], 'every column must still be exported');
    assert.equal(sel.downloadDetails, true, 'line items must still be fetched');
    assert.equal(sel.downloadPdf, false, 'PDFs stay off — the old default');
  }

  // The key set matches gather()'s exactly: an extra or missing key changes what plan() reads.
  assert.deepEqual(Object.keys(sales).sort(),
    ['dir', 'downloadDetails', 'downloadPdf', 'excludeColumns', 'field', 'from', 'source', 'statuses', 'to', 'year']);

  // Advanced left alone reports itself as untouched.
  assert.equal(advancedChanges('sales', defaultAdvanced('sales')), 0);
});

test('T-164 the year label rule is the old gather()’s, verbatim', () => {
  assert.equal(yearLabel('2026-01-01', '2026-08-09'), '2026');
  assert.equal(yearLabel('2025-11-01', '2026-02-01'), '2025-2026', 'a cross-year range keeps both — it feeds runKey and every filename');
  assert.equal(yearLabel('', ''), '2025', 'the old fallback, unchanged');
  assert.equal(buildSel('sales', { from: '2025-11-01', to: '2026-02-01' }).year, '2025-2026');
});

// ── T-165 ────────────────────────────────────────────────────────────────────────────────────────
test('T-165 default range is 1 Jan of the current year → today', () => {
  assert.deepEqual(defaultRange('2026-08-09'), { from: '2026-01-01', to: '2026-08-09' });
  assert.deepEqual(defaultRange('2031-12-31'), { from: '2031-01-01', to: '2031-12-31' });
  // Not hard-coded to a year the tool shipped in.
  const r = defaultRange('2027-03-04');
  assert.equal(r.from.slice(0, 4), '2027');
  assert.equal(buildSel('sales', r).year, '2027');
});

// ── T-166 ────────────────────────────────────────────────────────────────────────────────────────
test('T-166 Advanced remembers its last values across drawer close/open', () => {
  withStorage(() => {
    assert.deepEqual(loadAdvanced('sales'), defaultAdvanced('sales'), 'nothing stored → the defaults');

    saveAdvanced('sales', { field: 'Submission', statuses: ['Valid'], excludeColumns: ['taxTotal'], downloadPdf: true });
    // A fresh read is what a re-opened drawer does.
    assert.deepEqual(loadAdvanced('sales'), {
      field: 'Submission', statuses: ['Valid'], excludeColumns: ['taxTotal'], downloadPdf: true,
    });
    assert.equal(advancedChanges('sales', loadAdvanced('sales')), 4);

    // Per kind: the column and date-field vocabularies differ by source, so one kind's choices must
    // not leak into another's.
    assert.deepEqual(loadAdvanced('receipts'), defaultAdvanced('receipts'));
    assert.deepEqual(loadAdvanced('purchases'), defaultAdvanced('purchases'));

    // And a remembered Advanced is what the selection is built from.
    const sel = buildSel('sales', { from: '2026-01-01', to: '2026-08-09' }, loadAdvanced('sales'));
    assert.equal(sel.field, 'Submission');
    assert.deepEqual(sel.statuses, ['Valid']);
    assert.deepEqual(sel.excludeColumns, ['taxTotal']);
    assert.equal(sel.downloadPdf, true);
  });
});

test('T-166 a stored value that no longer exists cannot narrow an export', () => {
  withStorage(() => {
    // A date field that was renamed, a status that no longer exists, an empty status set.
    saveAdvanced('sales', { field: 'NoSuchField', statuses: ['Nope'], excludeColumns: null, downloadPdf: 'yes' });
    const a = loadAdvanced('sales');
    assert.equal(a.field, SOURCES.invoices.dateFields[0][0], 'unknown field falls back to the default');
    assert.deepEqual(a.statuses, ALL_STATUSES, 'an empty status set is not a narrower export, it is a broken one');
    assert.deepEqual(a.excludeColumns, [], 'a non-array exclusion list excludes nothing');
    assert.equal(a.downloadPdf, true);
  });
  // Storage refusing to answer at all must also leave the defaults intact.
  assert.deepEqual(loadAdvanced('sales'), defaultAdvanced('sales'));
  assert.deepEqual(normalizeAdvanced('receipts', { statuses: [] }).statuses, ALL_STATUSES);
});

// ── T-167 ────────────────────────────────────────────────────────────────────────────────────────
test('T-167 the rejection tab is hidden without auto-reject and shown with it', () => {
  assert.equal(rejectionAllowed(['auto-reject']), true);
  assert.equal(rejectionAllowed(['auto-reject', 'beta']), true);
  assert.equal(rejectionAllowed(['beta']), false);
  assert.equal(rejectionAllowed([]), false);
  // Absent, null, or a malformed verdict all mean "not entitled" — never "assume yes".
  assert.equal(rejectionAllowed(undefined), false);
  assert.equal(rejectionAllowed(null), false);
  assert.equal(rejectionAllowed('auto-reject'), false, 'a string is not a feature list');
  assert.equal(rejectionAllowed({ 0: 'auto-reject' }), false);
});

// ── T-168 ────────────────────────────────────────────────────────────────────────────────────────
test('T-168 merge runs automatically on fetch completion, then checkpoints done', async () => {
  // The orchestrator's terminal line is the trigger: kind 'done' = the fetch loop finished.
  assert.equal(runFinished({ terminal: true, kind: 'done', level: 'ok' }), true);
  assert.equal(runFinished({ terminal: true, kind: 'done', level: 'warn' }), true, 'an incomplete fetch still has output to merge');
  assert.equal(runFinished({ terminal: true, level: 'wait' }), false, 'a pause is not a finish');
  assert.equal(runFinished({ kind: 'done', level: 'ok' }), false, 'a non-terminal line is not a finish');
  assert.equal(runClean({ terminal: true, kind: 'done', level: 'ok' }), true);
  assert.equal(runClean({ terminal: true, kind: 'done', level: 'warn' }), false, 'a partial run must not be checkpointed done');

  const order = [];
  const res = await finishRun({
    merge: async () => { order.push('merge'); },
    checkpoint: async () => { order.push('checkpoint'); },
  });
  assert.deepEqual(order, ['merge', 'checkpoint'], 'the output must exist before the plan is purged');
  assert.deepEqual({ merged: res.merged, checkpointed: res.checkpointed, repair: res.repair }, { merged: true, checkpointed: true, repair: false });

  // A failed merge must NOT checkpoint: 'done' purges the plan server-side, and without output the
  // run is not done.
  const order2 = [];
  const bad = await finishRun({
    merge: async () => { order2.push('merge'); throw new Error('disk full'); },
    checkpoint: async () => { order2.push('checkpoint'); },
  });
  assert.deepEqual(order2, ['merge']);
  assert.equal(bad.merged, false);
  assert.equal(bad.checkpointed, false);
  assert.match(String(bad.error.message), /disk full/);

  // A checkpoint that fails is best-effort: the export still succeeded.
  const soft = await finishRun({ merge: async () => {}, checkpoint: async () => { throw new Error('offline'); } });
  assert.equal(soft.merged, true);
  assert.equal(soft.checkpointed, false);
  assert.equal(soft.error, null);

  // No checkpoint at all (a standalone merge, or an incomplete run) is a supported shape.
  const standalone = await finishRun({ merge: async () => {} });
  assert.deepEqual({ m: standalone.merged, c: standalone.checkpointed }, { m: true, c: false });
});

// ── T-169 ────────────────────────────────────────────────────────────────────────────────────────
test('T-169 repair is offered only when merge reports unreadable files', async () => {
  const skipEn = EN['merge.skipped'].replace('{name}', 'eInvoices_2026_Sent_x.xlsx');
  const skipAr = AR['merge.skipped'].replace('{name}', 'eInvoices_2026_Sent_x.xlsx');
  assert.equal(isUnreadableSkip(skipEn), true);
  assert.equal(isUnreadableSkip(skipAr), true, 'the drawer runs in Arabic too');
  // Every other line merge emits, including its own summary and the incremental chatter.
  for (const key of ['merge.phase1', 'merge.phase2', 'merge.upToDate', 'merge.incremental', 'merge.wrote', 'merge.noRows', 'merge.summary']) {
    assert.equal(isUnreadableSkip(EN[key]), false, key);
    assert.equal(isUnreadableSkip(AR[key]), false, key);
  }
  assert.equal(isUnreadableSkip(''), false);
  assert.equal(isUnreadableSkip(null), false);

  const quiet = await finishRun({ merge: async (onMsg) => { onMsg(EN['merge.phase1']); onMsg(EN['merge.summary']); } });
  assert.equal(quiet.repair, false, 'a clean merge must never offer Repair');

  const noisy = await finishRun({ merge: async (onMsg) => { onMsg(EN['merge.phase1']); onMsg(skipEn); } });
  assert.equal(noisy.repair, true, 'the offer is attached to the message that raised it');

  const arabic = await finishRun({ merge: async (onMsg) => { onMsg(skipAr); } });
  assert.equal(arabic.repair, true);
});

// ── T-170 ────────────────────────────────────────────────────────────────────────────────────────
const RESUMABLE = {
  ok: true,
  jobs: [{
    id: 'job-9', source: 'invoices', date_field: 'Issue', dir: 'Received',
    from_iso: '2026-01-01', to_iso: '2026-08-09', state: 'paused',
    total_chunks: 412, total_rows: 98000, done_count: 190, failed_count: 1,
    updated_at: '2026-08-09T10:00:00.000Z',
  }],
};

test('T-170 Resume appears only when /job/resumable returns a job', () => {
  assert.equal(resumeEntry({ ok: true, jobs: [] }), null, 'no interrupted run → no entry');
  assert.equal(resumeEntry({ ok: false, error: 'unauthorized' }), null);
  assert.equal(resumeEntry(null), null);
  assert.equal(resumeEntry({ ok: true, jobs: [{}] }), null, 'a job with no id cannot be resumed, so it is not offered');

  const e = resumeEntry(RESUMABLE);
  assert.deepEqual(e, {
    id: 'job-9', state: 'paused', kind: 'purchases',
    from: '2026-01-01', to: '2026-08-09', done: 190, failed: 1, total: 412, rows: 98000,
  });
});

test('T-170 resuming rebuilds the plan from /job/plan', () => {
  const res = {
    ok: true,
    job: { id: 'job-9', source: 'invoices', date_field: 'Issue', dir: 'Received', from_iso: '2026-01-01', to_iso: '2026-08-09', statuses: '["Valid","Invalid"]' },
    chunks: [
      { id: 'c1', fromISO: '2026-01-01T00:00:00.000Z', toISO: '2026-01-31T23:59:59.999Z', subF: null, subT: null, label: '2026-01', count: 900, warn: null },
      { id: 'c2', fromISO: '2026-02-01T00:00:00.000Z', toISO: '2026-02-28T23:59:59.999Z', subF: null, subT: null, label: '2026-02', count: 1200, warn: null },
    ],
  };
  const p = planFromJob(res);
  assert.equal(p.jobId, 'job-9');
  assert.equal(p.source, 'invoices');
  assert.equal(p.dir, 'Received');
  assert.equal(p.dateField, 'Issue');
  assert.equal(p.year, '2026');
  assert.equal(p.cap, SOURCES.invoices.cap);
  assert.equal(p.chunks.length, 2);
  assert.equal(p.totalRows, 2100);
  assert.equal(p.biggest, 1200);
  assert.deepEqual(p.statuses, ['Valid', 'Invalid']);
  assert.deepEqual(p.doneIds, [], 'the server keeps counts, not ids — the folder is the authority on which chunks landed');
  assert.equal(typeof p.key, 'string');
  assert.ok(p.key.includes('2026'));

  // A purged plan (the job reached 'done', chunks dropped) is not resumable, and must not produce a
  // plan with zero chunks that would look like a finished run.
  assert.equal(planFromJob({ ok: false, error: 'plan no longer available' }), null);
  assert.equal(planFromJob({ ok: true, job: res.job, chunks: [] }), null);
  assert.equal(planFromJob(null), null);

  // A receipts job comes back with the receipts cap, not the invoice one.
  const rec = planFromJob({ ok: true, job: { id: 'j2', source: 'receipts', dir: 'Submitted', date_field: 'DateTimeReceived', from_iso: '2026-01-01', to_iso: '2026-03-01', statuses: '[]' }, chunks: [{ id: 'r1', label: 'x', count: 10 }] });
  assert.equal(rec.cap, SOURCES.receipts.cap);
  assert.deepEqual(rec.statuses, ALL_STATUSES, 'no stored status filter means all of them');
});

// ── the drawer actually uses this ────────────────────────────────────────────────────────────────
// The helpers above are only worth anything if the drawer is wired to them; a static scan is the
// only check available without a shadow root.
test('the drawer is wired to the flow and the old form is gone', () => {
  const src = readFileSync(new URL('../src/ui/drawer.js', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/flow\.js'/, 'drawer must import the flow module');
  assert.match(src, /buildSel\(kind,/, 'the selection must be built by buildSel, not a local gather()');
  assert.ok(!/const gather = /.test(src), 'the old gather() must be gone');
  assert.ok(!/id="dir"/.test(src), 'the Direction select is replaced by Sales/Purchases/Receipts');
  assert.ok(!/id="year"/.test(src), 'the Quick year select is replaced by the default range');
  assert.ok(!/id="build"/.test(src), 'Build chunk plan is folded into Start');
  assert.ok(!/data-tab="receipts"/.test(src), 'the separate Receipts tab is deleted');
  assert.match(src, /data-kind="sales"[\s\S]*data-kind="purchases"[\s\S]*data-kind="receipts"/);
  assert.match(src, /id="resumeEntry"/, 'the Resume entry lives under Download');
  assert.match(src, /jobResumable\(\)/, 'the Resume entry is fed by /job/resumable');
  assert.match(src, /jobPlan\(resumeJob\.id\)/, 'resuming pulls the stored plan');
  assert.match(src, /runFinished\(meta\)\) autoFinish/, 'merge is automatic on fetch completion');
  assert.match(src, /state: 'done'/, 'a completed run checkpoints done');
  // Repair has exactly one entry point: the offer raised by a merge that skipped a file.
  assert.match(src, /id="repairOffer"/);
  assert.equal((src.match(/\$\('repair'\)\.onclick/g) || []).length, 1);
});

// The Arabic drawer must not be uppercased or letter-spaced — Arabic has no case and its letterforms
// join, so both are damage rather than styling.
test('RTL: the new flow chrome uses logical properties and leaves Arabic alone', () => {
  const src = readFileSync(new URL('../src/ui/drawer.js', import.meta.url), 'utf8');
  const css = src.slice(src.indexOf('const CSS = `'), src.indexOf('`;', src.indexOf('const CSS = `'))).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const bad of ['margin-left:', 'margin-right:', 'padding-left:', 'padding-right:', 'text-align:left', 'text-align:right']) {
    const rules = css.split('\n').filter((l) => l.includes(bad) && !l.includes('.log') && !l.includes('border-left'));
    assert.deepEqual(rules, [], `physical property "${bad}" — use the logical one so RTL mirrors`);
  }
  assert.match(css, /\.drawer\[dir=rtl\][\s\S]*text-transform:none/, 'RTL must neutralise the uppercase micro-labels');
});

// ── T-185 — the device-limit refusal is its own message ──────────────────────────────────────────
// SPEC-019 gives the cap its own `reason` so the drawer can explain it. The failure this guards
// against is the cheap one: catching the refusal in the generic "server error" arm, where a user
// holding four browsers on a one-device plan learns nothing and re-registers, which cannot help.
test('T-185 /register device_limit renders its own line naming both counts', () => {
  const r = registerRefusal({ ok: false, error: 'device limit reached', reason: 'device_limit', held: 4, allowed: 1 });
  assert.ok(r, 'a device_limit refusal must be recognised');
  assert.equal(r.reason, 'device_limit');
  assert.equal(r.held, 4);
  assert.equal(r.allowed, 1);
  // Both counts, in the sentence, in that order — the whole point of the reason carrying two numbers.
  assert.match(r.text, /already uses 4 of 1 devices/);
  // And it must say what did NOT happen: the natural reading of a refusal here is "my licence broke".
  assert.match(r.text, /keeps working/);
  assert.ok(!/\{\w+\}/.test(r.text), 'no placeholder may survive into the rendered line');
  assert.notEqual(r.text, EN['reg.serverError'], 'not the generic failure');

  // Arabic renders the same two numbers rather than falling back to English.
  setLang('ar');
  try {
    const ar = registerRefusal({ ok: false, reason: 'device_limit', held: 4, allowed: 1 });
    assert.equal(ar.text, AR['reg.deviceLimit'].replace('{held}', '4').replace('{allowed}', '1'));
    assert.ok(ar.text.includes('4') && ar.text.includes('1'));
  } finally { setLang('en'); }
});

test('T-185 every other /register answer is left to the caller, and counts are coerced', () => {
  // A success, an unrelated refusal and rubbish all mean "not mine" — never a device-limit line.
  assert.equal(registerRefusal({ ok: true }), null);
  assert.equal(registerRefusal({ ok: false, error: 'rin already bound', reason: 'rin_not_allowed' }), null);
  assert.equal(registerRefusal({ ok: false, error: 'boom' }), null);
  assert.equal(registerRefusal(null), null);
  assert.equal(registerRefusal('device_limit'), null);
  // ok:true wins even if a reason rode along — a registration that succeeded was not refused.
  assert.equal(registerRefusal({ ok: true, reason: 'device_limit', held: 4, allowed: 1 }), null);

  // Counts arrive as JSON: a missing or unusable one must read as 0, never as "undefined devices".
  const r = registerRefusal({ ok: false, reason: 'device_limit' });
  assert.equal(r.held, 0);
  assert.equal(r.allowed, 0);
  assert.ok(!/undefined|NaN/.test(r.text));
  assert.equal(registerRefusal({ ok: false, reason: 'device_limit', held: '4', allowed: '1' }).held, 4);
  assert.equal(registerRefusal({ ok: false, reason: 'device_limit', held: -3, allowed: 1.9 }).held, 0);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// T-186 — the chunk map: which chunks are DONE, and which are PENDING
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// The run card carried exactly one notion of a chunk — the one being worked right now — so nothing
// anywhere said which chunks had finished. The failure that matters is the RESUME one: start() skips
// an already-done chunk with `continue` and emits NO onChunk for it, so a map painted from the event
// stream shows a resumed run's completed chunks as "not started" while the counter above it says
// 190/412. The plan is the authority; these tests pin that.
const planOf = (n, doneIds = [], failedIds = []) => ({
  chunks: Array.from({ length: n }, (x, i) => ({ id: 'c' + (i + 1), label: 'L' + (i + 1), count: 10 })),
  doneIds, failedIds,
});
const statesOf = (m) => m.cells.map((c) => c.state);

test('T-186 the chunk map marks done, running, failed and pending from the plan', () => {
  const m = chunkMap(planOf(5, ['c1', 'c2'], ['c4']), 3);
  assert.equal(m.total, 5);
  assert.equal(m.per, 1, 'one cell per chunk at this size');
  assert.deepEqual(statesOf(m), ['done', 'done', 'run', 'failed', 'pending']);
  assert.deepEqual({ done: m.done, failed: m.failed, pending: m.pending, running: m.running }, { done: 2, failed: 1, pending: 1, running: 3 });
  // Each cell names the chunk it stands for, 1-based, so a tooltip can be assembled without the DOM.
  assert.deepEqual(m.cells[2], { state: 'run', from: 3, to: 3, n: 1 });

  // No plan / no chunks is an empty map, never a crash and never a phantom square.
  for (const p of [null, undefined, {}, { chunks: [] }, { chunks: [], doneIds: ['c1'] }]) {
    const e = chunkMap(p);
    assert.deepEqual(e.cells, [], 'empty plan → no cells');
    assert.equal(e.total, 0);
  }
  // A doneId for a chunk that is not in this plan cannot colour anything.
  assert.deepEqual(statesOf(chunkMap(planOf(2, ['nope']), null)), ['pending', 'pending']);
});

test('T-186 a RESUMED run shows its finished chunks as done before a single fetch goes out', () => {
  // What orchestrator.resume() hands the drawer: doneIds reconciled from the folder, nothing running.
  const resumed = planOf(6, ['c1', 'c2', 'c3']);
  const before = chunkMap(resumed, null);
  assert.deepEqual(statesOf(before), ['done', 'done', 'done', 'pending', 'pending', 'pending'],
    'the map is painted from plan.doneIds, so a resume is right before the first onChunk arrives');
  assert.equal(before.done, 3);
  assert.equal(before.running, null, 'nothing is running yet — no square may claim to be');

  // The orchestrator then skips c1..c3 (onProgress only, no onChunk) and starts work on c4.
  const during = chunkMap(resumed, 4);
  assert.deepEqual(statesOf(during), ['done', 'done', 'done', 'run', 'pending', 'pending'],
    'the skipped chunks stay done — an event-driven map would have shown them as not started');

  // done wins over running: a stale index must never un-finish a chunk that landed.
  assert.equal(chunkMap(resumed, 2).cells[1].state, 'done');
  // running wins over failed: a failed chunk stays in failedIds while it is being retried.
  assert.equal(chunkMap(planOf(3, [], ['c2']), 2).cells[1].state, 'run');
  assert.equal(chunkMap(planOf(3, [], ['c2']), 3).cells[1].state, 'failed');
  // An out-of-range or non-integer running index lights nothing.
  for (const bad of [0, 7, -1, null, 1.5, '2', NaN]) assert.equal(chunkMap(resumed, bad).running, null, String(bad));
});

test('T-186 a plan with hundreds of chunks still fits a 404px panel, and a red square survives', () => {
  const n = CHUNK_MAP_MAX * 3 + 7;   // 727 chunks — the T-170 fixture is 412, so this is realistic
  const done = Array.from({ length: 400 }, (x, i) => 'c' + (i + 1));
  const m = chunkMap(planOf(n, done, ['c' + n]), 401);
  assert.ok(m.cells.length <= CHUNK_MAP_MAX, `capped at ${CHUNK_MAP_MAX}, got ${m.cells.length}`);
  assert.equal(m.cells.reduce((s, c) => s + c.n, 0), n, 'every chunk is covered by exactly one cell');
  assert.deepEqual([m.cells[0].from, m.cells[m.cells.length - 1].to], [1, n], 'the cells span the whole plan');
  // The counts are per-CHUNK, not per-cell: the tracker and the map must agree.
  assert.deepEqual({ done: m.done, failed: m.failed }, { done: 400, failed: 1 });
  // The worst thing in a range wins, so a single failure is never averaged into a field of green.
  assert.ok(statesOf(m).includes('failed'), 'one failed chunk in 727 must still be visible');
  assert.ok(statesOf(m).includes('run'));
  assert.ok(statesOf(m).includes('done'));
  // A range only some of whose chunks landed is neither done nor pending.
  assert.ok(statesOf(chunkMap(planOf(10, ['c1']), null, 5)).includes('part'));
});

test('T-186 the drawer renders the map, and renders it from the plan', () => {
  assert.match(DRAWER, /id="ckgrid"/, 'the chunk map needs an element to live in');
  assert.match(DRAWER, /chunkMap\(/, 'the states come from flow.js, not from a second implementation');
  assert.match(DRAWER, /function renderChunkMap\(/);
  // Painted on every hook that can change it — including onProgress, which is the ONLY hook a
  // resume-skipped chunk emits.
  const hook = DRAWER.slice(DRAWER.indexOf('onProgress: ('), DRAWER.indexOf('onCount: ('));
  assert.match(hook, /renderChunkMap\(\)/, 'onProgress must repaint the map');
  assert.match(DRAWER.slice(DRAWER.indexOf('function renderPlan(')), /renderChunkMap\(\)/, 'a resumed plan paints before the first fetch');
  // The PDF phase had no label and no catalog key, so a PDF-enabled run blanked its own chunk line
  // for the longest phase of every chunk.
  assert.match(DRAWER, /pdf: t\('ui\.phPdf'\)/);
  assert.ok(EN['ui.phPdf'] && AR['ui.phPdf'], 'both languages');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// T-187 — Pause, then re-run: the controls are released by the PROMISE, never by a status line
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const tick = () => new Promise((r) => setTimeout(r, 0));

test('T-187 a re-run during the previous run’s wind-down is refused out loud, and works after it', async () => {
  // Model of the real thing: orchestrator.start() emits its terminal "⏸ Paused at i/n" line and only
  // THEN writes progress and sends its best-effort checkpoint, staying `running` throughout — and a
  // start() made in that window returns undefined with no status, no error and no log line.
  const starts = [];
  let running = false;
  const start = async (onStatus) => {
    if (running) { starts.push('swallowed'); return undefined; }   // orchestrator.js:161, verbatim
    running = true; starts.push('ran');
    onStatus('⏸ Paused at 2/3.', { level: 'wait', terminal: true });
    await tick(); await tick();                                     // writeProgress + jobCheckpoint
    running = false;
    return 'settled';
  };

  let busy = false; const refused = [];
  const attempt = () => runGuarded({
    isBusy: () => busy, setBusy: (b) => { busy = b; }, onRefused: (why) => refused.push(why),
    run: () => start(() => {}),
  });

  const first = attempt();
  await tick();   // the terminal line has been emitted — this is where the drawer used to setBusy(false)
  assert.equal(busy, true, 'the run has not settled, so the controls are still held');

  const second = await attempt();
  assert.deepEqual(second, { ran: false, refused: 'busy', value: undefined, error: null });
  assert.deepEqual(refused, ['busy'], 'a swallowed click is the visible half of the bug — it must speak');
  assert.deepEqual(starts, ['ran'], 'the refused attempt never reached the orchestrator’s silent return');

  assert.equal((await first).value, 'settled');
  assert.equal(busy, false, 'the promise is the release point');

  const third = await attempt();
  assert.equal(third.ran, true);
  assert.equal(third.value, 'settled', 'the re-run after a pause actually runs');
  assert.deepEqual(starts, ['ran', 'ran']);
  assert.deepEqual(refused, ['busy']);
});

test('T-187 runGuarded always releases the controls, including when the run throws', async () => {
  let busy = false;
  const r = await runGuarded({ isBusy: () => busy, setBusy: (b) => { busy = b; }, run: async () => { throw new Error('plan denied'); } });
  assert.equal(busy, false, 'a failed run must not leave the drawer wedged');
  assert.equal(r.ran, true);
  assert.match(String(r.error.message), /plan denied/, 'the error is returned, not thrown — the caller phrases it');
  assert.equal(r.refused, null);
});

test('T-187 the drawer releases on the promise, not on the terminal status line', () => {
  assert.ok(!/terminal\)\s*setBusy\(false\)/.test(DRAWER),
    'a terminal line ends the run’s narrative, not the run — releasing there is the pause → re-run bug');
  assert.match(DRAWER, /runGuarded\(\{/, 'the run entry points go through the guarded wrapper');
  // Every entry point that can start the orchestrator, and the refusal they share.
  for (const id of ['start', 'resumeEntry', 'sync', 'resume']) {
    const h = DRAWER.slice(DRAWER.indexOf(`$('${id}').onclick`), DRAWER.indexOf(`$('${id}').onclick`) + 1400);
    assert.match(h, /runGuarded\(/, `${id} must not manage busy by hand`);
    assert.match(h, /refuseRun/, `${id} must not swallow a click made while a run is winding down`);
  }
  assert.ok(EN['flow.runBusy'] && AR['flow.runBusy'], 'the refusal needs both languages');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// T-188 — a force-closed run must not come back stuck in "pause"
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test('T-188 a restored paused log can be cleared, and stays cleared across the next reload', () => {
  const paused = [{ t: 0, level: 'wait', msg: '⏸ Paused at 12/17.', n: 1 }];

  // What a force-closed run leaves behind, and what the next mount reads.
  const crashed = JSON.stringify(persistLog('active', paused));
  const r1 = restoreLog(crashed);
  assert.deepEqual({ run: r1.run, keep: r1.keep, n: r1.entries.length }, { run: 'resumable', keep: true, n: 1 },
    'a run that was mid-flight when the page died comes back as one that can be resumed');
  assert.equal(restoreLog(JSON.stringify(persistLog('resumable', paused))).run, 'resumable');

  // The ✕ next to the log. THIS is the round trip that used to fail: the entries and the key went,
  // the lifecycle flag did not, so the next status line re-persisted run:'resumable' and the paused
  // tail came back on the following reload — for ever.
  const c = clearedLog();
  assert.deepEqual(c, { run: 'none', entries: [] });
  const afterClear = restoreLog(JSON.stringify(persistLog(c.run, c.entries)));
  assert.deepEqual({ run: afterClear.run, keep: afterClear.keep }, { run: 'none', keep: false },
    'what the clear writes must read back as nothing to restore');

  // A clean finish is not resumable either, and nothing malformed may resurrect a log.
  assert.equal(restoreLog(JSON.stringify(persistLog('done', paused))).run, 'none');
  assert.equal(restoreLog(JSON.stringify({ closed: false, entries: paused })).run, 'resumable', 'v1 {closed} maps over');
  assert.equal(restoreLog(JSON.stringify({ closed: true, entries: paused })).run, 'none');
  for (const junk of [null, undefined, '', 'not json', '[]', JSON.stringify(paused), '{}', '7']) {
    const j = restoreLog(junk);
    assert.deepEqual({ run: j.run, keep: j.keep, n: j.entries.length }, { run: 'none', keep: false, n: 0 }, JSON.stringify(junk));
  }
});

test('T-188 the drawer’s clear resets the lifecycle, not just the lines', () => {
  const h = DRAWER.slice(DRAWER.indexOf("$('logclear').onclick"), DRAWER.indexOf("$('logclear').onclick") + 400);
  assert.match(h, /clearedLog\(\)/, 'the clear must go through the flow helper');
  assert.match(h, /logRun = /, 'clearing the log must clear its lifecycle flag or the paused tail comes back');
  assert.match(DRAWER, /restoreLog\(raw\)/, 'the mount-time restore is the same model');
  assert.match(DRAWER, /persistLog\(logRun,/);
});

test('T-188 an interrupted run can be discarded, which is the only way off the resume list', () => {
  // listResumable keeps a job while it is planned/running/merging/paused/incomplete/halted, and the
  // extension had no path that leaves that set — so a force-closed run was offered on every mount.
  const e = resumeEntry(RESUMABLE);
  assert.deepEqual(abandonCheckpoint(e), { jobId: 'job-9', state: 'abandoned', done: 190, failed: 1 });
  // The counts ride along: a checkpoint writes done_count/failed_count, so zeroes would erase how far
  // the run actually got from the history row it leaves behind.
  assert.equal(abandonCheckpoint({ id: 'j', done: 3, failed: 2 }).done, 3);
  assert.equal(abandonCheckpoint({ id: 'j' }).failed, 0, 'a missing count is 0, never undefined');
  // Nothing to abandon is not a checkpoint — never a request with an empty job id.
  for (const bad of [null, undefined, {}, { id: '' }, 'job-9']) assert.equal(abandonCheckpoint(bad), null, String(bad));

  assert.match(DRAWER, /id="resumeDiscard"/, 'the way out must be a control, not a devtools command');
  const h = DRAWER.slice(DRAWER.indexOf("$('resumeDiscard').onclick"), DRAWER.indexOf("$('resumeDiscard').onclick") + 700);
  assert.match(h, /confirmModal\(/, 'discarding a run is not an accident you can click into');
  assert.match(h, /abandonCheckpoint\(resumeJob\)/);
  assert.match(h, /jobCheckpoint\(body\)/);
  assert.match(h, /rlog\.clear\(\)/, 'discarding the run also clears the paused log it left behind');
  for (const k of ['flow.discardTitle', 'flow.discardConfirm', 'flow.discardBody', 'flow.discarded', 'flow.discardFailed']) {
    assert.ok(EN[k] && AR[k], k);
  }
});

test('T-188 a folder handle restored after a reload is re-permissioned before anything reads it', () => {
  // Chrome hands back a rehydrated handle in 'prompt' state. ensureDir() goes straight to the owner
  // -stamp check — dir.entries() — which throws NotAllowedError, is swallowed into "Pick an output
  // folder first.", and used to leave the user on the one screen with no Pick button. That is the
  // reload after which the tool "stops working".
  assert.equal(folderAction({ hasHandle: false }), 'pick', 'no handle → the picker');
  assert.equal(folderAction({ hasHandle: true }), 'request', 'a restored handle is asked about BEFORE it is read');
  assert.equal(folderAction({ hasHandle: true, permitted: null }), 'request');
  assert.equal(folderAction({ hasHandle: true, permitted: true }), 'use');
  assert.equal(folderAction({ hasHandle: true, permitted: false }), 'pick', 'a refused handle falls back to a fresh one, not to a dead end');
  assert.equal(folderAction(), 'pick');

  assert.match(DRAWER, /async function ensureFolder\(/);
  const f = DRAWER.slice(DRAWER.indexOf('async function ensureFolder('), DRAWER.indexOf('async function ensureFolder(') + 700);
  assert.match(f, /folderAction\(/, 'the decision lives in flow.js');
  assert.ok(f.indexOf('ensurePermission') < f.indexOf('orch.ensureDir'), 'permission must be settled BEFORE the directory is read');
  // No writing path may still go straight at ensureDir and inherit the wedge.
  assert.equal((DRAWER.match(/await orch\.ensureDir\(/g) || []).length, 1, 'ensureFolder is the single gate');
  // And the screen that reports "pick a folder" must be a screen you can pick one from.
  const home = DRAWER.slice(DRAWER.indexOf('<div id="step-home">'), DRAWER.indexOf('<div id="step-what"'));
  assert.match(home, /id="pickHome"/, 'the only Pick control used to sit behind the door that jams');
});
