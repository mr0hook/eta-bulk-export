// SPEC-022 — the pasted list. One textarea accepts either document UUIDs or counterparty
// registration numbers; the CONTENT decides which export runs, so classification must be strict:
// a token that is almost a UUID is a typo to surface, never something to guess about.
//
// The list itself never leaves the device (the server is sent a count — see /plan/uuids). That is
// why parsing lives here in core with no imports: it must be testable and auditable in isolation.

export const UUIDS_MAX = 10000;   // mirrors the server's cap (routes/plan.js UUIDS_MAX)
export const RINS_MAX = 200;      // a filter list, not a dataset — past this the range export wins

const UUID_RE = /^[0-9A-Z]{26}$/;          // ETA document uuid: 26 uppercase base-31 chars
const RIN_RE = /^(\d{9}|\d{14})$/;         // 9 digits (company TRN) or 14 (person national id)

/**
 * Parse a paste. Separators: any whitespace, commas, semicolons. Case-insensitive for UUIDs.
 * Returns { kind:'uuid'|'rin'|'empty', items:[], invalid:[], error?:'mixed'|'too_many' } —
 * `items` deduplicated in first-seen order, `invalid` the tokens that matched neither shape.
 */
export function parseList(text) {
  const tokens = String(text || '').split(/[\s,;]+/).filter(Boolean);
  const uuids = [], rins = [], invalid = [], seen = new Set();
  for (const raw of tokens) {
    const tok = raw.trim();
    if (seen.has(tok.toUpperCase())) continue;
    seen.add(tok.toUpperCase());
    const up = tok.toUpperCase();
    if (UUID_RE.test(up)) uuids.push(up);
    else if (RIN_RE.test(tok)) rins.push(tok);
    else invalid.push(tok);
  }
  if (uuids.length && rins.length) return { kind: 'empty', items: [], invalid, error: 'mixed' };
  if (uuids.length) {
    if (uuids.length > UUIDS_MAX) return { kind: 'uuid', items: [], invalid, error: 'too_many' };
    return { kind: 'uuid', items: uuids, invalid };
  }
  if (rins.length) {
    if (rins.length > RINS_MAX) return { kind: 'rin', items: [], invalid, error: 'too_many' };
    return { kind: 'rin', items: rins, invalid };
  }
  return { kind: 'empty', items: [], invalid };
}

// Order-independent stable hash of a list (djb2 over the sorted items). It keys the run: pasting
// the same list again — in any order — resumes the same progress file instead of starting over.
export function listKey(items) {
  const s = [...items].sort().join('\n');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(7, '0').slice(-7);
}

/**
 * SPEC-022b — the counterparty filter over SEARCH rows (the shape `SOURCES.invoices.rowSearch`
 * returns). The portal's exact spelling is not pinned anywhere in this codebase, so extraction is
 * deliberately tolerant: flat issuerId/receiverId AND nested issuer.id/receiver.id. `rinIdsOf`
 * is exported separately because the orchestrator must FAIL LOUD when rows carry no recognisable
 * id at all — silently filtering everything out would read as "this counterparty has no invoices".
 */
export function rinIdsOf(row) {
  const s = row || {};
  return [s.issuerId, s.receiverId, s.issuer?.id, s.receiver?.id]
    .map((v) => String(v == null ? '' : v).trim()).filter(Boolean);
}
export function rinMatch(rins) {
  const set = new Set((rins || []).map((r) => String(r).trim()));
  return (row) => rinIdsOf(row).some((id) => set.has(id));
}
