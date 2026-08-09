// Append-only trails: admin audit (180d) and extension-facing failures (30d).
// Both are best-effort by contract — a trail write must never fail the action it records.
// Extracted verbatim from the pre-split worker.js (A0). Bodies are unchanged — only the module
// header, imports and exports below are new.
import { randHex } from './util.js';

// Append-only admin audit trail. Key sorts reverse-chronologically (newest first on list) so the
// dashboard can page the most recent actions cheaply. Best-effort: an audit write must never fail an
// admin action, so every call site wraps it in try/catch. Entries auto-expire after 180 days.
// SPEC-017: entries carry an ACTOR. Every admin path is bearer-token authenticated and nothing else,
// so 'token' is the honest default for all of them — recorded rather than left blank, and ready for
// slice 4 to pass a real admin identity in its place.
async function audit(env, action, target, detail, actor = 'token') {
  try {
    const ts = Date.now();
    const key = 'audit:' + (1e15 - ts).toString().padStart(16, '0') + ':' + randHex(4);   // descending ts prefix
    await env.LEADS.put(key, JSON.stringify({ at: new Date(ts).toISOString(), action, actor: String(actor || 'token'), target: String(target || ''), detail: detail || {} }), { expirationTtl: 180 * 86400 });
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

export { audit, errlog };
