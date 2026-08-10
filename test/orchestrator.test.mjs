// End-to-end run-loop tests: drive createOrchestrator().start() against a stubbed fetch + fake
// folder + real ExcelJS, and assert the robustness invariants directly on the files that land in
// the folder. Covers the paths unit tests can't: dropped-detail durability, total-failure retry,
// and the proactive token pause. Timers are made instant so all backoffs collapse.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { fakeDir } from './fakefs.mjs';
import { invoices } from './fixtures.mjs';
import { chunkFile } from '../src/core/store.js';

// --- instant timers (skip apiGet backoff + inter-chunk sleeps) ---
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms, ...a) => realSetTimeout(fn, 0, ...a);
after(() => { globalThis.setTimeout = realSetTimeout; });

// --- browser globals the run loop expects ---
globalThis.window = { ExcelJS }; // renderWorkbook reads window.ExcelJS; no AudioContext → keepalive is inert
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
// A real portal session always carries the logged-in taxpayer's TaxRin; SPEC-010's folder guard
// refuses to write into a folder it can't attribute, so the fixture has to model that.
const TEST_RIN = '100000001';
const setTokenMinutes = (mins) => lsBag.set('USER_DATA', JSON.stringify({ access_token: jwt(Math.floor(Date.now() / 1000) + mins * 60), profile: { TaxRin: TEST_RIN } }));

const GOOD_DETAIL = invoices[0].detail;
const okResp = (body) => ({ status: 200, ok: true, json: async () => body, headers: { get: () => null } });
const badResp = (status) => ({ status, ok: false, json: async () => ({}), headers: { get: () => null } });

// 5-row single-page chunk; fail the /details fetch for any uuid in failUuids.
function stubFetch({ nRows = 5, failUuids = new Set() } = {}) {
  const rows = Array.from({ length: nRows }, (_, k) => ({ source: { uuid: 'U' + k, documentStatusEN: 'Valid' } }));
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/search')) return okResp({ result: rows, metadata: { totalCount: rows.length } });
    if (/\/pdf$/.test(u)) return { status: 200, ok: true, blob: async () => new Blob(['%PDF-1.4 test']), headers: { get: () => null } };
    if (u.includes('/details')) {
      const uuid = u.split('/documents/')[1].split('/details')[0];
      if (failUuids.has(uuid)) return badResp(500); // retryable → apiGet exhausts → fetchDetails throws
      return okResp({ ...GOOD_DETAIL, uuid });
    }
    return okResp({});
  };
}

const CHUNK = { id: 'c1', label: '2025-01', count: 5, fromISO: '2025-01-01T00:00:00Z', toISO: '2025-01-31T23:59:59Z' };
function makePlan(over = {}) {
  return {
    v: 1, key: 'testkey', source: 'invoices', year: '2025', dir: 'Sent', dateField: 'Issue',
    statuses: ['Valid', 'Invalid', 'Rejected', 'Cancelled'], // ALL → no client-side status filter
    from: '2025-01-01', to: '2025-01-31', cap: 10000, totalRows: 5,
    chunks: [CHUNK], doneIds: [], failedIds: [], ...over,
  };
}
const CHUNK_FILE = chunkFile(makePlan(), CHUNK); // eInvoices_2025_Sent_2025-01.xlsx

function run(dir, plan) {
  const msgs = [];
  const orch = createOrchestrator({ onStatus: (m) => msgs.push(m) });
  orch.setFolder(dir);
  return orch.start(plan).then(() => msgs);
}
const progress = (dir) => { const k = [...dir.files.keys()].find((n) => /^eta_progress.*\.json$/.test(n)); return JSON.parse(new TextDecoder().decode(dir.files.get(k))); };
const failuresText = (dir) => (dir.files.has('eta_failures.jsonl') ? new TextDecoder().decode(dir.files.get('eta_failures.jsonl')) : '');

test('happy path: all details succeed → one xlsx, no failures log, chunk done', async () => {
  setTokenMinutes(120); stubFetch();
  const dir = fakeDir();
  const msgs = await run(dir, makePlan());
  assert.ok(dir.files.has(CHUNK_FILE), 'chunk xlsx written');
  assert.equal(failuresText(dir), '', 'no failures log when nothing dropped');
  const p = progress(dir);
  assert.equal(p.status, 'done'); assert.deepEqual(p.doneIds, ['c1']);
  assert.ok(msgs.at(-1).includes('✅') && msgs.at(-1).includes('1/1'), 'completes');
  assert.ok(!msgs.at(-1).includes('⚠️'), 'no drop warning');
});

// The run used to report itself to the backend only AFTER a chunk finished, so a resumed export sat
// on the portal in the state it was interrupted in — "paused" for as long as the first chunk took,
// with a stale updated_at for the stuck detector to judge it by. The checkpoint now leads the work.
// (What it ships — the per-chunk snapshot — is covered by store.chunkStates; this is the ordering.)
test('a run reports itself running BEFORE it fetches, not after the first chunk lands', async () => {
  setTokenMinutes(120);
  const dir = fakeDir();
  let atFirstFetch = 'never fetched';
  const realFetch = (() => { stubFetch(); return globalThis.fetch; })();
  globalThis.fetch = async (url) => {
    if (String(url).includes('/search') && atFirstFetch === 'never fetched') {
      atFirstFetch = progress(dir)?.status ?? 'no progress file yet';
    }
    return realFetch(url);
  };
  await run(dir, makePlan());
  assert.equal(atFirstFetch, 'running', 'the folder — and so the checkpoint — said running before a byte moved');
});

test('a resumed run checkpoints at the chunk it picks up, not once that chunk completes', async () => {
  setTokenMinutes(120);
  const dir = fakeDir();
  const CHUNK2 = { id: 'c2', label: '2025-02', count: 5, fromISO: '2025-02-01T00:00:00Z', toISO: '2025-02-28T23:59:59Z' };
  // c1 already done, as a resume hands it over: the loop skips it with `continue` and must still
  // report before working c2 — skipping a chunk is not progress the backend can see.
  const plan = makePlan({ chunks: [CHUNK, CHUNK2], doneIds: ['c1'], totalRows: 10 });
  let atFirstFetch = 'never fetched';
  const realFetch = (() => { stubFetch(); return globalThis.fetch; })();
  globalThis.fetch = async (url) => {
    if (String(url).includes('/search') && atFirstFetch === 'never fetched') atFirstFetch = progress(dir)?.status ?? 'no progress file yet';
    return realFetch(url);
  };
  await run(dir, plan);
  assert.equal(atFirstFetch, 'running', 'reported before the resumed chunk was worked');
  const p = progress(dir);
  assert.equal(p.status, 'done');
  assert.deepEqual([...p.doneIds].sort(), ['c1', 'c2'], 'the skipped chunk stays done');
});

test('partial drop: 1 detail fails → xlsx written, UUID durably logged, chunk still done', async () => {
  setTokenMinutes(120); stubFetch({ failUuids: new Set(['U2']) });
  const dir = fakeDir();
  const msgs = await run(dir, makePlan());
  assert.ok(dir.files.has(CHUNK_FILE), 'chunk xlsx still written with the rows we got');
  assert.match(failuresText(dir), /"uuid":"U2"/, 'dropped UUID recorded in eta_failures.jsonl');
  const p = progress(dir);
  assert.equal(p.status, 'done'); assert.deepEqual(p.doneIds, ['c1'], 'chunk marked done (drop is logged)');
  assert.ok(msgs.at(-1).includes('⚠️') && msgs.at(-1).includes('1 document'), 'completion tallies the drop');
});

test('DURABILITY: failures-log write fails → chunk file removed, chunk NOT marked done (no silent drop)', async () => {
  setTokenMinutes(120); stubFetch({ failUuids: new Set(['U2']) });
  const dir = fakeDir();
  // simulate the user having eta_failures.jsonl open/locked: any handle to it throws
  const realGFH = dir.getFileHandle.bind(dir);
  dir.getFileHandle = async (name, opts) => {
    if (name === 'eta_failures.jsonl') throw new Error('NoModificationAllowedError');
    return realGFH(name, opts);
  };
  const msgs = await run(dir, makePlan());
  assert.ok(!dir.files.has(CHUNK_FILE), 'chunk file was REMOVED because the drop could not be logged');
  const p = progress(dir);
  assert.ok(!p.doneIds.includes('c1'), 'chunk NOT marked done → resume will retry it');
  assert.deepEqual(p.failedIds, ['c1'], 'chunk recorded as failed');
  assert.ok(msgs.some((m) => m.includes('could not record')), 'surfaces the logging failure');
});

test('total failure: every detail fails → no empty file, chunk failed & resumable', async () => {
  setTokenMinutes(120); stubFetch({ failUuids: new Set(['U0', 'U1', 'U2', 'U3', 'U4']) });
  const dir = fakeDir();
  const msgs = await run(dir, makePlan());
  assert.ok(!dir.files.has(CHUNK_FILE), 'no empty/partial xlsx written on total failure');
  assert.equal(failuresText(dir), '', 'total failure retries the chunk rather than logging drops');
  const p = progress(dir);
  assert.ok(!p.doneIds.includes('c1') && p.failedIds.includes('c1'), 'chunk failed, not done');
  assert.ok(msgs.some((m) => m.includes('all 5 detail fetches failed')), 'reports the total failure');
});

test('downloadPdf: official PDF saved to pdfs/ subfolder for every row, xlsx still written', async () => {
  setTokenMinutes(120); stubFetch();
  const dir = fakeDir();
  await run(dir, makePlan({ downloadPdf: true }));
  assert.ok(dir.files.has(CHUNK_FILE), 'xlsx export still produced');
  const pdfs = await dir.getDirectoryHandle('pdfs');
  assert.equal(pdfs.files.size, 5, 'one official PDF per row saved to pdfs/');
  assert.ok([...pdfs.files.keys()].every((n) => n.endsWith('.pdf')), 'all are .pdf files');
});

test('guard: a failing RIN guard halts before exporting anything (no chunk file)', async () => {
  setTokenMinutes(120); stubFetch();
  const dir = fakeDir();
  const msgs = [];
  const orch = createOrchestrator({ onStatus: (m) => msgs.push(m), guard: async () => false });
  orch.setFolder(dir);
  await orch.start(makePlan());
  assert.ok(!dir.files.has(CHUNK_FILE), 'nothing exported when the logged-in RIN fails the guard');
  assert.ok(msgs.some((m) => m.includes('no longer matches your registration')), 'halts with the mismatch message');
});

test('token: near-expiry token does NOT pause — the portal renews it silently, so the run proceeds', async () => {
  setTokenMinutes(3); stubFetch(); // v1 parity: exp time-left is never a reason to stop
  const dir = fakeDir();
  const msgs = await run(dir, makePlan());
  assert.ok(dir.files.has(CHUNK_FILE), 'chunk exported despite a token near expiry');
  assert.equal(progress(dir).status, 'done');
  assert.ok(!msgs.some((m) => m.includes('waiting') || m.includes('Paus')), 'no wait/pause messages');
});

test('token: expired token, never renewed → waits for renewal, then pauses; nothing fetched', async () => {
  setTokenMinutes(-5); stubFetch(); // already expired → ok:false
  const dir = fakeDir();
  const msgs = await run(dir, makePlan());
  assert.ok(!dir.files.has(CHUNK_FILE), 'no chunk started without a usable token');
  assert.equal(progress(dir).status, 'auth_expired');
  assert.ok(msgs.some((m) => m.includes('waiting for the portal to renew')), 'announces the renewal wait');
  assert.ok(msgs.some((m) => m.includes('no fresh token appeared') && m.includes('Re-login')), 'pauses with re-login guidance only after the wait times out');
});

const statsBag = () => JSON.parse(lsBag.get('etaBulk_stats') || 'null');

test('telemetry: completed run bumps etaBulk_stats runs/docs (no pdfs when off)', async () => {
  lsBag.delete('etaBulk_stats'); setTokenMinutes(120); stubFetch();
  await run(fakeDir(), makePlan());
  assert.deepEqual({ ...statsBag(), lastExportAt: '' }, { runs: 1, docs: 5, pdfs: 0, lastExportAt: '' });
  assert.ok(statsBag().lastExportAt, 'stamps the export time');
});

test('telemetry: pdf run counts saved PDFs', async () => {
  lsBag.delete('etaBulk_stats'); setTokenMinutes(120); stubFetch();
  await run(fakeDir(), makePlan({ downloadPdf: true }));
  assert.equal(statsBag().pdfs, 5);
});

test('telemetry: resume counts only newly fetched rows', async () => {
  lsBag.delete('etaBulk_stats'); setTokenMinutes(120); stubFetch();
  const C2 = { id: 'c2', label: '2025-02', count: 5, fromISO: '2025-02-01T00:00:00Z', toISO: '2025-02-28T23:59:59Z' };
  await run(fakeDir(), makePlan({ chunks: [CHUNK, C2], doneIds: [CHUNK.id], totalRows: 10 }));
  assert.equal(statsBag().docs, 5, 'the already-done chunk is not re-counted');
  assert.equal(statsBag().runs, 1);
});

test('telemetry: a paused run does not bump stats', async () => {
  lsBag.delete('etaBulk_stats'); setTokenMinutes(-5); stubFetch();   // expired, never renewed → waits then pauses
  await run(fakeDir(), makePlan());
  assert.equal(statsBag(), null, 'no counters for a run that never finished');
});

test('onStatus meta: terminal + level on completion, kind on per-page progress (drives log coalescing)', async () => {
  setTokenMinutes(120); stubFetch();
  const dir = fakeDir(); const pairs = [];
  const orch = createOrchestrator({ onStatus: (m, meta) => pairs.push([m, meta]) });
  orch.setFolder(dir);
  await orch.start(makePlan());
  const fin = pairs.find(([m]) => m.startsWith('✅'));
  assert.ok(fin && fin[1] && fin[1].terminal === true && fin[1].level === 'ok', 'completion status carries {terminal, level:ok}');
  const page = pairs.find(([m]) => /fetching \d+\/\d+/.test(m));
  assert.ok(page && page[1] && page[1].kind === 'page' && page[1].level === 'run', 'per-page lines carry kind:page');
});

test('onStatus meta: 429 wait lines carry kind:rate + level:wait', async () => {
  setTokenMinutes(120); stubFetch();
  const orig = globalThis.fetch; let first = true;   // one 429 on the first /search page, then normal
  globalThis.fetch = async (u) => {
    if (first && String(u).includes('/search')) { first = false; return { status: 429, ok: false, json: async () => ({}), headers: { get: (h) => (h === 'Retry-After' ? '0' : null) } }; }
    return orig(u);
  };
  const dir = fakeDir(); const pairs = [];
  const orch = createOrchestrator({ onStatus: (m, meta) => pairs.push([m, meta]) });
  orch.setFolder(dir);
  await orch.start(makePlan());
  const rate = pairs.find(([m]) => m.includes('Rate-limited'));
  assert.ok(rate && rate[1] && rate[1].kind === 'rate' && rate[1].level === 'wait', '429 backoff line is a coalescible wait');
  assert.ok(dir.files.has(CHUNK_FILE), 'run still completes after the 429');
});

test('token: expired token renewed while waiting → continues automatically to completion', async () => {
  setTokenMinutes(-5); stubFetch();
  const dir = fakeDir();
  const msgs = [];
  const orch = createOrchestrator({ onStatus: (m) => { msgs.push(m); if (m.includes('waiting for the portal to renew')) setTokenMinutes(120); } }); // portal renews mid-wait
  orch.setFolder(dir);
  await orch.start(makePlan());
  assert.ok(dir.files.has(CHUNK_FILE), 'run continued and exported the chunk');
  assert.equal(progress(dir).status, 'done');
  assert.ok(msgs.some((m) => m.includes('Token renewed')), 'reports the automatic continuation');
});
