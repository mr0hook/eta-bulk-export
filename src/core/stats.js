// Lifetime usage counters for this device (runs completed, documents exported, PDFs saved).
// Counts ONLY — never document contents. Sent with each /session check-in so the operator can see
// value delivered (disclosed in the privacy policy). Cleared localStorage restarts at 0; the server
// max-merges so the dashboard never regresses.
import { lsGet, lsSet } from './ls.js';

export const readStats = () => lsGet('stats') || { runs: 0, docs: 0, pdfs: 0, lastExportAt: '' };

export function bumpStats({ runs = 0, docs = 0, pdfs = 0 } = {}) {
  const s = readStats();
  s.runs += runs; s.docs += docs; s.pdfs += pdfs; s.lastExportAt = new Date().toISOString();
  lsSet('stats', s);
  return s;
}
