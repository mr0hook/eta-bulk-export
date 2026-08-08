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
    async removeEntry(name) { if (!files.delete(name)) throw new Error('not found'); },
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

test('T-059 merge: header union when only the newer part carries رقم الفاتورة الأصلية (SPEC-008)', async () => {
  const dir = fakeDir();
  const U = 'الرقم الإلكترونى', REF = 'الرقم المرجعي', NUM = 'رقم الفاتورة الأصلية';
  // a folder exported across the SPEC-008 upgrade: the old part predates the number column
  await putXlsx(dir, 'eInvoices_2026_Received_old.xlsx',
    ['مسلسل', U, REF], [[1, 'U1', 'A']],
    ['رقم الفاتورة', U, REF], [['A-1', 'U1', 'A']]);
  await putXlsx(dir, 'eInvoices_2026_Received_new.xlsx',
    ['مسلسل', U, NUM, REF], [[1, 'U2', 'ORIG-7', 'B']],
    ['رقم الفاتورة', U, NUM, REF], [['B-1', 'U2', 'ORIG-7', 'B']]);

  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });

  const combinedName = [...dir.files.keys()].find((n) => /COMBINED.*\.xlsx$/.test(n));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await (await dir.getFileHandle(combinedName)).getFile()).arrayBuffer());
  for (const sheet of ['جميع الفواتير', 'بيانات الفواتير']) {
    const s = wb.getWorksheet(sheet);
    const header = s.getRow(1).values.slice(1);
    assert.ok(header.includes(NUM), `${sheet}: header union includes ${NUM}`);
    const numCol = header.indexOf(NUM) + 1;
    const rows = [2, 3].map((rn) => s.getRow(rn));
    const oldRow = rows.find((r) => String(r.values[header.indexOf(U) + 1]) === 'U1');
    const newRow = rows.find((r) => String(r.values[header.indexOf(U) + 1]) === 'U2');
    assert.equal(oldRow.values[numCol] ?? '', '', `${sheet}: pre-upgrade rows stay blank, not broken`);
    assert.equal(newRow.values[numCol], 'ORIG-7', `${sheet}: new part keeps its resolved number`);
  }
});

test('T-072 merge: the scratch .jsonl never survives the merge, and stale ones are swept', async () => {
  const dir = fakeDir();
  const U = 'الرقم الإلكترونى';
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', ['مسلسل', U], [[1, 'U1']], ['رقم الفاتورة', U], [['A-1', 'U1']]);
  // an orphan left by a crashed pre-fix run — these were multi-GB in the field and never cleaned up
  const orphan = 'eInvoices_COMBINED_2026-01-01T00-00-00-000Z.jsonl';
  const fh = await dir.getFileHandle(orphan, { create: true });
  const w = await fh.createWritable(); await w.write(new TextEncoder().encode('{"stale":1}\n')); await w.close();

  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });

  const left = [...dir.files.keys()].filter((n) => /\.jsonl$/i.test(n));
  assert.deepEqual(left, [], `no scratch .jsonl left behind, got ${JSON.stringify(left)}`);
  assert.ok([...dir.files.keys()].some((n) => /COMBINED.*\.xlsx$/.test(n)), 'the merge still produced its output');
});

test('T-073 merge: the scratch .jsonl is cleaned up even when Phase 2 fails', async () => {
  const dir = fakeDir();
  const U = 'الرقم الإلكترونى';
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', ['مسلسل', U], [[1, 'U1']], ['رقم الفاتورة', U], [['A-1', 'U1']]);
  // fail the part write the way a full disk / revoked permission would
  const real = dir.getFileHandle.bind(dir);
  dir.getFileHandle = async (name, opts) => {
    if (/COMBINED.*\.xlsx$/.test(name)) throw new Error('disk full');
    return real(name, opts);
  };

  await assert.rejects(() => mergeFolder(ExcelJS, dir, { onStatus: () => {} }), /disk full/);

  const left = [...dir.files.keys()].filter((n) => /\.jsonl$/i.test(n));
  assert.deepEqual(left, [], `scratch removed on the failure path too, got ${JSON.stringify(left)}`);
});

test('T-074 merge: parts split on the row caps that keep a part inside browser memory', async () => {
  const dir = fakeDir();
  const U = 'الرقم الإلكترونى';
  // 5 invoices, 2 line rows each, in one source file
  const sum = [], lines = [];
  for (let i = 1; i <= 5; i++) { sum.push([i, 'U' + i]); lines.push(['L' + i + 'a', 'U' + i], ['L' + i + 'b', 'U' + i]); }
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', ['مسلسل', U], sum, ['رقم الفاتورة', U], lines);

  await mergeFolder(ExcelJS, dir, { onStatus: () => {}, partSum: 2, partLine: 1e9 });

  const parts = [...dir.files.keys()].filter((n) => /COMBINED.*\.xlsx$/.test(n)).sort();
  assert.equal(parts.length, 3, `5 invoices at 2 per part -> 3 parts, got ${JSON.stringify(parts)}`);

  // serial numbering stays continuous 1..5 across the parts, and every invoice survives exactly once
  const serials = [], uuids = [];
  for (const nm of [parts.find((n) => !/_part/.test(n)), ...parts.filter((n) => /_part/.test(n))]) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await (await dir.getFileHandle(nm)).getFile()).arrayBuffer());
    const s0 = wb.worksheets[0], hdr = s0.getRow(1).values.slice(1);
    for (let rn = 2; rn <= s0.actualRowCount; rn++) { const v = s0.getRow(rn).values; serials.push(v[1]); uuids.push(v[hdr.indexOf(U) + 1]); }
  }
  assert.deepEqual(serials, [1, 2, 3, 4, 5], 'serial runs continuously across parts');
  assert.deepEqual(uuids.sort(), ['U1', 'U2', 'U3', 'U4', 'U5'], 'no invoice dropped or duplicated at a part boundary');
});

test('T-075 merge: line rows alone can trigger a split (invoices with many lines)', async () => {
  const dir = fakeDir();
  const U = 'الرقم الإلكترونى';
  const sum = [], lines = [];
  for (let i = 1; i <= 4; i++) { sum.push([i, 'U' + i]); for (let k = 0; k < 3; k++) lines.push(['L' + i + '-' + k, 'U' + i]); }
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', ['مسلسل', U], sum, ['رقم الفاتورة', U], lines);

  // summary cap is out of reach; only the line cap can split this
  await mergeFolder(ExcelJS, dir, { onStatus: () => {}, partSum: 1e9, partLine: 3 });

  const parts = [...dir.files.keys()].filter((n) => /COMBINED.*\.xlsx$/.test(n));
  assert.ok(parts.length > 1, `line-row cap splits the run, got ${parts.length} part(s)`);
  let total = 0;
  for (const nm of parts) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await (await dir.getFileHandle(nm)).getFile()).arrayBuffer());
    total += wb.worksheets[1].actualRowCount - 1;
  }
  assert.equal(total, 12, 'every line row lands in exactly one part');
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
