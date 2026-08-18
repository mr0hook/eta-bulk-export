// SPEC-023 T-241..T-244 — entity pinning: a run switches ITSELF back after an entity flip
// (our own session renewal is the usual culprit on a multi-entity login) and pauses only when
// restoration genuinely fails.
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
const { switchTaxpayer } = await import('../src/api/client.js');
const { API_ORIGIN } = await import('../src/api/sources.js');

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (exp) => `h.${b64url({ exp })}.s`;
const TEST_RIN = '100000001';
const UD = (prof, taxId) => JSON.stringify({ access_token: jwt(Math.floor(Date.now() / 1000) + 7200), profile: { TaxRin: TEST_RIN, ProfId: prof, TaxId: taxId } });

const GOOD_DETAIL = invoices[0].detail;
const okResp = (body) => ({ status: 200, ok: true, json: async () => body, headers: { get: () => null } });

// details+search stub; onSwitch decides what a PUT to switchtaxpayer does.
function stubFetch({ onSwitch = () => true } = {}) {
  const calls = { details: [], switches: [] };
  const rows = Array.from({ length: 3 }, (_, k) => ({ source: { uuid: 'U' + k, documentStatusEN: 'Valid' } }));
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/switchtaxpayer')) {
      calls.switches.push(JSON.parse(opts.body));
      const ok = onSwitch(calls.switches.length);
      return { status: ok ? 200 : 400, ok, redirected: false, json: async () => ({ isSuccess: ok }) };
    }
    if (u.includes('/search')) return okResp({ result: rows, metadata: { totalCount: rows.length } });
    if (u.includes('/details')) { const uuid = u.split('/documents/')[1].split('/details')[0]; calls.details.push(uuid); return okResp({ ...GOOD_DETAIL, uuid }); }
    return okResp({});
  };
  return calls;
}

const CH = (i) => ({ id: 'c' + i, label: '2025-0' + i, count: 3, fromISO: `2025-0${i}-01T00:00:00Z`, toISO: `2025-0${i}-28T23:59:59Z` });
const makePlan = (n, over = {}) => ({
  v: 1, key: 'pin_testkey', source: 'invoices', year: '2025', dir: 'Sent', dateField: 'Issue',
  statuses: ['Valid', 'Invalid', 'Rejected', 'Cancelled'], from: '2025-01-01', to: '2025-06-30',
  cap: 10000, totalRows: 3 * n, chunks: Array.from({ length: n }, (_, k) => CH(k + 1)), doneIds: [], failedIds: [], ...over,
});
const progress = (dir) => { const k = [...dir.files.keys()].find((n) => /^eta_progress.*\.json$/.test(n)); return JSON.parse(new TextDecoder().decode(dir.files.get(k))); };

test('T-241 switchTaxpayer: exact portal contract, numeric body, refusals resolve false', async () => {
  lsBag.set('USER_DATA', UD('P-1', '4711'));
  let seen = null;
  globalThis.fetch = async (url, opts) => { seen = { url: String(url), method: opts.method, ct: opts.headers['Content-Type'], body: opts.body }; return { status: 200, ok: true, redirected: false, json: async () => ({ isSuccess: true }) }; };
  assert.equal(await switchTaxpayer('4711'), true);
  assert.equal(seen.url, API_ORIGIN + '/Api/v1/users/current/switchtaxpayer');
  assert.equal(seen.method, 'PUT');
  assert.equal(seen.ct, 'application/json-patch+json');
  assert.deepEqual(JSON.parse(seen.body), { taxpayerId: 4711 }, 'numeric, as the portal sends it');
  assert.equal(await switchTaxpayer(''), false, 'no taxId → false, never a throw');
  assert.equal(await switchTaxpayer('abc'), false);
  globalThis.fetch = async () => ({ status: 400, ok: false, redirected: false, json: async () => ({}) });
  assert.equal(await switchTaxpayer('4711'), false, 'a refusal is false, the caller pauses');
});

test('T-242 a mid-run flip is healed: switch back + renewed stamp → the run continues', async () => {
  lsBag.set('USER_DATA', UD('P-1', '4711'));
  const calls = stubFetch({ onSwitch: () => { lsBag.set('USER_DATA', UD('P-1', '4711')); return true; } });
  const dir = fakeDir();
  const msgs = [];
  let flipped = false;
  const orch = createOrchestrator({
    onStatus: (m) => msgs.push(m),
    onProgress: () => { if (!flipped) { flipped = true; lsBag.set('USER_DATA', UD('P-OTHER', '9999')); } },
  });
  orch.setFolder(dir);
  await orch.start(makePlan(2));
  assert.equal(calls.switches.length, 1, 'one restore');
  assert.deepEqual(calls.switches[0], { taxpayerId: 4711 }, 'switched back to the RUN entity, not the flipped one');
  assert.equal(progress(dir).status, 'done', 'the run finished — no pause');
  assert.ok(msgs.some((m) => /continuing|نُكمل/.test(m)), 'the recovery is named');
});

test('T-243 a flip that cannot be restored still pauses with the manual message', async () => {
  lsBag.set('USER_DATA', UD('P-1', '4711'));
  stubFetch({ onSwitch: () => true });   // the PUT "succeeds" but the stamp never comes back
  const dir = fakeDir();
  const msgs = [];
  let flipped = false;
  const orch = createOrchestrator({
    onStatus: (m) => msgs.push(m),
    onProgress: () => { if (!flipped) { flipped = true; lsBag.set('USER_DATA', UD('P-OTHER', '9999')); } },
  });
  orch.setFolder(dir);
  await orch.start(makePlan(2));
  const p = progress(dir);
  assert.equal(p.status, 'paused');
  assert.deepEqual(p.doneIds, ['c1'], 'work already done is kept');
  assert.ok(msgs.some((m) => /Switch the portal back|أعد البوابة/.test(m)), 'the manual instruction appears');
});

test('T-244 a 4th flip in one run pauses without another restore attempt', async () => {
  lsBag.set('USER_DATA', UD('P-1', '4711'));
  const calls = stubFetch({ onSwitch: () => { lsBag.set('USER_DATA', UD('P-1', '4711')); return true; } });
  const dir = fakeDir();
  const orch = createOrchestrator({
    onStatus: () => {},
    onProgress: () => lsBag.set('USER_DATA', UD('P-OTHER', '9999')),   // flip after EVERY chunk
  });
  orch.setFolder(dir);
  await orch.start(makePlan(5));
  assert.equal(calls.switches.length, 3, 'exactly three restores, then surrender');
  assert.equal(progress(dir).status, 'paused', 'the 4th flip pauses — a human is working the other entity');
});
