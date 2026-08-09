// Pure helpers — no env, no I/O.
// CORS/JSON shaping, hashing, hex, constant-time compare, version arithmetic.
// Extracted verbatim from the pre-split worker.js (A0). Bodies are unchanged — only the module
// header, imports and exports below are new.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization, x-device-id, x-ts, x-nonce, x-signature' };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const enc = new TextEncoder();
const nowSec = () => Math.floor(Date.now() / 1000);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function hmacHex(keyHex, msg) {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(keyHex.match(/.{2}/g).map((h) => parseInt(h, 16))), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
const randHex = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return hex(b); };
const cleanRin = (v) => String(v || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64);   // strip control chars, cap length

// Constant-time string compare for the admin bearer token (defense-in-depth vs. timing side-channel).
const ctEq = (a, b) => { const ba = enc.encode(String(a)), bb = enc.encode(String(b)); if (ba.length !== bb.length) return false; let d = 0; for (let i = 0; i < ba.length; i++) d |= ba[i] ^ bb[i]; return d === 0; };

// Version kill switch: numeric dotted compare, and a "is this client version blocked?" test.
const cmpVersion = (a, b) => {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0, len = Math.max(pa.length, pb.length); i < len; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
};
const isVersionBlocked = (cfg, v) => {
  const kv = Array.isArray(cfg.killedVersions) ? cfg.killedVersions : [];
  if (kv.length) {                                             // an active kill-list is fail-closed:
    if (!v) return true;                                       //   a client that omits its version is blocked,
    if (kv.some((k) => cmpVersion(v, k) === 0)) return true;   //   and matching is numeric (0.1.0 == 0.1.00 == '0.1.0 ') — not a byte-exact includes()
  }
  if (cfg.minVersion) { if (!v) return true; if (cmpVersion(v, cfg.minVersion) < 0) return true; }
  return false;
};

// SPEC-017 slice 3 — has this licence run out?
//   · a bare date is stretched to the END of that day: "valid until 2026-08-09" means through the
//     9th, not until midnight UTC at the start of it, which in Cairo is 2am on the 9th — a user
//     would lose the tool the night before the date printed on their invoice;
//   · blank means no expiry, not "expired at the epoch";
//   · an unparseable value is treated as NOT expired. A typo in an admin field must not lock a
//     paying user out of an export; the portal is where a wrong date is visible and fixable.
const isExpired = (validUntil, now = Date.now()) => {
  const v = String(validUntil || '').trim();
  if (!v) return false;
  const t = Date.parse(v.length <= 10 ? v + 'T23:59:59.999Z' : v);
  return Number.isFinite(t) && t < now;
};

export { CORS, json, EMAIL_RE, enc, nowSec, hex, sha256hex, hmacHex, randHex, cleanRin, ctEq, cmpVersion, isVersionBlocked, isExpired };
