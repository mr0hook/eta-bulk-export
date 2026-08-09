// SPEC-021 — the export column mapping endpoint.
//
//   POST /export/mapping   signed → { ok, source, revision, hash, mapping }
//                                 → { ok, source, revision, hash, unchanged:true }  when `have` matches
//
// Signed and entitlement-checked exactly like /plan/start, and for the same reason: this is a piece
// of the product, not a public asset. An unauthorised fork gets 401/403 and has to fall back to
// whatever mapping it can reconstruct itself.
//
// Be honest about the limit of that (it is written down in SPEC-021 too): a fork that ships the
// extension's own bundled mapping still exports correctly today, because the bundled mapping must
// stay complete for offline users. What this endpoint buys is CURRENCY, not secrecy — the day the
// headers change, only authorised installations follow, and every fork silently drifts out of date.
// The planner (/plan/start) remains the thing a fork genuinely cannot do without.
//
// Nothing about invoice ROWS passes through here in either direction. The request is a source name
// and a hash; the reply is column metadata.
import { json, cleanRin } from '../lib/util.js';
import { getDev, getCfg, deviceRate } from '../lib/kv.js';
import { verifySigned } from '../lib/auth.js';
import { computeVerdict } from '../lib/verdict.js';
import { errlog } from '../lib/audit.js';
import { MAPPING_REVISION, mappingFor, mappingHash } from '../mapping.js';

export async function exportRoutes(request, env, url, path) {
  if (path !== '/export/mapping') return null;
  if (request.method !== 'POST') return json({ ok: false, error: 'not found' }, 404);

  const body = await request.text();
  const dev = await verifySigned(env, request, body);
  if (!dev) {
    const known = await getDev(env, request.headers.get('x-device-id') || '');
    await errlog(env, request, 'sig_fail', { tag: 'mapping', known: !!known });
    return json({ ok: false, error: known ? 'unauthorized' : 'not registered' }, 401);
  }
  let b = {}; try { b = JSON.parse(body || '{}'); } catch {}

  // One mapping per export run is all a client needs; this ceiling only bites a loop.
  if (!(await deviceRate(env, 'map', dev.deviceId, 240, 3600000))) {
    await errlog(env, request, 'rate_limit', { tag: 'mapping' });
    return json({ ok: false, error: 'Too many mapping requests from this device — please try again later.' }, 429);
  }

  const cfg = await getCfg(env);
  const v = await computeVerdict(env, dev, { rin: cleanRin(b.rin), version: String(b.version || '').slice(0, 24), cfg });
  if (!v.allowed) return json({ ok: false, error: 'not allowed', reason: v.reason }, 403);

  const source = String(b.source || '');
  const m = mappingFor(source);
  if (!m) return json({ ok: false, error: 'unknown source' }, 400);

  const hash = await mappingHash(m);
  // Conditional fetch, in the body rather than via ETag headers: the extension reaches this route
  // through the background-worker bridge, so keeping the protocol inside the signed JSON keeps it
  // identical to every other extension call.
  if (String(b.have || '') === hash) return json({ ok: true, source, revision: MAPPING_REVISION, hash, unchanged: true });

  return json({ ok: true, source, revision: MAPPING_REVISION, hash, mapping: m });
}
