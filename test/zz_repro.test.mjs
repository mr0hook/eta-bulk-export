import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { mergeFolder } from '../src/core/merge.js';

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
    async removeEntry(name) { if (!files.delete(name)) throw new Error('not found'); },
    async *entries() { for (const n of files.keys()) yield [n, { kind: 'file' }]; },
  };
}
const sumFile = (dir) => [...dir.files.keys()].find((n) => /COMBINED_SUMMARY.*\.xlsx$/.test(n));
const load = async (dir, nm) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await (await dir.getFileHandle(nm)).getFile()).arrayBuffer()); return wb.worksheets[0]; };
async function putXlsx(dir, name, headerSum, rowsSum, headerLine, rowsLine) {
  const wb = new ExcelJS.Workbook();
  const s0 = wb.addWorksheet('جميع الفواتير'); s0.addRow(headerSum); rowsSum.forEach((r) => s0.addRow(r));
  const s1 = wb.addWorksheet('بيانات الفواتير'); s1.addRow(headerLine); rowsLine.forEach((r) => s1.addRow(r));
  const buf = await wb.xlsx.writeBuffer();
  const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(new Uint8Array(buf)); await w.close();
}

test('unreadable chunk is marked consumed → next merge says up-to-date and never retries it', async () => {
  const dir = fakeDir();
  const U = 'الرقم الإلكترونى';
  await putXlsx(dir, 'eInvoices_2025_Sent_a.xlsx', ['مسلسل', 'الحالة', U], [[1, 'Valid', 'U1']], ['رقم الفاتورة', U], [['A-1', 'U1']]);
  const fh = await dir.getFileHandle('eInvoices_2025_Sent_bad.xlsx', { create: true });
  const w = await fh.createWritable(); await w.write(new TextEncoder().encode('not a zip')); await w.close();

  const log1 = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log1.push(m) });
  console.log('MERGE 1:', log1.filter((l) => /SKIP|INCOMPLETE|Merged/.test(l)));

  const st = JSON.parse(new TextDecoder().decode(dir.files.get('eta_merge_state.json')));
  console.log('CONSUMED:', st.consumed.map((c) => c.name));

  // second merge: nothing changed on disk
  const log2 = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log2.push(m) });
  console.log('MERGE 2:', log2);

  // now "repair" the bad file so it is readable — same content the run should have had
  await putXlsx(dir, 'eInvoices_2025_Sent_bad.xlsx', ['مسلسل', 'الحالة', U], [[1, 'Valid', 'U9']], ['رقم الفاتورة', U], [['A-9', 'U9']]);
  const log3 = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log3.push(m) });
  console.log('MERGE 3 (after repair):', log3);
  const s0 = await load(dir, sumFile(dir));
  console.log('SUMMARY ROWS:', s0.actualRowCount - 1);
});
