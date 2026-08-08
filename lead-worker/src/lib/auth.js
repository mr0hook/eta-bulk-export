// Authentication — extension HMAC signatures, admin bearer token, email validation.
// makeAdminCheck returns the same zero-arg closure the pre-split router built inline, so every
// call site reads identically to before the split.
// Extracted verbatim from the pre-split worker.js (A0). Bodies are unchanged — only the module
// header, imports and exports below are new.
import { ctEq, hmacHex, sha256hex, nowSec } from './util.js';
import { getDev } from './kv.js';

// Free, no-key email validation (Disify): rejects disposable addresses + domains with no mail server.
// Fail-open on any error/timeout so a validator outage never blocks a genuine registration.
async function verifyEmail(email) {
  try {
    const r = await fetch('https://disify.com/api/email/' + encodeURIComponent(email), { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    if (j && j.disposable) return { reject: true, verified: false, reason: 'Please use a permanent (non-disposable) email address.' };
    if (j && j.dns === false) return { reject: true, verified: false, reason: 'That email domain has no mail server — please check the address.' };
    return { reject: false, verified: true };
  } catch { return { reject: false, verified: false }; }
}

// Verify an HMAC-signed extension request; returns the device record or null.
async function verifySigned(env, request, bodyText) {
  // Cap every attacker-controlled header (mirrors /register's deviceId cap) so an oversized header can't push
  // an over-limit ('nonce:'+deviceId+':'+nonce) KV key past the 512-byte limit.
  const deviceId = (request.headers.get('x-device-id') || '').slice(0, 80);
  const ts = (request.headers.get('x-ts') || '').slice(0, 20);
  const nonce = (request.headers.get('x-nonce') || '').slice(0, 80);
  const sig = (request.headers.get('x-signature') || '').slice(0, 128);
  if (!deviceId || !ts || !nonce || !sig) return null;
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(nowSec() - tsNum) > 300) return null;  // 5-min skew; Number.isFinite also closes the NaN-ts bypass
  const dev = await getDev(env, deviceId);
  if (!dev || !dev.clientKey) return null;
  const path = new URL(request.url).pathname;
  const expect = await hmacHex(dev.clientKey, `${ts}\n${nonce}\nPOST\n${path}\n${await sha256hex(bodyText || '')}`);
  if (!ctEq(expect, sig)) return null;   // constant-time compare (both are equal-length lowercase hex), same as the admin token
  // Single-use nonce (checked only AFTER the signature verifies, so it can't be used to spam KV writes). KV is
  // eventually consistent so a near-simultaneous double-send can still race, but this closes the 5-min replay window.
  const nKey = 'nonce:' + deviceId + ':' + String(nonce).slice(0, 64);
  if (await env.LEADS.get(nKey)) return null;
  await env.LEADS.put(nKey, '1', { expirationTtl: 360 });
  return dev;
}

// Admin auth: Bearer header ONLY. The token is never read from the query string, so it can't leak into
// Cloudflare request logs, browser history, bookmarks, or the Referer header. The dashboard sends it as
// a header for every call (including the CSV export, which downloads via fetch+blob).
const makeAdminCheck = (request, env) => () => {
  if (!env.ADMIN_TOKEN) return false;
  const h = request.headers.get('authorization') || '';
  const bearer = h.slice(0, 7).toLowerCase() === 'bearer ' ? h.slice(7).trim() : '';
  return ctEq(bearer, env.ADMIN_TOKEN);
};

export { verifyEmail, verifySigned, makeAdminCheck };
