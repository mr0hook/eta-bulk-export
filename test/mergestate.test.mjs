// SPEC-012 / F-13 — incremental merge.
// The property under test throughout: an incremental pass must be indistinguishable from a full
// rebuild in its OUTPUT, while doing strictly less work. Every ambiguity must fall back to full.
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { fakeDir } from './fakefs.mjs';
import { mergeFolder } from '../src/core/merge.js';
import * as ms from '../src/core/mergestate.js';

const U = 'الرقم الإلكترونى';

async function putXlsx(dir, name, headerSum, rowsSum, headerLine, rowsLine) {
  const wb = new ExcelJS.Workbook();
  const s0 = wb.addWorksheet('جميع الفواتير'); s0.addRow(headerSum); rowsSum.forEach((r) => s0.addRow(r));
  const s1 = wb.addWorksheet('بيانات الفواتير'); s1.addRow(headerLine); rowsLine.forEach((r) => s1.addRow(r));
  const buf = await wb.xlsx.writeBuffer();
  const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable();
  await w.write(new Uint8Array(buf)); await w.close();
}
// one invoice per uuid, two line rows each
const chunk = (dir, name, uuids, extraCol = null) => putXlsx(
  dir, name,
  extraCol ? ['مسلسل', U, extraCol] : ['مسلسل', U],
  uuids.map((u, i) => (extraCol ? [i + 1, u, 'X'] : [i + 1, u])),
  extraCol ? ['رقم الفاتورة', U, extraCol] : ['رقم الفاتورة', U],
  uuids.flatMap((u) => (extraCol ? [[u + '-a', u, 'X'], [u + '-b', u, 'X']] : [[u + '-a', u], [u + '-b', u]])),
);
const sumNames = (dir) => [...dir.files.keys()].filter((n) => /COMBINED_SUMMARY.*\.xlsx$/.test(n)).sort();
const detNames = (dir) => [...dir.files.keys()].filter((n) => /COMBINED_DETAILS.*\.xlsx$/.test(n)).sort();
const partNames = (dir) => [...sumNames(dir), ...detNames(dir)];
const stateOf = async (dir) => JSON.parse(new TextDecoder().decode(dir.files.get(ms.STATE)));
const bytesOf = (dir, n) => Buffer.from(dir.files.get(n)).toString('base64');

async function readAll(dir) {   // -> { serials, uuids, lineCount, headers[] }
  const serials = [], uuids = [], headers = []; let lineCount = 0;
  for (const nm of sumNames(dir)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await (await dir.getFileHandle(nm)).getFile()).arrayBuffer());
    const s0 = wb.worksheets[0];
    const hdr = s0.getRow(1).values.slice(1); headers.push(hdr.join('|'));
    for (let rn = 2; rn <= s0.actualRowCount; rn++) { const v = s0.getRow(rn).values; serials.push(v[1]); uuids.push(v[hdr.indexOf(U) + 1]); }
  }
  for (const nm of detNames(dir)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await (await dir.getFileHandle(nm)).getFile()).arrayBuffer());
    lineCount += wb.worksheets[0].actualRowCount - 1;
  }
  return { serials, uuids, lineCount, headers };
}

test('T-103 a full merge records what it consumed', async () => {
  const dir = fakeDir();
  await chunk(dir, 'eInvoices_2026_Sent_a.xlsx', ['U1', 'U2']);

  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });

  const st = await stateOf(dir);
  assert.equal(st.prefix, 'eInvoices');
  assert.deepEqual(st.consumed.map((c) => c.name), ['eInvoices_2026_Sent_a.xlsx']);
  assert.deepEqual(st.uuids.sort(), ['U1', 'U2']);
  assert.equal(st.nextSerial, 3, 'next merge continues at 3');
  assert.equal(st.writer, 'stream-v1', 'records which writer produced the parts');
  assert.equal(st.parts.summary.length, 1);
  assert.equal(st.parts.details.length, 1);
  assert.ok(st.sumCols.includes(U) && st.lineCols.includes(U));
});

test('T-104 merging again with nothing new writes NOTHING', async () => {
  const dir = fakeDir();
  await chunk(dir, 'eInvoices_2026_Sent_a.xlsx', ['U1', 'U2']);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });
  const before = Object.fromEntries([...dir.files.keys()].map((n) => [n, bytesOf(dir, n)]));

  const log = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log.push(m) });

  assert.ok(log.some((m) => /up to date/i.test(m)), `said so, got ${JSON.stringify(log)}`);
  for (const [n, b] of Object.entries(before)) assert.equal(bytesOf(dir, n), b, `${n} untouched`);
});

test('T-105 an increment appends only the new invoices and leaves earlier parts byte-identical', async () => {
  const dir = fakeDir();
  await chunk(dir, 'eInvoices_2026_Sent_a.xlsx', ['U1', 'U2']);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {}, rowCap: 2 });   // file 1 is full at 2
  const part1 = bytesOf(dir, sumNames(dir)[0]);

  await chunk(dir, 'eInvoices_2026_Sent_b.xlsx', ['U3']);
  const log = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log.push(m), rowCap: 2 });

  assert.ok(log.some((m) => /Incremental/i.test(m)), 'took the fast path');
  assert.ok(log.some((m) => /1 new file/i.test(m)), 'read only the new file');
  assert.equal(bytesOf(dir, sumNames(dir)[0]), part1, 'the full earlier summary file was never rewritten');
  const { uuids } = await readAll(dir);
  assert.deepEqual(uuids.sort(), ['U1', 'U2', 'U3']);
});

test('T-106 serial numbering continues unbroken across an increment', async () => {
  const dir = fakeDir();
  await chunk(dir, 'eInvoices_2026_Sent_a.xlsx', ['U1', 'U2']);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });
  await chunk(dir, 'eInvoices_2026_Sent_b.xlsx', ['U3', 'U4']);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });

  const { serials } = await readAll(dir);
  assert.deepEqual(serials, [1, 2, 3, 4], 'no restart, no gap');
});

test('T-107 an invoice already merged is deduped against state, not duplicated', async () => {
  const dir = fakeDir();
  await chunk(dir, 'eInvoices_2026_Sent_a.xlsx', ['U1', 'U2']);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });
  // the sync overlap re-downloads a boundary day: U2 arrives again alongside a genuinely new U3
  await chunk(dir, 'eInvoices_2026_Sent_b.xlsx', ['U2', 'U3']);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });

  const { uuids, serials } = await readAll(dir);
  assert.deepEqual(uuids.sort(), ['U1', 'U2', 'U3'], 'U2 appears once');
  assert.deepEqual(serials, [1, 2, 3]);
});

test('T-108 a new column forces a full rebuild so every part keeps identical headers', async () => {
  const dir = fakeDir();
  await chunk(dir, 'eInvoices_2026_Sent_a.xlsx', ['U1', 'U2']);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {}, rowCap: 1 });   // several parts
  await chunk(dir, 'eInvoices_2026_Sent_b.xlsx', ['U3'], 'رقم الفاتورة الأصلية');

  const log = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log.push(m), rowCap: 1 });

  assert.ok(log.some((m) => /New column/i.test(m)), `named the column, got ${JSON.stringify(log)}`);
  const { headers, uuids } = await readAll(dir);
  assert.equal(new Set(headers).size, 1, `all parts share one header, saw ${JSON.stringify(headers)}`);
  assert.ok(headers[0].includes('رقم الفاتورة الأصلية'), 'and it includes the new column');
  assert.deepEqual(uuids.sort(), ['U1', 'U2', 'U3']);
});

test('T-109 a consumed chunk file that changed size forces a full rebuild', async () => {
  const dir = fakeDir();
  await chunk(dir, 'eInvoices_2026_Sent_a.xlsx', ['U1']);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });
  await chunk(dir, 'eInvoices_2026_Sent_a.xlsx', ['U1', 'U9']);   // repaired / re-downloaded

  const log = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log.push(m) });

  assert.ok(log.some((m) => /Rebuilding/i.test(m)), 'noticed the change');
  const { uuids } = await readAll(dir);
  assert.deepEqual(uuids.sort(), ['U1', 'U9'], 'the changed file’s new rows are present');
});

test('T-110 a part the user deleted forces a full rebuild', async () => {
  const dir = fakeDir();
  await chunk(dir, 'eInvoices_2026_Sent_a.xlsx', ['U1', 'U2']);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {}, rowCap: 1 });
  const parts = sumNames(dir);
  assert.ok(parts.length > 1, 'precondition: more than one summary file');
  dir.files.delete(parts[1]);
  await chunk(dir, 'eInvoices_2026_Sent_b.xlsx', ['U3']);

  const log = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log.push(m), rowCap: 1 });

  assert.ok(log.some((m) => /Rebuilding/i.test(m)));
  const { uuids } = await readAll(dir);
  assert.deepEqual(uuids.sort(), ['U1', 'U2', 'U3']);
});

test('T-111 the incremental path cannot drift from a full rebuild', async () => {
  const build = async (incremental) => {
    const dir = fakeDir();
    await chunk(dir, 'eInvoices_2026_Sent_a.xlsx', ['U1', 'U2', 'U3']);
    if (incremental) await mergeFolder(ExcelJS, dir, { onStatus: () => {}, rowCap: 2 });
    await chunk(dir, 'eInvoices_2026_Sent_b.xlsx', ['U3', 'U4', 'U5']);
    if (incremental) await chunk(dir, 'eInvoices_2026_Sent_c.xlsx', ['U6']);
    else await chunk(dir, 'eInvoices_2026_Sent_c.xlsx', ['U6']);
    if (incremental) await mergeFolder(ExcelJS, dir, { onStatus: () => {}, rowCap: 2 });
    else { try { dir.files.delete(ms.STATE); } catch {} await mergeFolder(ExcelJS, dir, { onStatus: () => {}, rowCap: 2 }); }
    return readAll(dir);
  };

  const inc = await build(true);
  const full = await build(false);

  assert.deepEqual(inc.uuids, full.uuids, 'same invoices, same order');
  assert.deepEqual(inc.serials, full.serials, 'same serial numbering');
  assert.equal(inc.lineCount, full.lineCount, 'same line rows');
  assert.deepEqual(inc.headers, full.headers, 'same headers in the same parts');
});

test('T-112 an increment that overflows the last part spills into a new one, losing nothing', async () => {
  const dir = fakeDir();
  await chunk(dir, 'eInvoices_2026_Sent_a.xlsx', ['U1', 'U2']);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {}, rowCap: 3 });   // part1 has room for 1 more
  assert.equal(sumNames(dir).length, 1);

  await chunk(dir, 'eInvoices_2026_Sent_b.xlsx', ['U3', 'U4', 'U5']);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {}, rowCap: 3 });

  assert.ok(sumNames(dir).length > 1, 'spilled into a new file');
  const { uuids, serials, lineCount } = await readAll(dir);
  assert.deepEqual(uuids.sort(), ['U1', 'U2', 'U3', 'U4', 'U5']);
  assert.deepEqual(serials, [1, 2, 3, 4, 5], 'continuous across the spill');
  assert.equal(lineCount, 10, '2 line rows per invoice, none dropped at the boundary');
});

test('T-113 a corrupt or wrong-version state file is ignored, not obeyed', async () => {
  for (const junk of ['not json', '{"v":99}', '{}', '{"v":1}']) {
    const dir = fakeDir();
    await chunk(dir, 'eInvoices_2026_Sent_a.xlsx', ['U1']);
    const fh = await dir.getFileHandle(ms.STATE, { create: true });
    const w = await fh.createWritable(); await w.write(new TextEncoder().encode(junk)); await w.close();

    await mergeFolder(ExcelJS, dir, { onStatus: () => {} });   // must not throw

    const { uuids } = await readAll(dir);
    assert.deepEqual(uuids, ['U1'], `junk state ${JSON.stringify(junk)} fell back to a full merge`);
  }
});

test('T-114 output is two stable files — merging twice does not mint a second set', async () => {
  const dir = fakeDir();
  await chunk(dir, 'eInvoices_2026_Sent_a.xlsx', ['U1']);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });
  await chunk(dir, 'eInvoices_2026_Sent_b.xlsx', ['U2']);
  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });

  assert.deepEqual(partNames(dir), ['eInvoices_COMBINED_SUMMARY.xlsx', 'eInvoices_COMBINED_DETAILS.xlsx'],
    'exactly one summary file and one details file, no timestamps');
  assert.equal([...dir.files.keys()].some((n) => ms.DATED_RE.test(n)), false, 'no dated leftovers created');
});
