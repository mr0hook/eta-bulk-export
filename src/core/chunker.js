// Year-first adaptive date-bisection planner. Pure: probing is injected via deps so it's
// node-testable. Granular axis splits by time (inclusive boundary → gap-free even with
// sub-ms timestamps); date-only axis splits on whole Cairo days (no day double-counted).
import { dayStartISO, dayEndISO, chunkLabel, ymd } from './time.js';

function mkChunk(fromISO, toISO, count, warn, subF, subT) {
  const sub = subF && subT ? ` · sub ${subF.slice(11, 19)}→${subT.slice(11, 19)}` : '';
  return { id: `${fromISO}_${toISO}${subF ? '_' + subF + '_' + subT : ''}`, fromISO, toISO, subF, subT, label: chunkLabel(fromISO, toISO) + sub, count, warn };
}

// SPEC-024 — coalescing. Bisection accepts the first window under cap, so adjacent leaves are
// routinely half-empty; a greedy left-to-right fold merges them up to 90% of cap. Never touches a
// warned chunk; plain merges with plain (the span between two leaves probed zero — widening over
// it can only ADD a late arrival, and over-report dedups by UUID); sub merges with sub only inside
// the same issuance window. The server (lead-worker/src/planner.js) does the identical merge
// streaming at emit time — same function, planner.test.mjs proves the equivalence.
const MERGE_FILL = 0.9;
function canMerge(a, b, target) {
  if (!a || a.warn || b.warn || a.count + b.count > target) return false;
  if (!a.subF && !b.subF) return true;
  return !!a.subF && !!b.subF && a.fromISO === b.fromISO && a.toISO === b.toISO;
}
export function coalesce(chunks, cap) {
  const target = Math.floor(cap * MERGE_FILL);
  const out = [];
  for (const c of chunks) {
    const p = out[out.length - 1];
    if (canMerge(p, c, target)) {
      out[out.length - 1] = p.subF
        ? mkChunk(p.fromISO, p.toISO, p.count + c.count, null, p.subF, c.subT)
        : mkChunk(p.fromISO, c.toISO, p.count + c.count, null);
    } else out.push(c);
  }
  return out;
}

// deps: { probe(fromISO,toISO,subF?,subT?)->count, detectMaxSub(issF,issT)->isoOrNull, onProgress(n,msg), stopped()->bool }
export async function buildChunks(SRC, from, to, field, deps) {
  const { probe, detectMaxSub = async () => null, onProgress = () => {}, stopped = () => false } = deps;
  const CAP = SRC.cap, granular = SRC.granular.includes(field);
  let probes = 0;

  async function subSplit(issF, issT) {
    const maxSub = await detectMaxSub(issF, issT); if (!maxSub) return [];
    onProgress(probes, `Issuance day ${chunkLabel(issF, issT)} >${CAP} — splitting by submission time…`);
    const minMs = Date.parse(issF) - 86400000, maxMs = Date.parse(maxSub) + 1000;
    async function ss(subF, subT, depth) {
      if (stopped()) return [];
      const cnt = await probe(issF, issT, subF, subT); probes++;
      onProgress(probes, `${chunkLabel(issF, issT)} sub: ${cnt >= CAP ? '≥' : ''}${cnt}`);
      if (cnt === 0) return [];
      if (cnt < CAP) return [mkChunk(issF, issT, cnt, null, subF, subT)];
      const fMs = Date.parse(subF), tMs = Date.parse(subT);
      if (tMs - fMs <= 1000 || depth > 64) return [mkChunk(issF, issT, cnt, 'over_cap_one_second', subF, subT)];
      const mid = new Date(fMs + Math.floor((tMs - fMs) / 2)).toISOString();   // inclusive shared boundary → GAP-FREE
      const L = await ss(subF, mid, depth + 1); if (stopped()) return L;         // (NOT mid/mid+1ms, which opens a <1ms
      const R = await ss(mid, subT, depth + 1);                                 // gap at ETA's sub-ms precision). A doc on
      return [...L, ...R];                                                       // `mid` may appear twice → merge dedups by UUID.
    }
    return ss(new Date(minMs).toISOString(), new Date(maxMs).toISOString(), 0);
  }

  async function split(fromISO, toISO, depth) {
    if (stopped()) return [];
    const cnt = await probe(fromISO, toISO); probes++;
    onProgress(probes, `${chunkLabel(fromISO, toISO)}: ${cnt >= CAP ? '≥' : ''}${cnt}`);
    if (cnt === 0) return [];
    if (cnt < CAP) return [mkChunk(fromISO, toISO, cnt)];
    let leftTo, rightFrom, atFloor;
    if (granular) {
      const fMs = Date.parse(fromISO), tMs = Date.parse(toISO);
      atFloor = (tMs - fMs) <= 1000;
      const mid = new Date(fMs + Math.floor((tMs - fMs) / 2)).toISOString();
      leftTo = mid; rightFrom = mid;                       // inclusive shared boundary → GAP-FREE at any filter precision.
      // A doc exactly on `mid` can appear in both halves (rare over-report) — merge dedups it by UUID. Deliberately
      // NOT mid / mid+1ms: with ETA's sub-ms timestamps that opens a <1ms GAP (silent drop). For a compliance export,
      // a dedup-able over-report is recoverable; an under-report is not.
    } else {
      const f = new Date(fromISO), t = new Date(toISO);
      const fDay = new Date(f.getFullYear(), f.getMonth(), f.getDate());
      const tDay = new Date(t.getFullYear(), t.getMonth(), t.getDate());
      const days = Math.round((tDay - fDay) / 86400000);
      atFloor = days <= 0;
      // DST-safe calendar arithmetic (NOT fixed 86.4M-ms hops): a 25h Cairo fall-back day otherwise makes
      // next-day land at 23:00 of the SAME calendar day → overlapping chunks + non-terminating re-split.
      const midDay = new Date(fDay.getFullYear(), fDay.getMonth(), fDay.getDate() + Math.floor(days / 2));
      const nextDay = new Date(midDay.getFullYear(), midDay.getMonth(), midDay.getDate() + 1);
      leftTo = dayEndISO(ymd(midDay));
      rightFrom = dayStartISO(ymd(nextDay));
    }
    if (atFloor || depth > 80) {
      if (SRC.subSplit && field === 'Issue' && cnt >= CAP) { const s = await subSplit(fromISO, toISO); if (s.length) return s; }
      return [mkChunk(fromISO, toISO, cnt, granular ? 'over_cap_one_second' : 'over_cap_single_day')];
    }
    const L = await split(fromISO, leftTo, depth + 1); if (stopped()) return L;
    const R = await split(rightFrom, toISO, depth + 1);
    return [...L, ...R];
  }

  onProgress(0, `Probing ${chunkLabel(dayStartISO(from), dayEndISO(to))}…`);
  return coalesce(await split(dayStartISO(from), dayEndISO(to), 0), CAP);   // SPEC-024
}
