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
export function bridgeRequest(kind, timeoutMs = 20000, payload = null) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.postMessage) { resolve({ ok: false, status: 0, error: 'no bridge' }); return; }
    const id = 'k' + (++_bridgeSeq) + '_' + Date.now();
    const timer = setTimeout(() => { if (_bridgePending.has(id)) { _bridgePending.delete(id); resolve({ ok: false, status: 0, error: 'timeout' }); } }, timeoutMs);
    _bridgePending.set(id, (result) => { clearTimeout(timer); resolve(result || { ok: false, status: 0, error: 'no result' }); });
    window.postMessage({ __eta: 'req', kind, id, payload }, window.location.origin);
  });
}

// SPEC-033 — the extension's identity must survive the PORTAL clearing its own localStorage.
//
// 2026-08-20 incident: the portal re-authenticated mid-run and wiped page localStorage. The device
// id and creds went with it (they lived in the portal's storage — storage the portal owns and may
// clear at any re-login). The extension then generated a NEW device id, the server correctly said
// "not registered", the gate reappeared, and the automatic re-register was refused with
// "device limit reached" — because the account's allowance was already held by the OLD id, which
// no longer existed anywhere on the device. A finished 7-hour run was locked out of its own tool.
//
// So identity is mirrored into chrome.storage.local through the bridge (extension-owned storage the
// page cannot touch), and localStorage becomes a fast cache that is restored from the mirror.
// Best-effort by contract: a missing bridge degrades to exactly the old behaviour.
const idStore = {
  async get() {
    const r = await bridgeRequest('id-store', 8000, { op: 'get' });
    return r && r.ok ? r : null;
  },
  async set(patch) {
    try { await bridgeRequest('id-store', 8000, { op: 'set', ...patch }); } catch {}
  },
};

export async function deviceId() {
  let id = lsGet('reg_device_id');
  if (id) return id;
  // localStorage lost it — the mirror is the authority, and reusing the SAME id is what stops a
  // wipe from burning another device slot ("a returning deviceId is never refused" — T-182).
  const m = await idStore.get();
  if (m && m.deviceId) { lsSet('reg_device_id', m.deviceId); return m.deviceId; }
  id = uuid();
  lsSet('reg_device_id', id);
  await idStore.set({ deviceId: id });
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

// { clientKey, boundRins[], features[] } — localStorage first, then the SPEC-033 extension mirror.
const creds = async () => {
  const local = lsGet('reg_creds');
  if (local && local.clientKey) return local;
  const m = await idStore.get();
  if (m && m.creds && m.creds.clientKey) { lsSet('reg_creds', m.creds); return m.creds; }
  return null;
};

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
  const fresh = { clientKey: j.clientKey, boundRins: j.boundRins || [rin], features: j.features || [], at: new Date().toISOString() };
  const saved = lsSet('reg_creds', fresh);
  await idStore.set({ creds: fresh });   // SPEC-033: the copy the portal cannot wipe
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
  // SPEC-033: drop the CREDS from both stores, but never the device id — re-registering under the
  // same id is always accepted, while a fresh id would spend another slot off the allowance and can
  // strand the user behind "device limit reached" (2026-08-20).
  if (j.error === 'not registered') { lsDel('reg_creds'); lsDel('reg_verdict'); await idStore.set({ creds: null }); return { registered: false, allowed: false, rin }; }
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
