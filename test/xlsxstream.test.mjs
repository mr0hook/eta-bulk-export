// SPEC-014 / F-15 — streaming xlsx writer.
// The whole point is that we now own xlsx correctness for the merge output, so the load-bearing
// assertion throughout is a ROUND TRIP: write with our writer, read back with ExcelJS.
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { fakeDir } from './fakefs.mjs';
import { createXlsxWriter, SHEET_MAX_ROWS, colRef } from '../src/export/xlsxstream.js';

const readBack = async (dir, name) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
  return wb;
};

test('T-122 a written sheet round-trips through ExcelJS: name, header, values, types', async () => {
  const dir = fakeDir();
  const w = await createXlsxWriter(dir, 'out.xlsx', { sheetName: 'جميع الفواتير', header: ['مسلسل', 'الرقم الإلكترونى', 'تاريخ الإصدار', 'القيمة'] });
  await w.addRow([1, 'U1', new Date(Date.UTC(2026, 2, 15)), 1234.56]);
  await w.addRow([2, 'U2', new Date(Date.UTC(2026, 11, 31)), -99]);
  await w.close();

  const ws = (await readBack(dir, 'out.xlsx')).worksheets[0];
  assert.equal(ws.name, 'جميع الفواتير');
  assert.deepEqual(ws.getRow(1).values.slice(1), ['مسلسل', 'الرقم الإلكترونى', 'تاريخ الإصدار', 'القيمة']);
  const r2 = ws.getRow(2).values.slice(1);
  assert.equal(r2[0], 1);
  assert.equal(r2[1], 'U1');
  assert.ok(r2[2] instanceof Date, 'dates come back as Dates, not strings or serial numbers');
  assert.equal(r2[2].toISOString().slice(0, 10), '2026-03-15');
  assert.equal(r2[3], 1234.56);
  assert.equal(ws.getRow(3).values[4], -99, 'negatives survive (credit notes depend on this)');
});

test('T-123 the RTL frozen-pane view survives', async () => {
  const dir = fakeDir();
  const w = await createXlsxWriter(dir, 'out.xlsx', { sheetName: 'S', header: ['a'] });
  await w.addRow(['x']);
  await w.close();

  const v = (await readBack(dir, 'out.xlsx')).worksheets[0].views[0];
  assert.equal(v.rightToLeft, true);
  assert.equal(v.state, 'frozen');
  assert.equal(v.ySplit, 1, 'header row stays frozen');
});

test('T-124 XML-hostile content does not corrupt the file', async () => {
  const dir = fakeDir();
  const w = await createXlsxWriter(dir, 'out.xlsx', { sheetName: 'S', header: ['t'] });
  const nasty = 'a & b <tag> "q" \'s\' ]]> bell';
  await w.addRow([nasty]);
  await w.addRow(['  leading and trailing  ']);
  await w.close();

  const ws = (await readBack(dir, 'out.xlsx')).worksheets[0];
  assert.equal(ws.getRow(2).values[1], 'a & b <tag> "q" \'s\' ]]> bell', 'escaped, with the illegal control char dropped');
  assert.equal(ws.getRow(3).values[1], '  leading and trailing  ', 'whitespace preserved');
});

test('T-125 blanks, nulls and non-finite numbers become empty cells, not garbage', async () => {
  const dir = fakeDir();
  const w = await createXlsxWriter(dir, 'out.xlsx', { sheetName: 'S', header: ['a', 'b', 'c', 'd', 'e'] });
  await w.addRow([null, undefined, '', NaN, Infinity]);
  await w.addRow(['end', 0, 0, 0, 0]);
  await w.close();

  const ws = (await readBack(dir, 'out.xlsx')).worksheets[0];
  const r = ws.getRow(2).values.slice(1);
  assert.ok(r.every((v) => v == null || v === ''), `all blank, got ${JSON.stringify(r)}`);
  assert.equal(ws.getRow(3).values[2], 0, 'a real zero is NOT blanked');
});

test('T-126 wide sheets address columns correctly past Z and AZ', async () => {
  assert.equal(colRef(1), 'A');
  assert.equal(colRef(26), 'Z');
  assert.equal(colRef(27), 'AA');
  assert.equal(colRef(52), 'AZ');
  assert.equal(colRef(53), 'BA');

  const dir = fakeDir();
  const header = Array.from({ length: 60 }, (_, i) => 'c' + i);
  const w = await createXlsxWriter(dir, 'out.xlsx', { sheetName: 'S', header });
  await w.addRow(header.map((_, i) => 'v' + i));
  await w.close();

  const ws = (await readBack(dir, 'out.xlsx')).worksheets[0];
  assert.equal(ws.getRow(2).values[60], 'v59', 'the 60th column round-trips');
});

test('T-127 many rows stay correct end-to-end and cost flat memory', async () => {
  const dir = fakeDir();
  const N = 50000;
  const before = process.memoryUsage().heapUsed;
  const w = await createXlsxWriter(dir, 'out.xlsx', { sheetName: 'S', header: ['i', 'u'] });
  for (let i = 1; i <= N; i++) await w.addRow([i, 'U' + i]);
  const rows = await w.close();
  const grew = (process.memoryUsage().heapUsed - before) / 1048576;

  assert.equal(rows, N + 1, 'row count includes the header');
  const ws = (await readBack(dir, 'out.xlsx')).worksheets[0];
  assert.equal(ws.actualRowCount, N + 1);
  assert.equal(ws.getRow(2).values[2], 'U1', 'first row');
  assert.equal(ws.getRow(N + 1).values[2], 'U' + N, 'last row — nothing truncated');
  // ExcelJS needs ~9.5KB/row to BUILD this; the writer must not be in that regime.
  assert.ok(grew < 120, `writer heap growth ${grew.toFixed(0)}MB should be far below ExcelJS's ~475MB for 50k rows`);
});

test('T-128 SHEET_MAX_ROWS is the format limit, not a tuning knob', () => {
  assert.equal(SHEET_MAX_ROWS, 1048576);
});
