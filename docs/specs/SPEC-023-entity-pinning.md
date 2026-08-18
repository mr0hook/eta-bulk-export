# SPEC-023 — Entity pinning: a run heals an entity switch instead of pausing on it

> Feature F-24 · Phase: BUILD · Depends on: v0.6.3 profile-stamp guard (T-239)
> Born from the 2026-08-19 night: one login holds several entities (each with its own RIN); ANY
> cold portal load — including our own SPEC-009 session renewal every ~30 min — re-authenticates
> and can flip the active entity for every tab. v0.6.3 detects the flip and pauses; on a
> multi-entity account that turns every renewal into a manual intervention.

## Discovery (from the portal's own public bundle, main.792db98e.chunk.js — no session touched)

The portal's company switcher calls `UserProfileAdminClient.switchTaxpayer`:

```
PUT {PublicGatewayApiBaseURL}/Api/v1/users/current/switchtaxpayer
Content-Type: application/json-patch+json          body: { "taxpayerId": <numeric TaxId> }
→ { isSuccess: true } on success; the SPA then re-runs silent auth so the NEXT token carries the
  switched-to entity. Gateway = api-portal.invoicing.eta.gov.eg (config.js), same origin as every
  call we already make; taxpayerId matches profile.TaxId / taxpayerRepresentations[].taxpayerID.
```

## Behaviour

At run start the orchestrator snapshots `{ stamp: TaxRin:ProfId, taxId }` from USER_DATA. At every
chunk boundary (the existing T-239 check), a stamp mismatch now triggers RESTORE before pause:

1. say `orch.profileRestoring`; `PUT switchtaxpayer { taxpayerId: <snapshot.taxId> }`
2. `session.renewNow()` — the renewal that caused the flip is also what mints the corrected token
3. poll `profileStamp()` up to ~60s for the snapshot stamp
4. restored → `orch.profileRestored`, the chunk proceeds; not restored → the v0.6.3 pause, verbatim
5. at most 3 restores per run — a ping-pong with a human actively working the other entity in
   another tab must end in a pause, not a fight

Failure of the switch call is NEVER an error state of its own: every failure path lands on the
existing pause message, so the worst case equals v0.6.4 behaviour exactly.

## Tests

| ID | Level | Case | Expected |
|---|---|---|---|
| T-241 | unit | `switchTaxpayer()` request shape | PUT to the exact path on API_ORIGIN, json-patch content type, numeric taxpayerId body, origin-guarded, AUTH on 401 |
| T-242 | unit | stamp flips mid-run, switch+renew restore it | run continues, both chunks complete, `orch.profileRestored` logged, no pause |
| T-243 | unit | stamp flips, restore never converges | run pauses with the T-239 message after the poll window; chunk not marked done |
| T-244 | unit | 4th flip in one run | pause without attempting a 4th restore |

## Files

`src/api/client.js` (+`switchTaxpayer`) · `src/core/token.js` (+`profileInfo`) ·
`src/core/orchestrator.js` (restore sequence at the boundary check) · `src/core/i18n.js` (en+ar) ·
`test/pinning.test.mjs`. No worker changes; no schema changes. Rollback: revert the commit —
the v0.6.3 pause guard underneath is untouched.
