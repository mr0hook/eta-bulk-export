// SPEC-012 — what the last merge consumed, so the next one can skip it.
//
// Pure decision logic + a JSON sidecar. Every ambiguity resolves to 'full': a rebuild costs time,
// a wrong incremental costs correctness, and the two are not comparable.
import { readText, writeText, listFiles } from './fs.js';

export const STATE = 'eta_merge_state.json';
const V = 1;

export const combinedName = (prefix, part) => (part <= 1 ? `${prefix}_COMBINED.xlsx` : `${prefix}_COMBINED_part${part}.xlsx`);
// Pre-SPEC-012 output: every merge minted a NEW dated set and abandoned the last one.
export const DATED_RE = /^e(Invoices|Receipts)_COMBINED_\d{4}-.*\.xlsx$/i;

export async function readState(dir) {
  try {
    const raw = await readText(dir, STATE);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || j.v !== V) return null;
    if (!Array.isArray(j.consumed) || !Array.isArray(j.uuids) || !Array.isArray(j.parts)) return null;
    return j;
  } catch { return null; }
}

export async function writeState(dir, state) {
  await writeText(dir, STATE, JSON.stringify({ ...state, v: V, updatedAt: new Date().toISOString() }));
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
  if (!state.parts.length) return { mode: 'full', reason: 'no-parts', newFiles: files };

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
  return (state.parts || []).every((p) => present.has(p.name));
}
