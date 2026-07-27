// SPEC-002 (F-02) — shared received-details fetcher. Client functions are injected (deps
// parameter), so these tests need no network or fetch stubs.
import test from 'node:test';
import assert from 'node:assert/strict';

const bag = new Map();
globalThis.localStorage = {
  getItem: (k) => (bag.has(k) ? bag.get(k) : null),
  setItem: (k, v) => bag.set(k, String(v)),
  removeItem: (k) => bag.delete(k),
};

const { fetchReceivedDetails, SCAN_CAP, DETAIL_CONC } = await import('../src/reject/received.js');

const coded = (code) => Object.assign(new Error(code), { code });
const row = (uuid) => ({ source: { uuid } });
const detail = (uuid) => ({ uuid, status: 'Valid', totalAmount: 10 });

function deps(over = {}) {
  const calls = { probe: [], rows: [], details: [] };
  const d = {
    probeCount: async (...a) => { calls.probe.push(a); return over.count ?? 3; },
    fetchAllRows: async (...a) => { calls.rows.push(a); return (over.uuids ?? ['U1', 'U2', 'U3']).map(row); },
    fetchDetails: async (SRC, uuid) => { calls.details.push(uuid); if (over.failOn === uuid) throw over.err || new Error('HTTP 500'); return detail(uuid); },
    ...over.fns,
  };
  return { d, calls };
}

test('T-008 invalid range throws BAD_RANGE before any probe', async () => {
  const { d, calls } = deps();
  for (const [from, to] of [['2026-07-10', '2026-07-01'], [null, '2026-07-01'], ['2026-07-01', null]]) {
    await assert.rejects(fetchReceivedDetails({ from, to }, d), (e) => e.code === 'BAD_RANGE');
  }
  assert.equal(calls.probe.length, 0);
});

test('T-007 over cap throws TOO_MANY with count and cap attached', async () => {
  const { d } = deps({ count: 2001 });
  await assert.rejects(fetchReceivedDetails({ from: '2026-07-01', to: '2026-07-10' }, d),
    (e) => e.code === 'TOO_MANY' && e.count === 2001 && e.cap === 2000);
});

test('T-009 zero count short-circuits without fetching rows or details', async () => {
  const { d, calls } = deps({ count: 0 });
  const r = await fetchReceivedDetails({ from: '2026-07-01', to: '2026-07-10' }, d);
  assert.deepEqual(r, { results: [], count: 0 });
  assert.equal(calls.rows.length, 0);
  assert.equal(calls.details.length, 0);
});

test('T-010 one failed detail is fail-closed to {o:null, err}; order preserved', async () => {
  const { d } = deps({ failOn: 'U2' });
  const { results, count } = await fetchReceivedDetails({ from: '2026-07-01', to: '2026-07-10' }, d);
  assert.equal(count, 3);
  assert.deepEqual(results.map((r) => r.uuid), ['U1', 'U2', 'U3']);
  assert.equal(results[0].o.uuid, 'U1');
  assert.equal(results[1].o, null);
  assert.match(String(results[1].err), /HTTP 500/);
  assert.equal(results[2].o.uuid, 'U3');
});

test('T-011 STOPPED from a detail fetch is rethrown, never swallowed', async () => {
  const { d } = deps({ failOn: 'U1', err: coded('STOPPED') });
  await assert.rejects(fetchReceivedDetails({ from: '2026-07-01', to: '2026-07-10' }, d), (e) => e.code === 'STOPPED');
});

test('T-012 defaults: Received direction, Submission field, Valid server status; hooks fire', async () => {
  const { d, calls } = deps();
  const seen = { status: [], prog: [] };
  await fetchReceivedDetails({ from: '2026-07-01', to: '2026-07-10', hooks: {
    onStatus: (ph) => seen.status.push(ph),
    onProgress: (cur, max) => seen.prog.push([cur, max]),
  } }, d);
  // probeCount(SRC, from, to, dir, field, statusParam, subF, subT, opts)
  const p = calls.probe[0];
  assert.equal(p[3], 'Received'); assert.equal(p[4], 'Submission'); assert.equal(p[5], 'Valid');
  // fetchAllRows(SRC, chunk, dir, field, statusParam, filterSet, opts)
  const r = calls.rows[0];
  assert.equal(r[2], 'Received'); assert.equal(r[3], 'Submission'); assert.equal(r[4], 'Valid'); assert.equal(r[5], null);
  assert.deepEqual(seen.status, ['rows', 'details']);
  assert.equal(seen.prog.length, 3);
  assert.deepEqual(seen.prog[2], [3, 3]);
  assert.ok(SCAN_CAP === 2000 && DETAIL_CONC >= 1, 'tunables exported');
});
