// Auto-Reject scan: fetch Received+Valid invoices in a date range, evaluate each against the
// user's criteria, return review items. Read-only — nothing here touches document state.
// Every candidate gets a /details fetch (canonical fields for ALL rules — the /search row schema
// is never trusted for money math); a failed fetch yields a fail-closed flag row, never a guess.
import { SOURCES } from '../api/sources.js';
import { probeCount, fetchAllRows, fetchDetails, mapLimit } from '../api/client.js';
import { evaluateDoc } from './rules.js';
import { lsGet, lsSet } from '../core/ls.js';

const SCAN_CAP = 2000;      // rejection scans target the short legal window, not bulk history — refuse more (narrow the range)
const DETAIL_CONC = 12;
const SEEN_KEY = 'arSeen';  // dup keys of every document ever scanned (cross-run duplicate detection)
const SEEN_MAX = 8000;

const coded = (code) => Object.assign(new Error(code), { code });
export const loadSeen = () => new Set((lsGet(SEEN_KEY) || []).filter((k) => typeof k === 'string'));
const saveSeen = (set) => lsSet(SEEN_KEY, [...set].slice(-SEEN_MAX));

// hooks: { onStatus(msg), onProgress(cur,max), onRate(waitMs), signal }
// Returns { items, scanned, passed } — items sorted hard-rejects first, then flags.
export async function scanReceived({ from, to, cfg, hooks = {} }) {
  const { onStatus = () => {}, onProgress = () => {}, onRate, signal } = hooks;
  const SRC = SOURCES.invoices;
  const dir = 'Received', field = 'Submission', status = 'Valid';   // only Valid received docs are receiver-rejectable
  if (!from || !to || from > to) throw coded('BAD_RANGE');

  const opts = { signal, onRate };
  const n = await probeCount(SRC, from, to, dir, field, status, null, null, opts);
  if (n > SCAN_CAP) throw Object.assign(coded('TOO_MANY'), { count: n, cap: SCAN_CAP });
  if (n === 0) return { items: [], scanned: 0, passed: 0 };

  onStatus('rows');
  const rows = await fetchAllRows(SRC, { fromISO: from, toISO: to, count: n }, dir, field, status, null, { signal, onRate });
  const uuids = rows.map((r) => SRC.rowUuid(r)).filter(Boolean);

  onStatus('details');
  let done = 0;
  const seen = loadSeen();                       // prior-run keys — this scan's own keys join AFTER evaluation (below)
  const details = await mapLimit(uuids, DETAIL_CONC, async (uuid) => {
    if (signal?.aborted) throw coded('STOPPED');
    try { return { uuid, o: await fetchDetails(SRC, uuid, opts) }; }
    catch (e) { if (e.code === 'STOPPED') throw e; return { uuid, o: null, err: e.code || e.message }; }
    finally { onProgress(++done, uuids.length); }
  });

  const items = [];
  let passed = 0;
  const scanKeys = new Set();                    // in-scan duplicate detection: first occurrence registers, second fires DUP
  for (const dRes of details) {
    if (!dRes.o) {
      items.push({ uuid: dRes.uuid, verdict: 'flag', eligible: false, firings: [{ id: 'FETCH-FAILED', sev: 'flag', en: `Details fetch failed (${dRes.err}) — verify manually.`, ar: `تعذّر جلب التفاصيل (${dRes.err}) — راجع المستند يدويًا.` }], doc: null });
      continue;
    }
    const o = dRes.o;
    if (o.status && o.status !== 'Valid') { passed++; continue; }   // status changed under us — no longer rejectable
    const r = evaluateDoc(cfg, o, { seen: new Set([...seen, ...scanKeys]) });
    if (r.dupKey) scanKeys.add(r.dupKey);
    if (r.verdict === 'pass') { passed++; continue; }
    items.push({
      uuid: o.uuid || dRes.uuid, verdict: r.verdict, eligible: r.eligible, ageDays: r.ageDays, firings: r.firings,
      doc: {   // display + audit surface only — full details stay out of memory/audit
        internalID: o.internalID, issuerId: o.issuer?.id, issuerName: o.issuer?.name,
        totalAmount: o.totalAmount, typeEn: o.documentTypeNamePrimaryLang, typeAr: o.documentTypeNameSecondaryLang,
        received: o.dateTimeRecevied || o.dateTimeReceived || null,
      },
    });
  }
  for (const k of scanKeys) seen.add(k);         // remember every scanned doc for future cross-run dup detection
  saveSeen(seen);

  items.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'reject' ? -1 : 1));
  return { items, scanned: uuids.length, passed };
}
