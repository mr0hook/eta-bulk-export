// SPEC-018 Part B — the run log, shipped to the portal.
//
// What ships: status lines only — the same strings the drawer already displays and the bug reporter
// already sends. Counts and progress, never document content. This module never looks INSIDE a line;
// it is the orchestrator's single onStatus interception point that decides what gets pushed, and
// every line that reaches it is an i18n'd status string.
//
// Best-effort BY CONTRACT, which is the whole design:
//   · push() cannot throw — the whole body sits in a try/catch, because a logger that aborts the
//     export it documents is worse than no logger;
//   · push() never awaits — it kicks a promise chain and returns immediately, so a 15 s backend
//     timeout costs the run nothing;
//   · a failed flush DROPS that batch and moves on. This is the opposite of folderlog.js, which
//     holds a failed batch and retries: that file is the authoritative record (SPEC-011) and a hole
//     in it is a real loss, whereas this is a convenience copy for a support conversation and a
//     retry queue would only grow during exactly the outage that caused it.
//
// Batching, per the contract: flush every 15 s or 50 lines, whichever comes first, and ALWAYS on a
// terminal line — the pause/halt/done reason is the one line support actually needs.
//
// There is no timer. The interval is checked on push, so an idle shipper holds nothing open and a
// run that has stopped emitting has, by definition, nothing left to say.
export const SHIP_FLUSH_MS = 15000;
export const SHIP_MAX_LINES = 50;
const MAX_PENDING = 200;   // == the server-side cap; a buffer that outgrows it is already ballast
const MAX_TEXT = 300;      // a status line is a sentence; anything longer is a bug, not a message

export function createLogShip(opts = {}) {
  const {
    send, now = Date.now, flushMs = SHIP_FLUSH_MS,
    maxLines = SHIP_MAX_LINES, maxPending = MAX_PENDING,
  } = opts;
  let jobId = null, pending = [], lastFlush = now(), inflight = null, sent = 0, dropped = 0;

  // Keep only the NEWEST line of each kind in a batch. 'rate', 'page' and 'probe' are
  // high-frequency by design: a 3-hour run's 429 waits and per-page ticks are thousands of lines
  // that all say the same thing, and only the last one is still true by the time anyone reads it.
  // Position is preserved (the survivor keeps the newest occurrence's slot) so the batch still
  // reads as a narrative.
  const coalesce = (batch) => {
    const newest = new Map();
    batch.forEach((e, i) => { if (e.kind) newest.set(e.kind, i); });
    return batch.filter((e, i) => !e.kind || newest.get(e.kind) === i);
  };

  const doFlush = async () => {
    // No job yet → hold. The lines emitted while the planner is still probing belong to the job it
    // is about to mint, and shipping them nowhere would lose the beginning of every run.
    if (!jobId || !pending.length || typeof send !== 'function') return;
    const batch = coalesce(pending).slice(-maxPending);
    pending = [];   // released BEFORE the await: a failed batch is dropped, never retried
    try {
      const r = await send({ jobId, lines: batch });
      if (r && r.ok) sent += batch.length; else dropped += batch.length;
    } catch { dropped += batch.length; }
  };

  const kick = () => {
    lastFlush = now();
    inflight = (inflight || Promise.resolve()).then(doFlush).catch(() => {});
    return inflight;
  };

  return {
    // The jobId only exists once the server has minted the job (/plan/start), so shipping is off
    // until then and comes on mid-plan. The job row is already in D1 by the time the client holds
    // its id, so the first flush cannot race it.
    setJob(id) {
      try {
        const v = String(id || '') || null;
        if (!v || v === jobId) return;
        jobId = v;
        if (pending.length) kick();
      } catch {}
    },
    push(msg, meta) {
      try {
        const text = String(msg == null ? '' : msg).slice(0, MAX_TEXT);
        if (!text) return;
        const level = (meta && meta.level) || 'info';
        const kind = (meta && meta.kind) || null;
        const last = pending[pending.length - 1];
        // Consecutive same-kind lines collapse on the way in, exactly as folderlog.js does, so the
        // buffer never fills with a burst the flush would only throw away anyway.
        if (kind && last && last.kind === kind) { last.at = new Date(now()).toISOString(); last.level = level; last.text = text; }
        else pending.push({ at: new Date(now()).toISOString(), level, kind, text });
        // Oldest out: a shipper that cannot reach the server must not grow without bound, and the
        // newest lines are the ones a support conversation needs.
        if (pending.length > maxPending) pending.splice(0, pending.length - maxPending);
        if ((meta && meta.terminal) || pending.length >= maxLines || now() - lastFlush >= flushMs) kick();
      } catch { /* a logger must never be able to break the run it documents */ }
    },
    flush() { try { return kick(); } catch { return Promise.resolve(); } },
    idle: () => inflight || Promise.resolve(),
    stats: () => ({ jobId, pending: pending.length, sent, dropped }),
    // A run whose plan carries no jobId must not ship its lines into the PREVIOUS run's log.
    reset() { try { jobId = null; pending = []; lastFlush = now(); } catch {} },
  };
}
