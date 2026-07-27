// SPEC-003 (F-03) — rejection-window service. The portal documenttypes shape is unverified, so
// the parser is tested for defensiveness above all: any surprise → null, never a throw.
import test from 'node:test';
import assert from 'node:assert/strict';

const bag = new Map();
globalThis.localStorage = {
  getItem: (k) => (bag.has(k) ? bag.get(k) : null),
  setItem: (k, v) => bag.set(k, String(v)),
  removeItem: (k) => bag.delete(k),
};

const { parseWorkflowWindows, loadWindows, makeResolver, WIN_KEY, TTL_OK, TTL_FAIL } = await import('../src/reject/window.js');

const PAST = '2020-01-01T00:00:00Z', FUTURE = '2099-01-01T00:00:00Z';
const list = { result: [{ id: 1, name: 'Invoice' }, { id: 2, name: 'Credit Note' }, { id: 3, name: 'Debit Note' }] };
const det = (name, params) => ({ id: 9, name, workflowParameters: params });

test('T-013 plausible shape parses to per-type days', () => {
  const r = parseWorkflowWindows(list, [
    det('Invoice', [{ parameter: 'ReceiverRejectionWindow', value: 14, activeFrom: PAST }]),
    det('Credit Note', [{ parameter: 'receiverRejectionPeriod', value: 7, activeFrom: PAST }]),
  ]);
  assert.deepEqual(r, { byType: { 'Invoice': 14, 'Credit Note': 7 } });
});

test('T-014 hour-named parameters convert to days', () => {
  const r = parseWorkflowWindows(list, [det('Invoice', [{ parameter: 'RejectionWindowHours', value: 336, activeFrom: PAST }])]);
  assert.deepEqual(r, { byType: { 'Invoice': 14 } });
});

test('T-015 inactive parameters are ignored', () => {
  assert.equal(parseWorkflowWindows(list, [det('Invoice', [
    { parameter: 'ReceiverRejectionWindow', value: 14, activeFrom: PAST, activeTo: PAST },
    { parameter: 'ReceiverRejectionWindow', value: 10, activeFrom: FUTURE },
  ])]), null);
});

test('T-016 garbage never throws, returns null', () => {
  for (const [l, d] of [[null, null], ['', []], [{}, [{}]], [{ result: 'x' }, ['y']],
    [list, [det('Invoice', [{ parameter: 'ReceiverRejectionWindow', value: 0, activeFrom: PAST }])]],
    [list, [det('Invoice', [{ parameter: 'ReceiverRejectionWindow', value: 9999, activeFrom: PAST }])]],
    [list, [det('Invoice', [{ parameter: 'SubmissionWindow', value: 14, activeFrom: PAST }])]],
    [list, [det('Mystery Type', [{ parameter: 'ReceiverRejectionWindow', value: 14, activeFrom: PAST }])]]]) {
    assert.equal(parseWorkflowWindows(l, d), null, JSON.stringify(l).slice(0, 40));
  }
});

test('T-017 makeResolver: per-type hit, unknown type falls back, null loaded falls back', () => {
  const cfg = { windowDays: 14 };
  const r1 = makeResolver({ source: 'api', byType: { 'Invoice': 3 } }, cfg);
  assert.equal(r1({ documentTypeNamePrimaryLang: 'Invoice' }), 3);
  assert.equal(r1({ documentTypeNamePrimaryLang: 'Credit Note' }), 14);
  const r2 = makeResolver({ source: 'config', byType: null }, cfg);
  assert.equal(r2({ documentTypeNamePrimaryLang: 'Invoice' }), 14);
  assert.equal(makeResolver(null, cfg)({}), 14);
});

const coded = (code) => Object.assign(new Error(code), { code });
const okJson = (url) => /documenttypes$/.test(url) ? list : det('Invoice', [{ parameter: 'ReceiverRejectionWindow', value: 21, activeFrom: PAST }]);

test('T-019 fetch success: list + per-id, parsed, cached ok', async () => {
  bag.clear();
  const calls = [];
  const r = await loadWindows({}, { apiGet: async (url) => { calls.push(url); return okJson(url); } });
  assert.equal(r.source, 'api');
  assert.equal(r.byType.Invoice, 21);
  assert.ok(calls[0].endsWith('/api/v1/documenttypes'));
  assert.ok(calls.length >= 2, 'per-id detail calls follow the list');
  const env = JSON.parse(bag.get('etaBulk_' + WIN_KEY));
  assert.equal(env.ok, true);
  assert.equal(env.byType.Invoice, 21);
});

test('T-018 cache semantics', async () => {
  // fresh positive → no network
  bag.clear();
  bag.set('etaBulk_' + WIN_KEY, JSON.stringify({ at: Date.now(), ok: true, byType: { Invoice: 5 } }));
  let called = 0;
  let r = await loadWindows({}, { apiGet: async () => { called++; return {}; } });
  assert.equal(called, 0); assert.equal(r.source, 'api'); assert.equal(r.byType.Invoice, 5);
  // fresh negative → config source, no network
  bag.set('etaBulk_' + WIN_KEY, JSON.stringify({ at: Date.now(), ok: false, byType: null }));
  r = await loadWindows({}, { apiGet: async () => { called++; return {}; } });
  assert.equal(called, 0); assert.equal(r.source, 'config');
  // stale positive → refetch
  bag.set('etaBulk_' + WIN_KEY, JSON.stringify({ at: Date.now() - TTL_OK - 1000, ok: true, byType: { Invoice: 5 } }));
  r = await loadWindows({}, { apiGet: async (url) => { called++; return okJson(url); } });
  assert.ok(called >= 2); assert.equal(r.byType.Invoice, 21);
  // failure → negative cached, config source
  bag.clear(); called = 0;
  r = await loadWindows({}, { apiGet: async () => { called++; throw coded('NOT_FOUND'); } });
  assert.equal(r.source, 'config'); assert.equal(r.byType, null);
  assert.equal(JSON.parse(bag.get('etaBulk_' + WIN_KEY)).ok, false);
  // failure freshness honored
  called = 0;
  r = await loadWindows({}, { apiGet: async () => { called++; return {}; } });
  assert.equal(called, 0, 'fresh negative cache prevents hammering');
  assert.ok(TTL_FAIL < TTL_OK);
  // STOPPED rethrown, nothing cached over a cleared bag
  bag.clear();
  await assert.rejects(loadWindows({}, { apiGet: async () => { throw coded('STOPPED'); } }), (e) => e.code === 'STOPPED');
});
