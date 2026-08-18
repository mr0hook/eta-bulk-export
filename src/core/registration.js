// Registration + server-authoritative gate (MAIN world). Registers with the managed backend, stores a
// per-device HMAC key, then does SIGNED check-ins so the server can enforce lock / kill / features / allowed
// RINs. Verified live: RIN comes from USER_DATA.profile.TaxRin. State lives in IndexedDB (per browser profile).
// Registration state (device id, creds, cached verdict) lives in localStorage: it's synchronous and has no
// IndexedDB transaction/quota/version failure modes, and these blobs are tiny. (fs.js keeps IndexedDB for the
// large File System Access handles.)
import { lsGet, lsSet, lsDel } from './ls.js';
import { t } from './i18n.js';

// ← after deploying lead-worker/, set this to its URL (no trailing slash).
// The literal below is PRODUCTION and stays the single source of truth. `npm run build:staging`
// overrides it via the esbuild define, so testing against staging is a command rather than an edit
// you have to remember to undo — and build.mjs keeps bg.js's pinned origin and the manifest's
// host_permissions in step with whichever target you built.
export const LEAD_URL = (typeof __LEAD_URL__ !== 'undefined')
  ? __LEAD_URL__
  : 'https://eta-bulk-leads.omsoliman95.workers.dev';
export const gateEnabled = () => !/REPLACE-ME/.test(LEAD_URL);   // until wired, the gate stays OFF

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const enc = new TextEncoder();
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now() + Math.random().toString(36).slice(2));
const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256hex(s) { return hexOf(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function hmacHex(keyHex, msg) {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(keyHex.match(/.{2}/g).map((h) => parseInt(h, 16))), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hexOf(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

// Extension version, baked at build time by esbuild `define`. Falls back for tests / non-bundled runs.
export const EXT_VERSION = (typeof __EXT_VERSION__ !== 'undefined') ? __EXT_VERSION__ : '0.0.0';

// MAIN-world fetch() to the backend is blocked by the ETA portal CSP, so we relay through the ISOLATED
// bridge (bridge.js) → background SW (bg.js). Returns { ok, status, json, error }: ok = HTTP ok, status 0
// means the request never reached the server (blocked / offline / no bridge).
const _bridgePending = new Map();
let _bridgeSeq = 0;
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__eta !== 'res' || !d.id) return;
    const done = _bridgePending.get(d.id);
    if (done) { _bridgePending.delete(d.id); done(d.result || { ok: false, status: 0, error: 'no result' }); }
  });
}
function bridgeFetch(url, opts) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.postMessage) { resolve({ ok: false, status: 0, error: 'no bridge' }); return; }
    const id = 'f' + (++_bridgeSeq) + '_' + Date.now();
    const timer = setTimeout(() => { if (_bridgePending.has(id)) { _bridgePending.delete(id); resolve({ ok: false, status: 0, error: 'timeout' }); } }, 15000);
    _bridgePending.set(id, (result) => { clearTimeout(timer); if (!result || result.status === 0) { try { const er = (result && result.error) || 'no response'; if (/context invalidated/i.test(er)) console.info('[ETA Bulk] the extension was reloaded — reload this ETA page to reconnect (your session is unaffected).'); else console.warn('[ETA Bulk] backend call failed:', url, '→', er); } catch {} } resolve(result); });
    window.postMessage({ __eta: 'req', kind: 'lead-fetch', id, url, method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || {}, body: (opts && opts.body) || null }, window.location.origin);
  });
}

// SPEC-009: a bare kind-only bridge call (no url, no body) for the session keep-warm messages.
// Deliberately built on the SAME pending map and response listener as bridgeFetch above, but
// bridgeFetch itself is left untouched — it is the licensing path and not worth re-plumbing for
// this. Never rejects: the keeper is best-effort by contract.
export function bridgeRequest(kind, timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.postMessage) { resolve({ ok: false, status: 0, error: 'no bridge' }); return; }
    const id = 'k' + (++_bridgeSeq) + '_' + Date.now();
    const timer = setTimeout(() => { if (_bridgePending.has(id)) { _bridgePending.delete(id); resolve({ ok: false, status: 0, error: 'timeout' }); } }, timeoutMs);
    _bridgePending.set(id, (result) => { clearTimeout(timer); resolve(result || { ok: false, status: 0, error: 'no result' }); });
    window.postMessage({ __eta: 'req', kind, id }, window.location.origin);
  });
}

export async function deviceId() {
  let id = lsGet('reg_device_id');
  if (!id) { id = uuid(); lsSet('reg_device_id', id); }
  return id;
}
export function taxpayerId() {
  try {
    const ud = JSON.parse(localStorage.getItem('USER_DATA') || '{}');
    const rin = ud.profile?.TaxRin || ud.profile?.taxRin || localStorage.getItem('RIN') || ud.rin || ud.registrationNumber;
    if (rin) return String(rin).trim();
    const t = ud.access_token;
    if (typeof t === 'string' && t.split('.').length === 3) { const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return String(p.rin || p.TaxRin || p.sub || 'unknown').trim(); }
  } catch {}
  return 'unknown';
}
export function taxpayerName() {
  try { return String(localStorage.getItem('TaxpayerNameAR') || localStorage.getItem('TaxpayerNameEN') || JSON.parse(localStorage.getItem('USER_DATA') || '{}').profile?.name || '').trim(); } catch { return ''; }
}
export function portalProfile() {
  try { const p = JSON.parse(localStorage.getItem('USER_DATA') || '{}').profile || {}; return { rin: taxpayerId(), email: String(p.Email || '').trim(), phone: String(p.PhoneNumber || '').trim(), company: taxpayerName() }; }
  catch { return { rin: taxpayerId(), email: '', phone: '', company: '' }; }
}

const creds = () => lsGet('reg_creds') || null;   // { clientKey, boundRins[], features[] }

// signed extension→server request (HMAC over ts\nnonce\nPOST\npath\nsha256(body))
async function signedPost(path, bodyObj) {
  const c = await creds(); const dev = await deviceId();
  if (!c || !c.clientKey) return { ok: false, error: 'not registered' };
  const body = (bodyObj && Object.keys(bodyObj).length) ? JSON.stringify(bodyObj) : '';
  const ts = String(Math.floor(Date.now() / 1000)), nonce = uuid().replace(/-/g, '');
  const sig = await hmacHex(c.clientKey, `${ts}\n${nonce}\nPOST\n${path}\n${await sha256hex(body)}`);
  const res = await bridgeFetch(LEAD_URL + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': dev, 'x-ts': ts, 'x-nonce': nonce, 'x-signature': sig }, body });
  const j = res.json || {};
  if (res.ok && j.ok) return j;
  return { ok: false, error: j.error || (res.status ? ('http ' + res.status) : 'network'), network: res.status === 0 };
}

// Register: POST contact + verified RIN; store the device key + entitlements returned by the server.
export async function register(form) {
  const rin = taxpayerId(), dev = await deviceId();
  const name = String(form.name || '').trim(), email = String(form.email || '').trim();
  if (!name || !email || !form.consent) return { ok: false, error: t('reg.required') };
  if (!EMAIL_RE.test(email)) return { ok: false, error: t('reg.badEmail') };
  if (rin === 'unknown') return { ok: false, error: t('reg.noRin') };
  const body = { regId: uuid(), name, email, phone: String(form.phone || '').trim(), company: String(form.company || '').trim(), registrationNumber: rin, taxpayerName: taxpayerName(), deviceId: dev, version: EXT_VERSION, consent: true };
  const res = await bridgeFetch(LEAD_URL + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = res.json || {};
  if (!res.ok || !j.ok) {
    if (res.status === 0) return { ok: false, error: t('reg.unreachable', { err: res.error || 'no response' }) };
    return { ok: false, error: j.error || t('reg.serverError', { status: res.status }) };
  }
  const saved = lsSet('reg_creds', { clientKey: j.clientKey, boundRins: j.boundRins || [rin], features: j.features || [], at: new Date().toISOString() });
  lsSet('reg_verdict', { registered: true, allowed: !!j.allowed, locked: false, killed: false, reason: '', boundRins: j.boundRins || [rin], features: j.features || [], rin, at: Date.now() });   // seed grace verdict
  if (!saved) return { ok: false, error: t('reg.storageBlocked') };
  return { ok: true };
}

// Pure grace-verdict rule (exported for tests): on a network blip, reuse the server's LAST verdict as-is.
// Never upgrade a deny to allow (so version/void/kill/lock denials stay enforced offline), and only honour
// it for the SAME logged-in RIN. Returns null when there is no cached verdict (caller then fails closed).
export function graceVerdict(cached, rin) {
  if (!cached) return null;
  return { ...cached, allowed: !!cached.allowed && cached.rin === rin, rin, stale: true };
}

// Server check-in: the authoritative verdict for the CURRENT logged-in RIN. Caches; on a network blip it
// falls back to the last verdict (grace) so a transient outage doesn't brick a legitimate session.
export async function session() {
  const rin = taxpayerId();
  const c = await creds();
  if (!c || !c.clientKey) return { registered: false, allowed: false, rin };
  let stats; try { stats = lsGet('stats') || undefined; } catch {}   // usage counters (counts only — disclosed in the privacy policy)
  const j = await signedPost('/session', { rin, version: EXT_VERSION, stats });
  if (j.ok) {
    const v = { registered: true, allowed: !!j.allowed, locked: !!j.locked, killed: !!j.killed, reason: j.reason || '', boundRins: j.boundRins || [], features: j.features || [], rin, at: Date.now() };
    lsSet('reg_verdict', v);
    return { ...v, announcement: j.announcement || null, message: j.message || null };   // banners are transient — surfaced live, not cached in the grace verdict
  }
  // Server says this device is unknown (e.g. the admin DELETED the account) → wipe local creds so the gate
  // reappears and stale grace can't keep it alive. (A transient sig/skew failure returns 'unauthorized', not this.)
  if (j.error === 'not registered') { lsDel('reg_creds'); lsDel('reg_verdict'); return { registered: false, allowed: false, rin }; }
  // Grace: reuse the server's LAST AUTHORITATIVE verdict verbatim. Never recompute `allowed` from a subset
  // of dimensions — that would fail OPEN for version/void denials (cached.allowed already folds in
  // kill/lock/version/void). Only valid for the same logged-in RIN.
  const cached = lsGet('reg_verdict') || null;
  const g = graceVerdict(cached, rin);
  if (g) return g;
  return { registered: true, allowed: false, boundRins: c.boundRins || [], features: c.features || [], rin, stale: true };   // no server verdict ever obtained → fail closed
}

// ── SPEC-016: the planner conversation ────────────────────────────────────────────────────────────
// All signed, all through the same bridge as /session. The extension no longer decides how to slice
// a date range: it probes the portal and reports counts, the server decides where to cut.
export function planStart(body) { return signedPost('/plan/start', body); }
export function planStep(body) { return signedPost('/plan/step', body); }
// SPEC-022: the gate for a list-driven export. Carries a COUNT — the UUIDs never leave the device.
export function planUuids(body) { return signedPost('/plan/uuids', body); }
export function jobCheckpoint(body) { return signedPost('/job/checkpoint', body); }
// SPEC-018 Part B — a batch of run-log lines for a job. Status lines only (counts and progress,
// never document content), batched and coalesced by logship.js before they get here. Best-effort:
// the caller drops the batch on anything other than ok, and signedPost already resolves rather than
// rejecting on a network failure.
export function jobLog(body) { return signedPost('/job/log', body); }
// SPEC-021 — the export column mapping (sheet names + [key, header, width] tuples). Signed like
// every other extension call, so an unauthorised fork gets nothing from it. Carries no invoice
// data in either direction: the request is a source name and the hash the client already holds.
export function exportMapping(body) { return signedPost('/export/mapping', body); }
export function jobResumable() { return signedPost('/job/resumable', {}); }
export function jobPlan(jobId) { return signedPost('/job/plan', { jobId: String(jobId || '') }); }

// rin: explicit RIN to request (e.g. a second company typed by the user); falls back to the logged-in one.
export function requestRin(rin, note) { return signedPost('/rin-request', { requestedRin: String(rin || '').trim() || taxpayerId(), note: String(note || '') }); }
// diag: optional diagnostics object assembled by the drawer (recent log lines + run summary — counts only,
// never invoice content). Stamped with the extension version; old callers without diag send the old shape.
export function reportBug(message, diag) { return signedPost('/bug', { message: String(message || ''), ...(diag ? { diag: { ...diag, version: EXT_VERSION } } : {}) }); }
