// SPEC-009 — keep the portal SESSION alive across an unattended overnight run.
//
// The problem this exists to solve: every request a run makes goes to
// api-portal.invoicing.eta.gov.eg with a bearer token. The session that MINTS those tokens lives
// on invoicing.eta.gov.eg — a different host that, during a multi-hour run, receives nothing at
// all. A sliding idle timeout there sees an idle browser and logs the user out, precisely because
// the tool never touches the portal origin. The user then finds the run paused and the portal back
// at the login screen.
//
// So: warm the session host on a timer, and when the token is genuinely running down, ask for a
// real renewal (a background portal tab boots the SPA, which runs OIDC silent auth and writes a
// fresh token into localStorage — shared with the run tab).
//
// Everything is injected so this is node-testable with no browser. Best-effort by contract: a
// failure here must never disturb a run that is otherwise working.
import { tokenStatus } from './token.js';

export const WARM_EVERY_MS = 10 * 60 * 1000;    // one cookie-bearing request per 10 min, against thousands of API calls
export const RENEW_BELOW_MS = 10 * 60 * 1000;   // renew while there is still time left, not after it lapses
export const RENEW_MIN_GAP_MS = 5 * 60 * 1000;  // never churn tabs faster than this, whatever the token says
// A renewed token must gain at least this much expiry to count as the portal renewing ITSELF
// (guards against clock jitter reading as a renewal).
export const SELF_RENEW_MIN_GAIN_MS = 60 * 1000;

// SPEC-031 — the scheduled 30-minute renewal is RETIRED. It opened a background portal tab on a
// timer whether or not anything was wrong, and that tab boot is the entity-flip vector on a
// multi-entity login (2026-08-19: the flip and "session running low" landed in the same log
// second). It existed because the warm fetch was issued by the extension SERVICE WORKER — a
// cross-site request that a SameSite=Lax/Strict session cookie will legitimately not ride along
// with — so the tab was the only thing believed to slide the session.
//
// Two facts replace it:
//   1. The warm now goes out from the PAGE (the run tab IS the portal origin), so it is first
//      party and carries the session cookie whatever its SameSite setting — see orchestrator.js.
//   2. A fresh access token can only be minted by a LIVE session. The portal SPA silently renews
//      the token every ~15 min for as long as a tab is open, so an ADVANCING token expiry is
//      positive proof the session is alive — and proof that there is nothing for us to fix.
// So a tab is booted only when that proof stops arriving and the token is actually running down:
// the rescue case SPEC-009 was written for, which still works exactly as before.

export function createSessionKeeper({
  warm, renew, afterRenew, onSelfRenew,
  status = tokenStatus,
  onStatus = () => {},
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
  everyMs = WARM_EVERY_MS,
} = {}) {
  let timer = null, lastRenew = 0, lastExpAt = 0;

  // Rate-limited so a dead session can't turn into a tab-opening loop. Shared by the tick and by
  // the orchestrator's AUTH recovery path, which calls it directly.
  async function renewNow() {
    if (now() - lastRenew < RENEW_MIN_GAP_MS) return false;
    lastRenew = now();
    let ok = true;
    try { await renew?.(); } catch { ok = false; }
    // SPEC-030/031: the renewal's SPA boot is the entity-flip vector on multi-entity logins, so the
    // owner gets a hook to re-pin the active company IMMEDIATELY. It runs even when the renewal
    // ITSELF threw: a boot that failed halfway can still have flipped the entity, and the hook also
    // releases the orchestrator's fetch hold — skipping it there would strand a run.
    try { await afterRenew?.(); } catch { /* best-effort: pinning must never break a renewal */ }
    return ok;
  }

  async function tick() {
    try { await warm?.(); } catch { /* offline / 302 to login — the renewal path is what recovers */ }
    let tk = null;
    try { tk = status(); } catch { tk = null; }
    if (!tk) return;
    // SPEC-031: watch the ABSOLUTE expiry, not the remaining time. If it advanced since the last
    // tick, the portal minted a new token on its own — which only a live session can do, so the
    // session is provably healthy and no tab is opened.
    const expAt = tk.ok && tk.left > 0 ? now() + tk.left : 0;
    if (expAt && lastExpAt && expAt > lastExpAt + SELF_RENEW_MIN_GAIN_MS) { try { onSelfRenew?.(); } catch {} }
    if (expAt) lastExpAt = expAt;
    // left === 0 with ok:true means "valid token, unknown TTL" (token.js) — NOT expiring. Reading
    // it as expiring would renew on every single tick for the whole run.
    const runningDown = !tk.ok || (tk.left > 0 && tk.left < RENEW_BELOW_MS);
    // The rescue case, and now the ONLY one: the portal's own silent renewal has stopped keeping up
    // and the token is genuinely running down. RENEW_BELOW_MS leaves a full window to recover in.
    if (runningDown) await renewNow();
  }

  return {
    // lastRenew starts at 0 so an immediate renewNow() (the AUTH path) is never blocked.
    start() { if (timer) return; lastRenew = 0; lastExpAt = 0; timer = setTimer(tick, everyMs); },
    stop() { if (timer) { clearTimer(timer); timer = null; } },
    renewNow,
    tick,   // exposed for the AUTH path / tests; the timer calls the same function
  };
}
