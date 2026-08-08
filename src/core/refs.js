// SPEC-008 — resolve a credit/debit note's reference UUIDs to the ORIGINAL document's invoice
// number. The UUID linkage (SPEC-001) tells you *which* document a note reverses; this tells you
// its invoice number, which is what a human — or a VLOOKUP — actually reconciles against.
//
// Free path first: the referenced original is very often in the same export, so we read its
// internalID straight off the corpus. Only what's genuinely missing costs a /details call, and the
// cache is run-level so one original is fetched once no matter how many notes point at it.
//
// Client functions are injected so this is node-testable without a network.
import { SOURCES } from '../api/sources.js';
import { fetchDetails, mapLimit } from '../api/client.js';

export const REF_CONC = 8;   // originals outside the export are a long tail, not the main pass — stay well under the details concurrency

const UNRESOLVED = null;     // cached miss: looked it up, there is no number — never look again

// uuid → internalID for every document already in this corpus (zero network).
export function localNumbers(records) {
  const m = new Map();
  for (const r of records) {
    const d = r?.detail || r;
    if (d?.uuid && d.internalID) m.set(d.uuid, d.internalID);
  }
  return m;
}

// Every distinct uuid referenced by a note in this corpus.
export function referencedUuids(records) {
  const s = new Set();
  for (const r of records) {
    for (const u of (r?.detail || r)?.references || []) if (u) s.add(u);
  }
  return s;
}

// → Map(uuid → internalID | null). `cache` is the run-level map; pass the same one across chunks.
// AUTH/STOPPED propagate on purpose: the orchestrator owns token renewal and pause, and swallowing
// them here would strand a run that could have recovered. Every other failure is a blank cell.
export async function resolveReferenceNumbers(records, deps = {}, cache = new Map(), opts = {}) {
  const { fetchDetails: fetchOne = fetchDetails, SRC = SOURCES.invoices } = deps;
  const { signal, onRate, conc = REF_CONC, onLookup } = opts;

  const local = localNumbers(records);
  const wanted = referencedUuids(records);
  const missing = [];
  for (const u of wanted) {
    if (cache.has(u)) continue;
    if (local.has(u)) { cache.set(u, local.get(u)); continue; }   // free — it's in this export
    missing.push(u);
  }

  if (missing.length) {
    onLookup?.(missing.length);   // only fires when something actually costs network — silent on the free path
    await mapLimit(missing, Math.min(conc, missing.length), async (uuid) => {
      try {
        const d = await fetchOne(SRC, uuid, { signal, onRate });
        cache.set(uuid, d?.internalID || UNRESOLVED);
      } catch (e) {
        if (e?.code === 'AUTH' || e?.code === 'STOPPED') throw e;
        cache.set(uuid, UNRESOLVED);   // 404 / network / gone — blank cell, and don't ask again this run
      }
    });
  }
  return cache;
}
