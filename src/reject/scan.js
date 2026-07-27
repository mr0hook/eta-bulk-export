// Auto-Reject scan: fetch Received+Valid invoices in a date range (shared fetcher), evaluate each
// against the user's criteria, return review items. Read-only — nothing here touches document
// state. A failed details fetch yields a fail-closed flag row, never a guess.
import { evaluateDoc } from './rules.js';
import { fetchReceivedDetails } from './received.js';
import { lsGet, lsSet } from '../core/ls.js';

const SEEN_KEY = 'arSeen';  // dup keys of every document ever scanned (cross-run duplicate detection)
const SEEN_MAX = 8000;

export const loadSeen = () => new Set((lsGet(SEEN_KEY) || []).filter((k) => typeof k === 'string'));
const saveSeen = (set) => lsSet(SEEN_KEY, [...set].slice(-SEEN_MAX));

// hooks: { onStatus(msg), onProgress(cur,max), onRate(waitMs), signal }
// resolveWindow: optional per-document rejection-window resolver (days) — cfg.windowDays fallback.
// Returns { items, scanned, passed } — items sorted hard-rejects first, then flags.
export async function scanReceived({ from, to, cfg, resolveWindow, hooks = {} }) {
  const { results } = await fetchReceivedDetails({ from, to, hooks });

  const items = [];
  let passed = 0;
  const seen = loadSeen();                       // prior-run keys — this scan's own keys join AFTER evaluation (below)
  const scanKeys = new Set();                    // in-scan duplicate detection: first occurrence registers, second fires DUP
  for (const dRes of results) {
    if (!dRes.o) {
      items.push({ uuid: dRes.uuid, verdict: 'flag', eligible: false, firings: [{ id: 'FETCH-FAILED', sev: 'flag', en: `Details fetch failed (${dRes.err}) — verify manually.`, ar: `تعذّر جلب التفاصيل (${dRes.err}) — راجع المستند يدويًا.` }], doc: null });
      continue;
    }
    const o = dRes.o;
    if (o.status && o.status !== 'Valid') { passed++; continue; }   // status changed under us — no longer rejectable
    const r = evaluateDoc(cfg, o, { seen: new Set([...seen, ...scanKeys]), resolveWindow });
    if (r.dupKey) scanKeys.add(r.dupKey);
    if (r.verdict === 'pass') { passed++; continue; }
    items.push({
      uuid: o.uuid || dRes.uuid, verdict: r.verdict, eligible: r.eligible, ageDays: r.ageDays, windowDays: r.windowDays, firings: r.firings,
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
  return { items, scanned: results.length, passed };
}
