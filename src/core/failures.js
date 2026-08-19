// SPEC-028 — parse eta_failures.jsonl into the list of document UUIDs worth retrying.
//
// The file is an append-only audit log written by the run loop (one JSON object per line: dropped
// documents, failed official PDFs, over-cap range warnings). Retry-eligible lines are the dropped
// DOCUMENTS: they carry a uuid, are not 'pdf' (the document itself was exported; only its optional
// official PDF failed) and not receipts (the uuid-list export is invoices-only, SPEC-022).
// A crash can tear the last line mid-write, so garbage lines are counted and skipped, never fatal.
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
