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
import { EN, AR } from '../src/core/i18n.js';
import {
  KINDS, selOfKind, kindOf, defaultRange, defaultAdvanced, normalizeAdvanced,
  loadAdvanced, saveAdvanced, advancedChanges, buildSel, yearLabel,
  rejectionAllowed, resumeEntry, planFromJob, isUnreadableSkip, finishRun, runFinished, runClean,
} from '../src/ui/flow.js';

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
    from: '2026-01-01', to: '2026-08-09', done: 190, total: 412, rows: 98000,
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
