// SPEC-034 T-276/T-277 — resume a run from the folder's own progress file, with no server job.
//
// The 2026-08-20 lockout showed the gap: server jobs are device-scoped, so when this browser's
// device identity changed, /job/resumable stopped offering a run whose complete plan was sitting
// in the export folder the whole time. 37 of 38 chunks were on disk and unreachable from the UI.
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
const { writeProgress } = await import('../src/core/store.js');

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (exp) => `h.${b64url({ exp })}.s`;
const TEST_RIN = '100000001';
const setToken = () => lsBag.set('USER_DATA', JSON.stringify({ access_token: jwt(Math.floor(Date.now() / 1000) + 7200), profile: { TaxRin: TEST_RIN } }));

const GOOD = invoices[0].detail;
const okResp = (b) => ({ status: 200, ok: true, json: async () => b, headers: { get: () => null } });
function stubFetch(rowsPerChunk = 2) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/search')) {
      const rows = Array.from({ length: rowsPerChunk }, (_, i) => ({ source: { uuid: 'U' + i + '_' + (u.match(/IssueDateFrom=([^&]+)/) || [])[1], documentStatusEN: 'Valid' } }));
      return okResp({ result: rows, metadata: { totalCount: rows.length } });
    }
    if (u.includes('/details')) return okResp({ ...GOOD, uuid: u.split('/documents/')[1].split('/details')[0] });
    return okResp({});
  };
}

const CHUNKS = [
  { id: 'a', label: '2025-01', count: 2, fromISO: '2025-01-01T00:00:00Z', toISO: '2025-01-31T21:59:59Z' },
  { id: 'b', label: '2025-02', count: 2, fromISO: '2025-02-01T00:00:00Z', toISO: '2025-02-28T21:59:59Z' },
];
const basePlan = (over = {}) => ({
  v: 1, key: '2025_Sent_Issue_2025-01-01_2025-02-28', source: 'invoices', year: '2025', dir: 'Sent', dateField: 'Issue',
  statuses: ['Valid', 'Invalid', 'Rejected', 'Cancelled'], from: '2025-01-01', to: '2025-02-28',
  cap: 10000, totalRows: 4, chunks: CHUNKS, doneIds: [], failedIds: [],
  excludeColumns: ['signature'], downloadPdf: false, ...over,
});

test('T-276 resume() rebuilds a runnable plan from the folder alone — no server job involved', async () => {
  setToken(); stubFetch();
  const dir = fakeDir();
  // A run interrupted after chunk "a": the progress file names a job this device can no longer
  // claim server-side, which is exactly the state the lockout left behind.
  await writeProgress(dir, basePlan({ jobId: 'job-owned-by-a-dead-device', doneIds: ['a'] }), 'paused');

  const orch = createOrchestrator({ onStatus: () => {} });
  orch.setFolder(dir);
  const p = await orch.resume();

  assert.ok(p, 'a plan came back from the folder with no backend call');
  assert.equal(p.chunks.length, 2, 'the server-minted chunk list is preserved');
  assert.equal(p.source, 'invoices');
  assert.equal(p.dir, 'Sent');
  assert.deepEqual(p.excludeColumns, ['signature'], 'the column choices the server never stored survive');
  assert.equal(p.downloadPdf, false);
  assert.deepEqual(p.doneIds, [], 'no chunk FILES on disk → the recorded done is healed away and refetched');
});

test('T-277 a folder-resumed run completes and writes its chunks even though every checkpoint fails', async () => {
  // There is no bridge in the test environment, so every server checkpoint fails exactly as it
  // would for a job this device no longer owns. The export must not care.
  setToken(); stubFetch();
  const dir = fakeDir();
  await writeProgress(dir, basePlan({ jobId: 'job-owned-by-a-dead-device' }), 'paused');

  const orch = createOrchestrator({ onStatus: () => {} });
  orch.setFolder(dir);
  const p = await orch.resume();
  await orch.start(p);

  const files = [...dir.files.keys()].filter((n) => n.endsWith('.xlsx'));
  assert.equal(files.length, 2, 'both chunks were exported');
  const prog = JSON.parse(new TextDecoder().decode(dir.files.get([...dir.files.keys()].find((n) => /^eta_progress.*\.json$/.test(n)))));
  assert.equal(prog.doneIds.length, 2, 'and recorded as done in the folder');
  assert.equal(prog.failedIds.length, 0, 'with nothing failed');
});
