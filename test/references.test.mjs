// SPEC-001 (F-01) — credit/debit note → original invoice UUID linkage in the export.
// Local fixtures on purpose: parity.test.mjs pins the shared fixtures corpus (single-reference
// note, exact join result), so multi-reference and placement coverage lives here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkbook } from '../src/export/xlsx.js';

class Row { constructor(d) { this.data = d; this.fill = null; } eachCell(_o, _cb) {} }
class Sheet { constructor(n) { this.name = n; this.rows = []; this.columns = []; this.views = null; this.autoFilter = null; } addRow(o) { const r = new Row(o); this.rows.push(r); return r; } }
const MockExcel = { Workbook: class { constructor() { this.sheets = []; } addWorksheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; } } };
const OPTS = { columns: {}, combineAll: true, taxColumns: true, discountColumns: true, negativeCredit: false, validOnly: false };

const keys = (cols) => cols.map((c) => c.key);
const inv = (over = {}) => ({ search: {}, detail: {
  uuid: 'ORIG-1', internalID: 'A-1', status: 'Valid',
  documentTypeNamePrimaryLang: 'Invoice', documentTypeNameSecondaryLang: 'فاتورة',
  dateTimeIssued: '2026-07-01T00:00:00Z', dateTimeRecevied: '2026-07-01T09:00:00Z', currenciesSold: 'EGP',
  totalSales: 100, netAmount: 100, totalAmount: 114,
  issuer: { id: '100', name: 'Seller' }, receiver: { id: '200', name: 'Buyer' },
  taxTotals: [{ taxType: 'T1', amount: 14 }],
  invoiceLines: [{ itemCode: 'X', description: 'd', quantity: 1, unitValue: { amountEGP: 100 }, salesTotal: 100, netTotal: 100, total: 114, lineTaxableItems: [{ taxType: 'T1', rate: 14, amount: 14 }] }],
  signatures: [{ signedBy: 'CERT' }],
  ...over,
} });
const CORPUS = [
  inv(),
  inv({ uuid: 'CN-1', internalID: 'A-2', documentTypeNamePrimaryLang: 'Credit Note', documentTypeNameSecondaryLang: 'إشعار دائن', references: ['A', 'B'] }),
];

test('T-001 summary: multi-reference note joins UUIDs with comma', () => {
  const r = renderWorkbook(MockExcel, CORPUS, 'invoices', OPTS);
  const cn = r.summaryRows.find((x) => x.uuid === 'CN-1');
  assert.equal(cn.referenceUUID, 'A, B');
  assert.equal(r.summaryRows.find((x) => x.uuid === 'ORIG-1').referenceUUID, undefined, 'doc without references stays blank');
});

test('T-002 line sheet: referenceUUID column exists and every line row of the note carries the join', () => {
  const r = renderWorkbook(MockExcel, CORPUS, 'invoices', OPTS);
  assert.ok(keys(r.lineCols).includes('referenceUUID'), 'line sheet must carry the referenceUUID column (else ExcelJS silently drops the value)');
  const lr = r.lineRows.find((x) => x.uuid === 'CN-1');
  assert.equal(lr.referenceUUID, 'A, B');
  assert.equal(r.lineRows.find((x) => x.uuid === 'ORIG-1').referenceUUID, undefined);
});

test('T-003 placement: line col before uuid; summary col before signature (not appended after url)', () => {
  const r = renderWorkbook(MockExcel, CORPUS, 'invoices', OPTS);
  const lk = keys(r.lineCols);
  assert.equal(lk.indexOf('referenceUUID'), lk.indexOf('uuid') - 1, 'line: immediately before uuid');
  const sk = keys(r.summaryCols);
  assert.equal(sk.indexOf('referenceUUID'), sk.indexOf('signature') - 1, 'summary: immediately before signature');
});

test('T-004 no doc has references → no column on either sheet', () => {
  const r = renderWorkbook(MockExcel, [inv()], 'invoices', OPTS);
  assert.ok(!keys(r.summaryCols).includes('referenceUUID'));
  assert.ok(!keys(r.lineCols).includes('referenceUUID'));
});

test('T-005 falsy entries filtered from the join on both sheets', () => {
  const r = renderWorkbook(MockExcel, [inv({ uuid: 'CN-2', references: ['A', null, '', 'B'] })], 'invoices', OPTS);
  assert.equal(r.summaryRows[0].referenceUUID, 'A, B');
  assert.equal(r.lineRows[0].referenceUUID, 'A, B');
});
