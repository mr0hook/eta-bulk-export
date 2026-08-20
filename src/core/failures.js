// SPEC-028 — parse eta_failures.jsonl into the list of document UUIDs worth retrying.
//
// The file is an append-only audit log written by the run loop (one JSON object per line: dropped
// documents, failed official PDFs, over-cap range warnings). Retry-eligible lines are the dropped
// DOCUMENTS: they carry a uuid, are not 'pdf' (the document itself was exported; only its optional
// official PDF failed) and not receipts (the uuid-list export is invoices-only, SPEC-022).
// A crash can tear the last line mid-write, so garbage lines are counted and skipped, never fatal.
/**
 * SPEC-035 — rewrite the failures log after a run that recovered some of them.
 *
 * The log is append-only by design (it is the audit trail of every document that did not make it
 * into an export). But once a retry run has actually fetched those documents, leaving their lines
 * in place means the next "Load failed UUIDs" hands back documents that are already exported, and
 * the file never stops growing. So a run prunes the entries it just recovered — and ONLY those.
 *
 * Pure and node-testable. `recovered` is the set of uuids this run exported successfully.
 * Returns { text, removed, kept } — text is null when nothing changed, so the caller can skip the
 * write entirely rather than rewriting a multi-megabyte file for no reason.
 */
export function pruneFailureLines(text, recovered) {
  const src = String(text || '');
  if (!src.trim() || !recovered || !recovered.size) return { text: null, removed: 0, kept: 0 };
  const out = [];
  let removed = 0;
  for (const line of src.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let e = null; try { e = JSON.parse(s); } catch {}
    // Unparsable lines are KEPT: a torn line is still evidence, and dropping what we cannot read
    // would quietly delete history. Only a line we positively identify as recovered goes.
    //
    // A `kind` line is NOT about a missing document and is never pruned: kind:'pdf' says the
    // document exported but its official PDF did not — still true after the document is
    // re-exported (T-226 caught this) — and kind:'over_cap' describes a range, not a document.
    const uuid = e && !e.kind && typeof e.uuid === 'string' ? e.uuid : '';
    if (uuid && recovered.has(uuid)) { removed++; continue; }
    out.push(s);
  }
  if (!removed) return { text: null, removed: 0, kept: out.length };
  return { text: out.length ? out.join('\n') + '\n' : '', removed, kept: out.length };
}

export function parseFailureUuids(text) {
  const uuids = [];
  const seen = new Set();
  let pdfOnly = 0, receipts = 0, badLines = 0;
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let e; try { e = JSON.parse(s); } catch { badLines++; continue; }
    if (!e || typeof e !== 'object') { badLines++; continue; }
    if (e.kind === 'pdf') { pdfOnly++; continue; }
    const u = typeof e.uuid === 'string' ? e.uuid.trim() : '';
    if (!u) continue;                       // over_cap lines and other non-document entries
    if (e.source === 'receipts') { receipts++; continue; }
    if (!seen.has(u)) { seen.add(u); uuids.push(u); }
  }
  return { uuids, pdfOnly, receipts, badLines };
}
