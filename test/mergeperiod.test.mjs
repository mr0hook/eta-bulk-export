// SPEC-013 / F-14 — the period each output file covers, reported in the run log and recorded in
// state, plus day-aligned rollovers.
//
// Framing that survived SPEC-014: splits are now driven by Excel's own 1,048,576-row sheet limit,
// not by browser memory, so most folders produce ONE summary file and ONE details file. The period
// is reported rather than encoded in the filename — filenames stay stable so an incremental merge
// can leave finished files untouched instead of renaming them every time a period widens.
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
const sumFiles = (dir) => [...dir.files.keys()].filter((n) => /COMBINED_SUMMARY.*\.xlsx$/.test(n)).sort();
const stateOf = async (dir) => JSON.parse(new TextDecoder().decode(dir.files.get(ms.STATE)));
const countRows = async (dir, nm) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await (await dir.getFileHandle(nm)).getFile()).arrayBuffer());
  return wb.worksheets[0].actualRowCount - 1;
};

test('T-115 the log reports the period each written file covers', async () => {
  const dir = fakeDir();
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', [['U1', '2026-01-05'], ['U2', '2026-03-11']]);

  const log = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log.push(m) });

  assert.ok(log.some((m) => /2026-01-05 → 2026-03-11/.test(m)), `period reported, got ${JSON.stringify(log)}`);
});

test('T-116 the period is recorded in state, per file', async () => {
  const dir = fakeDir();
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', [['U1', '2026-01-05'], ['U2', '2026-03-11']]);

  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });

  const st = await stateOf(dir);
  assert.equal(st.parts.summary[0].from, '2026-01-05');
  assert.equal(st.parts.summary[0].to, '2026-03-11');
});

test('T-117 one day is never cut across two files', async () => {
  const dir = fakeDir();
  // cap is 2, but the first three invoices are all the SAME day
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', [
    ['U1', '2026-01-01'], ['U2', '2026-01-01'], ['U3', '2026-01-01'], ['U4', '2026-02-09'],
  ]);

  await mergeFolder(ExcelJS, dir, { onStatus: () => {}, rowCap: 2 });

  const st = await stateOf(dir);
  const ranges = st.parts.summary.map((p) => [p.from, p.to]);
  assert.equal(ranges[0][0], '2026-01-01');
  assert.equal(ranges[0][1], '2026-01-01', 'the whole of that day stayed in file 1');
  const claimed = new Set();
  for (const [from, to] of ranges) {
    for (const d of new Set([from, to])) { assert.equal(claimed.has(d), false, `${d} claimed twice`); claimed.add(d); }
  }
});

test('T-118 the day-alignment allowance is bounded — a huge single day still rolls over', async () => {
  const dir = fakeDir();
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', Array.from({ length: 20 }, (_, i) => ['U' + i, '2026-01-01']));

  await mergeFolder(ExcelJS, dir, { onStatus: () => {}, rowCap: 4 });

  const files = sumFiles(dir);
  assert.ok(files.length > 1, 'the cap wins over day alignment when a day is too big for one file');
  let total = 0;
  for (const nm of files) total += await countRows(dir, nm);
  assert.equal(total, 20, 'and nothing is lost when it does');
});

test('T-119 topping up widens the recorded period without duplicating the file', async () => {
  const dir = fakeDir();
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', [['U1', '2026-01-05']]);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });
  assert.deepEqual(sumFiles(dir), ['eInvoices_COMBINED_SUMMARY.xlsx']);

  await putXlsx(dir, 'eInvoices_2026_Sent_b.xlsx', [['U2', '2026-04-20']]);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });

  assert.deepEqual(sumFiles(dir), ['eInvoices_COMBINED_SUMMARY.xlsx'], 'still one file, not two');
  const st = await stateOf(dir);
  assert.equal(st.parts.summary[0].from, '2026-01-05');
  assert.equal(st.parts.summary[0].to, '2026-04-20', 'period widened to cover the increment');
  assert.equal(await countRows(dir, 'eInvoices_COMBINED_SUMMARY.xlsx'), 2, 'and it holds both invoices');
});

test('T-120 without the issue-date column the merge still works, just without periods', async () => {
  const dir = fakeDir();
  const wb = new ExcelJS.Workbook();
  const s0 = wb.addWorksheet('جميع الفواتير'); s0.addRow(['مسلسل', U]); s0.addRow([1, 'U1']); s0.addRow([2, 'U2']);
  const s1 = wb.addWorksheet('بيانات الفواتير'); s1.addRow(['رقم الفاتورة', U]); s1.addRow(['a', 'U1']);
  const buf = await wb.xlsx.writeBuffer();
  const fh = await dir.getFileHandle('eInvoices_2026_Sent_a.xlsx', { create: true });
  const w = await fh.createWritable(); await w.write(new Uint8Array(buf)); await w.close();

  await mergeFolder(ExcelJS, dir, { onStatus: () => {}, rowCap: 1 });

  assert.deepEqual(sumFiles(dir), ['eInvoices_COMBINED_SUMMARY.xlsx', 'eInvoices_COMBINED_SUMMARY_part2.xlsx']);
  const st = await stateOf(dir);
  assert.equal(st.parts.summary[0].from, null, 'no period claimed when there is no date to claim it from');
});

test('T-121 SPEC-013 period names are not mistaken for the old timestamped sets', () => {
  assert.equal(ms.DATED_RE.test('eInvoices_COMBINED_SUMMARY.xlsx'), false, 'current output');
  assert.equal(ms.DATED_RE.test('eInvoices_COMBINED_2026-08-08T14-55-21-919Z.xlsx'), true, 'superseded');
  assert.equal(ms.DATED_RE.test('eInvoices_COMBINED_2026-08-08T14-55-21-919Z_part3.xlsx'), true);
});
