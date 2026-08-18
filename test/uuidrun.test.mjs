// SPEC-022 T-224..T-228 — the uuid-mode run loop: no search, details drive everything, missed
// uuids stay visible, resume skips finished batches, and a list-less plan refuses to run.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { fakeDir } from './fakefs.mjs';
import { invoices } from './fixtures.mjs';
import { chunkFile } from '../src/core/store.js';

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

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (exp) => `h.${b64url({ exp })}.s`;
const TEST_RIN = '100000001';
const setToken = () => lsBag.set('USER_DATA', JSON.stringify({ access_token: jwt(Math.floor(Date.now() / 1000) + 7200), profile: { TaxRin: TEST_RIN } }));

const GOOD_DETAIL = invoices[0].detail;
const okResp = (body) => ({ status: 200, ok: true, json: async () => body, headers: { get: () => null } });
const notFound = { status: 404, ok: false, json: async () => ({}), headers: { get: () => null } };

// details+pdf only — uuid mode must never search. missing: uuids that 404 on BOTH endpoints.
function stubFetch({ missing = new Set(), pdfMissing = new Set() } = {}) {
  const calls = { search: 0, details: [], pdf: [] };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/search')) { calls.search++; return okResp({ result: [], metadata: { totalCount: 0 } }); }
    if (/\/pdf$/.test(u)) {
      const uuid = u.split('/documents/')[1].split('/pdf')[0];
      calls.pdf.push(uuid);
      if (pdfMissing.has(uuid) || missing.has(uuid)) return notFound;
      return { status: 200, ok: true, blob: async () => new Blob(['%PDF-1.4 test']), headers: { get: () => null } };
    }
    if (u.includes('/details')) {
      const uuid = u.split('/documents/')[1].split('/details')[0];
      calls.details.push(uuid);
      if (missing.has(uuid)) return notFound;
      return okResp({ ...GOOD_DETAIL, uuid });
    }
    return okResp({});
  };
  return calls;
}

const UU = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => ('U' + String(a + i).padStart(25, '0')).slice(0, 26));
function makeUuidPlan(over = {}) {
  const c1 = { id: 'uuids_0', label: 'UUIDs 1-3', count: 3, uuids: UU(1, 3) };
  const c2 = { id: 'uuids_1', label: 'UUIDs 4-5', count: 2, uuids: UU(4, 5) };
  return {
    v: 1, mode: 'uuids', key: 'uuids_testkey', source: 'invoices', year: '2026', dir: 'uuids',
    dateField: 'Uuid', statuses: ['Valid', 'Invalid', 'Rejected', 'Cancelled'],
    from: '', to: '', cap: 10000, totalRows: 5, chunks: [c1, c2], doneIds: [], failedIds: [], ...over,
  };
}

function run(dir, plan) {
  const msgs = [];
  const orch = createOrchestrator({ onStatus: (m) => msgs.push(m) });
  orch.setFolder(dir);
  return orch.start(plan).then(() => msgs);
}
const progress = (dir) => { const k = [...dir.files.keys()].find((n) => /^eta_progress.*\.json$/.test(n)); return JSON.parse(new TextDecoder().decode(dir.files.get(k))); };
const failuresText = (dir) => (dir.files.has('eta_failures.jsonl') ? new TextDecoder().decode(dir.files.get('eta_failures.jsonl')) : '');
const loadWb = async (dir, name) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(dir.files.get(name).buffer); return wb; };

test('T-224 uuid run: no search, one xlsx per batch under the Uuid prefix, progress done', async () => {
  setToken();
  const calls = stubFetch();
  const dir = fakeDir();
  const plan = makeUuidPlan();
  const msgs = await run(dir, plan);
  const f1 = chunkFile(plan, plan.chunks[0]), f2 = chunkFile(plan, plan.chunks[1]);
  assert.ok(f1.startsWith('eInvoicesUuid_'), `uuid chunk files carry their own prefix, got ${f1}`);
  assert.ok(dir.files.has(f1) && dir.files.has(f2), 'both batch files written');
  assert.equal(calls.search, 0, 'a uuid run never touches /search');
  assert.deepEqual([...calls.details].sort(), UU(1, 5), 'exactly the pasted uuids were fetched');
  const p = progress(dir);
  assert.equal(p.status, 'done'); assert.equal(p.mode, 'uuids');
  assert.deepEqual(p.doneIds.sort(), ['uuids_0', 'uuids_1']);
  assert.ok(p.chunks[0].uuids.length === 3, 'the progress file carries the list — it is the only durable copy');
  assert.ok(msgs.at(-1).includes('✅'), 'clean finish');
});

test('T-225 a missing uuid lands on the Missed sheet and in the failures log; the chunk still completes', async () => {
  setToken();
  const missUuid = UU(2, 2)[0];
  stubFetch({ missing: new Set([missUuid]) });
  const dir = fakeDir();
  const plan = makeUuidPlan();
  const msgs = await run(dir, plan);
  const p = progress(dir);
  assert.equal(p.status, 'done', 'a conclusive not-found never fails the run');
  assert.deepEqual(p.doneIds.sort(), ['uuids_0', 'uuids_1']);
  const wb = await loadWb(dir, chunkFile(plan, plan.chunks[0]));
  const missed = wb.worksheets.find((w) => w.name === 'Missed');
  assert.ok(missed, 'the batch file carries a Missed sheet');
  assert.equal(missed.getRow(2).getCell(1).value, missUuid);
  assert.ok(failuresText(dir).includes(missUuid), 'durable failures log names it too');
  assert.ok(msgs.at(-1).includes('Missed') || msgs.at(-1).includes('1'), 'summary mentions the miss');
});

test('T-225 an all-missing batch still completes (header-only file + full Missed sheet)', async () => {
  setToken();
  stubFetch({ missing: new Set(UU(1, 3)) });
  const dir = fakeDir();
  const plan = makeUuidPlan();
  await run(dir, plan);
  const p = progress(dir);
  assert.equal(p.status, 'done');
  const wb = await loadWb(dir, chunkFile(plan, plan.chunks[0]));
  const missed = wb.worksheets.find((w) => w.name === 'Missed');
  assert.equal(missed.actualRowCount - 1, 3, 'all three uuids on the Missed sheet');
});

test('T-226 downloadPdf: official PDFs land under pdfs/, one failure is logged and never fails the batch', async () => {
  setToken();
  const pdfMiss = UU(4, 4)[0];
  const calls = stubFetch({ pdfMissing: new Set([pdfMiss]) });
  const dir = fakeDir();
  const plan = makeUuidPlan({ downloadPdf: true });
  await run(dir, plan);
  assert.deepEqual([...calls.pdf].sort(), UU(1, 5), 'a PDF was asked for every uuid');
  const pdfNames = [...(dir.subs.get('pdfs')?.files.keys() ?? [])];
  assert.equal(pdfNames.length, 4, '4 of 5 PDFs saved');
  assert.ok(pdfNames.every((n) => n.endsWith('.pdf')));
  assert.ok(failuresText(dir).includes(pdfMiss), 'the missing PDF is in the failures log');
  assert.equal(progress(dir).status, 'done');
});

test('T-227 resume: a finished batch is never refetched', async () => {
  setToken();
  const calls = stubFetch();
  const dir = fakeDir();
  const plan = makeUuidPlan({ doneIds: ['uuids_0'] });
  await run(dir, plan);
  assert.deepEqual([...calls.details].sort(), UU(4, 5), 'only the second batch was fetched');
  assert.equal(progress(dir).status, 'done');
});

test('T-228 a uuid plan whose chunks lost their lists refuses to run — loudly, before any write', async () => {
  setToken();
  const calls = stubFetch();
  const dir = fakeDir();
  const plan = makeUuidPlan();
  plan.chunks = plan.chunks.map(({ uuids, ...c }) => c);   // what /job/plan alone would hand back
  const msgs = await run(dir, plan);
  assert.equal(calls.details.length, 0, 'nothing fetched');
  assert.ok(![...dir.files.keys()].some((n) => n.endsWith('.xlsx')), 'nothing written');
  assert.ok(msgs.some((m) => m.includes('❌')), 'the refusal is explicit');
});
