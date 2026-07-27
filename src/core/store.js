// Folder-authoritative state: per-run localStorage mirror + eta_progress.json + canonical JSONL.
import { writeText, readText, listFiles } from './fs.js';
import { safeName } from './time.js';

const PREFIX = '__etaBulk_v1_';
// short deterministic hash (djb2) — for collision-free, filter-aware filenames
function hash8(s) { let h = 5381; for (let i = 0; i < String(s).length; i++) h = ((h * 33) ^ String(s).charCodeAt(i)) >>> 0; return h.toString(36).padStart(7, '0').slice(-7); }
export const runKey = (source, year, dir, field, from, to) => (source === 'receipts' ? 'receipts_' : '') + `${year}_${dir}_${field}_${from}_${to}`;
export const filePrefix = (plan) => (plan.source === 'receipts' ? 'eReceipts' : 'eInvoices');
// Filter signature: date field + selected statuses (order-independent). Distinguishes runs that share
// year/dir/source but filter differently, so a stale file from another filter can't be counted as done.
const planSig = (plan) => hash8(`${plan.dateField || ''}|${[...(plan.statuses || [])].sort().join(',')}`);
// Filename embeds the collision-free chunk.id (via hash) + the filter signature, so two distinct chunks
// — even sub-minute granular chunks with byte-identical human labels — can never map to one file, and a
// different filter over the same range never aliases onto these files. label kept as a readable prefix.
export const chunkFile = (plan, chunk) => `${filePrefix(plan)}_${plan.year}_${plan.dir}_${planSig(plan)}_${safeName(chunk.label || chunk.id)}_${hash8(chunk.id)}.xlsx`;
const progressName = (plan) => `eta_progress_${safeName(plan.key)}.json`;

export function saveState(s) { try { localStorage.setItem(PREFIX + s.key, JSON.stringify(s)); } catch {} }
export function loadState(key) { try { return JSON.parse(localStorage.getItem(PREFIX + key) || 'null'); } catch { return null; } }
export function allStates() { const o = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(PREFIX)) { try { o.push(JSON.parse(localStorage.getItem(k))); } catch {} } } return o.filter(Boolean); }

export async function writeProgress(dir, plan, status) {
  if (!dir) return;
  const done = new Set(plan.doneIds || []);
  const doneChunks = plan.chunks.filter((c) => done.has(c.id));
  const p = {
    key: plan.key, source: plan.source, status, updatedAt: new Date().toISOString(),
    year: plan.year, dir: plan.dir, field: plan.dateField, from: plan.from, to: plan.to, statuses: plan.statuses,
    totalChunks: plan.chunks.length, totalRows: plan.totalRows, excludeColumns: plan.excludeColumns || [], downloadPdf: !!plan.downloadPdf,
    doneChunks: doneChunks.length, remainingChunks: plan.chunks.length - doneChunks.length,
    doneRows: doneChunks.reduce((s, c) => s + Math.min(c.count, plan.cap || 1e12), 0),
    doneIds: [...done], failedIds: plan.failedIds || [], chunks: plan.chunks,
  };
  try { await writeText(dir, progressName(plan), JSON.stringify(p, null, 1)); } catch {}
}
// With a plan → read that plan's own progress file. Without → pick the most-recently-updated progress
// file in the folder (so two runs sharing a folder no longer clobber each other's resume state).
export async function readProgress(dir, plan) {
  if (plan) { const t = await readText(dir, progressName(plan)); if (t) { try { return JSON.parse(t); } catch { return null; } } return null; }
  const names = await listFiles(dir, /^eta_progress.*\.json$/i);
  let best = null;
  for (const n of names) {
    const t = await readText(dir, n); if (!t) continue;
    try { const j = JSON.parse(t); if (!best || (j.updatedAt || '') > (best.updatedAt || '')) best = j; } catch {}
  }
  return best;
}
export async function scanDoneFromFolder(dir, plan) { const present = new Set(await listFiles(dir, /\.xlsx$/i)); return plan.chunks.filter((c) => present.has(chunkFile(plan, c))).map((c) => c.id); }
