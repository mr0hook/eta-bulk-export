// SPEC-022b T-232..T-234 — the counterparty (RIN) filter on a range run: filter before details,
// era default for standalone lists, composition with the status filter, and the fail-loud rule
// when search rows carry no recognisable ids.
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

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (exp) => `h.${b64url({ exp })}.s`;
const TEST_RIN = '100000001';
const setToken = () => lsBag.set('USER_DATA', JSON.stringify({ access_token: jwt(Math.floor(Date.now() / 1000) + 7200), profile: { TaxRin: TEST_RIN } }));

const GOOD_DETAIL = invoices[0].detail;
const okResp = (body) => ({ status: 200, ok: true, json: async () => body, headers: { get: () => null } });

// 5 search rows with counterparty ids; U1/U3 belong to RIN 555000111 (issuer or receiver side).
const ROWS = [
  { source: { uuid: 'U1', documentStatusEN: 'Valid', issuerId: '555000111', receiverId: '999000999' } },
  { source: { uuid: 'U2', documentStatusEN: 'Valid', issuerId: '111000111', receiverId: '999000999' } },
  { source: { uuid: 'U3', documentStatusEN: 'Invalid', issuerId: '222000222', receiverId: '555000111' } },
  { source: { uuid: 'U4', documentStatusEN: 'Valid', issuerId: '333000333', receiverId: '999000999' } },
  { source: { uuid: 'U5', documentStatusEN: 'Cancelled', issuerId: '555000111', receiverId: '999000999' } },
];
function stubFetch(rows = ROWS) {
  const calls = { details: [] };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/search')) return okResp({ result: rows, metadata: { totalCount: rows.length } });
    if (u.includes('/details')) {
      const uuid = u.split('/documents/')[1].split('/details')[0];
      calls.details.push(uuid);
      return okResp({ ...GOOD_DETAIL, uuid });
    }
    return okResp({});
  };
  return calls;
}

const CHUNK = { id: 'c1', label: '2025-01', count: 5, fromISO: '2025-01-01T00:00:00Z', toISO: '2025-01-31T23:59:59Z' };
function makePlan(over = {}) {
  return {
    v: 1, key: 'rin_testkey', source: 'invoices', year: '2025', dir: 'Sent', dateField: 'Issue',
    statuses: ['Valid', 'Invalid', 'Rejected', 'Cancelled'],
    from: '2025-01-01', to: '2025-01-31', cap: 10000, totalRows: 5,
    chunks: [CHUNK], doneIds: [], failedIds: [], ...over,
  };
}
function run(dir, plan) {
  const msgs = [];
  const orch = createOrchestrator({ onStatus: (m) => msgs.push(m) });
  orch.setFolder(dir);
  return orch.start(plan).then(() => msgs);
}
const progress = (dir) => { const k = [...dir.files.keys()].find((n) => /^eta_progress.*\.json$/.test(n)); return JSON.parse(new TextDecoder().decode(dir.files.get(k))); };

test('T-232 details are fetched ONLY for rows matching the RIN list; the xlsx holds only matches', async () => {
  setToken();
  const calls = stubFetch();
  const dir = fakeDir();
  const msgs = await run(dir, makePlan({ rinFilter: ['555000111'] }));
  assert.deepEqual(calls.details.sort(), ['U1', 'U3', 'U5'], 'only the counterparty rows cost a details call');
  const name = [...dir.files.keys()].find((n) => n.endsWith('.xlsx'));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(dir.files.get(name).buffer);
  assert.equal(wb.worksheets[0].actualRowCount - 1, 3, 'summary holds exactly the matches');
  assert.equal(progress(dir).status, 'done');
  assert.ok(msgs.some((m) => m.includes('3 of 5')), 'the run says what matched');
});

test('T-233 a standalone RIN export spans the e-invoicing era and keys separately', async () => {
  setToken(); stubFetch();
  let req = null;
  const orch = createOrchestrator({
    onStatus: () => {},
    planner: async (r) => { req = r; return { jobId: 'j-era', chunks: [CHUNK] }; },
  });
  const p = await orch.plan({ source: 'invoices', field: 'Issue', dir: 'Sent', era: true, rinFilter: ['555000111'] });
  assert.equal(req.from, '2020-11-15', 'era start = the mandate rollout');
  assert.equal(req.to, new Date().toISOString().slice(0, 10), 'era end = today');
  assert.equal(p.year, 'era');
  assert.ok(p.key.includes('_rin'), 'a filtered run never shares a key with the unfiltered one');
  assert.deepEqual(p.rinFilter, ['555000111']);
});

test('T-234 status filter and RIN filter compose', async () => {
  setToken();
  const calls = stubFetch();
  const dir = fakeDir();
  // two statuses → client-side status filterSet; U5 (Cancelled) matches the RIN but not the status
  await run(dir, makePlan({ statuses: ['Valid', 'Invalid'], rinFilter: ['555000111'] }));
  assert.deepEqual(calls.details.sort(), ['U1', 'U3'], 'both predicates applied before details');
});

test('T-232 rows with NO recognisable counterparty ids fail the chunk loudly — never an empty export', async () => {
  setToken();
  stubFetch(ROWS.map((r) => ({ source: { uuid: r.source.uuid, documentStatusEN: r.source.documentStatusEN } })));
  const dir = fakeDir();
  const msgs = await run(dir, makePlan({ rinFilter: ['555000111'] }));
  assert.ok(![...dir.files.keys()].some((n) => n.endsWith('.xlsx')), 'no file written');
  assert.notEqual(progress(dir).status, 'done', 'the run does not claim success');
  assert.ok(msgs.some((m) => /counterparty ids|refusing to filter/i.test(m)), 'the reason is named');
});

test('T-236 a single-RIN run narrows server-side: probe and page URLs carry Query=<rin>', async () => {
  setToken();
  const urls = [];
  const realFetch = (() => { stubFetch(); return globalThis.fetch; })();
  globalThis.fetch = async (url) => { if (String(url).includes('/search')) urls.push(String(url)); return realFetch(url); };

  // probe path: a planner that actually uses deps.probe, as the real one does
  const orch = createOrchestrator({ onStatus: () => {}, planner: async (req, deps) => { await deps.probe('2025-01-01T00:00:00Z', '2025-01-31T23:59:59Z'); return { jobId: 'j', chunks: [CHUNK] }; } });
  await orch.plan({ source: 'invoices', field: 'Issue', dir: 'Sent', year: '2025', rinFilter: ['555000111'] });
  assert.ok(urls.length >= 1 && urls[0].includes('Query=555000111'), `probe carries Query, got ${urls[0]}`);

  // fetch path
  urls.length = 0;
  const dir = fakeDir();
  await run(dir, makePlan({ rinFilter: ['555000111'] }));
  assert.ok(urls.length >= 1 && urls.every((u) => u.includes('Query=555000111')), 'every page fetch carries Query');

  // two RINs → no server query (the portal takes one), client filter only
  urls.length = 0;
  const dir2 = fakeDir();
  await run(dir2, makePlan({ rinFilter: ['555000111', '111000111'] }));
  assert.ok(urls.length >= 1 && urls.every((u) => !u.includes('Query=')), 'multi-RIN stays un-narrowed');
});

// ── 2026-08-19 incident: the portal served 200 + correct totalCount + EMPTY result pages for
// ~7 minutes; 192 chunks were marked done with zero rows and no files. T-237/T-238 are the fix.
test('T-237 an unfiltered chunk that fetches ZERO rows against a >0 plan count FAILS, never completes', async () => {
  setToken();
  const calls = stubFetch([]);                       // every search page: 200, result []
  const dir = fakeDir();
  const msgs = await run(dir, makePlan());           // all 4 statuses, no RIN → unfiltered
  assert.equal(calls.details.length, 0);
  assert.ok(![...dir.files.keys()].some((n) => n.endsWith('.xlsx')), 'no file written');
  const p = progress(dir);
  assert.notEqual(p.status, 'done', 'the run must not claim success');
  assert.deepEqual(p.doneIds, [], 'the empty chunk is NOT recorded as done');
  assert.ok(msgs.some((m) => /empty page|re-probe/i.test(m)), 'the contradiction is named, with the re-probe count');
});

test('T-238 resume trusts only files for an unfiltered run — poisoned doneIds are dropped', async () => {
  setToken(); stubFetch();
  const dir = fakeDir();
  const orch = createOrchestrator({ onStatus: () => {} });
  orch.setFolder(dir);
  // a progress file poisoned exactly as the incident left it: chunks done, zero files in the folder
  const { writeProgress } = await import('../src/core/store.js');
  const poisoned = { ...makePlan(), doneIds: ['c1'], jobId: 'j-x' };
  await writeProgress(dir, poisoned, 'paused');
  const p = await orch.resume();
  assert.deepEqual(p.doneIds, [], 'file-less done chunks are retried, not skipped');

  // but a FILTERED run keeps its progress-file dones (legitimately-empty chunks have no file)
  const filtered = { ...makePlan(), key: 'rin_other', statuses: ['Valid'], rinFilter: ['555000111'], doneIds: ['c1'], jobId: 'j-y' };
  await writeProgress(dir, filtered, 'paused');
  const p2 = await orch.resume();
  assert.deepEqual(p2.doneIds, ['c1'], 'a filtered run keeps its recorded dones');
});

test('T-239 a mid-run taxpayer-PROFILE switch pauses the run before the next chunk', async () => {
  // Profiles can share a TaxRin and differ only in ProfId — the RIN guard sees nothing while the
  // portal answers for a different taxpayer. The run snapshots TaxRin:ProfId at start and pauses
  // (not halts) the moment it changes, so switching back + Resume continues exactly where it was.
  const mkUD = (prof) => JSON.stringify({ access_token: jwt(Math.floor(Date.now() / 1000) + 7200), profile: { TaxRin: TEST_RIN, ProfId: prof } });
  lsBag.set('USER_DATA', mkUD('P-1'));
  const calls = stubFetch();
  const dir = fakeDir();
  const CHUNK2 = { id: 'c2', label: '2025-02', count: 5, fromISO: '2025-02-01T00:00:00Z', toISO: '2025-02-28T23:59:59Z' };
  const plan = makePlan({ chunks: [CHUNK, CHUNK2], totalRows: 10 });
  const msgs = [];
  const orch = createOrchestrator({
    onStatus: (m) => msgs.push(m),
    // flip the ACTIVE PROFILE (same TaxRin!) once the first chunk reports progress
    onProgress: () => lsBag.set('USER_DATA', mkUD('P-2')),
  });
  orch.setFolder(dir);
  await orch.start(plan);
  const p = progress(dir);
  assert.equal(p.status, 'paused', 'paused, not halted — switch back and Resume');
  assert.deepEqual(p.doneIds, ['c1'], 'the finished chunk stays finished');
  assert.ok([...calls.details].every((u) => ['U1','U2','U3','U4','U5'].includes(u)), 'chunk 2 was never fetched');
  assert.ok(msgs.some((m) => /profile changed|الملف الضريبى/.test(m)), 'the reason is named');
});

test('T-298 resume subtracts shortIds even though the file-scan calls them done', async () => {
  // T-238 above pins the rule that makes this necessary: for an unfiltered run resume REBUILDS
  // doneIds from file PRESENCE and discards the progress file's list. So a chunk whose file exists
  // but holds a fraction of its documents — Q2 2024 had one with 9 rows of a planned 7,052 — counted
  // as done for ever, and editing doneIds could not change it. shortIds is the one list resume must
  // honour over the files on disk.
  setToken(); stubFetch();
  const { writeProgress, readProgress, markShortChunks, chunkFile } = await import('../src/core/store.js');
  const dir = fakeDir();
  // confirmFolder: the folder already holds an xlsx, so SPEC-010 asks who owns it before resuming.
  const orch = createOrchestrator({ onStatus: () => {}, confirmFolder: async () => true });
  orch.setFolder(dir);

  const plan = { ...makePlan(), key: 'short_run', doneIds: [CHUNK.id], jobId: 'j-s' };
  // The chunk FILE exists — this is the case that used to be unfixable, because scanDoneFromFolder
  // reads presence, not contents.
  const fh = await dir.getFileHandle(chunkFile(plan, CHUNK), { create: true });
  const w = await fh.createWritable(); await w.write(new Uint8Array([1])); await w.close();
  await writeProgress(dir, plan, 'complete');
  assert.deepEqual((await orch.resume()).doneIds, [CHUNK.id], 'baseline: the file alone makes it done');

  // now the merge records it as short, exactly as reconcile() does
  const pn = [...dir.files.keys()].find((n) => /^eta_progress/.test(n));
  assert.equal(await markShortChunks(dir, pn, [CHUNK.id]), true);
  const p = await orch.resume();
  assert.deepEqual(p.doneIds, [], 'the short chunk is not done, whatever the folder scan says');
  assert.deepEqual(p.shortIds, [CHUNK.id], 'and the list rides along so a later write can clear it');

  // self-clearing: once the chunk really is fetched, the next progress write drops it
  await writeProgress(dir, { ...p, doneIds: [CHUNK.id] }, 'done');
  const back = await readProgress(dir, p);
  assert.deepEqual(back.shortIds, [], 'a refetched chunk stops being short');
});
