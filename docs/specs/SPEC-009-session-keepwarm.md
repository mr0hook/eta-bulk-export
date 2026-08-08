# SPEC-009 — Overnight session keep-warm (F-09)

**Feature:** F-09 · **Requirement source:** user report 2026-08-08 — a run left going overnight is
found paused in the morning **with the portal itself logged out** (back at the login screen).

## Diagnosis

The run loop's own comment (`orchestrator.js:18-24`) states the working assumption: *"the portal
silently renews the access token for as long as a portal tab is open (overnight runs on the
original tool proved this)"*. The overnight failure shows that assumption has a hole, and the
shape of the tool explains it:

- Every request a run makes goes to **`api-portal.invoicing.eta.gov.eg`** — bearer token, no
  cookies, a *different host*.
- The session that mints those tokens lives on **`invoicing.eta.gov.eg`**.
- So during a multi-hour run the API host is hammered continuously while **the session host
  receives nothing at all**. A sliding idle timeout on that session sees an idle browser and
  expires it — precisely *because* the tool never touches the portal origin.

Once the session is gone the SPA's silent renew fails, it redirects to login, and the token in
`localStorage` is never replaced. The orchestrator then waits `TOKEN_WAIT_MAX_POLLS × 15 s` =
**15 minutes** and hard-pauses — so a session that dies at 01:00 costs the entire night.

**Honest limit:** if the identity provider enforces an *absolute* session lifetime (a hard cap
regardless of activity) nothing in an extension can prevent the logout. This spec removes the
idle-timeout cause, which is the one the tool itself creates, and makes the absolute case
survivable instead of fatal. Which of the two is in play is only knowable from an overnight run —
the new log lines are written so the user can tell the difference the next morning.

## Design

Three changes, smallest first:

**1. Keep the session host warm (cheap, best-effort).** While a run is active, every **10 minutes**
the background service worker issues a credentialed `GET` to `https://invoicing.eta.gov.eg/`. One
request per 10 minutes against thousands of API calls in the same window.

*Caveat that shapes the rest of the design:* this fetch is issued by the **extension** service
worker, so a session cookie set `SameSite=Lax/Strict` may legitimately **not** ride along with it.
The warm ping is therefore treated as a bonus, never as the mechanism.

**2. Renew on a schedule, not only when the token looks ill.** Every **30 minutes** — and
additionally whenever the token is missing or has under 10 minutes left — the worker opens the
portal in a **background tab** (`active: false`), lets it boot for 12 s, then closes it. A tab is a
**top-level navigation**, which *does* carry `Lax` cookies, so this is the one mechanism guaranteed
to both slide the session and mint a fresh token (the SPA's OIDC silent auth writes it into
`localStorage`, shared with the run tab). This is the behaviour the existing code already documents
as known-good — *"a fresh token appears in localStorage whenever any portal tab (re)loads"* — made
automatic instead of waiting on the user.

Renewals are rate limited to at most one per 5 minutes however many reasons coincide. Scheduling on
a fixed interval rather than on token TTL is deliberate and load-bearing: **the session dies of
idleness long before the token does**, so a keeper that only reacted to token TTL would sail
straight into the logout it exists to prevent (pinned by T-071).

**3. Stop giving up after 15 minutes.** `TOKEN_WAIT_MAX_POLLS` goes 60 → 1920 (15 s × 1920 = **8
hours**). The existing AUTH path also asks for a renewal instead of waiting passively. If the
session is genuinely dead, the run now sits waiting all night and resumes by itself the moment the
user logs back in the next morning, instead of being paused since 01:15. Pause/Halt still break the
wait on the next poll, and the run is still resumable if the user prefers to restart it.

**Requirement (AC-09):** an unattended run must not lose a whole night to a session lapse — it
either avoids the lapse (idle-timeout case) or resumes unattended once the user logs back in
(absolute-lifetime case), and the run log must say which happened.

**Transport.** MAIN world → `bridge.js` (ISOLATED) → `bg.js` (service worker), the existing relay.
`bg.js` pins the destination to `https://invoicing.eta.gov.eg` exactly as it pins the backend
origin, so this cannot be repurposed to fetch or open anything else. `registration.js` gains a
generic `bridgeRequest(kind, payload)` — the existing `bridgeFetch` is **not** modified (it is the
licensing path); the new helper only reuses the response listener already installed there.

**Permissions.** None added. `chrome.tabs.create` / `.remove` need no `"tabs"` permission, and the
portal origin is already in `host_permissions`. The manifest is unchanged — no new install prompt.

**NOT in this spec:** re-authenticating on the user's behalf (never — credentials are the user's);
keeping the session alive while no run is active; anything that could survive an absolute session
cap; the `keepalive.js` audio-tone timer throttling fix (already shipped, unrelated cause).

## Test cases (before implementation — `test/session.test.mjs`; all deps injected, no browser)

| ID | Level | Given / When / Then | Expected |
|---|---|---|---|
| T-060 | unit | keeper started, timer fired 3× | `warm()` called 3×; `stop()` → no further calls |
| T-061 | unit | token healthy (`left` well above threshold) on tick | `warm()` yes, `renew()` **not** called |
| T-062 | unit | token `left` under 10 min on tick | `renew()` called |
| T-063 | unit | token missing (`ok:false`) on tick | `renew()` called |
| T-064 | unit | `left === 0` with `ok:true` (valid token, unknown TTL) | `renew()` **not** called — must not be read as expiring |
| T-065 | unit | two ticks inside the 5-min gap | `renew()` called once — rate limit holds |
| T-066 | unit | `warm()` and `renew()` both reject | keeper swallows both; the run is never disturbed |
| T-067 | unit | `renewNow()` called directly (the AUTH path) | `renew()` invoked, and its own rate limit respected |
| T-068 | unit | `start()` twice | one timer, not two |
| T-069 | integration | `orchestrator.js` source | `TOKEN_WAIT_MAX_POLLS × TOKEN_WAIT_POLL_MS ≥ 8 h` |
| T-070 | integration | `src/bg.js` source | portal handler pins to `https://invoicing.eta.gov.eg`, and takes no URL from the page |
| T-071 | unit | token **healthy** the whole time, `RENEW_EVERY_MS` elapses | `renew()` fires on schedule anyway — the idle-session case — and not again until the next interval |

## Implementation plan

Files: `src/core/session.js` (new), `src/bg.js` (portal warm + renew handlers, origin-pinned),
`bridge.js` (relay the new kind), `src/core/registration.js` (export `bridgeRequest`),
`src/core/orchestrator.js` (start/stop the keeper; `renewNow()` on AUTH; raise the wait cap),
`src/core/i18n.js` (2 keys × EN/AR), `test/session.test.mjs` (new). No deps, no manifest change.

Slices:
1. `test/session.test.mjs` T-060..T-070 → run → watch fail.
2. `session.js` keeper (all deps injected). 3. `bg.js` + `bridge.js` + `bridgeRequest`.
4. `orchestrator.js` wiring + wait cap + i18n. Full suite + build → commit.

## Risks & rollback
Risk: a background tab appears in the tab strip for ~12 s every 30 min of an active run (~16 over
an 8-hour night) — accepted as the cost of the only mechanism that reliably carries `Lax` cookies;
it never takes focus and closes itself. Risk: the portal
warm fetch 302s to a login page once the session is already dead — harmless, the response is
discarded and the renewal path is what recovers. Risk: an 8-hour wait holds the tab open on a
genuinely dead session — bounded, Pause/Halt still work, and progress is written before the wait.
**Unverifiable in-repo:** whether the ETA session is idle-sliding or absolute-capped; this ships
the fix for the cause the tool creates and instruments the other. Rollback: revert the commit.

Size: well under a day.
