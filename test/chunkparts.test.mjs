// SPEC-027 T-258..T-261 — split chunk render: streamed detail parts beside the summary workbook,
// and merge's grouping of a chunk's parts back onto its summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildRows, renderWorkbook, renderFromRows } from '../src/export/xlsx.js';
import { writeDetailParts, createDetailSink } from '../src/export/chunkparts.js';
import { chunkFile, chunkDetailFile, detailParentOf, CHUNK_DET_RE } from '../src/core/store.js';
import { mergeFolder } from '../src/core/merge.js';

// same in-memory FSA shim as merge.test.mjs
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

const U = 'الرقم الإلكترونى';
const loadSheet = async (dir, nm, i = 0) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await (await dir.getFileHandle(nm)).getFile()).arrayBuffer()); return wb.worksheets[i]; };

const rec = (uuid, nLines) => ({ search: {}, detail: {
  uuid, internalID: 'INV-' + uuid, documentTypeNamePrimaryLang: 'Invoice', documentTypeNameSecondaryLang: 'فاتورة',
  documentTypeVersion: '1.0', status: 'Valid', dateTimeIssued: '2025-03-01T10:00:00Z', dateTimeRecevied: '2025-03-01T11:00:00Z',
  currenciesSold: 'EGP', totalSales: 10, netAmount: 10, totalAmount: 10,
  issuer: { id: '100', name: 'Seller' }, receiver: { id: '200', name: 'Buyer' },
  invoiceLines: Array.from({ length: nLines }, (_, i) => ({ itemCode: 'EG-1', description: 'item ' + i, quantity: 1, salesTotal: 1, netTotal: 1, total: 1, unitValue: { amountEGP: 1 } })),
} });

test('T-258 buildRows/renderFromRows refactor pin: renderWorkbook output and rows unchanged', () => {
  const records = [rec('U1', 2), rec('U2', 3)];
  const built = buildRows(records, 'invoices', {});
  const r = renderWorkbook(ExcelJS, records, 'invoices', {});
  assert.deepEqual(r.summaryRows, built.summaryRows, 'renderWorkbook uses exactly buildRows\' summary rows');
  assert.deepEqual(r.lineRows, built.lineRows, 'renderWorkbook uses exactly buildRows\' line rows');
  assert.equal(r.workbook.worksheets.length, 2);
  assert.equal(r.workbook.worksheets[1].actualRowCount, built.lineRows.length + 1, 'lines sheet holds every line row');

  const headerOnly = renderFromRows(ExcelJS, built, { includeLines: false });
  assert.equal(headerOnly.workbook.worksheets[0].actualRowCount, built.summaryRows.length + 1, 'summary intact');
  assert.equal(headerOnly.workbook.worksheets[1].actualRowCount, 1, 'lines sheet is header-only in the split-chunk summary workbook');
  assert.equal(headerOnly.workbook.worksheets[1].name, r.workbook.worksheets[1].name, 'lines sheet keeps its mapped name');
});

test('T-259 writeDetailParts: capped parts, no invoice straddles two parts, names round-trip to the parent', async () => {
  const dir = fakeDir();
  const built = buildRows([rec('U1', 4), rec('U2', 4), rec('U3', 4), rec('U4', 4), rec('U5', 1)], 'invoices', {});
  assert.equal(built.lineRows.length, 17);
  const names = [];
  const parts = await writeDetailParts(dir, (i) => { const n = `eInvoices_x_det_p${String(i).padStart(2, '0')}.xlsx`; names.push(n); return n; }, built, { rowCap: 10 });
  // 4+4 = 8 fits; 8+4 > 10 rotates; the trailing 1-liner tops part 2 up to 9: parts of [8, 9].
  assert.deepEqual(parts, names);
  assert.equal(parts.length, 2);
  const perPartUuids = [];
  const counts = [];
  for (const p of parts) {
    const ws = await loadSheet(dir, p);
    counts.push(ws.actualRowCount - 1);
    const hdr = ws.getRow(1).values.slice(1);
    const uCol = hdr.indexOf(U) + 1;
    assert.ok(uCol > 0, 'part carries the uuid column merge joins on');
    const us = new Set();
    ws.eachRow((row, rn) => { if (rn > 1) us.add(row.values[uCol]); });   // row.values is 1-based
    perPartUuids.push(us);
  }
  assert.deepEqual(counts, [8, 9], 'rows split at the cap without splitting an invoice');
  for (let a = 0; a < perPartUuids.length; a++) for (let b = a + 1; b < perPartUuids.length; b++)
    for (const u of perPartUuids[a]) assert.ok(!perPartUuids[b].has(u), `invoice ${u} must not straddle parts ${a} and ${b}`);

  const plan = { mode: 'range', source: 'invoices', year: '2025', dir: 'Received', dateField: 'Issue', statuses: [] };
  const chunk = { id: '2025-03-01_2025-03-02', label: 'Mar 1-2' };
  const det3 = chunkDetailFile(plan, chunk, 3);
  assert.ok(CHUNK_DET_RE.test(det3));
  assert.equal(detailParentOf(det3), chunkFile(plan, chunk), 'a part name maps back to its summary file');
});

test('T-270 the sink keeps a chunk in ONE file until it genuinely outgrows it, then rolls at the cap', async () => {
  const dir = fakeDir();
  const nameOf = (i) => `eInvoices_x_det_p${String(i).padStart(2, '0')}.xlsx`;
  // Small chunk, several batches: stays inline, no file is written at all.
  const small = createDetailSink(dir, nameOf, { inlineMax: 10, rowCap: 20 });
  await small.add(buildRows([rec('U1', 3), rec('U2', 3)], 'invoices', {}));
  await small.add(buildRows([rec('U3', 3)], 'invoices', {}));
  const outSmall = await small.finish();
  assert.equal(outSmall.mode, 'inline', 'under the budget it is one workbook, batches notwithstanding');
  assert.equal(outSmall.rows.length, 9);
  assert.equal(dir.files.size, 0, 'no part file is created for a chunk that fits');
  assert.ok(outSmall.cols.length, 'the caller still gets the line columns for the sheet');

  // Big chunk: crosses the budget → spills, then rolls only at the row cap, never mid-invoice.
  const big = createDetailSink(dir, nameOf, { inlineMax: 10, rowCap: 20 });
  for (let b = 0; b < 4; b++) await big.add(buildRows([rec('B' + b + 'a', 6), rec('B' + b + 'b', 6)], 'invoices', {}));
  const outBig = await big.finish();
  assert.equal(outBig.mode, 'parts');
  assert.equal(outBig.parts.length, 3, '48 rows at a 20-row cap, respecting 6-row invoices → 18/18/12');
  const counts = [];
  const seen = [];
  for (const p of outBig.parts) {
    const ws = await loadSheet(dir, p);
    counts.push(ws.actualRowCount - 1);
    const uCol = ws.getRow(1).values.slice(1).indexOf(U) + 1;
    const us = new Set();
    ws.eachRow((row, rn) => { if (rn > 1) us.add(row.values[uCol]); });
    seen.push(us);
  }
  assert.deepEqual(counts, [18, 18, 12], 'parts fill to the cap without splitting an invoice');
  for (let a = 0; a < seen.length; a++) for (let b = a + 1; b < seen.length; b++)
    for (const u of seen[a]) assert.ok(!seen[b].has(u), `invoice ${u} must live in exactly one part`);
});

test('T-280 a column that first appears in a LATER batch is not silently dropped (F-3)', async () => {
  // The 2026-08-20 review reproduced this: a part pins its header when it opens, so a tax type or a
  // discount first seen in batch k+1 was written against batch k's narrower header and discarded —
  // and the merged DETAILS file then shows an empty tax cell, indistinguishable from an untaxed
  // line. Column growth must rotate the part.
  const dir = fakeDir();
  const nameOf = (i) => `eInvoices_g_det_p${String(i).padStart(2, '0')}.xlsx`;
  const plain = rec('P1', 2);                                   // no taxes, no discounts
  const taxed = rec('T1x', 2);
  taxed.detail.taxTotals = [{ taxType: 'T1', amount: 14 }];
  taxed.detail.invoiceLines.forEach((l) => { l.lineTaxableItems = [{ taxType: 'T1', rate: 14, amount: 7 }]; });

  const sink = createDetailSink(dir, nameOf, { inlineMax: 1, rowCap: 500 });
  await sink.add(buildRows([plain], 'invoices', { taxColumns: true }));   // opens a part with the narrow header
  await sink.add(buildRows([taxed], 'invoices', { taxColumns: true }));   // introduces T1 + T1%
  const out = await sink.finish();

  assert.equal(out.mode, 'parts');
  assert.ok(out.parts.length >= 2, 'the new column rotated the part instead of being written into the old header');
  // The tax amount (7 per line) must physically exist in some part file. Before the fix the taxed
  // batch was written against the 29-column header and the value had nowhere to go.
  const widths = [], sawTax = [];
  for (const p of out.parts) {
    const ws = await loadSheet(dir, p);
    widths.push(ws.getRow(1).values.slice(1).length);
    ws.eachRow((row, rn) => { if (rn > 1) for (const v of row.values) if (Number(v) === 7) sawTax.push(p); });
  }
  assert.ok(widths.some((w) => w > widths[0]), `a wider header exists after the column appeared (${widths.join(',')})`);
  assert.ok(sawTax.length >= 2, 'both taxed line rows carry their tax amount into a part file');
});

test('T-260 merge joins a split chunk (summary + parts) identically to the legacy single file', async () => {
  const mkLegacy = async (dir) => {
    const wb = new ExcelJS.Workbook();
    const s0 = wb.addWorksheet('جميع الفواتير'); s0.addRow(['مسلسل', 'الحالة', U]); s0.addRow([1, 'Valid', 'U1']); s0.addRow([2, 'Valid', 'U2']);
    const s1 = wb.addWorksheet('بيانات الفواتير'); s1.addRow(['رقم الفاتورة', U]);
    s1.addRow(['A-1a', 'U1']); s1.addRow(['A-1b', 'U1']); s1.addRow(['A-2a', 'U2']);
    const buf = await wb.xlsx.writeBuffer();
    const fh = await dir.getFileHandle('eInvoices_2025_Received_chunkA.xlsx', { create: true }); const w = await fh.createWritable(); await w.write(new Uint8Array(buf)); await w.close();
  };
  const mkSplit = async (dir) => {
    const wb = new ExcelJS.Workbook();
    const s0 = wb.addWorksheet('جميع الفواتير'); s0.addRow(['مسلسل', 'الحالة', U]); s0.addRow([1, 'Valid', 'U1']); s0.addRow([2, 'Valid', 'U2']);
    wb.addWorksheet('بيانات الفواتير').addRow(['رقم الفاتورة', U]);   // header-only lines sheet
    const buf = await wb.xlsx.writeBuffer();
    const fh = await dir.getFileHandle('eInvoices_2025_Received_chunkA.xlsx', { create: true }); const w = await fh.createWritable(); await w.write(new Uint8Array(buf)); await w.close();
    const part = async (name, rows) => {
      const pwb = new ExcelJS.Workbook();
      const ps = pwb.addWorksheet('بيانات الفواتير'); ps.addRow(['رقم الفاتورة', U]); rows.forEach((r) => ps.addRow(r));
      const pbuf = await pwb.xlsx.writeBuffer();
      const pfh = await dir.getFileHandle(name, { create: true }); const pw = await pfh.createWritable(); await pw.write(new Uint8Array(pbuf)); await pw.close();
    };
    await part('eInvoices_2025_Received_chunkA_det_p01.xlsx', [['A-1a', 'U1'], ['A-1b', 'U1']]);
    await part('eInvoices_2025_Received_chunkA_det_p02.xlsx', [['A-2a', 'U2']]);
  };
  const detailRows = async (dir) => {
    const det = [...dir.files.keys()].find((n) => /COMBINED_DETAILS.*\.xlsx$/.test(n));
    assert.ok(det, 'combined details written');
    const ws = await loadSheet(dir, det);
    const rows = [];
    ws.eachRow((row, rn) => { if (rn > 1) rows.push(row.values.slice(1).map((v) => String(v ?? ''))); });
    return rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  };

  const dirL = fakeDir(); await mkLegacy(dirL); await mergeFolder(ExcelJS, dirL, { onStatus: () => {} });
  const dirS = fakeDir(); await mkSplit(dirS); await mergeFolder(ExcelJS, dirS, { onStatus: () => {} });
  const L = await detailRows(dirL), S = await detailRows(dirS);
  assert.equal(S.length, 3, 'all three line rows joined across both parts');
  assert.deepEqual(S, L, 'a split chunk merges to exactly what the legacy single file produced');
});

test('T-261 orphan parts: skipped loudly in a full merge; a new orphan in incremental forces a rebuild', async () => {
  const dir = fakeDir();
  // one healthy legacy chunk
  const wb = new ExcelJS.Workbook();
  const s0 = wb.addWorksheet('جميع الفواتير'); s0.addRow(['مسلسل', 'الحالة', U]); s0.addRow([1, 'Valid', 'U1']);
  const s1 = wb.addWorksheet('بيانات الفواتير'); s1.addRow(['رقم الفاتورة', U]); s1.addRow(['A-1', 'U1']);
  const buf = await wb.xlsx.writeBuffer();
  const fh = await dir.getFileHandle('eInvoices_2025_Received_ok.xlsx', { create: true }); const w = await fh.createWritable(); await w.write(new Uint8Array(buf)); await w.close();
  // an orphan part whose parent never landed (crashed chunk write)
  const pwb = new ExcelJS.Workbook();
  const ps = pwb.addWorksheet('بيانات الفواتير'); ps.addRow(['رقم الفاتورة', U]); ps.addRow(['B-1', 'U9']);
  const pbuf = await pwb.xlsx.writeBuffer();
  const pfh = await dir.getFileHandle('eInvoices_2025_Received_gone_det_p01.xlsx', { create: true }); const pw = await pfh.createWritable(); await pw.write(new Uint8Array(pbuf)); await pw.close();

  const log1 = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log1.push(m) });
  assert.ok(log1.some((m) => m.includes('gone_det_p01')), 'the orphan part is named in a warn, not silently ignored');
  const det = [...dir.files.keys()].find((n) => /COMBINED_DETAILS.*\.xlsx$/.test(n));
  const ws = await loadSheet(dir, det);
  assert.equal(ws.actualRowCount - 1, 1, "the orphan's rows (no summary to join) are not smuggled into the output");

  // incremental: a NEW orphan part appears after a clean merge → the conservative full rebuild
  const p2 = await dir.getFileHandle('eInvoices_2025_Received_gone2_det_p01.xlsx', { create: true }); const w2 = await p2.createWritable(); await w2.write(new Uint8Array(pbuf)); await w2.close();
  const log2 = [];
  await mergeFolder(ExcelJS, dir, { onStatus: (m) => log2.push(m) });
  assert.ok(log2.some((m) => m.includes('من البداية') || /rebuild/i.test(m)), 'a new orphan part in incremental mode triggers the rebuild path');
});
