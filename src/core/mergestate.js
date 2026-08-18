// SPEC-012 — what the last merge consumed, so the next one can skip it.
//
// Pure decision logic + a JSON sidecar. Every ambiguity resolves to 'full': a rebuild costs time,
// a wrong incremental costs correctness, and the two are not comparable.
import { readText, writeText, listFiles } from './fs.js';

export const STATE = 'eta_merge_state.json';
const V = 2;   // v2: two single-sheet files + the streaming writer (SPEC-014)

// SPEC-013: a part is named for the period it covers, so the folder says what is in each file
// without opening any of them. Falls back to part numbers when the issue-date column was excluded.
// `taken` disambiguates the case where two parts cover the same single day (a day bigger than one
// part's cap), which would otherwise collide on one filename.
// SPEC-014: summary and details are SEPARATE single-sheet files, so the small one you actually
// browse opens instantly no matter how huge the detail set gets, and the two split independently.
// COMBINED stays in the name because the merge input glob excludes it — rename it and the output
// would be re-consumed as input on the next merge.
export const KIND = { SUM: 'SUMMARY', DET: 'DETAILS' };
export const combinedName = (prefix, kind, idx) =>
  (idx <= 1 ? prefix + '_COMBINED_' + kind + '.xlsx' : prefix + '_COMBINED_' + kind + '_part' + idx + '.xlsx');
export const workingName = (prefix, kind, idx) => combinedName(prefix, kind, idx).replace(/\.xlsx$/, '.writing.xlsx');
export const WORKING_RE = /\.writing\.xlsx$/i;

export const DATED_RE = /^e(Invoices|Receipts)_COMBINED_\d{4}-\d{2}-\d{2}T[\d-]+Z(_part\d+)?\.xlsx$/i;

// `file` (SPEC-022): a scoped merge — one uuid run's files only — keeps its OWN state so it can
// never clobber the folder-wide range merge's incremental record, and vice versa.
export async function readState(dir, file = STATE) {
  try {
    const raw = await readText(dir, file);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || j.v !== V) return null;
    if (!Array.isArray(j.consumed) || !Array.isArray(j.uuids)) return null;
    if (!j.parts || !Array.isArray(j.parts.summary) || !Array.isArray(j.parts.details)) return null;
    // Parts written by the old ExcelJS path use sharedStrings; the streaming top-up copies raw row
    // XML and would produce garbage against them. Force one rebuild instead.
    if (j.writer !== 'stream-v1') return null;
    return j;
  } catch { return null; }
}

export async function writeState(dir, state, file = STATE) {
  await writeText(dir, file, JSON.stringify({ ...state, v: V, updatedAt: new Date().toISOString() }));
}

// Sizes let us notice a chunk file that was re-downloaded or repaired since we consumed it.
export async function fileSizes(dir, names) {
  const out = new Map();
  for (const n of names) {
    try { const fh = await dir.getFileHandle(n); out.set(n, (await fh.getFile()).size); }
    catch { out.set(n, -1); }
  }
  return out;
}

// -> { mode: 'full'|'incremental'|'uptodate', reason, newFiles[] }
export function decideMode(state, files, sizes, prefix) {
  if (!state) return { mode: 'full', reason: 'no-state', newFiles: files };
  if (state.prefix !== prefix) return { mode: 'full', reason: 'prefix-changed', newFiles: files };
  if (!state.parts.summary.length) return { mode: 'full', reason: 'no-parts', newFiles: files };

  const consumed = new Map((state.consumed || []).map((c) => [c.name, c.size]));
  for (const [name, size] of consumed) {
    const now = sizes.get(name);
    if (now == null || now < 0) return { mode: 'full', reason: 'consumed-missing:' + name, newFiles: files };
    if (now !== size) return { mode: 'full', reason: 'consumed-changed:' + name, newFiles: files };
  }
  const newFiles = files.filter((n) => !consumed.has(n));
  if (!newFiles.length) return { mode: 'uptodate', reason: 'no-new-files', newFiles: [] };
  return { mode: 'incremental', reason: 'new-files:' + newFiles.length, newFiles };
}

// A part the user deleted (or that never landed) means the set on disk no longer matches the state.
export async function partsIntact(dir, state) {
  const present = new Set(await listFiles(dir, /\.xlsx$/i));
  return [...state.parts.summary, ...state.parts.details].every((p) => present.has(p.name));
}
