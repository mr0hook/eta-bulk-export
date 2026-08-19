# SPEC-031 — Stop refreshing on a timer: renew only on evidence, and hold fetches while it happens

**Status:** BUILT · 2026-08-20 · ships as v0.11.0 · answers the user's question directly
**Question asked:** "the 15 min window — is this necessary to be there? I think no. And if yes and I
have multiple users, the opened user and company should be PINNED, not changing through the
refresh."

## The investigation, and the answer

Two different things were being conflated, and only one of them is ours.

**The ~15-minute window is ETA's, and it is not a problem.** The access token in
`localStorage.USER_DATA` is minted by ETA's identity server with a ~15-minute lifetime (visible in
the drawer's countdown pill). We never mint it and cannot lengthen it. Crucially we do not need to:
**the portal SPA silently renews it for as long as a portal tab is open** — documented and
field-proven in orchestrator.js:40 ("overnight runs on the original tool proved this"), which is
also why the run never pauses on time-left. The run tab IS a portal tab, so this is the normal
steady state.

**What was ours — and was NOT necessary — is the 30-minute forced renewal.** SPEC-009 booted a
background portal tab every 30 minutes *whether or not anything was wrong*. That boot re-runs OIDC
auth, and on a multi-entity login the portal re-selects the login's default entity server-side.
**That is the company flip**, and it explains the pattern the user reported exactly: it happens
while they work (a run is going, so the timer is running) and never at 4am (no run, no timer, no
tab, no flip). Nobody was switching companies — our own keep-alive was.

Why the timer existed at all: the warm request was issued by the extension SERVICE WORKER, which
is a cross-site context, so a `SameSite=Lax/Strict` session cookie legitimately may not ride along
— the warm could not be trusted to slide the session's idle timeout, leaving the tab boot as the
only mechanism believed to work.

Two facts retire it:

1. **The warm now goes out from the page.** The content script runs on `invoicing.eta.gov.eg`, so
   its request to that origin is first-party and carries the session cookie whatever its SameSite
   setting. The service-worker warm stays as a fallback if page CSP ever blocks it.
2. **A fresh token can only be minted by a live session.** So an ADVANCING token expiry is positive
   proof the session is alive — and proof there is nothing to fix. The keeper now watches absolute
   expiry across ticks: while it advances, no tab is opened, ever.

A tab is booted only in the rescue case SPEC-009 was actually written for: the portal has stopped
renewing and the token is genuinely running down (< `RENEW_BELOW_MS`, 10 minutes of headroom) or is
already gone. That path is unchanged, still rate-limited, and still waits all night for a token.

## Pinning through a refresh (the second half of the request)

When a rescue renewal does fire, the entity is now protected end to end:

- `holdRenew()` parks every document fetch for the seconds the renewal takes. Nothing is requested
  while the active company may be wrong — the mechanism that turned one flip into 974 dropped
  documents on 2026-08-19 (chunk 7).
- `afterRenew` runs after EVERY renewal attempt — including one that threw, since a half-finished
  boot can still have flipped the entity — compares the profile stamp against the run's pinned
  entity, switches back via the portal's own endpoint and re-mints, then releases the hold.
- SPEC-030's mass-403 chunk guard remains as the backstop, and SPEC-023's chunk-boundary restore as
  the enforcing layer.

## Effect

A normal run now opens **zero** background tabs: one cheap first-party warm per 10 minutes, and the
portal's own silent renewal doing what it already does. The flip vector fires only when the session
is genuinely failing, and even then no request goes out under the wrong company.

## Tests

- T-071 (rewritten) six hours of ticks with a self-renewing token → zero renewals, 36 warms.
- T-267 self-renewal is observed and reported; a token that stops advancing is rescued.
- T-268 `afterRenew` runs even when the renewal throws (the fetch hold must always release).
- T-269 source pin: the page-context warm is attempted BEFORE the service-worker fallback, and the
  portal origin is a constant — if that order is ever reversed the warm silently stops working and
  the tab boot returns by the back door.
- Retired: the old T-071, which pinned the scheduled boot this spec removes.
