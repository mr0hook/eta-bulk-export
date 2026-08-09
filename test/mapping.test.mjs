// SPEC-021 — the served export mapping and its bundled fallback.
//
// The property under test throughout: NO reachable failure of the server path may change what ends
// up in the spreadsheet except by making the headers older. A missing column, a renamed one that
// the row builder no longer feeds, or a half-applied mapping must be impossible.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLED, BUNDLED_REVISION, MAX_AGE_MS, ALWAYS_KEEP,
  bundledFor, validateMapping, chooseMapping, readEntry, writeEntry, mappingFor, mappingStatus,
} from '../src/export/mapping.js';
import { renderWorkbook, removableColumns } from '../src/export/xlsx.js';

// ── a localStorage the pure module can actually use (ls.js is try/caught, so absent = no cache) ──
const bag = new Map();
const useLS = () => { globalThis.localStorage = { getItem: (k) => (bag.has(k) ? bag.get(k) : null), setItem: (k, v) => bag.set(k, String(v)), removeItem: (k) => bag.delete(k) }; };
const noLS = () => { bag.clear(); delete globalThis.localStorage; };

const deep = (o) => JSON.parse(JSON.stringify(o));
const MockExcel = { Workbook: class { constructor() { this.worksheets = []; } addWorksheet(name) { const ws = { name, views: [], columns: [], _rows: [], addRow(v) { const r = { values: v, eachCell() {} }; this._rows.push(r); return r; } }; this.worksheets.push(ws); return ws; } } };
const OPTS = { combineAll: true, taxColumns: true, discountColumns: true, validOnly: false };
const REC = [{ detail: { uuid: 'U1', internalID: 'A-1', documentTypeNamePrimaryLang: 'Invoice', status: 'Valid', dateTimeIssued: '2025-01-02T10:00:00Z', invoiceLines: [{ description: 'x', total: 1 }] } }];

test.afterEach(noLS);

// ── the bundled mapping is a complete, usable mapping on its own ──────────────────────────────
test('bundled: both sources carry the structural keys, and nothing is malformed', () => {
  for (const src of ['invoices', 'receipts']) {
    const m = bundledFor(src);
    const v = validateMapping(m, m);
    assert.equal(v.ok, true, src + ': ' + v.why);
    const sumKeys = m.summary.map(([k]) => k);
    for (const k of ALWAYS_KEEP) assert.ok(sumKeys.includes(k), src + ' summary must carry ' + k);
    assert.ok(m.lines.map(([k]) => k).includes('uuid'), src + ' lines must carry uuid (merge joins on it)');
  }
  assert.equal(BUNDLED.invoices.summarySheet !== BUNDLED.receipts.summarySheet, true);
});

test('no cache at all → the bundled mapping renders, and says why', () => {
  noLS();
  assert.equal(mappingFor('invoices'), BUNDLED.invoices);
  assert.equal(mappingStatus('receipts').origin, 'bundled');
  assert.equal(mappingStatus('receipts').reason, 'no-cache');
});

// ── validation: the one-directional rule ──────────────────────────────────────────────────────
test('validate: a served mapping may rename, re-width, re-order and ADD', () => {
  const b = bundledFor('invoices');
  const m = deep(b);
  m.summary = [...m.summary].reverse().map(([k, h, w]) => [k, h + ' (2026)', w + 1]);
  m.summary.push(['brandNewColumn', 'حقل جديد', 20]);
  assert.equal(validateMapping(m, b).ok, true);
});

test('validate: a served mapping may NOT drop a column — that is silent data loss', () => {
  const b = bundledFor('invoices');
  const m = deep(b);
  m.summary = m.summary.filter(([k]) => k !== 'totalAmount');
  const v = validateMapping(m, b);
  assert.equal(v.ok, false);
  assert.match(v.why, /drops column totalAmount/);
  // …including the structural ones the merge depends on.
  const m2 = deep(b); m2.lines = m2.lines.filter(([k]) => k !== 'uuid');
  assert.match(validateMapping(m2, b).why, /drops column uuid/);
});

test('validate: malformed payloads are rejected whole, never partly applied', () => {
  const b = bundledFor('receipts');
  const bad = [
    [null, /not an object/],
    [[], /not an object/],
    [{ ...deep(b), summarySheet: '' }, /summary sheet/],
    [{ ...deep(b), lineSheet: '   ' }, /line sheet/],
    [{ ...deep(b), lineSheet: b.summarySheet }, /same name/],
    [{ ...deep(b), summary: [] }, /not a column list/],
    [{ ...deep(b), summary: deep(b).summary.map((c, i) => (i ? c : ['index', 'مسلسل'])) }, /triple/],
    [{ ...deep(b), summary: deep(b).summary.map((c, i) => (i ? c : ['index', '', 10])) }, /empty header/],
    [{ ...deep(b), summary: deep(b).summary.map((c, i) => (i ? c : ['index', 'x', 0])) }, /bad width/],
    [{ ...deep(b), summary: deep(b).summary.map((c, i) => (i ? c : ['index', 'x', '10'])) }, /bad width/],
    [{ ...deep(b), summary: [...deep(b).summary, ['index', 'dup', 10]] }, /duplicate column key index/],
    [{ ...deep(b), summary: [...deep(b).summary, ['bad key!', 'x', 10]] }, /bad column key/],
  ];
  for (const [m, re] of bad) {
    const v = validateMapping(m, b);
    assert.equal(v.ok, false, 'should have been rejected: ' + JSON.stringify(m).slice(0, 60));
    assert.match(v.why, re);
  }
});

// ── chooseMapping: every way a cache can be untrustworthy ─────────────────────────────────────
test('choose: a valid, current cache wins; a stale or suspect one never does', () => {
  const b = bundledFor('invoices');
  const server = deep(b); server.summary[2][1] = 'Document type';
  const now = 1_800_000_000_000;
  const entry = (over) => ({ revision: BUNDLED_REVISION, hash: 'h', at: now - 1000, mapping: server, ...over });

  assert.equal(chooseMapping(b, entry(), now).origin, 'server');
  assert.equal(chooseMapping(b, entry(), now).mapping.summary[2][1], 'Document type');

  const cases = [
    [entry({ revision: BUNDLED_REVISION - 1 }), 'older-revision'],   // build is newer than the cache
    [entry({ revision: 'x' }), 'older-revision'],
    [entry({ at: 0 }), 'no-timestamp'],
    [entry({ at: now + 3600000 }), 'future-timestamp'],
    [entry({ at: now - MAX_AGE_MS - 1 }), 'expired'],               // aged out → detectable, not silent
    [entry({ mapping: { ...deep(server), summary: deep(server).summary.filter(([k]) => k !== 'uuid') } }), 'invalid: summary: served mapping drops column uuid'],
    [null, 'no-cache'],
    ['nonsense', 'no-cache'],
  ];
  for (const [e, reason] of cases) {
    const c = chooseMapping(b, e, now);
    assert.equal(c.origin, 'bundled', reason);
    assert.equal(c.mapping, b);
    assert.equal(c.reason, reason);
  }
});

test('choose: a newer revision from the server is honoured', () => {
  const b = bundledFor('receipts');
  const c = chooseMapping(b, { revision: BUNDLED_REVISION + 5, hash: 'h', at: Date.now(), mapping: deep(b) }, Date.now());
  assert.equal(c.origin, 'server');
  assert.equal(c.revision, BUNDLED_REVISION + 5);
});

// ── the render actually follows the mapping in force ──────────────────────────────────────────
test('render: a cached server mapping renames headers and sheets; every bundled key still ships', () => {
  useLS();
  const b = bundledFor('invoices');
  const server = deep(b);
  server.summarySheet = 'All invoices';
  server.summary = server.summary.map(([k, h, w]) => [k, 'EN:' + k, w]);
  writeEntry('invoices', { revision: BUNDLED_REVISION, hash: 'h', at: Date.now(), mapping: server });

  const r = renderWorkbook(MockExcel, REC, 'invoices', OPTS);
  assert.equal(r.workbook.worksheets[0].name, 'All invoices');
  assert.equal(r.summaryCols.find((c) => c.key === 'totalAmount').header, 'EN:totalAmount');
  for (const [k] of b.summary) assert.ok(r.summaryCols.some((c) => c.key === k), 'lost column ' + k);
  assert.equal(r.summaryRows[0].uuid, 'U1', 'rows are still built locally, unchanged');
  // The Columns UI offers what the export will really write, and still never offers the structural three.
  const off = removableColumns('invoices');
  assert.equal(off.some((c) => ALWAYS_KEEP.has(c.key)), false);
  assert.equal(off.find((c) => c.key === 'issuerName').header, 'EN:issuerName');
});

test('render: a corrupt or stale cached mapping falls back silently to the bundled headers', () => {
  useLS();
  const b = bundledFor('invoices');
  // (1) garbage in the slot
  bag.set('etaBulk_export_mapping_invoices', '{not json');
  assert.equal(renderWorkbook(MockExcel, REC, 'invoices', OPTS).summaryCols[0].header, b.summary[0][1]);
  // (2) a mapping that drops a column — the exact failure this design exists to prevent
  const holed = deep(b); holed.summary = holed.summary.filter(([k]) => k !== 'issuerName');
  writeEntry('invoices', { revision: BUNDLED_REVISION, hash: 'h', at: Date.now(), mapping: holed });
  const r = renderWorkbook(MockExcel, REC, 'invoices', OPTS);
  assert.ok(r.summaryCols.some((c) => c.key === 'issuerName'), 'the dropped column must come back from the bundle');
  // (3) aged out
  writeEntry('invoices', { revision: BUNDLED_REVISION, hash: 'h', at: Date.now() - MAX_AGE_MS - 1, mapping: deep(b) });
  assert.equal(mappingStatus('invoices').reason, 'expired');
});

test('render: options.mapping pins an exact mapping regardless of cache', () => {
  useLS();
  const b = bundledFor('invoices');
  writeEntry('invoices', { revision: BUNDLED_REVISION, hash: 'h', at: Date.now(), mapping: deep(b) });
  const pinned = deep(b); pinned.summarySheet = 'PINNED';
  assert.equal(renderWorkbook(MockExcel, REC, 'invoices', { ...OPTS, mapping: pinned }).workbook.worksheets[0].name, 'PINNED');
});

// ── refreshMapping: the network half ──────────────────────────────────────────────────────────
const { refreshMapping } = await import('../src/export/mapsync.js');

test('refresh: a valid server mapping is cached and takes effect', async () => {
  useLS();
  const b = bundledFor('invoices');
  const server = deep(b); server.summary[0][1] = 'SERIAL';
  let asked = null;
  const res = await refreshMapping('invoices', { call: async (body) => { asked = body; return { ok: true, revision: BUNDLED_REVISION + 1, hash: 'abc', mapping: server }; } });
  assert.equal(asked.source, 'invoices');
  assert.equal(asked.have, '', 'nothing cached yet → no conditional hash');
  assert.equal(res.origin, 'server');
  assert.equal(res.fetched, true);
  assert.equal(readEntry('invoices').hash, 'abc');
  assert.equal(mappingFor('invoices').summary[0][1], 'SERIAL');
});

test('refresh: unchanged re-stamps the cache without resending the table', async () => {
  useLS();
  const b = bundledFor('receipts');
  const old = Date.now() - 10 * 24 * 3600 * 1000;
  writeEntry('receipts', { revision: BUNDLED_REVISION, hash: 'abc', at: old, mapping: deep(b) });
  let asked = null;
  const res = await refreshMapping('receipts', { call: async (body) => { asked = body; return { ok: true, revision: BUNDLED_REVISION, hash: 'abc', unchanged: true }; } });
  assert.equal(asked.have, 'abc', 'the client offers what it holds');
  assert.equal(res.origin, 'server');
  assert.ok(readEntry('receipts').at > old, 'freshness renewed, mapping untouched');
});

test('refresh: an unreachable server keeps a fresh cache, and never throws', async () => {
  useLS();
  const b = bundledFor('invoices');
  const server = deep(b); server.summarySheet = 'CACHED';
  writeEntry('invoices', { revision: BUNDLED_REVISION, hash: 'abc', at: Date.now(), mapping: server });
  const res = await refreshMapping('invoices', { call: async () => ({ ok: false, error: 'network', network: true }) });
  assert.equal(res.origin, 'server', 'a cached mapping still in date remains in force');
  assert.equal(res.fetched, false);
  assert.equal(res.error, 'network');
  assert.equal(mappingFor('invoices').summarySheet, 'CACHED');

  const thrown = await refreshMapping('invoices', { call: async () => { throw new Error('bridge gone'); } });
  assert.equal(thrown.error, 'bridge gone');
  assert.equal(thrown.origin, 'server');
});

test('refresh: an unreachable server with NOTHING cached falls back to bundled — the export still runs', async () => {
  useLS();
  const res = await refreshMapping('invoices', { call: async () => ({ ok: false, error: 'unauthorized' }) });
  assert.equal(res.origin, 'bundled');
  assert.equal(res.reason, 'no-cache');
  assert.equal(res.error, 'unauthorized');
  assert.equal(renderWorkbook(MockExcel, REC, 'invoices', OPTS).summaryCols.length, bundledFor('invoices').summary.length);
});

test('refresh: a bad or backdated server mapping is refused AND not cached', async () => {
  useLS();
  const b = bundledFor('invoices');
  const holed = deep(b); holed.summary = holed.summary.filter(([k]) => k !== 'netAmount');

  const r1 = await refreshMapping('invoices', { call: async () => ({ ok: true, revision: BUNDLED_REVISION, hash: 'x', mapping: holed }) });
  assert.equal(r1.origin, 'bundled');
  assert.match(r1.error, /rejected: summary: served mapping drops column netAmount/);
  assert.equal(readEntry('invoices'), null, 'a refused mapping must not be written to the cache');

  const r2 = await refreshMapping('invoices', { call: async () => ({ ok: true, revision: BUNDLED_REVISION - 1, hash: 'x', mapping: deep(b) }) });
  assert.equal(r2.origin, 'bundled');
  assert.match(r2.error, /older than this build/);
  assert.equal(readEntry('invoices'), null);
});
