// SPEC-008 (F-08) — resolve a credit/debit note's reference UUIDs to the ORIGINAL invoice number.
// The resolver takes its client functions as deps, so the whole thing is node-testable with no
// network and we can count calls to prove "free when the original is already in the export".
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkbook } from '../src/export/xlsx.js';
import { resolveReferenceNumbers } from '../src/core/refs.js';

class Row { constructor(d) { this.data = d; this.fill = null; } eachCell(_o, _cb) {} }
class Sheet { constructor(n) { this.name = n; this.rows = []; this.columns = []; this.views = null; this.autoFilter = null; } addRow(o) { const r = new Row(o); this.rows.push(r); return r; } }
const MockExcel = { Workbook: class { constructor() { this.sheets = []; } addWorksheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; } } };
const OPTS = { columns: {}, combineAll: true, taxColumns: true, discountColumns: true, negativeCredit: true, validOnly: false };

const doc = (over = {}) => ({ search: {}, detail: {
  uuid: 'ORIG-A', internalID: 'A-1', status: 'Valid',
  documentTypeNamePrimaryLang: 'Invoice', documentTypeNameSecondaryLang: 'فاتورة',
  dateTimeIssued: '2026-07-01T00:00:00Z', dateTimeRecevied: '2026-07-01T09:00:00Z', currenciesSold: 'EGP',
  totalSales: 100, netAmount: 100, totalAmount: 114,
  issuer: { id: '1', name: 'S' }, receiver: { id: '2', name: 'B' },
  taxTotals: [{ taxType: 'T1', amount: 14 }],
  invoiceLines: [{ itemCode: 'X', description: 'd', quantity: 1, unitValue: { amountEGP: 100 }, salesTotal: 100, netTotal: 100, total: 114, lineTaxableItems: [{ taxType: 'T1', rate: 14, amount: 14 }] }],
  signatures: [{ signedBy: 'C' }], ...over,
} });
const note = (refs, over = {}) => doc({ uuid: 'CN-1', internalID: 'C-9', documentTypeNamePrimaryLang: 'Credit Note', documentTypeNameSecondaryLang: 'إشعار دائن', references: refs, ...over });

// A fake fetchDetails that records every uuid it is asked for.
function fakeClient(byUuid, { fail = new Set(), throws = null } = {}) {
  const calls = [];
  return { calls, fetchDetails: async (_SRC, uuid) => {
    calls.push(uuid);
    if (throws) throw Object.assign(new Error(throws), { code: throws });
    if (fail.has(uuid)) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
    return byUuid[uuid] || null;
  } };
}
const keys = (cols) => cols.map((c) => c.key);

test('T-049 original already in the corpus resolves for free — zero API calls', async () => {
  const records = [doc(), note(['ORIG-A'])];
  const c = fakeClient({});
  const map = await resolveReferenceNumbers(records, { fetchDetails: c.fetchDetails });
  assert.equal(map.get('ORIG-A'), 'A-1', 'resolved from the corpus');
  assert.equal(c.calls.length, 0, 'no lookup for a document we already hold');
});

test('T-050 original outside the corpus costs exactly one lookup', async () => {
  const records = [note(['ORIG-Z'])];
  const c = fakeClient({ 'ORIG-Z': { uuid: 'ORIG-Z', internalID: 'Z-77' } });
  const map = await resolveReferenceNumbers(records, { fetchDetails: c.fetchDetails });
  assert.equal(map.get('ORIG-Z'), 'Z-77');
  assert.deepEqual(c.calls, ['ORIG-Z'], 'exactly one lookup, for the missing original only');
});

test('T-051 a failed lookup is blank-safe and is not retried', async () => {
  const records = [note(['ORIG-Z'])];
  const c = fakeClient({}, { fail: new Set(['ORIG-Z']) });
  const cache = new Map();
  const map = await resolveReferenceNumbers(records, { fetchDetails: c.fetchDetails }, cache);
  assert.equal(map.get('ORIG-Z') ?? null, null, 'unresolved → no number, no throw');
  await resolveReferenceNumbers(records, { fetchDetails: c.fetchDetails }, cache);
  assert.equal(c.calls.length, 1, 'a known-unresolvable uuid is never looked up twice');
});

test('T-052 the cache is run-level: repeats across chunks cost nothing', async () => {
  const c = fakeClient({ 'ORIG-Z': { uuid: 'ORIG-Z', internalID: 'Z-77' } });
  const cache = new Map();
  await resolveReferenceNumbers([note(['ORIG-Z'])], { fetchDetails: c.fetchDetails }, cache);
  await resolveReferenceNumbers([note(['ORIG-Z'], { uuid: 'CN-2' })], { fetchDetails: c.fetchDetails }, cache);
  await resolveReferenceNumbers([note(['ORIG-Z'], { uuid: 'CN-3' })], { fetchDetails: c.fetchDetails }, cache);
  assert.equal(c.calls.length, 1, 'three notes, one original, one lookup');
});

test('T-053 AUTH and STOPPED propagate — the run owns those, not the resolver', async () => {
  for (const code of ['AUTH', 'STOPPED']) {
    const c = fakeClient({}, { throws: code });
    await assert.rejects(
      () => resolveReferenceNumbers([note(['ORIG-Z'])], { fetchDetails: c.fetchDetails }, new Map()),
      (e) => e.code === code, `${code} must reach the caller`,
    );
  }
});

test('T-054 referenceNumber sits immediately before referenceUUID on both sheets', () => {
  const refNumbers = new Map([['ORIG-A', 'A-1']]);
  const r = renderWorkbook(MockExcel, [doc(), note(['ORIG-A'])], 'invoices', { ...OPTS, refNumbers });
  const s = keys(r.summaryCols), l = keys(r.lineCols);
  assert.equal(s.indexOf('referenceNumber') + 1, s.indexOf('referenceUUID'), 'summary: number then uuid');
  assert.equal(l.indexOf('referenceNumber') + 1, l.indexOf('referenceUUID'), 'line: number then uuid');
  assert.ok(s.indexOf('referenceNumber') >= 0 && l.indexOf('referenceNumber') >= 0, 'present on both');
});

test('T-055 multi-reference: numbers join in the same order as the UUIDs', () => {
  const refNumbers = new Map([['ORIG-A', 'A-1'], ['ORIG-B', 'A-2']]);
  const r = renderWorkbook(MockExcel, [note(['ORIG-A', 'ORIG-B'])], 'invoices', { ...OPTS, refNumbers });
  assert.equal(r.summaryRows[0].referenceNumber, 'A-1, A-2', 'summary join');
  assert.equal(r.summaryRows[0].referenceUUID, 'ORIG-A, ORIG-B', 'uuid column unchanged');
  assert.equal(r.lineRows[0].referenceNumber, 'A-1, A-2', 'line join');
});

test('T-056 partially resolved: only the resolved numbers appear, no empty separators', () => {
  const refNumbers = new Map([['ORIG-A', 'A-1']]);
  const r = renderWorkbook(MockExcel, [note(['ORIG-A', 'ORIG-B'])], 'invoices', { ...OPTS, refNumbers });
  assert.equal(r.summaryRows[0].referenceNumber, 'A-1', 'unresolved reference is skipped');
  assert.equal(r.summaryRows[0].referenceUUID, 'ORIG-A, ORIG-B', 'both uuids still listed');
});

test('T-057 without a refNumbers map the export degrades to SPEC-001 (uuid only)', () => {
  const r = renderWorkbook(MockExcel, [note(['ORIG-A'])], 'invoices', OPTS);
  assert.ok(keys(r.summaryCols).includes('referenceUUID'), 'uuid column still there');
  assert.ok(!keys(r.summaryCols).includes('referenceNumber'), 'no number column without a map');
  assert.equal(r.summaryRows[0].referenceNumber, undefined, 'no stray key on the row');
});

test('T-058 no references anywhere → neither column on either sheet', () => {
  const r = renderWorkbook(MockExcel, [doc()], 'invoices', { ...OPTS, refNumbers: new Map() });
  for (const k of ['referenceNumber', 'referenceUUID']) {
    assert.ok(!keys(r.summaryCols).includes(k), `summary must not carry ${k}`);
    assert.ok(!keys(r.lineCols).includes(k), `line must not carry ${k}`);
  }
});
