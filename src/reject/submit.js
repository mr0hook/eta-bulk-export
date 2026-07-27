// Auto-Reject submission + audit. The ONLY state-changing call path in the extension, so it is
// deliberately narrow: origin-pinned to the portal API, one document at a time, per-item results
// (one failure never aborts the batch), and an append-only local audit of every confirm run.
//
// LIVE ENDPOINT NOT YET CAPTURED: the portal's receiver-rejection endpoint must be recorded once
// from DevTools (Network tab) while rejecting a single received document manually on the portal UI.
// Until LIVE_REJECT_PATH is set, every confirm runs as a DRY RUN — the full pipeline executes and
// is audited, but no request leaves the browser. This is the fail-safe against guessing a
// state-changing government API. Expected shape (from the documented integration API's
// "Reject Document"): PUT {path with {uuid}} body { status: 'rejected', reason }.
import { API_ORIGIN } from '../api/sources.js';
import { getToken } from '../core/token.js';
import { lsGet, lsSet } from '../core/ls.js';

export const LIVE_REJECT_PATH = '';   // e.g. '/api/v1/documents/state/{uuid}/state' once captured; '' ⇒ dry-run only
export const liveRejectAvailable = () => !!LIVE_REJECT_PATH;

const coded = (code) => Object.assign(new Error(code), { code });
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(coded('STOPPED'));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(coded('STOPPED')); }, { once: true });
});

async function rejectOne(uuid, reason, { signal } = {}) {
  const url = `${API_ORIGIN}${LIVE_REJECT_PATH.replace('{uuid}', encodeURIComponent(uuid))}`;
  if (new URL(url).origin !== API_ORIGIN) throw coded('BAD_URL');
  for (let i = 0; i < 3; i++) {
    if (signal?.aborted) throw coded('STOPPED');
    const tok = getToken(); if (!tok) throw coded('AUTH');
    const r = await fetch(url, {
      method: 'PUT', signal,
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Language': 'ar' },
      body: JSON.stringify({ status: 'rejected', reason }),
    });
    if (r.redirected && new URL(r.url).origin !== API_ORIGIN) throw coded('BAD_URL');
    if (r.ok) return true;
    if (r.status === 401 || r.status === 403) throw coded('AUTH');
    if (r.status === 429) { const ra = parseInt(r.headers?.get?.('Retry-After') || '', 10); await sleep(Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 5000 * 2 ** i, signal); continue; }
    if (r.status >= 400 && r.status < 500) throw coded('HTTP_' + r.status);   // 4xx (window closed, already rejected…) won't improve on retry
    await sleep(2000 * (i + 1), signal);
  }
  throw coded('RETRIES');
}

// items: [{ uuid, reason, doc, rules }]. onItem(i, result) fires as each document settles.
// Returns { dryRun, results: [{ uuid, ok, error? }] } and always writes an audit record.
export async function submitRejections(items, { dryRun, onItem = () => {}, signal } = {}) {
  const live = liveRejectAvailable() && dryRun === false;   // dry-run unless live is possible AND explicitly requested
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let res;
    if (!live) res = { uuid: it.uuid, ok: true, dry: true };
    else {
      try { await rejectOne(it.uuid, it.reason, { signal }); res = { uuid: it.uuid, ok: true }; }
      catch (e) {
        if (e.code === 'STOPPED') { res = { uuid: it.uuid, ok: false, error: 'STOPPED' }; results.push(res); onItem(i, res); break; }
        res = { uuid: it.uuid, ok: false, error: e.code || e.message };
      }
      await sleep(400, signal).catch(() => {});   // gentle pacing between state-changing calls
    }
    results.push(res); onItem(i, res);
  }
  writeAudit({ ts: new Date().toISOString(), dryRun: !live, count: items.length,
    items: items.map((it, i) => ({ uuid: it.uuid, internalID: it.doc?.internalID, issuerId: it.doc?.issuerId, total: it.doc?.totalAmount, rules: it.rules, reason: it.reason, result: results[i] ? (results[i].ok ? (results[i].dry ? 'dry' : 'ok') : results[i].error) : 'skipped' })) });
  return { dryRun: !live, results };
}

// ── audit (append-only, local, capped) ─────────────────────────────────────
const AUDIT_KEY = 'arAudit', AUDIT_MAX = 20;
function writeAudit(run) { const a = lsGet(AUDIT_KEY) || []; a.push(run); lsSet(AUDIT_KEY, a.slice(-AUDIT_MAX)); }
export const auditRuns = () => lsGet(AUDIT_KEY) || [];
export const auditText = () => JSON.stringify(auditRuns(), null, 1);
