# SPEC-030 — Renewal-coupled entity pinning + the mass-403 chunk guard

**Status:** BUILT · 2026-08-20 · ships in v0.10.0
**Driver:** user report ("the company change issue — no one is switching, it happens every time I
work, never at 4am"). The research answer is in one log pair from 2026-08-19 23:24:29 — the flip
and "Portal session running low — refreshing it in the background…" landed in the SAME second.

## Root cause (the research, recorded)

The ETA access token is short-lived and is minted by the SESSION host (invoicing.eta.gov.eg), not
the API host the run talks to. SPEC-009 therefore renews on a schedule (~30 min) by opening a
background portal tab: the SPA boots, runs OIDC silent auth, writes a fresh token. **That boot is
a cold portal load, and on a multi-entity login it can re-select the login's DEFAULT entity
server-side** (entity selection is per-login, server-side — user-validated on 2026-08-19: a switch
in Edge flipped Chrome). So the extension's own keep-alive is the flip vector — which is exactly
why flips track working hours and never happen when nobody runs anything. The renewal itself is
NOT optional: without it the token dies mid-run and the run stalls until a manual login (the
pre-SPEC-009 overnight failure). The fix is to make renewal safe, not to remove it.

## Changes

1. **afterRenew hook** (session.js → orchestrator): immediately after EVERY renewal — scheduled,
   token-low, or AUTH-recovery — the orchestrator compares the profile stamp against the run's
   pinned entity. On a mismatch it switches back via the portal's own endpoint and triggers one
   direct re-mint (gap-exempt: this is the corrective boot), so the flip window shrinks from
   "until the next chunk boundary" to seconds. Best-effort by contract; the chunk-boundary
   restore (SPEC-023) remains the enforcing layer.
2. **Mass-403 chunk guard** (orchestrator): ≥25 FORBIDDEN documents amounting to ≥half of the
   chunk's processed docs ⇒ the chunk FAILS with a company-flip diagnosis instead of completing
   thin — the 2026-08-19 chunk-7 incident (974/1086 dropped into eta_failures.jsonl, chunk marked
   done) cannot recur. The boundary restore heals the entity and Resume refetches the chunk whole.
   Genuine per-document 403s (intermediary/marketplace submissions) arrive in ones and fives and
   stay far under the threshold.

## Tests

- T-266 (batchrun.test.mjs) 50 of 60 documents answering 403 → no chunk file, chunk in failedIds,
  the mass-403 diagnosis in the log.
- afterRenew is exercised through session.test's keeper contract (renewNow still resolves when the
  hook throws) and lives behind the SPEC-023 pinning suite's switchTaxpayer contract (T-241).
