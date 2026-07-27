// Shared "received invoices for a period, with details" fetcher — the single pipeline behind the
// Auto-Reject scan and the PO reconciliation analytics. Read-only. Client functions are injected
// (deps) so the pipeline is node-testable without a network; production callers use the default.
import { SOURCES } from '../api/sources.js';
import { probeCount, fetchAllRows, fetchDetails, mapLimit } from '../api/client.js';

export const SCAN_CAP = 2000;   // rejection-era workflows target a short window, not bulk history — refuse more (narrow the range)
export const DETAIL_CONC = 12;

const coded = (code) => Object.assign(new Error(code), { code });
const CLIENT = { probeCount, fetchAllRows, fetchDetails };

// hooks: { onStatus('rows'|'details'), onProgress(cur,max), onRate(waitMs), signal }
// → { results: [{ uuid, o /* full /details or null */, err? }], count } — order = search order.
export async function fetchReceivedDetails({ from, to, field = 'Submission', status = 'Valid', cap = SCAN_CAP, hooks = {} } = {}, deps = CLIENT) {
  const { onStatus = () => {}, onProgress = () => {}, onRate, signal } = hooks;
  const SRC = SOURCES.invoices;
  const dir = 'Received';   // receiver-side workflows only; issued docs are never candidates
  if (!from || !to || from > to) throw coded('BAD_RANGE');

  const opts = { signal, onRate };
  const count = await deps.probeCount(SRC, from, to, dir, field, status, null, null, opts);
  if (count > cap) throw Object.assign(coded('TOO_MANY'), { count, cap });
  if (count === 0) return { results: [], count: 0 };

  onStatus('rows');
  const rows = await deps.fetchAllRows(SRC, { fromISO: from, toISO: to, count }, dir, field, status, null, { signal, onRate });
  const uuids = rows.map((r) => SRC.rowUuid(r)).filter(Boolean);

  onStatus('details');
  let done = 0;
  const results = await mapLimit(uuids, DETAIL_CONC, async (uuid) => {
    if (signal?.aborted) throw coded('STOPPED');
    try { return { uuid, o: await deps.fetchDetails(SRC, uuid, opts) }; }
    catch (e) { if (e.code === 'STOPPED') throw e; return { uuid, o: null, err: e.code || e.message }; }
    finally { onProgress(++done, uuids.length); }
  });
  return { results, count };
}
