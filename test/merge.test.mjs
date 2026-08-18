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

const sumFile = (dir) => [...dir.files.keys()].find((n) => /COMBINED_SUMMARY.*\.xlsx$/.test(n));
const detFile = (dir) => [...dir.files.keys()].find((n) => /COMBINED_DETAILS.*\.xlsx$/.test(n));
const sumFiles = (dir) => [...dir.files.keys()].filter((n) => /COMBINED_SUMMARY.*\.xlsx$/.test(n));
const detFiles = (dir) => [...dir.files.keys()].filter((n) => /COMBINED_DETAILS.*\.xlsx$/.test(n));
const load = async (dir, nm) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await (await dir.getFileHandle(nm)).getFile()).arrayBuffer()); return wb.worksheets[0]; };

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

  assert.ok(sumFile(dir), 'combined summary xlsx written');
  const s0 = await load(dir, sumFile(dir));
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

  const s1 = await load(dir, detFile(dir));
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

  for (const [label, nm] of [['summary', sumFile(dir)], ['details', detFile(dir)]]) {
    const sheet = label;
    const s = await load(dir, nm);
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

test('T-074 output rolls over to a new file at the row cap, without losing or renumbering rows', async () => {
  const dir = fakeDir();
  const U = 'الرقم الإلكترونى';
  const sum = [], lines = [];
  for (let i = 1; i <= 5; i++) { sum.push([i, 'U' + i]); lines.push(['L' + i + 'a', 'U' + i], ['L' + i + 'b', 'U' + i]); }
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', ['مسلسل', U], sum, ['رقم الفاتورة', U], lines);

  await mergeFolder(ExcelJS, dir, { onStatus: () => {}, rowCap: 2 });

  const files = sumFiles(dir);
  assert.equal(files.length, 3, `5 invoices at 2 per file -> 3 summary files, got ${JSON.stringify(files)}`);

  const serials = [], uuids = [];
  for (const nm of files.sort()) {
    const s0 = await load(dir, nm);
    const hdr = s0.getRow(1).values.slice(1);
    for (let rn = 2; rn <= s0.actualRowCount; rn++) { const v = s0.getRow(rn).values; serials.push(v[1]); uuids.push(v[hdr.indexOf(U) + 1]); }
  }
  assert.deepEqual(serials.sort((a, b) => a - b), [1, 2, 3, 4, 5], 'serial runs continuously across files');
  assert.deepEqual(uuids.sort(), ['U1', 'U2', 'U3', 'U4', 'U5'], 'no invoice dropped or duplicated at a boundary');
});

test('T-075 the details file rolls over on its own, independently of the summary', async () => {
  const dir = fakeDir();
  const U = 'الرقم الإلكترونى';
  const sum = [], lines = [];
  for (let i = 1; i <= 4; i++) { sum.push([i, 'U' + i]); for (let k = 0; k < 3; k++) lines.push(['L' + i + '-' + k, 'U' + i]); }
  await putXlsx(dir, 'eInvoices_2026_Sent_a.xlsx', ['مسلسل', U], sum, ['رقم الفاتورة', U], lines);

  await mergeFolder(ExcelJS, dir, { onStatus: () => {}, rowCap: 4 });

  // 4 summary rows fit one file; 12 line rows cannot — the two split independently (SPEC-014)
  assert.equal(sumFiles(dir).length, 1, 'summary stays a single file');
  assert.ok(detFiles(dir).length > 1, `details rolled over, got ${detFiles(dir).length}`);
  let total = 0;
  for (const nm of detFiles(dir)) total += (await load(dir, nm)).actualRowCount - 1;
  assert.equal(total, 12, 'every line row lands in exactly one file');
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
  assert.ok(sumFile(dir), 'the readable rows still produce a combined file');
});

test('T-229 uuid-run files and the folder-wide merge are invisible to each other (SPEC-022)', async () => {
  const { uuidMergeScope, chunkFile } = await import('../src/core/store.js');
  const dir = fakeDir();
  const U = 'الرقم الإلكترونى';

  // a normal range chunk + a uuid-run chunk in the SAME folder
  await putXlsx(dir, 'eInvoices_2025_Sent_a.xlsx',
    ['مسلسل', 'الحالة', U], [[1, 'Valid', 'R1']], ['رقم الفاتورة', U], [['A-1', 'R1']]);
  const plan = { mode: 'uuids', key: 'uuids_k1', source: 'invoices', year: '2026', dir: 'uuids', dateField: 'Uuid', statuses: [] };
  const chunk = { id: 'uuids_0', label: 'UUIDs 1-2' };
  const uuidFile = chunkFile(plan, chunk);
  assert.ok(uuidFile.startsWith('eInvoicesUuid_'), uuidFile);
  await putXlsx(dir, uuidFile,
    ['مسلسل', 'الحالة', U], [[1, 'Valid', 'X1'], [2, 'Valid', 'X2']], ['رقم الفاتورة', U], [['B-1', 'X1'], ['B-2', 'X2']]);

  // direction 1: the folder-wide merge consumes ONLY the range file
  await mergeFolder(ExcelJS, dir, { onStatus: () => {} });
  const wideSum = await load(dir, sumFile(dir));
  assert.equal(wideSum.actualRowCount - 1, 1, 'folder-wide COMBINED holds only the range row');
  assert.ok(!JSON.stringify(new TextDecoder().decode(dir.files.get([...dir.files.keys()].find((n) => n === 'eta_merge_state.json')))).includes('X1'),
    'the folder-wide state never consumed a uuid-run uuid');

  // direction 2: the scoped merge consumes ONLY its own run's files, under its own state
  const scope = uuidMergeScope(plan);
  const log = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log.push(m), scope });
  const scopedSum = [...dir.files.keys()].find((n) => n.startsWith(scope.prefix) && /COMBINED_SUMMARY/.test(n));
  assert.ok(scopedSum, 'scoped COMBINED written under the uuid prefix');
  assert.equal((await load(dir, scopedSum)).actualRowCount - 1, 2, 'scoped COMBINED holds exactly the uuid rows');
  assert.ok(dir.files.has(scope.stateFile), 'scoped merge keeps its own state file');
  assert.ok(dir.files.has('eta_merge_state.json'), 'the folder-wide state survives untouched');

  // and the folder-wide merge, re-run, still ignores everything the scoped one produced
  const log2 = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log2.push(m) });
  assert.equal((await load(dir, sumFile(dir))).actualRowCount - 1, 1, 'still only the range row');
});
