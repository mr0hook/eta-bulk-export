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
