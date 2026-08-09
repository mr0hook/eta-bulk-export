// Append-only trails: admin audit (180d) and extension-facing failures (30d).
// Both are best-effort by contract — a trail write must never fail the action it records.
// Extracted verbatim from the pre-split worker.js (A0). Bodies are unchanged — only the module
// header, imports and exports below are new.
import { randHex } from './util.js';

/**
 * SPEC-017 slice 4 — who is holding the admin token right now.
 *
 * Cloudflare Access, when it fronts this Worker, stamps the authenticated person's address onto
 * every request it lets through as `Cf-Access-Authenticated-User-Email`. Reading it here means the
 * day the account owner switches Access on, the trail starts naming people with no further code
 * change and no migration of the entries already written.
 *
 * What this is NOT is verification. Turning that header into proof means validating the
 * `Cf-Access-Jwt-Assertion` JWT against the team's public keys, which needs the team domain and the
 * application AUD from the account owner's dashboard — not available to this codebase. So the
 * header is a LABEL on an action the admin bearer token has already authorised, and `via` on every
 * entry records which of the two the name came from ('access' | 'token'). Anyone reading the trail
 * can tell an asserted identity from the shared token; nobody can mistake one for the other.
 */
function actorOf(request) {
  try {
    const email = String((request && request.headers && request.headers.get('cf-access-authenticated-user-email')) || '')
      .trim().toLowerCase().slice(0, 254);
    // Shape-checked, not trusted: a malformed value is a misconfiguration, and recording it verbatim
    // would put attacker-chosen text in the actor column of every row an admin reads.
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : 'token';
  } catch { return 'token'; }
}

// Keys whose VALUE is a credential. The audit trail is read by more people than the secret store is,
// and lives 180 days; a clientKey or bearer token that reached it would outlive the incident that
// leaked it. Nothing in the current call sites puts one here — this exists so that stays true when
// somebody adds a detail field in a hurry.
const SECRET_KEY = /(client_?key|token|secret|password|passwd|authorization|signature|nonce|api_?key|bearer)/i;

function scrub(v, depth = 0) {
  if (depth > 4 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v).slice(0, 40)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : scrub(val, depth + 1);
  return out;
}

// Append-only admin audit trail. Key sorts reverse-chronologically (newest first on list) so the
// dashboard can page the most recent actions cheaply. Best-effort: an audit write must never fail an
// admin action, so every call site wraps it in try/catch. Entries auto-expire after 180 days.
// SPEC-017: entries carry an ACTOR — 'token' when the shared bearer token is all we know, the
// Access identity when there is one (see actorOf). `detail` may carry `before`/`after`, which is
// what makes an entitlement change answerable ("quota 5 → 25") rather than merely recorded.
async function audit(env, action, target, detail, actor = 'token') {
  try {
    const ts = Date.now();
    const key = 'audit:' + (1e15 - ts).toString().padStart(16, '0') + ':' + randHex(4);   // descending ts prefix
    const who = String(actor || 'token');
    await env.LEADS.put(key, JSON.stringify({
      at: new Date(ts).toISOString(), action, actor: who, via: who === 'token' ? 'token' : 'access',
      target: String(target || ''), detail: scrub(detail || {}),
    }), { expirationTtl: 180 * 86400 });
  } catch {}
}
// Extension-facing FAILURE log (sig failures, rate limits, register rejections, unhandled exceptions) —
// same reverse-ts key trick as audit(), 30-day TTL. Write-budgeted per isolate so an attacker hammering an
// unauthenticated path can't burn the KV write quota (free tier: writes are the scarce resource). Best-effort.
let _errWin = 0, _errN = 0;
async function errlog(env, request, kind, detail) {
  try {
    const w = Math.floor(Date.now() / 60000);
    if (w !== _errWin) { _errWin = w; _errN = 0; }
    if (++_errN > 6) return;                                   // ≤6 error writes/min/isolate
    const ts = Date.now();
    await env.LEADS.put('err:' + (1e15 - ts).toString().padStart(16, '0') + ':' + randHex(4),
      JSON.stringify({ at: new Date(ts).toISOString(), kind, path: new URL(request.url).pathname, deviceId: (request.headers.get('x-device-id') || '').slice(0, 12), country: (request.cf && request.cf.country) || '', detail: detail || {} }),
      { expirationTtl: 30 * 86400 });
  } catch {}
}

export { audit, errlog, actorOf };
