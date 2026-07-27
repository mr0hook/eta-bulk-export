import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { mergeFolder } from '../src/core/merge.js';

// in-memory File System Access shim covering what fs.js/merge.js use
function fakeDir() {
  const files = new Map();
  const enc = new TextEncoder();
  const toU8 = async (x) => x instanceof Uint8Array ? x : (typeof x === 'string' ? enc.encode(x) : new Uint8Array(await x.arrayBuffer()));
  return {
    files,
    async getFileHandle(name, opts) {
      if (!files.has(name) && !opts?.create) throw new Error('not found');
      return {
        async getFile() {
          const d = files.get(name) || new Uint8Array();
          return {
            size: d.byteLength,
            arrayBuffer: async () => d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength),
            text: async () => new TextDecoder().decode(d),
            stream: () => new ReadableStream({ start(c) { c.enqueue(d); c.close(); } }),
          };
        },
        async createWritable(o) {
          const chunks = o?.keepExistingData && files.has(name) ? [files.get(name)] : [];
          return {
            async write(x) { chunks.push(await toU8(x && x.type === 'write' ? x.data : x)); },
            async close() { const len = chunks.reduce((s, c) => s + c.byteLength, 0); const out = new Uint8Array(len); let off = 0; for (const c of chunks) { out.set(c, off); off += c.byteLength; } files.set(name, out); },
          };
        },
      };
    },
    async *entries() { for (const n of files.keys()) yield [n, { kind: 'file' }]; },
  };
}

async function putXlsx(dir, name, headerSum, rowsSum, headerLine, rowsLine) {
  const wb = new ExcelJS.Workbook();
  const s0 = wb.addWorksheet('جميع الفواتير'); s0.addRow(headerSum); rowsSum.forEach((r) => s0.addRow(r));
  const s1 = wb.addWorksheet('بيانات الفواتير'); s1.addRow(headerLine); rowsLine.forEach((r) => s1.addRow(r));
  const buf = await wb.xlsx.writeBuffer();
  const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(new Uint8Array(buf)); await w.close();
}

test('merge: dedup by uuid + header union + continuous serial', async () => {
  const dir = fakeDir();
  const U = 'الرقم الإلكترونى';
  // file A: uuids U1,U2 ; cols [مسلسل, الحالة, uuid]
  await putXlsx(dir, 'eInvoices_2025_Sent_a.xlsx',
    ['مسلسل', 'الحالة', U], [[1, 'Valid', 'U1'], [2, 'Valid', 'U2']],
    ['رقم الفاتورة', U], [['A-1', 'U1'], ['A-2', 'U2']]);
  // file B: uuids U2(dup), U3 ; introduces a NEW column T4 (ضريبة) not in A
  await putXlsx(dir, 'eInvoices_2025_Sent_b.xlsx',
    ['مسلسل', 'الحالة', U, 'الخصم تحت حساب الضريبة'], [[1, 'Valid', 'U2', 5], [2, 'Invalid', 'U3', 9]],
    ['رقم الفاتورة', U], [['B-2', 'U2'], ['B-3', 'U3']]);

  const log = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log.push(m) });

  const combinedName = [...dir.files.keys()].find((n) => /COMBINED.*\.xlsx$/.test(n));
  assert.ok(combinedName, 'combined xlsx written');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await (await dir.getFileHandle(combinedName)).getFile()).arrayBuffer());
  const s0 = wb.getWorksheet('جميع الفواتير');
  const dataRows = s0.actualRowCount - 1;
  assert.equal(dataRows, 3, 'deduped to 3 unique invoices (U1,U2,U3)');
  const header = s0.getRow(1).values.slice(1);
  assert.ok(header.includes('الخصم تحت حساب الضريبة'), 'header union includes the new column from file B');
  // continuous serial 1..3 in مسلسل (first column)
  const serials = [2, 3, 4].map((rn) => s0.getRow(rn).values[1]);
  assert.deepEqual(serials, [1, 2, 3], 'serial renumbered continuously');
  // first-file-wins for U2 (status 'Valid' from A, not 'Invalid')
  const uuidCol = header.indexOf(U) + 1;
  const statusCol = header.indexOf('الحالة') + 1;
  const u2 = [2, 3, 4].map((rn) => s0.getRow(rn)).find((r) => r.values[uuidCol] === 'U2');
  assert.equal(u2.values[statusCol], 'Valid', 'first-file-wins on dedup');
});

test('T-006 merge: line-sheet header union when only the newer part carries الرقم المرجعي', async () => {
  const dir = fakeDir();
  const U = 'الرقم الإلكترونى', REF = 'الرقم المرجعي';
  // old part: line sheet WITHOUT the references column
  await putXlsx(dir, 'eInvoices_2026_Received_old.xlsx',
    ['مسلسل', U], [[1, 'U1']],
    ['رقم الفاتورة', U], [['A-1', 'U1']]);
  // new part: line sheet WITH it
  await putXlsx(dir, 'eInvoices_2026_Received_new.xlsx',
    ['مسلسل', U, REF], [[1, 'U2', 'A, B']],
    ['رقم الفاتورة', U, REF], [['B-1', 'U2', 'A, B']]);

  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });

  const combinedName = [...dir.files.keys()].find((n) => /COMBINED.*\.xlsx$/.test(n));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await (await dir.getFileHandle(combinedName)).getFile()).arrayBuffer());
  const s1 = wb.getWorksheet('بيانات الفواتير');
  const header = s1.getRow(1).values.slice(1);
  assert.ok(header.includes(REF), 'line-sheet header union includes الرقم المرجعي from the new part');
  const refCol = header.indexOf(REF) + 1;
  const rows = [2, 3].map((rn) => s1.getRow(rn));
  const oldRow = rows.find((r) => r.values[1] === 'A-1');
  const newRow = rows.find((r) => r.values[1] === 'B-1');
  assert.equal(oldRow.values[refCol] ?? '', '', 'old part renders blank in the unioned column');
  assert.equal(newRow.values[refCol], 'A, B', 'new part keeps its joined references');
});

test('merge: HIGH regression — an unreadable chunk is surfaced, not silently counted as merged (#2)', async () => {
  const dir = fakeDir();
  const U = 'الرقم الإلكترونى';
  await putXlsx(dir, 'eInvoices_2025_Sent_a.xlsx', ['مسلسل', 'الحالة', U], [[1, 'Valid', 'U1']], ['رقم الفاتورة', U], [['A-1', 'U1']]);
  // a file matching the merge glob but whose bytes are not a valid xlsx → wb.xlsx.load throws
  const fh = await dir.getFileHandle('eInvoices_2025_Sent_bad.xlsx', { create: true });
  const w = await fh.createWritable(); await w.write(new TextEncoder().encode('not a zip')); await w.close();

  const log = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log.push(m) });

  assert.ok(log.some((m) => /SKIPPED \(unreadable\)/.test(m)), 'the unreadable file is loudly skipped');
  const final = log[log.length - 1];
  assert.match(final, /INCOMPLETE/, 'final status refuses to claim success');
  assert.match(final, /1\/2 files/, 'reports the REAL read count (1/2), not files.length');
  assert.ok([...dir.files.keys()].some((n) => /COMBINED.*\.xlsx$/.test(n)), 'the readable rows still produce a combined file');
});
