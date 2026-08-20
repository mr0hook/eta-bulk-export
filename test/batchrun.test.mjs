// SPEC-029 T-264/T-265 + SPEC-030 T-266 — the batched chunk pipeline: a chunk larger than one
// batch streams line rows to part files per batch (raw JSON never accumulates), keeps one
// continuous serial, and a flood of 403s fails the chunk instead of completing thin.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { fakeDir } from './fakefs.mjs';
import { invoices } from './fixtures.mjs';

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms, ...a) => realSetTimeout(fn, 0, ...a);
after(() => { globalThis.setTimeout = realSetTimeout; });

globalThis.window = { ExcelJS };
const lsBag = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsBag.has(k) ? lsBag.get(k) : null),
  setItem: (k, v) => lsBag.set(k, String(v)),
  removeItem: (k) => lsBag.delete(k),
  get length() { return lsBag.size; },
  key: (i) => [...lsBag.keys()][i] ?? null,
};

const { createOrchestrator } = await import('../src/core/orchestrator.js');
const { buildRows } = await import('../src/export/xlsx.js');

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (exp) => `h.${b64url({ exp })}.s`;
const TEST_RIN = '100000001';
const setToken = () => lsBag.set('USER_DATA', JSON.stringify({ access_token: jwt(Math.floor(Date.now() / 1000) + 7200), profile: { TaxRin: TEST_RIN } }));

const GOOD_DETAIL = invoices[0].detail;   // no `references` → no lookup traffic
const okResp = (body) => ({ status: 200, ok: true, json: async () => body, headers: { get: () => null } });

// A paged synthetic portal: N rows served through real Page/PageSize params, details by uuid.
// uuids beginning with F are FORBIDDEN (403) — the entity-flip signature.
function stubPagedFetch(n) {
  // uuids starting with F answer 403. `forbidden` lets a test set the exact share of a chunk.
  const forbidden = stubPagedFetch.forbidden != null ? stubPagedFetch.forbidden : (n === 60 ? 50 : 0);
  const rows = Array.from({ length: n }, (_, k) => ({ source: { uuid: (k < forbidden ? 'F' : 'U') + k, documentStatusEN: 'Valid' } }));
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/search')) {
      const p = new URL(u).searchParams;
      const page = parseInt(p.get('Page') || '1', 10), ps = parseInt(p.get('PageSize') || '100', 10);
      return okResp({ result: rows.slice((page - 1) * ps, page * ps), metadata: { totalCount: rows.length } });
    }
    if (u.includes('/details')) {
      const uuid = u.split('/documents/')[1].split('/details')[0];
      if (uuid.startsWith('F')) return { status: 403, ok: false, json: async () => ({}), headers: { get: () => null } };
      return okResp({ ...GOOD_DETAIL, uuid });
    }
    return okResp({});
  };
  return rows;
}

const mkPlan = (count, over = {}) => ({
  v: 1, key: 'batch_testkey', source: 'invoices', year: '2025', dir: 'Received', dateField: 'Issue',
  statuses: ['Valid', 'Invalid', 'Rejected', 'Cancelled'],
  from: '2025-01-01', to: '2025-01-31', cap: 10000, totalRows: count,
  chunks: [{ id: 'c1', label: '2025-01', count, fromISO: '2025-01-01T00:00:00Z', toISO: '2025-01-31T23:59:59Z' }],
  doneIds: [], failedIds: [], ...over,
});
function run(dir, plan) {
  const msgs = [];
  const orch = createOrchestrator({ onStatus: (m) => msgs.push(m) });
  orch.setFolder(dir);
  return orch.start(plan).then(() => msgs);
}
const progress = (dir) => { const k = [...dir.files.keys()].find((n) => /^eta_progress.*\.json$/.test(n)); return JSON.parse(new TextDecoder().decode(dir.files.get(k))); };
const loadSheet = async (dir, nm, i = 0) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await (await dir.getFileHandle(nm)).getFile()).arrayBuffer()); return wb.worksheets[i]; };

test('T-264 buildRows serialBase: batches of one chunk keep one continuous index', () => {
  const recs = [{ search: {}, detail: { ...GOOD_DETAIL, uuid: 'S1' } }, { search: {}, detail: { ...GOOD_DETAIL, uuid: 'S2' } }];
  const b = buildRows(recs, 'invoices', { serialBase: 7 });
  assert.equal(b.summaryRows[0].index, 8);
  assert.equal(b.summaryRows[1].index, 9);
  assert.equal(buildRows(recs, 'invoices', {}).summaryRows[0].index, 1, 'no base → unchanged');
});

test('T-265 a 4,500-doc chunk spans three batches but still lands in ONE file (SPEC-032)', async () => {
  // The batching exists for MEMORY (raw JSON never accumulates past one batch); it must not
  // fragment the output. 4,500 line rows is far under the inline budget, so this chunk writes one
  // workbook with real line rows — exactly what a pre-batching run produced.
  setToken();
  stubPagedFetch(4500);
  const dir = fakeDir();
  await run(dir, mkPlan(4500));

  assert.equal([...dir.files.keys()].filter((n) => /_det_p\d+\.xlsx$/i.test(n)).length, 0,
    'no part files: a batch boundary is not a reason to split a file');

  const summaryName = [...dir.files.keys()].find((n) => n.endsWith('.xlsx'));
  assert.ok(summaryName, 'the chunk workbook exists');
  const s0 = await loadSheet(dir, summaryName, 0);
  assert.equal(s0.actualRowCount - 1, 4500, 'all summary rows in one sheet');
  assert.equal(s0.getRow(2).values[1], 1, 'serial starts at 1');
  assert.equal(s0.getRow(4501).values[1], 4500, 'serial is continuous across batches');
  const s1 = await loadSheet(dir, summaryName, 1);
  assert.equal(s1.actualRowCount - 1, 4500, 'the lines sheet holds every line row inline');

  assert.deepEqual(progress(dir).doneIds, ['c1'], 'the chunk completed');
  assert.ok(![...dir.files.keys()].some((n) => n === 'eta_failures.jsonl'), 'no documents were dropped');
});

test('T-266 a flood of 403s FAILS the chunk (entity-flip signature) instead of completing thin', async () => {
  setToken();
  stubPagedFetch.forbidden = null;
  stubPagedFetch(60);   // 50 of 60 uuids answer 403 — like the 2026-08-19 chunk-7 flip (974/1086)
  const dir = fakeDir();
  const msgs = await run(dir, mkPlan(60));

  assert.ok(![...dir.files.keys()].some((n) => n.endsWith('.xlsx')), 'no chunk file — a thin completion is the failure mode this exists to stop');
  assert.deepEqual(progress(dir).failedIds, ['c1'], 'the chunk is marked failed so Resume retries it whole');
  assert.ok(msgs.some((m) => /403/.test(m)), 'the mass-403 diagnosis is stated in the log');
});

test('T-274 the 2026-08-20 chunk-31 case: 47% forbidden must FAIL, not write a thin chunk', async () => {
  // The real incident: 3,484 of 7,391 documents (47.1%) were refused after an entity flip, and the
  // old ">= half" rule let it through — the chunk was written with 3,907 rows and marked DONE, so
  // resume never retried it and 3,484 documents silently left the export.
  setToken();
  stubPagedFetch.forbidden = 47;      // 47 of 100 → 47%, just under the retired 50% threshold
  stubPagedFetch(100);
  const dir = fakeDir();
  const msgs = await run(dir, mkPlan(100));
  stubPagedFetch.forbidden = null;

  assert.ok(![...dir.files.keys()].some((n) => n.endsWith('.xlsx')), 'no thin chunk file is written');
  assert.deepEqual(progress(dir).failedIds, ['c1'], 'the chunk fails so a resume refetches it whole');
  assert.ok(msgs.some((m) => /403/.test(m)), 'and says why');
});

test('T-275 an ordinary trickle of 403s still completes the chunk', async () => {
  // The counterweight: genuine per-document denials (intermediary/marketplace submissions) arrive
  // in ones and fives. Those must never fail a chunk — they belong in eta_failures.jsonl.
  setToken();
  stubPagedFetch.forbidden = 6;       // 6 of 400 = 1.5%
  stubPagedFetch(400);
  const dir = fakeDir();
  await run(dir, mkPlan(400));
  stubPagedFetch.forbidden = null;

  assert.ok([...dir.files.keys()].some((n) => n.endsWith('.xlsx')), 'the chunk is written');
  assert.deepEqual(progress(dir).doneIds, ['c1'], 'and marked done');
  assert.ok([...dir.files.keys()].includes('eta_failures.jsonl'), 'the few refusals are recorded for the retry button');
});
