// Streaming two-phase merge (bounded memory, scales to any file count). Reads the run's
// per-chunk xlsx (fidelity-preserving), dedups by UUID, unions headers by name, and writes the
// combined output. Phase 1: xlsx -> canonical JSONL (only the UUID Set held).
// Phase 2: JSONL -> two single-sheet xlsx files, written straight to disk (SPEC-014), so the only
// row limit left is Excel's own 1,048,576 per sheet — not browser memory.
//
// SPEC-012: the merge is incremental. eta_merge_state.json records what was consumed, so a merge
// after a sync reads only the new chunk files and tops up the last part instead of rebuilding
// everything. Every ambiguity falls back to a full rebuild — see mergestate.decideMode.
import { listFiles, readArrayBuffer, openWrite, readLines, remove } from './fs.js';
import * as ms from './mergestate.js';
import { createRotator } from './mergeout.js';
import { t } from './i18n.js';

const UUID = 'الرقم الإلكترونى', SERIAL = 'مسلسل';
const TEMP_RE = /^e(Invoices|Receipts)_COMBINED_.*\.jsonl$/i;   // scratch only — never a deliverable
const FLUSH_CHARS = 1 << 20;                                    // batch scratch writes ~1MB at a time

// SPEC-013 — the issue-date column, identical in the invoice and receipt schemas. Used only to
// label parts; if the user excluded it, parts fall back to numbers and nothing else changes.
const DATE_COL = 'تاريخ الإصدار';
// dateEg() shifts the instant so it reads as Cairo wall-clock, so the UTC date IS the Cairo day.
const dayOf = (v) => {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ''));
  return m ? m[1] : null;
};

const uuidKeyOf = (hdr) => hdr.includes(UUID) ? UUID : (hdr.find((h) => typeof h === 'string' && (h.indexOf('إلكترون') >= 0 || /^uuid$/i.test(h.trim()))) || UUID);
const addCols = (into, hdr) => { for (const h of hdr) if (h != null && h !== '' && !into.includes(h)) into.push(h); };
const toObj = (hdr, vals) => { const o = {}; for (let i = 0; i < hdr.length; i++) { const h = hdr[i]; if (h != null && h !== '') o[h] = vals[i]; } return o; };
// Normalize header strings so the same Arabic column in two Unicode forms (NFC/NFD) isn't unioned as two columns.
const nfcHdr = (arr) => arr.map((h) => (typeof h === 'string' ? h.normalize('NFC') : h));

// `scope` (SPEC-022): merge ONE uuid run's files instead of the whole folder — { re, prefix,
// stateFile } from store.uuidMergeScope(plan). The folder-wide default regex requires the
// underscore right after e(Invoices|Receipts), so scoped (eInvoicesUuid_…) files and outputs are
// invisible to it by construction; the scoped state file keeps the two merges' incremental
// records from ever touching.
export async function mergeFolder(ExcelJS, dir, { onStatus = () => {}, rowCap, scope } = {}) {
  if (!ExcelJS) { onStatus(t('merge.noExcel')); return; }
  // Sorted so parts come out in roughly chronological order: chunk filenames embed the date label,
  // so name order tracks date order within a run. SPEC-013's period labels are only meaningful if
  // consecutive parts cover consecutive ranges rather than interleaving.
  const files = (await listFiles(dir, scope?.re || /^e(Invoices|Receipts)_.*\.xlsx$/i)).filter((n) => !/COMBINED/i.test(n)).sort();
  if (!files.length) { onStatus(t('merge.noFiles')); return; }
  // Sweep scratch files an earlier run left behind. Pre-fix versions only unlinked the temp on the happy
  // path, so a crashed merge stranded a multi-GB .jsonl in the user's export folder for good.
  const tempRe = scope ? new RegExp('^' + scope.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_COMBINED_.*\\.jsonl$', 'i') : TEMP_RE;
  for (const stale of await listFiles(dir, tempRe)) { try { await remove(dir, stale); } catch {} }
  // Half-written output from a merge that died mid-file. Never a deliverable; always disposable.
  for (const half of await listFiles(dir, ms.WORKING_RE)) { try { await remove(dir, half); } catch {} }
  const prefix = scope?.prefix || (/^eReceipts/i.test(files[0]) ? 'eReceipts' : 'eInvoices');
  const stateFile = scope?.stateFile;

  // ---- mode ----
  let state = await ms.readState(dir, stateFile);
  if (state && !(await ms.partsIntact(dir, state))) { onStatus(t('merge.rebuildParts')); state = null; }
  const sizes = await ms.fileSizes(dir, files);
  let { mode, reason, newFiles } = ms.decideMode(state, files, sizes, prefix);
  if (mode === 'uptodate') { onStatus(t('merge.upToDate', { n: files.length })); return; }
  if (mode === 'full' && state) onStatus(t('merge.rebuild', { reason }));
  if (mode === 'incremental') onStatus(t('merge.incremental', { n: newFiles.length, total: files.length }));

  // Older versions minted a new dated COMBINED set on every merge and abandoned the previous one.
  // Never delete the user's files — just say once that they are superseded. (Legacy names only —
  // scoped runs never produced them.)
  const dated = scope ? [] : await listFiles(dir, ms.DATED_RE);
  if (dated.length) onStatus(t('merge.superseded', { n: dated.length }));

  const out = await runMerge(ExcelJS, dir, {
    onStatus, rowCap, prefix, files, sizes, stateFile,
    read: mode === 'incremental' ? newFiles : files,
    base: mode === 'incremental' ? state : null,
  });
  // Column drift is only visible after reading the new files. Nothing has been written to the output
  // set at that point, so restarting in full mode is clean.
  if (out === 'DRIFT') {
    onStatus(t('merge.driftRebuild'));
    await runMerge(ExcelJS, dir, { onStatus, rowCap, prefix, files, sizes, stateFile, read: files, base: null });
  }
}

async function runMerge(ExcelJS, dir, { onStatus, rowCap, prefix, files, sizes, read, base, stateFile }) {
  const jsonl = `${prefix}_COMBINED_${Date.now().toString(36)}.jsonl`;
  // Seeding from state is what makes the incremental pass correct: without the prior UUIDs it cannot
  // tell a genuinely new invoice from one merged last week, and without the prior column unions the
  // top-up part would be written with a narrower header than the rows already in it.
  const sumCols = base ? [...base.sumCols] : [];
  const lineCols = base ? [...base.lineCols] : [];
  const sheetNames = base ? { ...base.sheetNames } : { s0: '', s1: '' };
  const seen = new Set(base ? base.uuids : []);
  const sumBefore = sumCols.length, lineBefore = lineCols.length;
  let sink = null;

  try {
    // ---- Phase 1: read each xlsx once -> dedup -> stream JSONL ----
    let uniq = 0, fi = 0; const failed = [];
    sink = await openWrite(dir, jsonl);
    for (const name of read) {
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
      onStatus(t('merge.phase1', { i: fi, n: read.length, uniq }));
    }
    await sink.close(); sink = null;   // must land on disk before Phase 2 reads it back

    // A column the existing parts don't have. Bail before touching the output so every part keeps
    // identical headers — mixed headers stop the parts being one dataset.
    if (base && (sumCols.length !== sumBefore || lineCols.length !== lineBefore)) {
      const grew = [...sumCols.slice(sumBefore), ...lineCols.slice(lineBefore)];
      onStatus(t('merge.drift', { cols: grew.join(', ') }));
      return 'DRIFT';
    }
    if (!uniq && !base) { onStatus(t('merge.noRows')); return; }
    if (!base) { if (sumCols.includes(SERIAL)) sumCols.splice(sumCols.indexOf(SERIAL), 1); sumCols.unshift(SERIAL); }

    // ---- Phase 2: stream JSONL -> two independent single-sheet files ----
    // Summary and details roll over separately (SPEC-014): the summary file stays small and instant
    // to open however large the detail set grows, and neither is bounded by memory any more.
    const seed = base ? base.parts : { summary: [], details: [] };
    let serial = base ? base.nextSerial : 1;
    const sumOut = createRotator(dir, {
      prefix, kind: ms.KIND.SUM, sheetName: sheetNames.s0 || 'Summary', cols: sumCols, seed: seed.summary, rowCap,
      onStatus: (p) => onStatus(p.from ? t('merge.wrotePeriod', { name: p.name, from: p.from, to: p.to, rows: p.rows })
                                       : t('merge.wrote', { name: p.name, rows: p.rows })),
    });
    const detOut = createRotator(dir, {
      prefix, kind: ms.KIND.DET, sheetName: sheetNames.s1 || 'Details', cols: lineCols, seed: seed.details, rowCap,
      onStatus: (p) => onStatus(p.from ? t('merge.wrotePeriod', { name: p.name, from: p.from, to: p.to, rows: p.rows })
                                       : t('merge.wrote', { name: p.name, rows: p.rows })),
    });

    const emit = async (rec) => {
      if (!rec || !rec.sum) return;
      const day = dayOf(rec.sum[DATE_COL]);
      const lines = rec.lines || [];
      // Room is reserved for the WHOLE record first, so an invoice's line rows never straddle two
      // detail files — the join back to the summary row has to stay inside one file.
      await sumOut.ensureRoom(1, day);
      await detOut.ensureRoom(lines.length, day);
      const s = { ...rec.sum, [SERIAL]: serial++ };
      await sumOut.addRow(sumCols.map((c) => s[c] ?? ''), day);
      for (const l of lines) await detOut.addRow(lineCols.map((c) => l[c] ?? ''), day);
    };
    for await (const line of readLines(dir, jsonl)) { if (line.trim()) { let rec; try { rec = JSON.parse(line); } catch {} if (rec) await emit(rec); } }
    await sumOut.close();
    await detOut.close();
    const parts = { summary: sumOut.parts(), details: detOut.parts() };

    // Written LAST, and only once every part has landed: a crash before this leaves the previous
    // state intact, so the next merge re-does this increment rather than silently skipping it.
    await ms.writeState(dir, {
      prefix, sumCols, lineCols, sheetNames, nextSerial: serial, parts, writer: 'stream-v1',
      consumed: files.filter((n) => sizes.get(n) >= 0).map((n) => ({ name: n, size: sizes.get(n) })),
      uuids: [...seen],
    }, stateFile);

    const total = base ? base.uuids.length + uniq : uniq;
    const readN = read.length - failed.length;
    const nFiles = parts.summary.length + parts.details.length;
    const warn = failed.length ? t('merge.warnTail', { n: failed.length, names: failed.slice(0, 5).join(', ') + (failed.length > 5 ? '…' : '') }) : '';
    onStatus(t('merge.summary', { icon: failed.length ? '⚠️' : '✅', read: readN, n: read.length, uniq: total, parts: nFiles, cols: sumCols.length, warn }));
  } finally {
    // The .jsonl is scratch, never a deliverable — it must not outlive the merge, error or not.
    try { await sink?.close(); } catch {}
    try { await remove(dir, jsonl); } catch {}
  }
}
