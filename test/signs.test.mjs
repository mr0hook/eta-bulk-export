// SPEC-007 (F-07) — every figure on a Credit Note exports negative.
// Local fixtures on purpose: parity.test.mjs pins the shared corpus, and the cases that matter
// here (a PLAIN invoice carrying T4, a debit note, per-line discounts, FX on a credit note) are
// exactly the ones that corpus does not carry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkbook } from '../src/export/xlsx.js';
import { createOrchestrator } from '../src/core/orchestrator.js';

class Row { constructor(d) { this.data = d; this.fill = null; } eachCell(_o, _cb) {} }
class Sheet { constructor(n) { this.name = n; this.rows = []; this.columns = []; this.views = null; this.autoFilter = null; } addRow(o) { const r = new Row(o); this.rows.push(r); return r; } }
const MockExcel = { Workbook: class { constructor() { this.sheets = []; } addWorksheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; } } };
const OPTS = { columns: {}, combineAll: true, taxColumns: true, discountColumns: true, negativeCredit: true, validOnly: false };

const doc = (over = {}) => ({ search: {}, detail: {
  uuid: 'D-1', internalID: 'A-1', status: 'Valid',
  documentTypeNamePrimaryLang: 'Invoice', documentTypeNameSecondaryLang: 'فاتورة', documentTypeVersion: '1.0',
  dateTimeIssued: '2026-07-01T00:00:00Z', dateTimeRecevied: '2026-07-01T09:00:00Z', currenciesSold: 'EGP',
  totalSales: 500, netAmount: 500, totalAmount: 560,
  issuer: { id: '100', name: 'Seller' }, receiver: { id: '200', name: 'Buyer' },
  taxTotals: [{ taxType: 'T1', amount: 70 }, { taxType: 'T4', amount: 10 }],
  invoiceLines: [{ itemCode: 'X', description: 'd', quantity: 5, unitType: 'EA', unitValue: { amountEGP: 100 },
    salesTotal: 500, netTotal: 500, total: 560,
    lineTaxableItems: [{ taxType: 'T1', rate: 14, amount: 70 }, { taxType: 'T4', rate: 2, amount: 10 }] }],
  signatures: [{ signedBy: 'CERT' }],
  ...over,
} });
const CREDIT = { documentTypeNamePrimaryLang: 'Credit Note', documentTypeNameSecondaryLang: 'إشعار دائن' };
const DEBIT = { documentTypeNamePrimaryLang: 'Debit Note', documentTypeNameSecondaryLang: 'إشعار مدين' };

const render = (docs) => renderWorkbook(MockExcel, docs, 'invoices', OPTS);
const sum = (r, i = 0) => r.summaryRows[i];
const line = (r, i = 0) => r.lineRows[i];

test('T-039 credit note: totals and ALL taxes (T4 included) go negative', () => {
  const r = render([doc(CREDIT)]);
  const s = sum(r);
  assert.equal(s.totalSales, -500, 'totalSales');
  assert.equal(s.netAmount, -500, 'netAmount');
  assert.equal(s.totalAmount, -560, 'totalAmount');
  assert.equal(s.T1, -70, 'T1');
  assert.equal(s.T4, -10, 'T4 withholding is a figure like any other — negative on a credit note');
  const l = line(r);
  assert.equal(l.T1, -70, 'line T1');
  assert.equal(l.T4, -10, 'line T4');
});

test('T-040 credit note: rate columns and FX rate are NOT signed', () => {
  const r = render([doc({ ...CREDIT, currenciesSold: 'USD',
    currencySegments: [{ currencyExchangeRate: 49.5, totalAmount: 11.31 }] })]);
  const s = sum(r);
  assert.equal(s['T1%'], '14', 'tax rate % stays positive');
  assert.equal(s.currencyExchangeRate, 49.5, 'FX rate stays positive');
  assert.equal(line(r)['T1%'], 14, 'line tax rate % stays positive');
});

test('T-041 credit note: summary discounts go negative', () => {
  const r = render([doc({ ...CREDIT, totalItemsDiscountAmount: 60, totalDiscount: 40, extraDiscountAmount: 25 })]);
  const s = sum(r);
  assert.equal(s.itemsDiscount, -60, 'itemsDiscount');
  assert.equal(s.discount, -40, 'discount');
  assert.equal(s.extraDiscount, -25, 'extraDiscount');
});

test('T-042 credit note: line discounts go negative', () => {
  const d = doc(CREDIT);
  Object.assign(d.detail.invoiceLines[0], { valueDifference: 12, discount: { amount: 30 }, itemsDiscount: 8 });
  const l = line(render([d]));
  assert.equal(l.valueDifference, -12, 'valueDifference');
  assert.equal(l.discount, -30, 'discount');
  assert.equal(l.itemsDiscount, -8, 'itemsDiscount');
});

test('T-043 credit note: line amounts negative, unit price positive (keeps qty × price = total)', () => {
  const l = line(render([doc(CREDIT)]));
  assert.equal(l.quantity, -5, 'quantity');
  assert.equal(l.salesTotal, -500, 'salesTotal');
  assert.equal(l.netTotal, -500, 'netTotal');
  assert.equal(l.total, -560, 'total');
  assert.equal(l.unitValue, 100, 'unit price is a per-unit rate — stays positive');
  assert.equal(l.quantity * l.unitValue, l.salesTotal, 'line arithmetic still holds');
});

test('T-044 credit note: FX amounts go negative, FX rate and currency code do not', () => {
  const d = doc({ ...CREDIT, currenciesSold: 'USD', currencySegments: [{ currencyExchangeRate: 49.5, totalAmount: 11.31 }] });
  Object.assign(d.detail.invoiceLines[0], { totalForeign: 11.31 });
  d.detail.invoiceLines[0].unitValue = { amountEGP: 100, currencySold: 'USD', currencyExchangeRate: 49.5, amountSold: 2.02 };
  const r = render([d]);
  assert.equal(sum(r).currencyTotal, -11.31, 'currencyTotal');
  const l = line(r);
  assert.equal(l.amountSold, -2.02, 'amountSold');
  assert.equal(l.totalForeign, -11.31, 'totalForeign');
  assert.equal(l.currencyExchangeRate, 49.5, 'line FX rate stays positive');
  assert.equal(l.currencySold, 'USD', 'currency code untouched');
});

// The defect SPEC-007 fixes: the old T4 branch negated withholding on documents that are NOT
// credit notes as soon as negativeCredit was switched on. Nothing in the suite covered it.
test('T-045 plain invoice with T4: every figure stays positive under negativeCredit', () => {
  const r = render([doc({ totalItemsDiscountAmount: 60 })]);
  const s = sum(r);
  assert.equal(s.totalAmount, 560, 'totalAmount');
  assert.equal(s.T1, 70, 'T1');
  assert.equal(s.T4, 10, 'T4 must NOT flip on a plain invoice');
  assert.equal(s.itemsDiscount, 60, 'itemsDiscount');
  const l = line(r);
  assert.equal(l.quantity, 5, 'line quantity');
  assert.equal(l.T4, 10, 'line T4 must NOT flip on a plain invoice');
});

test('T-046 debit note: adds value, so every figure stays positive', () => {
  const r = render([doc(DEBIT)]);
  const s = sum(r);
  assert.equal(s.totalSales, 500, 'totalSales');
  assert.equal(s.totalAmount, 560, 'totalAmount');
  assert.equal(s.T1, 70, 'T1');
  assert.equal(s.T4, 10, 'T4');
  assert.equal(line(r).quantity, 5, 'line quantity');
});

test('T-047 mixed corpus: only the credit note is signed', () => {
  const r = render([doc(), doc({ ...CREDIT, uuid: 'D-2', internalID: 'A-2' }), doc({ ...DEBIT, uuid: 'D-3', internalID: 'A-3' })]);
  assert.equal(sum(r, 0).totalAmount, 560, 'invoice untouched');
  assert.equal(sum(r, 1).totalAmount, -560, 'credit note signed');
  assert.equal(sum(r, 2).totalAmount, 560, 'debit note untouched');
});

test('T-048 orchestrator forces negativeCredit on — no UI, no way to export positive', async () => {
  // The flag reaches the renderer only through orchestrator.start(); assert on the source of
  // truth rather than reconstructing the whole run loop.
  const src = await (await import('node:fs/promises')).readFile(new URL('../src/core/orchestrator.js', import.meta.url), 'utf8');
  const m = src.match(/negativeCredit:\s*(true|false)/);
  assert.ok(m, 'orchestrator still sets negativeCredit explicitly');
  assert.equal(m[1], 'true', 'credit notes must export negative without user action');
  assert.ok(typeof createOrchestrator === 'function', 'orchestrator module still loads');
});
