// ETA API client. Origin-guarded, retry/backoff, 404→empty (receipts), abortable.
import { API_ORIGIN } from './sources.js';
import { getToken } from '../core/token.js';

const MAX_BACKOFF = 10 * 60 * 1000;
// Per-request deadlines (2026-08-19): the WAF can TARPIT — hold a connection open and never
// answer. Without a timeout that hangs a mapLimit worker forever and the run goes silent
// ("stuck at chunk N", no errors, no waits). A timed-out request rejects with TimeoutError,
// which is NOT the user's abort — it falls into the ordinary retry-with-backoff below and, if it
// keeps happening, surfaces as that row's loud failure instead of an invisible hang.
const REQ_TIMEOUT_MS = 60 * 1000;        // JSON endpoints: search pages and details
const BLOB_TIMEOUT_MS = 180 * 1000;      // official PDFs are bigger and slower
const deadline = (signal, ms) => {
  try {
    if (typeof AbortSignal.timeout !== 'function' || typeof AbortSignal.any !== 'function') return signal;
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  } catch { return signal; }
};
const coded = (code) => Object.assign(new Error(code), { code });
// abort-aware sleep: rejects with STOPPED the instant the signal aborts, so Pause/Halt isn't stuck behind a backoff
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(coded('STOPPED'));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(coded('STOPPED')); }, { once: true });
});

export function buildUrl(SRC, fromISO, toISO, dir, field, page, size, statusParam, subF, subT, sortDesc, query) {
  const p = new URLSearchParams();
  if (dir && dir !== SRC.dirOmit) p.set(SRC.dirParam, dir);
  if (statusParam && SRC.statusServer) p.set('Status', statusParam);
  // SPEC-022b: the portal's own free-text search param. Documented on the Documents page as
  // matching Receiver ID/Name and Issuer ID/Name (exact or fragment) and verified live
  // (2026-08-19) to compose with the date filters — so a single-RIN export narrows SERVER-side
  // and probes count only that party's documents. Over-matching is fine: the orchestrator's
  // rinMatch() re-filters rows precisely.
  if (query) p.set('Query', query);
  p.set(SRC.dateName(field, 'From'), fromISO);
  p.set(SRC.dateName(field, 'To'), toISO);
  if (subF && subT) { p.set('SubmissionDateFrom', subF); p.set('SubmissionDateTo', subT); } // invoice sub-split
  if (sortDesc) { p.set('SortBy', 'DateTimeReceived'); p.set('SortDir', 'Desc'); }
  for (const k in SRC.extra) p.set(k, SRC.extra[k]);
  p.set(SRC.pageParam, String(page)); p.set('PageSize', String(size));
  return `${SRC.search}?${p.toString()}`;
}

export async function apiGet(url, { attempts = 7, signal, onRate, timeoutMs = REQ_TIMEOUT_MS } = {}) {
  try { if (new URL(url).origin !== API_ORIGIN) throw coded('BAD_URL'); } catch { throw coded('BAD_URL'); }
  let lastErr, saw403 = false;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw coded('STOPPED');
    const tok = getToken(); if (!tok) throw coded('AUTH');
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json', 'Accept-Language': 'ar' }, signal: deadline(signal, timeoutMs) });
      if (r.redirected && new URL(r.url).origin !== API_ORIGIN) throw coded('BAD_URL');   // never trust a response redirected off the ETA origin
      if (r.status === 401) throw coded('AUTH');
      // 403 is deliberately NOT auth (2026-08-19, portal build 72): /details returns
      // AccessDenied for specific documents the account's own range search LISTS but is not
      // authorized to read (uuid-search can't see them and the portal page says not found —
      // likely intermediary/marketplace submissions). As AUTH it sent the run into token-renewal
      // loops it can't win. One retry rides out a transient WAF refusal; a second 403 is the
      // document's answer, and the caller records that one row as dropped. A dead session is 401.
      if (r.status === 403) {
        if (saw403) throw coded('FORBIDDEN');
        saw403 = true; lastErr = coded('FORBIDDEN');
        await sleep(1500 + Math.floor(Math.random() * 500), signal); continue;
      }
      if (r.status === 404) throw coded('NOT_FOUND');   // receipts: empty date range
      if (r.status === 429) {                            // honor Retry-After; add jitter so N concurrent fetches don't retry in lockstep
        const ra = parseInt(r.headers?.get?.('Retry-After') || '', 10);
        const base = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 5000 * 2 ** i;   // ignore negative/garbage Retry-After; 0 = retry now
        const w = Math.min(base, MAX_BACKOFF) + Math.floor(Math.random() * 1000);
        lastErr = coded('RATE_LIMIT'); onRate?.(w, true); await sleep(w, signal); continue;   // true = real 429 (SPEC-025: feeds the governor)
      }
      if (!r.ok) { lastErr = new Error('HTTP ' + r.status); await sleep(1500 * (i + 1) + Math.floor(Math.random() * 500), signal); continue; }
      return await r.json();
    } catch (e) {
      // STOPPED means THE USER stopped — decided solely by the caller's signal. The deadline's
      // timeout also surfaces as an abort, and not always as TimeoutError: a deadline that fires
      // MID-BODY (r.json() on a slow stream) rejects with plain AbortError in Chrome. Before this
      // check keyed on the caller's signal (2026-08-19), such a timeout masqueraded as the user's
      // Pause and the run "paused itself" with no one touching it — a phantom pause mid-details.
      if (signal?.aborted) throw coded('STOPPED');
      if (['AUTH', 'FORBIDDEN', 'NOT_FOUND', 'STOPPED', 'BAD_URL', 'NOT_PDF'].includes(e.code)) throw e;
      lastErr = e; const w = Math.min(5000 * 2 ** i, MAX_BACKOFF) + Math.floor(Math.random() * 1000); onRate?.(w); await sleep(w, signal);
    }
  }
  throw lastErr || new Error('apiGet failed');
}

export async function probeCount(SRC, fromISO, toISO, dir, field, statusParam, subF, subT, opts) {
  try {
    const j = await apiGet(buildUrl(SRC, fromISO, toISO, dir, field, 1, 10, statusParam, subF, subT, false, opts?.query), opts);
    const n = j?.metadata?.totalCount;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw coded('BAD_COUNT');   // missing/garbled count must NOT be read as a genuine 0
    return n;
  } catch (e) { if (e.code === 'NOT_FOUND') return 0; throw e; }
}

export async function fetchAllRows(SRC, chunk, dir, field, statusParam, filterSet, { onPage, signal, onRate, pagePause = 250, query } = {}) {
  const ps = SRC.pageSize, maxPage = Math.ceil(SRC.cap / ps) + 5;
  const expected = Math.min(chunk.count || 0, SRC.cap);
  let rows = [], page = 1;
  for (;;) {
    if (signal?.aborted) break;
    let j;
    try { j = await apiGet(buildUrl(SRC, chunk.fromISO, chunk.toISO, dir, field, page, ps, statusParam, chunk.subF, chunk.subT, false, query), { signal, onRate }); }
    catch (e) { if (e.code === 'NOT_FOUND') { if (page > 1) throw e; break; } throw e; }   // 404 after real pages ≠ clean end → fail the chunk
    const r = (j && j[SRC.resultKey]) || [];
    rows.push(...r); onPage?.(rows.length, Math.max(expected, rows.length));
    if (r.length < ps) break;                 // short page = definitive end; paginate to HERE, not to the (possibly stale) probed count
    page++; if (page > maxPage) break;         // API result cap reached
    await sleep(pagePause, signal);
  }
  if (filterSet) rows = rows.filter((x) => filterSet.has(SRC.rowStatus(x)));
  return rows;
}

export async function fetchDetails(SRC, uuid, opts) {
  const j = await apiGet(`${SRC.detailsBase}/${uuid}/details?documentLinesLimit=1000`, opts);
  return SRC.detailUnwrap(j);
}

// Official signed PDF for a document/receipt: authenticated GET returning a binary blob.
// Same origin + session token as the JSON API. 404 → NOT_FOUND (no PDF for that doc).
export async function apiGetBlob(url, { attempts = 5, signal, onRate, timeoutMs = BLOB_TIMEOUT_MS } = {}) {
  try { if (new URL(url).origin !== API_ORIGIN) throw coded('BAD_URL'); } catch { throw coded('BAD_URL'); }
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw coded('STOPPED');
    const tok = getToken(); if (!tok) throw coded('AUTH');
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/pdf', 'Accept-Language': 'ar' }, signal: deadline(signal, timeoutMs) });
      if (r.redirected && new URL(r.url).origin !== API_ORIGIN) throw coded('BAD_URL');   // never trust a response redirected off the ETA origin
      if (r.status === 401) throw coded('AUTH');   // 403 falls to the generic retry — see apiGet
      if (r.status === 404) throw coded('NOT_FOUND');
      if (r.status === 429) {
        const ra = parseInt(r.headers?.get?.('Retry-After') || '', 10);
        const base = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 5000 * 2 ** i;
        const w = Math.min(base, MAX_BACKOFF) + Math.floor(Math.random() * 1000);
        lastErr = coded('RATE_LIMIT'); onRate?.(w, true); await sleep(w, signal); continue;   // true = real 429 (SPEC-025)
      }
      if (!r.ok) { lastErr = new Error('HTTP ' + r.status); await sleep(1500 * (i + 1) + Math.floor(Math.random() * 500), signal); continue; }
      const blob = await r.blob();
      const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
      if (!(head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46)) throw coded('NOT_PDF');   // %PDF magic — reject an HTML/JSON error page served as 200
      return blob;
    } catch (e) {
      // Same rule as apiGet: only the CALLER's aborted signal is the user's stop; a deadline
      // firing mid-body rejects as plain AbortError and must retry, not fake a pause.
      if (signal?.aborted) throw coded('STOPPED');
      if (['AUTH', 'NOT_FOUND', 'STOPPED', 'BAD_URL', 'NOT_PDF'].includes(e.code)) throw e;
      lastErr = e; const w = Math.min(5000 * 2 ** i, MAX_BACKOFF) + Math.floor(Math.random() * 1000); onRate?.(w); await sleep(w, signal);
    }
  }
  throw lastErr || new Error('apiGetBlob failed');
}
export function fetchPdf(SRC, uuid, opts) { return apiGetBlob(`${SRC.detailsBase}/${uuid}/pdf`, opts); }

// SPEC-023 — the portal's own entity switcher, discovered in its public bundle: the company
// picker PUTs { taxpayerId } here and the next silent auth mints a token for that entity. Used
// by the orchestrator to switch BACK after a renewal flipped the active entity mid-run. Same
// origin guard and token as every other call; a refusal resolves false (the caller's fallback is
// the pause guard, never an error state of its own).
export async function switchTaxpayer(taxId, { signal, timeoutMs = REQ_TIMEOUT_MS } = {}) {
  const url = `${API_ORIGIN}/Api/v1/users/current/switchtaxpayer`;
  const tok = getToken(); if (!tok) return false;
  const id = Number(taxId);
  if (!Number.isFinite(id) || id <= 0) return false;
  try {
    const r = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json-patch+json', Accept: 'text/plain' },
      body: JSON.stringify({ taxpayerId: id }),
      signal: deadline(signal, timeoutMs),
    });
    if (r.redirected && new URL(r.url).origin !== API_ORIGIN) return false;
    if (!r.ok) return false;
    let j = null; try { j = await r.json(); } catch {}
    return !j || j.isSuccess !== false;   // some gateways answer 200 with an empty body
  } catch { return false; }
}

// bounded-concurrency map (for per-row /details fetches)
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

// SPEC-025 — AIMD concurrency governor for the details phase. The portal's rate ceiling is opaque
// and moves with its load (this session: 40 workers drew a 429 storm; the sequential search lane
// never drew one), so the limit is DISCOVERED, TCP-style: any real 429 halves it and freezes
// growth for a cool-down; every `rise` consecutive successes grow it by 1 back up to the old
// static maximum. One governor lives for a whole run — chunk 13 keeps what chunk 1 learned.
export function makeGovernor({ start = 12, min = 3, max = 40, rise = 25, cooldownMs = 10000, now = Date.now } = {}) {
  let limit = Math.max(min, Math.min(start, max)), streak = 0, coolUntil = 0;
  return {
    limit: () => limit,
    ok() { if (now() < coolUntil || limit >= max) { streak = 0; return; } if (++streak >= rise) { limit++; streak = 0; } },
    slow() { limit = Math.max(min, Math.floor(limit / 2)); streak = 0; coolUntil = now() + cooldownMs; },
  };
}

// mapLimit with a live limit: the pump starts work while active < gov.limit(), so a shrink simply
// stops new spawns (the surplus drains as fetches finish) and growth takes effect on the next
// completion. Same contract as mapLimit otherwise — ordered results, first rejection wins.
export function mapAdaptive(items, gov, fn) {
  const out = new Array(items.length);
  let i = 0, active = 0, rejected = false;
  return new Promise((resolve, reject) => {
    const pump = () => {
      if (rejected) return;
      if (i >= items.length && active === 0) return resolve(out);
      while (!rejected && active < gov.limit() && i < items.length) {
        const idx = i++; active++;
        Promise.resolve(fn(items[idx], idx)).then(
          (r) => { out[idx] = r; active--; pump(); },
          (e) => { if (!rejected) { rejected = true; reject(e); } },
        );
      }
    };
    pump();
  });
}
