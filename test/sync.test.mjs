// deriveSyncSel: date math, clamps, filter passthrough. Runs under TZ=Africa/Cairo (npm test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSyncSel, SYNC_OVERLAP_DAYS } from '../src/core/sync.js';
import { addDaysYmd } from '../src/core/time.js';

const prog = (over = {}) => ({
  source: 'invoices', dir: 'Sent', field: 'Issue', from: '2026-01-01', to: '2026-06-30',
  statuses: ['Valid', 'Cancelled'], excludeColumns: ['taxpayerActivityCode'], downloadPdf: true, ...over,
});

test('overlap: from = last run end − 3 days, to = today; filters carried through', () => {
  const s = deriveSyncSel(prog(), '2026-07-12');
  assert.equal(SYNC_OVERLAP_DAYS, 3);
  assert.equal(s.from, '2026-06-27');
  assert.equal(s.to, '2026-07-12');
  assert.equal(s.year, '2026');
  assert.deepEqual([s.source, s.dir, s.field], ['invoices', 'Sent', 'Issue']);
  assert.deepEqual(s.statuses, ['Valid', 'Cancelled']);
  assert.deepEqual(s.excludeColumns, ['taxpayerActivityCode']);
  assert.equal(s.downloadPdf, true);
  assert.equal(s.downloadDetails, true);
});

test('overlap clamp: never reaches before the original run start', () => {
  const s = deriveSyncSel(prog({ from: '2026-06-29', to: '2026-06-30' }), '2026-07-12');
  assert.equal(s.from, '2026-06-29', '−3d would be 06-27 but the run started 06-29');
});

test('month boundary: overlap crosses into the previous month', () => {
  const s = deriveSyncSel(prog({ to: '2026-03-02' }), '2026-03-15');
  assert.equal(s.from, '2026-02-27');
});

test('year boundary: cross-year range gets the combined year label', () => {
  const s = deriveSyncSel(prog({ from: '2025-01-01', to: '2025-12-31' }), '2026-01-04');
  assert.equal(s.from, '2025-12-28');
  assert.equal(s.year, '2025-2026');
});

test('clock skew: progress.to after today → clamps to a 1-day range, never inverted', () => {
  const s = deriveSyncSel(prog({ to: '2026-12-31' }), '2026-07-12');
  assert.equal(s.from, '2026-12-28');
  assert.equal(s.to, '2026-12-28', 'to clamped up to from');
  assert.ok(s.from <= s.to);
});

test('receipts: fields and statuses pass through untouched', () => {
  const s = deriveSyncSel(prog({ source: 'receipts', dir: 'Submitted', field: 'DateTimeReceived', statuses: undefined, downloadPdf: false }), '2026-07-12');
  assert.deepEqual([s.source, s.dir, s.field], ['receipts', 'Submitted', 'DateTimeReceived']);
  assert.equal(s.statuses, undefined, 'absent statuses stay absent (= all)');
  assert.equal(s.downloadPdf, false);
});

test('unusable progress → null', () => {
  assert.equal(deriveSyncSel(null, '2026-07-12'), null);
  assert.equal(deriveSyncSel({}, '2026-07-12'), null);
  assert.equal(deriveSyncSel(prog({ field: undefined }), '2026-07-12'), null);
  assert.equal(deriveSyncSel(prog({ to: undefined }), '2026-07-12'), null);
});

test('addDaysYmd: leap day and Egypt DST transition are calendar-exact', () => {
  assert.equal(addDaysYmd('2024-03-01', -1), '2024-02-29', 'leap year');
  assert.equal(addDaysYmd('2023-03-01', -1), '2023-02-28', 'non-leap');
  assert.equal(addDaysYmd('2026-04-23', 3), '2026-04-26', 'across the DST spring-forward window');
  assert.equal(addDaysYmd('2026-01-01', -3), '2025-12-29', 'year underflow');
});
