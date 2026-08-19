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
// A scheduled renewal happens even while the token looks perfectly healthy, and it is the load
// bearing part of this design. The warm fetch is issued by the extension service worker, so a
// session cookie set SameSite=Lax/Strict may legitimately NOT ride along with it — meaning the
// fetch alone cannot be trusted to slide the session. A background tab is a top-level navigation,
// which does carry Lax cookies, so this is the one mechanism guaranteed to keep the session alive.
export const RENEW_EVERY_MS = 30 * 60 * 1000;

export function createSessionKeeper({
  warm, renew, afterRenew,
  status = tokenStatus,
  onStatus = () => {},
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
  everyMs = WARM_EVERY_MS,
} = {}) {
  let timer = null, lastRenew = 0, sinceRenew = 0;

  // Rate-limited so a dead session can't turn into a tab-opening loop. Shared by the tick and by
  // the orchestrator's AUTH recovery path, which calls it directly.
  async function renewNow() {
    if (now() - lastRenew < RENEW_MIN_GAP_MS) return false;
    lastRenew = sinceRenew = now();
    try { await renew?.(); } catch { return false; }
    // SPEC-030: the renewal's SPA boot is the entity-flip vector on multi-entity logins — give the
    // owner a hook to verify/re-pin the active company IMMEDIATELY, not at the next chunk boundary.
    try { await afterRenew?.(); } catch { /* best-effort: pinning must never break a renewal */ }
    return true;
  }

  async function tick() {
    try { await warm?.(); } catch { /* offline / 302 to login — the renewal path is what recovers */ }
    let tk = null;
    try { tk = status(); } catch { tk = null; }
    if (!tk) return;
    // left === 0 with ok:true means "valid token, unknown TTL" (token.js) — NOT expiring. Reading
    // it as expiring would renew on every single tick for the whole run.
    const runningDown = !tk.ok || (tk.left > 0 && tk.left < RENEW_BELOW_MS);
    // ...and renew on schedule even when the token looks fine: the session can die of idleness
    // long before the token does, which is exactly the overnight failure this exists to stop.
    const due = now() - sinceRenew >= RENEW_EVERY_MS;
    if (runningDown || due) await renewNow();
  }

  return {
    // lastRenew starts at 0 so an immediate renewNow() (the AUTH path) is never blocked, while
    // sinceRenew starts now so the first SCHEDULED renewal is a full interval away.
    start() { if (timer) return; lastRenew = 0; sinceRenew = now(); timer = setTimer(tick, everyMs); },
    stop() { if (timer) { clearTimer(timer); timer = null; } },
    renewNow,
    tick,   // exposed for the AUTH path / tests; the timer calls the same function
  };
}
