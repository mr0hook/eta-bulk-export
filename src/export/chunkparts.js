// SPEC-027 / SPEC-032 — detail rows for one chunk.
//
// A chunk file is INTERMEDIATE: merge reads it back and produces the COMBINED deliverables, which
// roll at Excel's own 1,048,576-row sheet limit (mergeout.ROW_CAP). So the caps here are not about
// what Excel can hold — they are about what can be WRITTEN and READ BACK without OOMing the tab:
//
//   • writing: the vendored browser ExcelJS keeps ~KBs of object model per row, so a big lines
//     sheet cannot go through it. The SPEC-014 streaming writer used below is flat-memory instead.
//   • reading: merge Phase 1 loads each chunk file THROUGH ExcelJS (fidelity, header union, dedup).
//     F-10 measured ~9.5KB heap/row there: 72k rows peaks ~950MB and passes, 90k OOMs. That read
//     back — not Excel — is what bounds a part at PART_ROW_CAP.
//
// SPEC-032: split only when a chunk genuinely needs it. Rows are held in memory while the chunk
// still fits in ONE file, so an ordinary chunk (even a 10,000-document one) writes a single
// workbook exactly as it always did; a chunk that outgrows the inline budget spills to part files
// and rolls only at the read-back cap. An invoice's lines never straddle two parts — merge joins
// lines to their summary row within one file.
import { createXlsxWriter } from './xlsxstream.js';
import { clean } from './sanitize.js';

// Held in memory (plain row objects, ~tens of MB at this size) while the chunk may still be one
// file. Crossing it is what starts a part file, NOT a batch boundary.
export const CHUNK_LINES_INLINE_MAX = 30000;
// The envelope merge's ExcelJS read-back tolerates — see the note above.
export const PART_ROW_CAP = 60000;

const headerOf = (cols) => cols.map((c) => String(c.header ?? c.key));
const valueOf = (row, col) => { const v = row[col.key]; return typeof v === 'string' ? clean(v) : (v ?? ''); };
// Contiguous runs of one document's line rows (buildRows emits them together, keyed by uuid).
function runsOf(rows) {
  const runs = [];
  for (let i = 0; i < rows.length;) {
    let j = i + 1;
    while (j < rows.length && rows[j].uuid === rows[i].uuid) j++;
    runs.push([i, j]); i = j;
  }
  return runs;
}
function unionCols(into, add) {
  if (!into) return add.slice();
  const have = new Set(into.map((c) => c.key));
  for (const c of add) if (!have.has(c.key)) { into.push(c); have.add(c.key); }
  return into;
}

/**
 * Collect a chunk's line rows across however many batches, then either hand them back to be
 * written inline (one file) or report the part files they were streamed into.
 *
 * add(built) — one batch's buildRows() output.  finish() — { mode:'inline', rows, cols }
 *                                                        | { mode:'parts', parts, cols }
 */
export function createDetailSink(dirHandle, nameOf, { inlineMax = CHUNK_LINES_INLINE_MAX, rowCap = PART_ROW_CAP } = {}) {
  let held = [], cols = null, sheetName = 'Details', spilled = false;
  const parts = [];
  let writer = null, writerCols = null, writerRows = 0;

  const openPart = async () => {
    // The header is fixed when a part opens. Later batches may introduce new dynamic columns, so
    // rows are always written against THIS part's own column list — never a later, wider one, which
    // would shift every value one column right. Merge unions the parts' headers by name.
    writerCols = cols.slice();
    const name = nameOf(parts.length + 1);
    parts.push(name);
    writer = await createXlsxWriter(dirHandle, name, { sheetName, header: headerOf(writerCols), rtl: true });
    writerRows = 0;
  };
  const writeRows = async (rows) => {
    for (const [a, b] of runsOf(rows)) {
      const n = b - a;
      if (!writer || (writerRows > 0 && writerRows + n > rowCap)) { if (writer) await writer.close(); await openPart(); }
      for (let i = a; i < b; i++) await writer.addRow(writerCols.map((c) => valueOf(rows[i], c)));
      writerRows += n;
    }
  };

  return {
    get spilled() { return spilled; },
    async add(built) {
      cols = unionCols(cols, built.lineCols);
      if (built.cfg?.lineSheet) sheetName = built.cfg.lineSheet;
      if (!built.lineRows.length) return;
      if (spilled) { await writeRows(built.lineRows); return; }
      held.push(...built.lineRows);
      if (held.length <= inlineMax) return;
      spilled = true;                     // outgrew one file — flush what is held, then stream
      const flush = held; held = [];
      await writeRows(flush);
    },
    async finish() {
      if (!spilled) return { mode: 'inline', rows: held, cols: cols || [] };
      if (writer) { await writer.close(); writer = null; }
      return { mode: 'parts', parts, cols: cols || [] };
    },
  };
}

/** Write one batch of built rows straight to part files. Kept for direct/unit use. */
export async function writeDetailParts(dirHandle, nameOf, built, { rowCap = PART_ROW_CAP } = {}) {
  const sink = createDetailSink(dirHandle, nameOf, { inlineMax: 0, rowCap });
  await sink.add(built);
  return (await sink.finish()).parts;
}
