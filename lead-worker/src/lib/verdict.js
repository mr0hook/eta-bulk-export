// Single source of truth for "may this device act right now?".
//
// /session REPORTS this to the extension so the drawer can explain itself. /plan/start ENFORCES it
// before minting a job. Those must never be two copies of the same rules: a drift where /session
// says no and /plan/start says yes is the whole gate failing open, and it would be invisible until
// someone noticed exports from a killed account.
import { isVersionBlocked } from './util.js';
import { isVoided } from './kv.js';

/**
 * @param dev  the device record
 * @param rin  the RIN being acted on; omit to ask "is ANY bound RIN usable?"
 * @returns { allowed, locked, killed, globalKill, reason, superadmin }
 */
export async function computeVerdict(env, dev, { rin, version, cfg }) {
  const sa = !!dev.superadmin;                    // superadmin → works on ANY account
  const globalKill = !!cfg.globalKill;            // reversible service-wide emergency stop
  const killed = !!dev.killed || globalKill;      // emergency stop still applies to everyone
  const locked = !!dev.locked && !sa;             // superadmin bypasses its own lock

  let allowed = true, reason = '';
  if (killed) { allowed = false; reason = dev.killed ? 'killed' : 'global_stop'; }   // per-device kill vs reversible global pause
  else if (locked) { allowed = false; reason = 'locked'; }
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
  return { allowed, locked, killed, globalKill, reason, superadmin: sa };
}
