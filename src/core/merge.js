// Streaming two-phase merge (bounded memory, scales to any file count). Reads the run's
// per-chunk xlsx (fidelity-preserving), dedups by UUID, unions headers by name, and writes the
// combined output. Phase 1: xlsx -> canonical JSONL (only the UUID Set held).
// Phase 2: JSONL -> two single-sheet xlsx files, written straight to disk (SPEC-014), so the only
// row limit left is Excel's own 1,048,576 per sheet — not browser memory.
//
// SPEC-012: the merge is incremental. eta_merge_state.json records what was consumed, so a merge
// after a sync reads only the new chunk files and tops up the last part instead of rebuilding
// everything. Every ambiguity falls back to a full rebuild — see mergestate.decideMode.
import { listFiles, readArrayBuffer, readText, openWrite, readLines, remove } from './fs.js';
import * as ms from './mergestate.js';
import { createRotator } from './mergeout.js';
import { CHUNK_DET_RE, detailParentOf, chunkFile } from './store.js';   // SPEC-027: split-chunk detail parts
import { ALL_STATUSES } from '../api/sources.js';
import { t } from './i18n.js';

const UUID = 'الرقم الإلكترونى', SERIAL = 'مسلسل';
// Scratch only — never a deliverable. `.crswap` is Chromium's swap file for an open
// FileSystemWritableFileStream: a merge that dies mid-write leaves one behind, and the old pattern
// (which required the name to END at .jsonl) never swept them. Three failed merges on one folder
// left 5.3 GB of them (2026-08-20).
const TEMP_RE = /^e(Invoices|Receipts)_COMBINED_.*\.jsonl(\.crswap)?$/i;
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

// SPEC-040 — the merge's closing reconciliation: what the run PLANNED to hold vs what the chunk
// files actually contained.
//
// This is the check that was missing on 2026-08-20. A merge reported "✅ Merged 69/69 files →
// 230,545 unique" and looked perfect; the run had planned 240,351 documents, so 9,806 were simply
// not there — no failed chunk, no failures file, nothing on screen that could have told anyone.
// "69/69 files" only ever meant every file was READ, never that every document was IN them.
//
// It compares against the chunk files that are actually present, so an incomplete or partly-deleted
// run reconciles against what it should hold today rather than crying wolf. Duplicates are fully
// accounted for: the planner cuts on an inclusive shared boundary, so a document sitting exactly on
// a cut is fetched by both neighbours, and the count compared here is summary ROWS READ (unique +
// deduped), not unique — the one comparison in which boundary duplicates cannot masquerade as loss.
async function reconcile(dir, prefix, files, rowsRead, onStatus) {
  const present = new Set(files.map((n) => n.toLowerCase()));
  let planned = 0, missing = 0, plans = 0;
  for (const n of await listFiles(dir, /^eta_progress.*\.json$/i)) {
    let p; try { p = JSON.parse((await readText(dir, n)) || ''); } catch { continue; }
    if (!p || !Array.isArray(p.chunks) || !p.chunks.length) continue;
    // The progress file stores the date field as `field`; chunkFile() hashes `dateField` (resume
    // does the same remap). Without it every filename misses and the whole folder reads as lost.
    const plan = { ...p, dateField: p.dateField || p.field, mode: p.mode || 'range' };
    let head; try { head = chunkFile(plan, plan.chunks[0]); } catch { continue; }
    if (!head.toLowerCase().startsWith(prefix.toLowerCase())) continue;   // another document type, or another scoped run
    // A filtered run's chunk counts are the UNFILTERED window totals, so its files legitimately hold
    // fewer rows. Comparing them would report loss on a healthy run — skip, exactly as the run-time
    // shortfall guard exempts the same three cases.
    if (plan.mode === 'uuids' || (p.rinFilter || []).length) continue;
    if (Array.isArray(p.statuses) && p.statuses.length && p.statuses.length < ALL_STATUSES.length) continue;
    plans++;
    for (const c of plan.chunks) {
      try { if (present.has(chunkFile(plan, c).toLowerCase())) planned += c.count | 0; else missing += c.count | 0; }
      catch {}
    }
  }
  if (!plans || !planned) return;   // no comparable plan in this folder — say nothing rather than guess
  const short = Math.max(0, planned - rowsRead);
  // Two different problems, and the user has to be able to tell them apart: `short` means the chunk
  // files that ARE here hold fewer documents than they were planned to (silent loss — the 2024 Q1
  // failure); `missing` means whole chunks have no file at all (an unfinished run — Resume fixes it).
  if (short || missing) onStatus(t('merge.reconcileShort', { planned: planned + missing, got: rowsRead, short, missing }));
  else onStatus(t('merge.reconcileOk', { planned, got: rowsRead }));
}

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
  // SPEC-039 — the Phase-1 scratch is written in SEGMENTS, not one file.
  //
  // A 250,000-invoice folder expands to ~2.3 GB of JSONL (measured 2026-08-20), and two merges died
  // at byte-identical 2,332.6 MB with 137 GB free, no file open in Excel and no cloud sync — a
  // deterministic wall in one very large FileSystemWritableFileStream, not a race. Each segment is
  // opened, written and CLOSED in turn, so no single handle carries gigabytes, and Phase 2 reads
  // them back in order — the records are consumed as a stream either way, so nothing else changes.
  const stamp = Date.now().toString(36);
  const segName = (i) => `${prefix}_COMBINED_${stamp}_s${String(i).padStart(3, '0')}.jsonl`;
  const SEG_MAX_CHARS = 192 * 1024 * 1024;   // ~192M chars ≈ 200-400MB of UTF-8 with Arabic text
  const segs = [];
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
    // SPEC-027: a split chunk is a summary workbook plus `_det_pNN` single-sheet part files. The
    // loop walks PARENTS; each parent claims its parts (they extend the lines sheet). A retried
    // chunk rewrites summary + parts together, so incremental normally reads them together — a NEW
    // part whose parent is not being read is ambiguity, handled below via the DRIFT full-rebuild
    // path. An orphan part with no parent in the folder at all is an incomplete chunk write: its
    // lines have no summary to join (they contribute nothing today either), so it is skipped.
    const isPart = (n) => CHUNK_DET_RE.test(n);
    const partsOf = new Map();
    for (const n of read) { if (isPart(n)) { const p = detailParentOf(n); if (!partsOf.has(p)) partsOf.set(p, []); partsOf.get(p).push(n); } }
    for (const list of partsOf.values()) list.sort();
    const parents = read.filter((n) => !isPart(n));
    let uniq = 0, fi = 0, written = 0, extra = 0; const failed = [];
    {
      const reading = new Set(parents);
      for (const p of [...partsOf.keys()]) {
        if (reading.has(p)) continue;
        // Incremental: a new part without its parent → rebuild from scratch (DRIFT path). Full:
        // the parent isn't in the folder at all — an incomplete chunk write; its lines have no
        // summary to join, so the parts are skipped LOUDLY and the retry will rewrite them.
        if (base) { onStatus(t('merge.partOrphanRebuild', { name: partsOf.get(p)[0] })); return 'DRIFT'; }
        for (const pn of partsOf.get(p)) { failed.push(pn); onStatus(t('merge.skipped', { name: pn })); }
        partsOf.delete(p);
      }
    }
    let segChars = 0;
    const openSeg = async () => { const n = segName(segs.length); segs.push(n); sink = await openWrite(dir, n); segChars = 0; };
    // One writer at a time; rolled over once a segment is full so no handle ever holds gigabytes.
    const writeScratch = async (s) => {
      if (!sink) await openSeg();
      await sink.write(s);
      segChars += s.length;
      if (segChars >= SEG_MAX_CHARS) { await sink.close(); sink = null; }
    };
    await openSeg();
    for (const name of parents) {
      fi++;
      let wb; try { wb = new ExcelJS.Workbook(); await wb.xlsx.load(await readArrayBuffer(dir, name)); }
      catch { failed.push(name); onStatus(t('merge.skipped', { name })); continue; }
      const s0 = wb.worksheets[0];
      const s1 = wb.worksheets[1] && wb.worksheets[1] !== s0 ? wb.worksheets[1] : null;
      const localSum = new Map(), localLines = new Map(), order = [];
      if (s0) {
        if (!sheetNames.s0) sheetNames.s0 = s0.name;
        const hdr = nfcHdr(s0.getRow(1).values.slice(1)); const uk = uuidKeyOf(hdr); addCols(sumCols, hdr);
        // `extra` = summary rows read that did NOT become a new unique row (a boundary duplicate, or
        // a row with no UUID). unique + extra is the true number of documents these files hold, which
        // is what reconcile() has to compare against the plan — see SPEC-040.
        s0.eachRow((row, rn) => { if (rn === 1) return; const o = toObj(hdr, row.values.slice(1)); const u = o[uk]; if (u == null || seen.has(u)) { extra++; return; } seen.add(u); localSum.set(u, o); order.push(u); });
      }
      const eatLines = (ws) => {
        if (!sheetNames.s1 && ws.name !== sheetNames.s0) sheetNames.s1 = ws.name;
        const hdr = nfcHdr(ws.getRow(1).values.slice(1)); const uk = uuidKeyOf(hdr); addCols(lineCols, hdr);
        ws.eachRow((row, rn) => { if (rn === 1) return; const o = toObj(hdr, row.values.slice(1)); const u = o[uk]; if (u == null || !localSum.has(u)) return; if (!localLines.has(u)) localLines.set(u, []); localLines.get(u).push(o); });
      };
      if (s1) { if (!sheetNames.s1) sheetNames.s1 = s1.name; eatLines(s1); }
      for (const pn of partsOf.get(name) || []) {   // SPEC-027: the chunk's detail parts extend its lines sheet
        let pwb; try { pwb = new ExcelJS.Workbook(); await pwb.xlsx.load(await readArrayBuffer(dir, pn)); }
        catch { failed.push(pn); onStatus(t('merge.skipped', { name: pn })); continue; }
        if (pwb.worksheets[0]) eatLines(pwb.worksheets[0]);
      }
      let buf = '';
      for (const u of order) {
        uniq++; buf += JSON.stringify({ sum: localSum.get(u), lines: localLines.get(u) || [] }) + '\n';
        // Named on failure (2026-08-20): a merge that died here reported only Chromium's opaque
        // "state cached in an interface object" with no hint of which step or how far in, which
        // cost an afternoon of guessing. Say what was being written and at what size.
        if (buf.length >= FLUSH_CHARS) {
          try { await writeScratch(buf); } catch (e) { throw new Error(`scratch write failed after ${Math.round(written / 1048576)}MB (segment ${segs.length}) while consuming ${name}: ${e?.name || ''} ${e?.message || e}`); }
          written += buf.length; buf = '';
        }
      }
      if (buf) { try { await writeScratch(buf); } catch (e) { throw new Error(`scratch write failed after ${Math.round(written / 1048576)}MB (segment ${segs.length}) while consuming ${name}: ${e?.name || ''} ${e?.message || e}`); } written += buf.length; }
      onStatus(t('merge.phase1', { i: fi, n: parents.length, uniq }));
    }
    if (sink) { await sink.close(); sink = null; }   // must land on disk before Phase 2 reads it back

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
    for (const seg of segs) {
      for await (const line of readLines(dir, seg)) { if (line.trim()) { let rec; try { rec = JSON.parse(line); } catch {} if (rec) await emit(rec); } }
    }
    await sumOut.close();
    await detOut.close();
    const parts = { summary: sumOut.parts(), details: detOut.parts() };

    // Written LAST, and only once every part has landed: a crash before this leaves the previous
    // state intact, so the next merge re-does this increment rather than silently skipping it.
    // extraRows accumulates across incremental merges: a later pass only reads the NEW chunk files,
    // so without carrying it the reconciliation would forget the duplicates the first pass deduped
    // and report that gap as loss.
    const extraRows = (base ? base.extraRows | 0 : 0) + extra;
    await ms.writeState(dir, {
      prefix, sumCols, lineCols, sheetNames, nextSerial: serial, parts, writer: 'stream-v1',
      consumed: files.filter((n) => sizes.get(n) >= 0).map((n) => ({ name: n, size: sizes.get(n) })),
      uuids: [...seen], extraRows,
    }, stateFile);

    const total = base ? base.uuids.length + uniq : uniq;
    const readN = read.length - failed.length;
    const nFiles = parts.summary.length + parts.details.length;
    const warn = failed.length ? t('merge.warnTail', { n: failed.length, names: failed.slice(0, 5).join(', ') + (failed.length > 5 ? '…' : '') }) : '';
    onStatus(t('merge.summary', { icon: failed.length ? '⚠️' : '✅', read: readN, n: read.length, uniq: total, parts: nFiles, cols: sumCols.length, warn }));
    // Last word of the merge, and deliberately after the ✅ — the summary line above says the files
    // were read, this one says whether they held the documents the run promised.
    // Skipped on the first incremental merge over a PRE-SPEC-040 state: that state carries no
    // extraRows, so every boundary duplicate the earlier passes deduped is invisible here and the
    // reconciliation would report an entirely healthy folder as short. It self-heals — the next
    // full rebuild, or any later incremental, counts correctly.
    const canCount = !base || base.extraRows !== undefined;
    try { if (canCount) await reconcile(dir, prefix, files, total + extraRows, onStatus); }
    catch (e) { onStatus(t('merge.reconcileFailed', { msg: String(e?.message || e).slice(0, 80) })); }
  } finally {
    // The .jsonl is scratch, never a deliverable — it must not outlive the merge, error or not.
    try { await sink?.close(); } catch {}
    for (const seg of segs) { try { await remove(dir, seg); } catch {} }
  }
}
