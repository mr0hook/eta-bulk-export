// SPEC-013 / F-14 — parts labeled by the period they cover, split on day boundaries.
// Framing worth keeping: Excel's 1,048,576-row limit is NOT what triggers a split — memory caps a
// part at ~72k rows (SPEC-012/F-10). Period labels exist to make the output self-describing.
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { fakeDir } from './fakefs.mjs';
import { mergeFolder } from '../src/core/merge.js';
import * as ms from '../src/core/mergestate.js';

const U = 'الرقم الإلكترونى', D = 'تاريخ الإصدار';

async function putXlsx(dir, name, rows) {   // rows: [uuid, 'YYYY-MM-DD']
  const wb = new ExcelJS.Workbook();
  const s0 = wb.addWorksheet('جميع الفواتير'); s0.addRow(['مسلسل', U, D]);
  const s1 = wb.addWorksheet('بيانات الفواتير'); s1.addRow(['رقم الفاتورة', U]);
  rows.forEach(([u, d], i) => { s0.addRow([i + 1, u, new Date(d + 'T00:00:00Z')]); s1.addRow([u + '-a', u]); });
  const buf = await wb.xlsx.writeBuffer();
  const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable();
  await w.write(new Uint8Array(buf)); await w.close();
}
const parts = (dir) => [...dir.files.keys()].filter((n) => /COMBINED/.test(n) && /\.xlsx$/.test(n)).sort();

test('T-115 part filenames carry the period they cover', async () => {
  const dir = fakeDir();
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', [['U1', '2026-01-05'], ['U2', '2026-03-11']]);

  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });

  assert.deepEqual(parts(dir), ['eInvoices_COMBINED_2026-01-05_2026-03-11.xlsx']);
});

test('T-116 a split is logged with the day it happened on and the size it reached', async () => {
  const dir = fakeDir();
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', [['U1', '2026-01-01'], ['U2', '2026-01-02'], ['U3', '2026-01-03']]);

  const log = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log.push(m), partSum: 1 });

  const splits = log.filter((m) => /Split at/.test(m));
  assert.ok(splits.length >= 2, `each split announced, got ${JSON.stringify(log)}`);
  assert.match(splits[0], /Split at 2026-01-01/);
  assert.ok(log.some((m) => /2026-01-01 → 2026-01-01/.test(m)), 'and each part reports its range');
});

test('T-117 one day is never cut across two parts', async () => {
  const dir = fakeDir();
  // cap is 2, but the first three invoices are all the SAME day
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', [
    ['U1', '2026-01-01'], ['U2', '2026-01-01'], ['U3', '2026-01-01'], ['U4', '2026-02-09'],
  ]);

  await mergeFolder(ExcelJS, dir, { onStatus: () => {}, partSum: 2 });

  const names = parts(dir);
  const ranges = names.map((n) => /_COMBINED_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/.exec(n).slice(1, 3));
  for (const [from, to] of ranges) assert.ok(from <= to, `${from}..${to} is ordered`);
  // the three same-day invoices stayed together rather than being cut across the cap
  assert.equal(ranges[0][0], '2026-01-01');
  assert.equal(ranges[0][1], '2026-01-01', 'part 1 is exactly that one day');
  // and no DAY appears in two different parts' ranges
  const claimed = new Set();
  for (const [from, to] of ranges) {
    for (const d of new Set([from, to])) { assert.equal(claimed.has(d), false, `${d} claimed by two parts: ${names}`); claimed.add(d); }
  }
});

test('T-118 the day-overflow allowance is bounded — a huge single day still splits', async () => {
  const dir = fakeDir();
  const rows = Array.from({ length: 20 }, (_, i) => ['U' + i, '2026-01-01']);
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', rows);

  await mergeFolder(ExcelJS, dir, { onStatus: () => {}, partSum: 4 });

  assert.ok(parts(dir).length > 1, 'memory cap wins over day alignment when a day is too big');
  const total = await countInvoices(dir);
  assert.equal(total, 20, 'and nothing is lost when it does');
});

test('T-119 topping up a part widens its period and leaves no stale copy behind', async () => {
  const dir = fakeDir();
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', [['U1', '2026-01-05']]);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });
  assert.deepEqual(parts(dir), ['eInvoices_COMBINED_2026-01-05_2026-01-05.xlsx']);

  await putXlsx(dir, 'eInvoices_2026_Sent_b.xlsx', [['U2', '2026-04-20']]);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });

  assert.deepEqual(parts(dir), ['eInvoices_COMBINED_2026-01-05_2026-04-20.xlsx'], 'renamed, not duplicated');
  assert.equal(await countInvoices(dir), 2);
});

test('T-120 without the issue-date column, parts fall back to numbers and nothing breaks', async () => {
  const dir = fakeDir();
  const wb = new ExcelJS.Workbook();
  const s0 = wb.addWorksheet('جميع الفواتير'); s0.addRow(['مسلسل', U]); s0.addRow([1, 'U1']); s0.addRow([2, 'U2']);
  const s1 = wb.addWorksheet('بيانات الفواتير'); s1.addRow(['رقم الفاتورة', U]); s1.addRow(['a', 'U1']);
  const buf = await wb.xlsx.writeBuffer();
  const fh = await dir.getFileHandle('eInvoices_2026_Sent_a.xlsx', { create: true });
  const w = await fh.createWritable(); await w.write(new Uint8Array(buf)); await w.close();

  await mergeFolder(ExcelJS, dir, { onStatus: () => {}, partSum: 1 });

  assert.deepEqual(parts(dir), ['eInvoices_COMBINED.xlsx', 'eInvoices_COMBINED_part2.xlsx']);
});

test('T-121 SPEC-013 period names are not mistaken for the old timestamped sets', () => {
  assert.equal(ms.DATED_RE.test('eInvoices_COMBINED_2026-01-05_2026-04-20.xlsx'), false, 'a period name is current output');
  assert.equal(ms.DATED_RE.test('eInvoices_COMBINED_2026-08-08T14-55-21-919Z.xlsx'), true, 'an old stamped name is superseded');
  assert.equal(ms.DATED_RE.test('eInvoices_COMBINED_2026-08-08T14-55-21-919Z_part3.xlsx'), true);
});

async function countInvoices(dir) {
  let n = 0;
  for (const nm of parts(dir)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await (await dir.getFileHandle(nm)).getFile()).arrayBuffer());
    n += wb.worksheets[0].actualRowCount - 1;
  }
  return n;
}
