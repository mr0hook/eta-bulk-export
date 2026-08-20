// Folder-authoritative state: per-run localStorage mirror + eta_progress.json + canonical JSONL.
import { writeText, readText, listFiles } from './fs.js';
import { safeName } from './time.js';

const PREFIX = '__etaBulk_v1_';
// short deterministic hash (djb2) — for collision-free, filter-aware filenames
function hash8(s) { let h = 5381; for (let i = 0; i < String(s).length; i++) h = ((h * 33) ^ String(s).charCodeAt(i)) >>> 0; return h.toString(36).padStart(7, '0').slice(-7); }
export const runKey = (source, year, dir, field, from, to) => (source === 'receipts' ? 'receipts_' : '') + `${year}_${dir}_${field}_${from}_${to}`;
// SPEC-022: uuid-list runs get their own prefix — the folder-wide merge regex requires the
// underscore right after e(Invoices|Receipts), so these files never leak into a range COMBINED.
// SPEC-036: a RECOVERY run — the "⟳ Load failed UUIDs" retry of documents this folder's own range
// run dropped — is not a foreign list. Those documents belong to the range export that lost them,
// so its files take the ordinary prefix and land in the same COMBINED output. An arbitrary pasted
// list keeps the separate eInvoicesUuid prefix, which is what stops it polluting a range export.
export const filePrefix = (plan) => ((plan.mode === 'uuids' && !plan.recovery) ? 'eInvoicesUuid' : plan.source === 'receipts' ? 'eReceipts' : 'eInvoices');
// Filter signature: date field + selected statuses (order-independent) + for list runs the list
// identity itself and any RIN filter. Distinguishes runs that share year/dir/source but filter
// differently, so a stale file from another filter can't be counted as done — two different UUID
// lists share chunk ids ('uuids_0'…), so without the key here their files would alias.
const planSig = (plan) => hash8(`${plan.dateField || ''}|${[...(plan.statuses || [])].sort().join(',')}|${plan.mode === 'uuids' ? plan.key : ''}|${[...(plan.rinFilter || [])].sort().join(',')}`);
// Filename embeds the collision-free chunk.id (via hash) + the filter signature, so two distinct chunks
// — even sub-minute granular chunks with byte-identical human labels — can never map to one file, and a
// different filter over the same range never aliases onto these files. label kept as a readable prefix.
export const chunkFile = (plan, chunk) => `${filePrefix(plan)}_${plan.year}_${plan.dir}_${planSig(plan)}_${safeName(chunk.label || chunk.id)}_${hash8(chunk.id)}.xlsx`;
// SPEC-027: a line-heavy chunk splits its details into single-sheet part files beside the summary
// workbook (which keeps the chunkFile name — resume's completion marker). Parts derive from the
// summary name so merge can claim them, and stale ones from a retried chunk can be swept by regex.
export const CHUNK_DET_RE = /_det_p\d+\.xlsx$/i;
export const chunkDetailFile = (plan, chunk, i) => chunkFile(plan, chunk).replace(/\.xlsx$/i, `_det_p${String(i).padStart(2, '0')}.xlsx`);
export const detailParentOf = (name) => name.replace(CHUNK_DET_RE, '.xlsx');
const progressName = (plan) => `eta_progress_${safeName(plan.key)}.json`;

// SPEC-022: everything one uuid run's merge needs to see ONLY its own files. The prefix mirrors
// chunkFile()'s fixed head (filePrefix_year_dir_sig), so the regex matches exactly this run's
// chunks and COMBINED parts and nothing else in the folder; the state file keeps the scoped
// merge's incremental record apart from the folder-wide one.
export function uuidMergeScope(plan) {
  const pfx = `${filePrefix(plan)}_${plan.year}_${plan.dir}_${planSig(plan)}`;
  const esc = pfx.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { re: new RegExp('^' + esc + '_.*\\.xlsx$', 'i'), prefix: pfx, stateFile: `eta_merge_state_${pfx}.json` };
}

/**
 * The run's per-chunk state as one character per chunk, in plan order: d=done, f=failed, r=running,
 * p=not started. This is what /job/checkpoint ships so the admin timeline can show where a live run
 * actually is; the plan rows in D1 stay immutable and this rewrites only their state column.
 *
 * Precedence matches flow.js chunkMap exactly, and for the same reasons: done beats running so a
 * resumed run's skipped chunks read as finished, and running beats failed so a chunk being retried
 * does not flash red while it is in flight.
 */
export function chunkStates(plan, runningId = null) {
  if (!plan || !Array.isArray(plan.chunks)) return '';
  const done = new Set(plan.doneIds || []);
  const failed = new Set(plan.failedIds || []);
  return plan.chunks.map((c) => (
    done.has(c.id) ? 'd' : (runningId != null && c.id === runningId) ? 'r' : failed.has(c.id) ? 'f' : 'p'
  )).join('');
}

export function saveState(s) { try { localStorage.setItem(PREFIX + s.key, JSON.stringify(s)); } catch {} }
export function loadState(key) { try { return JSON.parse(localStorage.getItem(PREFIX + key) || 'null'); } catch { return null; } }
export function allStates() { const o = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(PREFIX)) { try { o.push(JSON.parse(localStorage.getItem(k))); } catch {} } } return o.filter(Boolean); }

export async function writeProgress(dir, plan, status) {
  if (!dir) return;
  const done = new Set(plan.doneIds || []);
  const doneChunks = plan.chunks.filter((c) => done.has(c.id));
  const p = {
    // jobId travels with the progress file so a folder-only resume (orchestrator.resume() without
    // the server's /job/plan answer) can still check point against the job it belongs to. Without
    // it, mark() bails on `!p.jobId` and the run goes dark to the backend for its whole life.
    key: plan.key, jobId: plan.jobId || '', source: plan.source, status, updatedAt: new Date().toISOString(),
    // SPEC-022: mode + filters travel with the progress file. For uuid runs the chunks below carry
    // each batch's uuid slice — the ONLY durable copy (the server holds a count), so resume owns it.
    mode: plan.mode || 'range', rinFilter: plan.rinFilter || [],
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
