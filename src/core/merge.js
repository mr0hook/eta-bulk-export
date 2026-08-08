// Streaming two-phase merge (bounded memory, scales to any file count). Reads the run's
// per-chunk xlsx (fidelity-preserving), dedups by UUID, unions headers by name, and writes
// auto-split combined parts. Phase 1: xlsx -> canonical JSONL (only the UUID Set held).
// Phase 2: JSONL -> xlsx parts (one part's rows in memory at a time).
import { listFiles, readArrayBuffer, openWrite, readLines, writeBlob, remove } from './fs.js';
import { XLSX_MIME } from '../export/xlsx.js';
import { t } from './i18n.js';

const UUID = 'الرقم الإلكترونى', SERIAL = 'مسلسل';
const RTL = { rightToLeft: true, rtl: true, activeCell: 'A1', state: 'frozen', ySplit: 1 };
// Part size is bounded by MEMORY, not by Excel's 1,048,576-row sheet limit: the vendored browser build of
// ExcelJS has no streaming writer, so a whole part lives in its object model until writeBuffer() zips it.
// Measured on realistic ETA columns: ~9.5KB of heap per row to build, and writeBuffer peaks ~1.4x that.
// 72k rows/part peaks near 950MB and completes; 90k rows/part dies with "heap out of memory". These caps
// keep the peak under ~1GB, which a portal tab can afford. Raising them brings the OOM straight back.
const PART_SUM = 12000, PART_LINE = 60000;
const TEMP_RE = /^e(Invoices|Receipts)_COMBINED_.*\.jsonl$/i;   // scratch only — never a deliverable
const FLUSH_CHARS = 1 << 20;                                    // batch scratch writes ~1MB at a time

const uuidKeyOf = (hdr) => hdr.includes(UUID) ? UUID : (hdr.find((h) => typeof h === 'string' && (h.indexOf('\u0625\u0644\u0643\u062A\u0631\u0648\u0646') >= 0 || /^uuid$/i.test(h.trim()))) || UUID);
const addCols = (into, hdr) => { for (const h of hdr) if (h != null && h !== '' && !into.includes(h)) into.push(h); };
const toObj = (hdr, vals) => { const o = {}; for (let i = 0; i < hdr.length; i++) { const h = hdr[i]; if (h != null && h !== '') o[h] = vals[i]; } return o; };
// Normalize header strings so the same Arabic column in two Unicode forms (NFC/NFD) isn't unioned as two columns.
const nfcHdr = (arr) => arr.map((h) => (typeof h === 'string' ? h.normalize('NFC') : h));

export async function mergeFolder(ExcelJS, dir, { onStatus = () => {}, partSum = PART_SUM, partLine = PART_LINE } = {}) {
  if (!ExcelJS) { onStatus(t('merge.noExcel')); return; }
  const files = (await listFiles(dir, /^e(Invoices|Receipts)_.*\.xlsx$/i)).filter((n) => !/COMBINED/i.test(n));
  if (!files.length) { onStatus(t('merge.noFiles')); return; }
  // Sweep scratch files an earlier run left behind. Pre-fix versions only unlinked the temp on the happy
  // path, so a crashed merge stranded a multi-GB .jsonl in the user's export folder for good.
  for (const stale of await listFiles(dir, TEMP_RE)) { try { await remove(dir, stale); } catch {} }
  const prefix = /^eReceipts/i.test(files[0]) ? 'eReceipts' : 'eInvoices';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonl = `${prefix}_COMBINED_${stamp}.jsonl`;
  const sumCols = [], lineCols = [], sheetNames = { s0: '', s1: '' };
  const seen = new Set();
  let sink = null;

  try {
    // ---- Phase 1: read each xlsx once -> dedup -> stream JSONL ----
    let uniq = 0, fi = 0; const failed = [];
    sink = await openWrite(dir, jsonl);
    for (const name of files) {
      fi++;
      let wb; try { wb = new ExcelJS.Workbook(); await wb.xlsx.load(await readArrayBuffer(dir, name)); }
      catch { failed.push(name); onStatus(t('merge.skipped', { name })); continue; }
      const s0 = wb.worksheets[0];
      const s1 = wb.worksheets[1] && wb.worksheets[1] !== s0 ? wb.worksheets[1] : null;
      const localSum = new Map(), localLines = new Map(), order = [];
      if (s0) {
        if (!sheetNames.s0) sheetNames.s0 = s0.name;
        const hdr = nfcHdr(s0.getRow(1).values.slice(1)); const uk = uuidKeyOf(hdr); addCols(sumCols, hdr);
        s0.eachRow((row, rn) => { if (rn === 1) return; const o = toObj(hdr, row.values.slice(1)); const u = o[uk]; if (u == null || seen.has(u)) return; seen.add(u); localSum.set(u, o); order.push(u); });
      }
      if (s1) {
        if (!sheetNames.s1) sheetNames.s1 = s1.name;
        const hdr = nfcHdr(s1.getRow(1).values.slice(1)); const uk = uuidKeyOf(hdr); addCols(lineCols, hdr);
        s1.eachRow((row, rn) => { if (rn === 1) return; const o = toObj(hdr, row.values.slice(1)); const u = o[uk]; if (u == null || !localSum.has(u)) return; if (!localLines.has(u)) localLines.set(u, []); localLines.get(u).push(o); });
      }
      let buf = '';
      for (const u of order) {
        uniq++; buf += JSON.stringify({ sum: localSum.get(u), lines: localLines.get(u) || [] }) + '\n';
        if (buf.length >= FLUSH_CHARS) { await sink.write(buf); buf = ''; }   // bound the in-flight string
      }
      if (buf) await sink.write(buf);
      onStatus(t('merge.phase1', { i: fi, n: files.length, uniq }));
    }
    await sink.close(); sink = null;   // must land on disk before Phase 2 reads it back
    if (!uniq) { onStatus(t('merge.noRows')); return; }
    if (sumCols.includes(SERIAL)) sumCols.splice(sumCols.indexOf(SERIAL), 1);
    sumCols.unshift(SERIAL);

    // ---- Phase 2: stream JSONL -> xlsx parts (auto-split; continuous serial) ----
    let part = 0, serial = 1, wb = null, ws0 = null, ws1 = null, curSum = 0, curLine = 0;
    const newPart = () => {
      part++; wb = new ExcelJS.Workbook();
      ws0 = wb.addWorksheet(sheetNames.s0 || 'Summary', { views: [RTL] });
      ws1 = wb.addWorksheet(sheetNames.s1 || 'Details', { views: [RTL] });
      ws0.addRow(sumCols); ws1.addRow(lineCols); curSum = 0; curLine = 0;
    };
    const flush = async () => {
      if (!wb || curSum === 0) return;
      const out = await wb.xlsx.writeBuffer();
      const nm = part === 1 ? `${prefix}_COMBINED_${stamp}.xlsx` : `${prefix}_COMBINED_${stamp}_part${part}.xlsx`;
      await writeBlob(dir, nm, new Blob([out], { type: XLSX_MIME }));
      wb = null; ws0 = null; ws1 = null;   // drop the part's object model before the next one is built
      onStatus(t('merge.phase2', { name: nm }));
    };
    const emit = async (rec) => {
      if (!rec || !rec.sum) return;
      if (!wb) newPart();
      if (curSum >= partSum || curLine >= partLine) { await flush(); newPart(); }
      const s = { ...rec.sum, [SERIAL]: serial++ };
      ws0.addRow(sumCols.map((c) => s[c] ?? '')); curSum++;
      for (const l of rec.lines || []) { ws1.addRow(lineCols.map((c) => l[c] ?? '')); curLine++; }
    };
    for await (const line of readLines(dir, jsonl)) { if (line.trim()) { let rec; try { rec = JSON.parse(line); } catch {} if (rec) await emit(rec); } }
    await flush();
    const read = files.length - failed.length;
    const warn = failed.length ? t('merge.warnTail', { n: failed.length, names: failed.slice(0, 5).join(', ') + (failed.length > 5 ? '…' : '') }) : '';
    onStatus(t('merge.summary', { icon: failed.length ? '⚠️' : '✅', read, n: files.length, uniq, parts: part, cols: sumCols.length, warn }));
  } finally {
    // The .jsonl is scratch, never a deliverable — it must not outlive the merge, error or not.
    try { await sink?.close(); } catch {}
    try { await remove(dir, jsonl); } catch {}
  }
}
