import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkbook, removableColumns } from '../src/export/xlsx.js';
import { taxName } from '../src/export/codes.js';
import { clean } from '../src/export/sanitize.js';
import { dateEg } from '../src/export/dates.js';
import { invoices, receipts, OPTS } from './fixtures.mjs';

// minimal ExcelJS mock — records rows/cols/fills, no serialization
class Row { constructor(d) { this.data = d; this.fill = null; } eachCell(_o, _cb) {} }
class Sheet { constructor(n) { this.name = n; this.rows = []; this.columns = []; this.views = null; this.autoFilter = null; } addRow(o) { const r = new Row(o); this.rows.push(r); return r; } }
const MockExcel = { Workbook: class { constructor() { this.sheets = []; } addWorksheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; } } };

const keys = (cols) => cols.map((c) => c.key);
const has = (cols, k) => keys(cols).includes(k);
const col = (cols, k) => cols.find((c) => c.key === k);
const byUuid = (rows, u) => rows.find((r) => r.uuid === u);

test('invoices: dynamic columns appear correctly', () => {
  const r = renderWorkbook(MockExcel, invoices, 'invoices', OPTS);
  const s = r.summaryCols;
  for (const k of ['T1', 'T1%', 'T4', 'T4%', 'currencyExchangeRate', 'currencyTotal', 'itemsDiscount', 'discount']) assert.ok(has(s, k), `summary missing ${k}`);
  assert.ok(!has(s, 'extraDiscount'), 'extraDiscount should be absent (all zero)');
  assert.equal(col(s, 'T1').header, taxName('T1'), 'tax header must use official SDK name');
  // tax cols land right after netAmount, before totalAmount
  assert.ok(keys(s).indexOf('T1') > keys(s).indexOf('netAmount'));
  assert.ok(keys(s).indexOf('T1') < keys(s).indexOf('totalAmount'));
});

test('invoices: a detail with no/empty invoiceLines still appears in the summary (#1 — no silent drop)', () => {
  const noLines = [{ search: {}, detail: { uuid: 'NOLINES', documentTypeNamePrimaryLang: 'Invoice', status: 'Valid', taxTotals: [], invoiceLines: [] } }];
  const r = renderWorkbook(MockExcel, noLines, 'invoices', OPTS);
  assert.equal(r.summaryRows.length, 1, 'lineless invoice is NOT dropped from the summary');
  assert.equal(r.summaryRows[0].uuid, 'NOLINES');
  assert.equal(r.lineRows.length, 0, 'and has no line rows');
  const missing = [{ search: {}, detail: { uuid: 'MISSING', documentTypeNamePrimaryLang: 'Invoice', status: 'Valid' } }];
  assert.equal(renderWorkbook(MockExcel, missing, 'invoices', OPTS).summaryRows.length, 1, 'undefined invoiceLines also survives');
});

test('invoices: multiple same-taxType items on one line accumulate, not overwrite (#4)', () => {
  const recs = [{ search: {}, detail: { uuid: 'MULTI', documentTypeNamePrimaryLang: 'Invoice', status: 'Valid', currenciesSold: 'EGP',
    taxTotals: [{ taxType: 'T1', amount: 30 }],
    invoiceLines: [{ description: 'x', quantity: 1, unitValue: { amountEGP: 100 }, salesTotal: 100, netTotal: 100, total: 130,
      lineTaxableItems: [{ taxType: 'T1', rate: 14, amount: 10 }, { taxType: 'T1', rate: 5, amount: 20 }] }] } }];
  const line = renderWorkbook(MockExcel, recs, 'invoices', OPTS).lineRows[0];
  assert.equal(line.T1, 30, 'two T1 items on one line sum (10+20) instead of overwriting to 20');
  assert.equal(String(line['T1%']), '14&5', 'both rates surfaced');
});

test('invoices: line-item discounts get line columns and are not dropped (regression)', () => {
  const recs = [{ search: {}, detail: { uuid: 'DISC', documentTypeNamePrimaryLang: 'Invoice', status: 'Valid', currenciesSold: 'EGP',
    totalItemsDiscountAmount: 30, serviceDeliveryDate: '2025-05-01T00:00:00Z',
    invoiceLines: [{ itemCode: 'L1', description: 'd', quantity: 1, unitValue: { amountEGP: 100 }, salesTotal: 100, netTotal: 100, total: 130,
      itemsDiscount: 5, discount: { amount: 8 }, valueDifference: 3, lineTaxableItems: [] }] } }];
  const r = renderWorkbook(MockExcel, recs, 'invoices', OPTS);
  for (const k of ['itemsDiscount', 'discount', 'valueDifference', 'serviceDeliveryDate']) assert.ok(has(r.lineCols, k), `line sheet must carry ${k} column (else ExcelJS silently drops it)`);
  const lr = r.lineRows[0];
  assert.equal(lr.itemsDiscount, 5, 'line itemsDiscount value present');
  assert.equal(lr.discount, 8, 'line discount value present');
  assert.equal(lr.valueDifference, 3, 'line valueDifference value present');
  assert.ok(lr.serviceDeliveryDate instanceof Date, 'line serviceDeliveryDate present');
});

test('codes: two distinct unknown tax codes get distinct fallback headers (merge collision guard)', () => {
  assert.notEqual(taxName('T998'), taxName('T999'), 'unknown codes must not collapse to one header');
  assert.ok(taxName('T998').includes('T998'), 'fallback header disambiguates by code');
});

test('sanitize: strips lone UTF-16 surrogates, preserves valid emoji pairs (#3)', () => {
  assert.equal(clean('ab\uD800cd'), 'abcd', 'lone high surrogate stripped');
  assert.equal(clean('ab\uDC00cd'), 'abcd', 'lone low surrogate stripped');
  assert.equal(clean('x😀y'), 'x😀y', 'valid emoji (surrogate pair) preserved');
});

test('columns: options.columns removes base columns; always-kept survive (Columns UI)', () => {
  const r = renderWorkbook(MockExcel, invoices, 'invoices', { ...OPTS, columns: { issuerAddress: false, url: false, uuid: false } });
  assert.ok(!has(r.summaryCols, 'issuerAddress') && !has(r.summaryCols, 'url'), 'excluded columns dropped');
  assert.ok(has(r.summaryCols, 'index') && has(r.summaryCols, 'uuid') && has(r.summaryCols, 'totalAmount'), 'index/uuid force-kept even when columns:{uuid:false} (#7)');
});

test('removableColumns: never offers index/details/uuid, does offer the extras', () => {
  const inv = removableColumns('invoices').map((c) => c.key);
  for (const k of ['index', 'details', 'uuid']) assert.ok(!inv.includes(k), `${k} must not be removable`);
  assert.ok(inv.includes('issuerAddress') && inv.includes('url'), 'extra columns are removable');
  const rcp = removableColumns('receipts').map((c) => c.key);
  assert.ok(rcp.length > 0 && !rcp.includes('uuid'), 'receipts list valid, uuid protected');
});

test('invoices: credit-note signs + T4 special case', () => {
  const r = renderWorkbook(MockExcel, invoices, 'invoices', OPTS);
  const cn = byUuid(r.summaryRows, 'INV-2');
  assert.equal(cn.totalAmount, -560, 'credit note totalAmount negated under negativeCredit');
  assert.equal(cn.T1, -70, 'T1 negated for credit note');
  assert.equal(cn.T4, 10, 'T4 (withholding) keeps raw amount for a credit note');
});

test('invoices: v62 sparse fields (reference/customs/ePayment)', () => {
  const r = renderWorkbook(MockExcel, invoices, 'invoices', OPTS);
  const s = r.summaryCols;
  for (const k of ['referenceUUID', 'customsDeclarationNumber', 'customsClearanceDate', 'ePaymentNumber']) assert.ok(has(s, k), `summary missing ${k}`);
  const cn = byUuid(r.summaryRows, 'INV-2');
  assert.equal(cn.referenceUUID, 'ORIG-UUID-99', 'referenceUUID = references[0]');
  assert.equal(cn.customsDeclarationNumber, 'CD-123');
  assert.equal(cn.ePaymentNumber, 'EP-777');
  assert.ok(cn.customsClearanceDate instanceof Date, 'customs date is Cairo-formatted Date');
  // sparse: absent on a plain invoice → column exists (INV-2 has it) but value undefined
  assert.equal(byUuid(r.summaryRows, 'INV-1').referenceUUID, undefined, 'plain invoice has no referenceUUID');
});

test('invoices: Cairo-DST date shifting (+2 winter / +3 summer)', () => {
  const r = renderWorkbook(MockExcel, invoices, 'invoices', OPTS);
  assert.equal(byUuid(r.summaryRows, 'INV-1').dateIssued.getUTCHours(), 2, 'March → +2');
  assert.equal(byUuid(r.summaryRows, 'INV-2').dateIssued.getUTCHours(), 3, 'August → +3');
  assert.ok(byUuid(r.summaryRows, 'INV-1').dateIssued instanceof Date);
});

test('invoices: illegal XML char stripped from names', () => {
  const r = renderWorkbook(MockExcel, invoices, 'invoices', OPTS);
  assert.equal(byUuid(r.summaryRows, 'INV-3').issuerName, 'Seller A', 'U+FFFE must be stripped');
  assert.ok(!/[￾￿]/.test(JSON.stringify(r.summaryRows)), 'no noncharacters anywhere');
});

test('invoices: foreign-currency values + line % rates', () => {
  const r = renderWorkbook(MockExcel, invoices, 'invoices', OPTS);
  const fx = byUuid(r.summaryRows, 'INV-3');
  assert.equal(fx.currency, 'USD');
  assert.equal(fx.currencyExchangeRate, 49.5);
  assert.ok(has(r.lineCols, 'currencySold') && has(r.lineCols, 'totalForeign'), 'line currency cols present');
  const line1 = r.lineRows.find((l) => l.itemCode === 'EG-1');
  assert.equal(line1['T1%'], 14, 'line % column = rate');
});

test('invoices: row fills by status/type', () => {
  const r = renderWorkbook(MockExcel, invoices, 'invoices', OPTS);
  const rows = r.workbook.sheets[0].rows;
  const fillOf = (u) => rows.find((x) => x.data.uuid === u).fill?.fgColor?.argb;
  assert.equal(fillOf('INV-1'), 'FFC6EFCE', 'valid invoice = green');
  assert.equal(fillOf('INV-2'), 'FFD9E1F2', 'valid credit note = blue');
});

test('receipts: columns, uuid on lines, no % cols, sanitize', () => {
  const r = renderWorkbook(MockExcel, receipts, 'receipts', OPTS);
  assert.ok(has(r.summaryCols, 'T1'), 'receipt tax col');
  assert.ok(has(r.summaryCols, 'commercialDiscount'), 'commercial discount col (>0)');
  assert.ok(!has(r.summaryCols, 'itemsDiscount'), 'items discount absent (not present)');
  assert.ok(!has(r.summaryCols, 'T1%'), 'receipts have NO % columns');
  assert.ok(has(r.lineCols, 'uuid'), 'receipt line sheet must carry uuid for merge');
  assert.ok(has(r.lineCols, 'valueDifference'), 'line valueDifference col (>0)');
  const row = r.summaryRows[0];
  assert.equal(row.T1, 28); assert.equal(row.commercialDiscount, 5);
  assert.equal(row.receiverName, 'Cust', 'illegal char stripped');
  assert.equal(r.lineRows.length, 2);
  assert.ok(r.lineRows.every((l) => l.uuid === 'RCP-1'), 'every line carries its receipt uuid');
});

test('unit: sanitize + dateEg helpers', () => {
  assert.equal(clean('ab' + String.fromCharCode(0xFFFE) + 'c'), 'abc');
  assert.equal(clean('tab\there'), 'tab\there'); // tab kept
  assert.equal(dateEg(null), null);
  assert.equal(dateEg('2025-01-15T00:00:00Z').getUTCHours(), 2); // winter +2
});
