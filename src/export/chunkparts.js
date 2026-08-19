// SPEC-027 — split-chunk detail parts. A chunk whose line rows would OOM ExcelJS's object model
// (~KBs of heap per row; "Invalid array length"/Aw-Snap at creation, and the same again when merge
// reads the file back) streams them instead into single-sheet part files of ≤ PART_ROW_CAP rows
// via the SPEC-014 writer (constant memory at any size). An invoice's lines never straddle two
// parts — merge joins lines to summaries within one file set member, so the whole invoice must
// stay together (the same rule mergeout's rotator enforces on the COMBINED side).
import { createXlsxWriter } from './xlsxstream.js';
import { clean } from './sanitize.js';

// Above this, the single-workbook path is left alone: every Sales chunk observed lives well under
// it, so the common case stays byte-identical to pre-SPEC-027 output.
export const CHUNK_LINES_INLINE_MAX = 30000;
// The envelope F-10 proved safe for ExcelJS to LOAD back — merge reads each part through ExcelJS,
// so the write-side cap must respect the read side's memory, not Excel's 1M-row sheet limit.
export const PART_ROW_CAP = 60000;

/**
 * Write built.lineRows into capped part files. `nameOf(i)` supplies the 1-based part filename.
 * Returns the part names in order. Values pass through sanitize.clean() so parts get the same
 * noncharacter/lone-surrogate scrub the ExcelJS path applies via cleanRow().
 */
export async function writeDetailParts(dirHandle, nameOf, built, { rowCap = PART_ROW_CAP } = {}) {
  const cols = built.lineCols;
  const header = cols.map((c) => String(c.header ?? c.key));
  const rows = built.lineRows;
  // Per-invoice runs: line rows are built contiguously per document, keyed by uuid.
  const runs = [];
  for (let i = 0; i < rows.length;) {
    let j = i + 1;
    while (j < rows.length && rows[j].uuid === rows[i].uuid) j++;
    runs.push([i, j]); i = j;
  }
  const val = (r, c) => { const v = r[c.key]; return typeof v === 'string' ? clean(v) : (v ?? ''); };

  const out = [];
  let w = null, wRows = 0;
  const open = async () => {
    const name = nameOf(out.length + 1);
    out.push(name);
    w = await createXlsxWriter(dirHandle, name, { sheetName: built.cfg.lineSheet, header, rtl: true });
    wRows = 0;
  };
  for (const [a, b] of runs) {
    const n = b - a;
    if (!w || (wRows > 0 && wRows + n > rowCap)) { if (w) await w.close(); await open(); }
    for (let i = a; i < b; i++) await w.addRow(cols.map((c) => val(rows[i], c)));
    wRows += n;
  }
  if (w) await w.close();
  return out;
}
