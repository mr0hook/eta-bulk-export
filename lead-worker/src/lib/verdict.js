// Single source of truth for "may this device act right now?".
//
// /session REPORTS this to the extension so the drawer can explain itself. /plan/start ENFORCES it
// before minting a job. Those must never be two copies of the same rules: a drift where /session
// says no and /plan/start says yes is the whole gate failing open, and it would be invisible until
// someone noticed exports from a killed account.
//
// SPEC-017 slice 3 adds the two entitlement rules to the SAME function for exactly that reason. The
// D1 read lives here rather than in the two callers on purpose: if /plan/start had to remember to
// pass an entitlement in, forgetting would fail OPEN — an expired licence would still mint jobs and
// nothing would look wrong until the invoices arrived.
import { isVersionBlocked, isExpired } from './util.js';
import { isVoided } from './kv.js';
import { resolveEntitlement } from '../users.js';

/**
 * @param dev  the device record
 * @param rin  the RIN being acted on; omit to ask "is ANY bound RIN usable?"
 * @returns { allowed, locked, killed, expired, globalKill, reason, superadmin, features, quota }
 */
export async function computeVerdict(env, dev, { rin, version, cfg }) {
  const sa = !!dev.superadmin;                    // superadmin → works on ANY account
  const globalKill = !!cfg.globalKill;            // reversible service-wide emergency stop
  const killed = !!dev.killed || globalKill;      // emergency stop still applies to everyone
  const locked = !!dev.locked && !sa;             // superadmin bypasses its own lock

  // Entitlement comes from the PERSON's row, not the browser's. Best-effort: a D1 hiccup, or an
  // environment without the binding, must degrade to the KV record rather than lock everyone out —
  // failing closed here would be a total outage triggered by a dependency the extension never had.
  let ent = null;
  try { ent = await resolveEntitlement(env, dev.email); } catch {}
  // Features: the per-user override wins, then the plan grants them, and only if neither says
  // anything does the KV record answer. That last fallback is not cosmetic — a pre-migration install
  // (and the legacy per-device setFeatures in routes/admin.js, which writes KV only) would otherwise
  // silently LOSE a feature an admin had already granted the moment slice 3 shipped.
  const features = (ent && ent.features.length) ? ent.features : (dev.features || []);
  const quota = ent ? ent.quotaEff : (dev.quota ?? 1);
  // Expiry binds, and it is its own reason: the drawer must be able to say "your plan expired"
  // rather than "you are locked", because those ask completely different things of the user — one
  // renews, the other phones support. Superadmins are exempt for the same reason they bypass their
  // own lock: they are staff, and a stale date field should not take the tool's operators offline.
  const expired = !!(ent && isExpired(ent.validUntil)) && !sa;

  let allowed = true, reason = '';
  if (killed) { allowed = false; reason = dev.killed ? 'killed' : 'global_stop'; }   // per-device kill vs reversible global pause
  else if (locked) { allowed = false; reason = 'locked'; }
  else if (expired) { allowed = false; reason = 'expired'; }
  else if (isVersionBlocked(cfg, version)) { allowed = false; reason = 'update_required'; }   // applies to superadmins too
  else if (!sa) {                                 // superadmin skips void + allow-list entirely
    if (rin) {
      if (await isVoided(env, rin)) { allowed = false; reason = 'rin_voided'; }
      else if (!(dev.boundRins || []).includes(rin)) { allowed = false; reason = 'rin_not_allowed'; }
    } else {                                      // no specific RIN → require at least one bound, non-voided RIN
      let usable = false;
      for (const r of (dev.boundRins || [])) { if (!(await isVoided(env, r))) { usable = true; break; } }
      if (!usable) { allowed = false; reason = 'no_usable_rin'; }
    }
  }
  return { allowed, locked, killed, expired, globalKill, reason, superadmin: sa, features, quota };
}
