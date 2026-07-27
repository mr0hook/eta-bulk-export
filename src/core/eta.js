// Live time-left estimation in WORK units, not discovered rows. A chunk has two phases: fast paged
// /search (rows appear quickly) and the slow per-invoice /details (+ optional PDF) fetches that
// dominate wall-clock. Counting discovered rows made the timer plummet during paging then stall —
// so progress here is invoices FULLY PROCESSED: 'search' contributes zero work (its time still counts
// as elapsed), 'details' contributes per-row, and PDFs double each invoice's work when enabled.
// Known overstatement: with a multi-status client-side filter chunk.count is the unfiltered probe
// count, so workTotal is high (details are only fetched for filtered rows) — same as the old estimator.
const unit = (pdf) => (pdf ? 2 : 1);
export const workTotal = (plan) => (plan.totalRows || 0) * unit(plan.downloadPdf);
// work already banked in completed chunks (resume-aware; mirrors the doneRows sum in the drawer's onPlan)
export function doneChunkWork(plan) {
  const done = new Set(plan.doneIds || []);
  return plan.chunks.filter((c) => done.has(c.id)).reduce((s, c) => s + Math.min(c.count, plan.cap || 1e12), 0) * unit(plan.downloadPdf);
}
// live work inside the CURRENT chunk, from the orchestrator's onChunk {phase, cur, max} payload
// (max = the chunk's actual row count in both the details and pdf phases)
export function chunkPhaseWork(chunk, pdf) {
  if (!chunk || !chunk.max) return 0;
  return chunk.phase === 'details' ? chunk.cur
    : chunk.phase === 'pdf' ? chunk.max + chunk.cur
    : chunk.phase === 'write' ? unit(pdf) * chunk.max
    : 0;   // 'search' paging = elapsed time, zero work — the point of the redesign
}
// Stateful rate tracker. First update() records the baseline (work already present when THIS session
// started, so a resume never averages in prior sessions); later updates return minutes remaining, or
// null while warming up / done. Injectable clock for tests.
export function createEtaTracker({ warmupMs = 30000, minWork = 20, now = Date.now } = {}) {
  let work0 = null, t0 = 0;
  return {
    reset() { work0 = null; t0 = 0; },
    update(plan, lastChunk) {
      if (!plan || !plan.chunks) return null;
      const total = workTotal(plan);
      const done = doneChunkWork(plan) + chunkPhaseWork(lastChunk, !!plan.downloadPdf);
      if (work0 == null) { work0 = done; t0 = now(); return null; }
      const gained = done - work0, el = (now() - t0) / 1000;
      if (el < warmupMs / 1000 || gained < minWork || total <= done) return null;
      return Math.max(1, Math.round((total - done) / (gained / el) / 60));
    },
  };
}
