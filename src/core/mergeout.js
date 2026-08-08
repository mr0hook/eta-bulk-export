// SPEC-014 — the merge's output side: a rotating, streaming writer for ONE sheet kind.
//
// Summary and details are separate single-sheet files that roll over independently, so the summary
// (small, the one you actually browse) stays instant to open however huge the details get. Each file
// is written straight to disk through xlsxstream, so row count is bounded only by Excel's own
// 1,048,576-row sheet limit rather than by browser memory.
import { readArrayBuffer, writeBlob, remove } from './fs.js';
import { createXlsxWriter, copySheetBody, SHEET_MAX_ROWS } from '../export/xlsxstream.js';
import * as ms from './mergestate.js';

// Roll over here rather than at the format limit, leaving headroom so a day-alignment overflow can
// never push a sheet past what the format allows.
export const ROW_CAP = 1000000;
export const ROW_HARD = SHEET_MAX_ROWS - 1;

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Files are written under a .writing.xlsx name and put in place at close, so a crashed merge can
// never leave a half-written file sitting under the name of a real deliverable.
async function promote(dir, from, to) {
  if (from === to) return to;
  try {
    const fh = await dir.getFileHandle(from);
    if (typeof fh.move === 'function') { await fh.move(to); return to; }
    // No rename support: fall back to a copy. Costs one file's bytes, and only on rollover.
    const buf = await readArrayBuffer(dir, from);
    await writeBlob(dir, to, new Blob([buf], { type: MIME }));
    await remove(dir, from);
    return to;
  } catch { return from; }
}

export function createRotator(dir, { prefix, kind, sheetName, cols, seed = [], onStatus = () => {}, rowCap = ROW_CAP }) {
  const parts = [...seed];
  let w = null, rows = 0, from = null, to = null, working = null, idx = 0, replacing = null, dirty = false;

  const open = async (append) => {
    if (append) {
      const last = parts[parts.length - 1];
      idx = parts.length;
      working = ms.workingName(prefix, kind, idx);
      w = await createXlsxWriter(dir, working, { sheetName, header: [] });
      // Copy the existing rows straight from the old file's compressed sheet — never materialised.
      await copySheetBody(await readArrayBuffer(dir, last.name), (t) => w.copyChunk(t));
      w.setRows(last.rows);
      rows = last.rows; from = last.from; to = last.to; replacing = last.name; dirty = false;
    } else {
      idx = parts.length + 1;
      working = ms.workingName(prefix, kind, idx);
      w = await createXlsxWriter(dir, working, { sheetName, header: cols });
      rows = 1; from = null; to = null; replacing = null; dirty = false;
    }
  };

  const seal = async () => {
    if (!w) return;
    if (!dirty && replacing) {           // reopened, then rolled past without adding anything
      await w.close(); try { await remove(dir, working); } catch {}
      w = null; return;
    }
    const total = await w.close();
    const final = ms.combinedName(prefix, kind, idx);
    if (replacing && replacing !== final) { try { await remove(dir, replacing); } catch {} }
    const name = await promote(dir, working, final);
    const rec = { name, rows: total, from, to };
    if (parts.length >= idx) parts[idx - 1] = rec; else parts.push(rec);
    onStatus({ name, rows: total - 1, from, to, part: idx });
    w = null; replacing = null;
  };

  return {
    parts: () => parts,
    rowsInCurrent: () => rows - 1,
    // `n` = how many rows this record will add; the caller keeps a record's rows in ONE file.
    async ensureRoom(n, day) {
      if (!w) await open(parts.length > 0);
      const cap = rows - 1 + n > rowCap;
      if (!cap) return;
      // Don't cut a single day across two files unless the format itself forces it.
      const hard = rows - 1 + n > Math.min(ROW_HARD, rowCap * 1.5);
      if (!hard && day && day === to) return;
      await seal();
      await open(false);
    },
    async addRow(vals, day) {
      if (!w) await open(parts.length > 0);
      await w.addRow(vals);
      rows++; dirty = true;
      if (day) { if (!from || day < from) from = day; if (!to || day > to) to = day; }
    },
    close: seal,
  };
}
