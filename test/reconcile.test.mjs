// SPEC-040 — the merge's closing reconciliation.
//
// On 2026-08-20 a merge of 2024 Q1 reported "✅ Merged 69/69 files → 230,545 unique → 3 parts" and
// looked flawless. The run had planned 240,351 documents. 9,806 were simply not in the files: no
// failed chunk, no failures file, nothing on screen that could have told anyone. "69/69 files" only
// ever meant every file was READ — never that every document was IN them.
//
// The comparison has to be against summary ROWS READ, not unique: the planner cuts on an inclusive
// shared boundary, so a document sitting exactly on a cut is fetched by BOTH neighbours and counted
// twice in the plan. Comparing unique against the plan would report that as loss on a healthy run.
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { mergeFolder } from '../src/core/merge.js';
import { chunkFile, writeProgress } from '../src/core/store.js';

function fakeDir() {
  const files = new Map();
  const enc = new TextEncoder();
  const toU8 = async (x) => (x instanceof Uint8Array ? x : (typeof x === 'string' ? enc.encode(x) : new Uint8Array(await x.arrayBuffer())));
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

const U = 'الرقم الإلكترونى';
async function putChunk(dir, name, uuids) {
  const wb = new ExcelJS.Workbook();
  const s0 = wb.addWorksheet('جميع الفواتير'); s0.addRow(['مسلسل', 'الحالة', U]);
  uuids.forEach((u, i) => s0.addRow([i + 1, 'Valid', u]));
  const s1 = wb.addWorksheet('بيانات الفواتير'); s1.addRow(['رقم الفاتورة', U]);
  uuids.forEach((u) => s1.addRow(['L-' + u, u]));
  const buf = await wb.xlsx.writeBuffer();
  const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable();
  await w.write(new Uint8Array(buf)); await w.close();
}

// counts[] are what the PLAN says each chunk holds; held[] are the uuids actually in its file.
async function folder(counts, held) {
  const dir = fakeDir();
  const plan = {
    v: 1, key: 'recon_key', source: 'invoices', year: '2025', dir: 'Sent', dateField: 'Issue',
    statuses: ['Valid', 'Invalid', 'Rejected', 'Cancelled'], mode: 'range',
    from: '2025-01-01', to: '2025-02-28', cap: 10000, rinFilter: [],
    totalRows: counts.reduce((s, n) => s + n, 0),
    chunks: counts.map((n, i) => ({ id: 'c' + i, label: '2025-0' + (i + 1), count: n, fromISO: `2025-0${i + 1}-01T00:00:00Z`, toISO: `2025-0${i + 1}-28T23:59:59Z` })),
    doneIds: counts.map((_, i) => 'c' + i), failedIds: [],
  };
  for (const [i, uuids] of held.entries()) if (uuids) await putChunk(dir, chunkFile(plan, plan.chunks[i]), uuids);
  await writeProgress(dir, plan, 'complete');
  const log = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log.push(m) });
  return { dir, log, last: log[log.length - 1] };
}

test('T-291 a chunk holding fewer documents than it was planned with is reported, not celebrated', async () => {
  // Chunk 2 was planned with 3 and its file holds 2 — the 2024 Q1 shape, scaled down.
  const { log, last } = await folder([2, 3], [['U1', 'U2'], ['U3', 'U4']]);
  assert.ok(log.some((m) => /Merged 2\/2 files/.test(m)), 'the old summary still says every file was read');
  assert.match(last, /INCOMPLETE/, 'and the LAST word is that the export is not complete');
  assert.match(last, /plan says 5 documents, the files hold 4/);
  assert.match(last, /ARE here: 1/, 'the shortfall is inside a file that exists → Resume refetches that chunk');
});

test('T-292 boundary duplicates are NOT loss — a healthy folder reconciles clean', async () => {
  // U2 sits exactly on the cut, so both neighbours fetched it and the plan counted it twice: 4 rows
  // present, 3 unique, plan says 4. Comparing unique against the plan would call this a lost
  // document on a completely healthy export, and that false alarm would train the user to ignore it.
  const { log, last } = await folder([2, 2], [['U1', 'U2'], ['U2', 'U3']]);
  assert.match(last, /Reconciled against the plan: 4 documents planned, 4 present/);
  assert.ok(!log.some((m) => /INCOMPLETE/.test(m)));
});

test('T-293 a chunk with no file at all is named separately — that is an unfinished run, not loss', async () => {
  const { last } = await folder([2, 3], [['U1', 'U2'], null]);
  assert.match(last, /plan says 5 documents, the files hold 2/);
  assert.match(last, /no file at all: 3/, 'a missing chunk is a different problem from a short one');
});

test('T-294 a filtered run is not reconciled — its chunk counts are the unfiltered window totals', async () => {
  // A status-filtered run legitimately writes fewer rows than the plan's counts. Reporting that as
  // loss would make the check noise, and noise is how the real one gets ignored.
  const dir = fakeDir();
  const plan = {
    v: 1, key: 'filt_key', source: 'invoices', year: '2025', dir: 'Sent', dateField: 'Issue',
    statuses: ['Valid'], mode: 'range', from: '2025-01-01', to: '2025-01-31', cap: 10000, rinFilter: [],
    totalRows: 100, chunks: [{ id: 'c0', label: '2025-01', count: 100, fromISO: '2025-01-01T00:00:00Z', toISO: '2025-01-31T23:59:59Z' }],
    doneIds: ['c0'], failedIds: [],
  };
  await putChunk(dir, chunkFile(plan, plan.chunks[0]), ['U1', 'U2']);
  await writeProgress(dir, plan, 'complete');
  const log = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log.push(m) });
  assert.ok(!log.some((m) => /INCOMPLETE|Reconciled/.test(m)), 'says nothing rather than guessing');
});
