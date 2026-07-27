import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { renderWorkbook } from '../src/export/xlsx.js';
import { invoices, receipts, OPTS } from './fixtures.mjs';

// dev-only: validates our rows/cols are ExcelJS-compatible and survive a write→reload,
// and that the sanitizer prevents any illegal XML char from reaching a cell (the
// corruption bug that caused "repaired records"). Runtime uses the vendored browser build.
const ILLEGAL = new RegExp('[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F' + String.fromCharCode(0xFFFE, 0xFFFF) + ']');

async function roundTrip(recs, src) {
  const { workbook } = renderWorkbook(ExcelJS, recs, src, OPTS);
  const buf = await workbook.xlsx.writeBuffer();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(buf);
  return { buf, wb2 };
}
function scanIllegal(wb) {
  let bad = 0;
  wb.eachSheet((s) => s.eachRow((row) => row.eachCell((c) => {
    const v = c.value && typeof c.value === 'object' ? c.value.text : c.value;
    if (typeof v === 'string' && ILLEGAL.test(v)) bad++;
  })));
  return bad;
}

test('invoices: serialize→reload, valid xlsx, zero illegal chars', async () => {
  const { buf, wb2 } = await roundTrip(invoices, 'invoices');
  assert.ok(buf.byteLength > 1000, 'non-trivial xlsx produced');
  assert.ok(wb2.getWorksheet('جميع الفواتير'), 'summary sheet present');
  assert.ok(wb2.getWorksheet('بيانات الفواتير'), 'line-items sheet present');
  assert.equal(scanIllegal(wb2), 0, 'no illegal XML chars in any cell (no corruption)');
});

test('receipts: serialize→reload, valid xlsx, zero illegal chars', async () => {
  const { buf, wb2 } = await roundTrip(receipts, 'receipts');
  assert.ok(buf.byteLength > 1000);
  assert.ok(wb2.getWorksheet('جميع الإيصالات'), 'receipt summary sheet');
  assert.ok(wb2.getWorksheet('بيانات الإيصالات'), 'receipt line-items sheet');
  assert.equal(scanIllegal(wb2), 0);
});
