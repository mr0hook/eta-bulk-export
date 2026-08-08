// SPEC-011 — the run log, written to the export folder so a tab kill can't erase it.
//
// Durability shape, and why it is the OPPOSITE of merge.js's: a FileSystemWritableFileStream only
// lands durably on close(), so the long-lived stream F-10 adopted for the merge scratch would lose
// everything buffered in exactly the crash this file exists to survive. So: open → append → close
// per batch (fs.appendText). That re-open copies the whole file each time, which is the O(n²) cost
// F-10 removed from merge — tolerable here ONLY because this file is capped at LOG_MAX_BYTES and
// coalesced, i.e. three orders of magnitude smaller than the merge scratch ever was.
//
// The in-memory ring (runlog.js) is bounded to 200 entries and drops the oldest; this file is
// append-only so a 9-hour run keeps its own beginning.
import { appendText, readText, writeText, remove } from './fs.js';
import { safeName } from './time.js';

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const FLUSH_MS = 2000, MAX_PENDING = 64;

export const logName = (key) => `eta_runlog_${safeName(key)}.log`;
export const prevLogName = (key) => `eta_runlog_${safeName(key)}.prev.log`;

const pad = (s, n) => String(s).padEnd(n);

export function createFolderLog(dir, key, opts = {}) {
  const { now = Date.now, flushMs = FLUSH_MS, maxPending = MAX_PENDING, maxBytes = LOG_MAX_BYTES } = opts;
  const name = logName(key);
  let pending = [];          // { t, level, msg, n, kind }
  let bytes = 0, capped = false, lastFlush = now(), inflight = null;

  const render = (e) => `${new Date(e.t).toISOString()}  ${pad(e.level, 4)}  ${e.msg}${e.n > 1 ? ' ×' + e.n : ''}`;

  const doFlush = async () => {
    if (!pending.length || capped) return;
    // Hold the batch until the write CONFIRMS. On failure these lines stay pending and go out with
    // the next flush — a dropped batch would silently punch a hole in the record.
    const batch = pending;
    pending = [];
    // Fill to the cap line-by-line rather than writing the batch and checking afterwards — a burst
    // arrives as one batch, so an after-the-fact check would already have blown past the limit and
    // with it the bound on appendText's whole-file copy.
    const budget = maxBytes - bytes;
    let text = '', used = 0, hitCap = false;
    for (const e of batch) {
      const line = render(e) + '\n';
      if (used + line.length > budget) { hitCap = true; break; }
      text += line; used += line.length;
    }
    try {
      if (text) { await appendText(dir, name, text); bytes += used; lastFlush = now(); }
      if (hitCap) {
        capped = true;
        try { await appendText(dir, name, `${new Date(now()).toISOString()}  warn  … log truncated at ${maxBytes} bytes\n`); } catch {}
      }
    } catch {
      pending = batch.concat(pending);   // keep them, retry next time; never disturb the run
    }
  };

  const kick = () => { inflight = (inflight || Promise.resolve()).then(doFlush).catch(() => {}); return inflight; };

  return {
    // Coalesce consecutive same-kind lines the way the UI ring does, so the file and the pane agree
    // — and so a 3-hour 429 storm costs one line instead of thousands.
    push(msg, meta) {
      if (capped) return;
      const m = String(msg ?? ''), level = (meta && meta.level) || 'info', kind = (meta && meta.kind) || null;
      const last = pending[pending.length - 1];
      if (kind && last && last.kind === kind) { last.n = last.msg === m ? (last.n || 1) + 1 : 1; last.msg = m; last.t = now(); last.level = level; }
      else pending.push({ t: now(), level, msg: m, n: 1, kind });
      if (pending.length >= maxPending || now() - lastFlush >= flushMs) kick();
    },
    flush: () => kick(),
    idle: () => inflight || Promise.resolve(),
    // Keep exactly one generation back: enough to compare "last night failed, tonight worked"
    // without logs accumulating forever.
    async rotate() {
      try {
        const old = await readText(dir, name);
        if (old != null) { await writeText(dir, prevLogName(key), old); await remove(dir, name); }
      } catch {}
      bytes = 0; capped = false; pending = [];
    },
  };
}
