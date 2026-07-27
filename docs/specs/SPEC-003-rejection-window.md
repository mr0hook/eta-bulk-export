# SPEC-003 — Real rejection window from portal documenttypes (F-03)

**Feature:** F-03 · **Design:** design doc §3 + plan "New modules §2" + check-pass corrections
**Requirement:** the eligibility window used to tell the user "you can still reject this" vs
"window passed — ask the seller for a credit note" must come from ETA's per-document-type
workflowParameters when available (AC-05), degrade to the user-configured fallback when not
(AC-06), and the UI must always be able to state which source is in effect (AC-07 — badge rides
F-06; this spec exposes `source`).

**Reality constraint:** the integration-API URL is unreachable from the extension (origin guard /
permissions / CSP / OAuth2). We call the PORTAL origin `GET {API_ORIGIN}/api/v1/documenttypes`
(+ `/{id}`) through the existing `apiGet` with `attempts: 2`. The portal path/shape is
UNVERIFIED → the parser NEVER throws, failures are cached for 1 day (no per-scan hammering), and
`source:'config'` behavior is byte-identical to today's cfg.windowDays.

**NOT in this spec:** UI badge markup (F-06); PO analytics consumption (F-04/F-06); unit
verification of ETA's real parameter names (post-merge live capture task).

## Test cases (`test/window.test.mjs` + extend `test/reject.test.mjs`)

| ID | Level | Given / When / Then | Expected |
|---|---|---|---|
| T-013 | unit | list `{result:[{id,name:'Invoice'},…]}` + details with `workflowParameters:[{parameter:'ReceiverRejectionWindow', value:14, activeFrom:past}]` | `parseWorkflowWindows` → `{ byType: { Invoice: 14 } }` |
| T-014 | unit | param name contains `hour` with value 336 | converted to 14 days |
| T-015 | unit | param inactive (activeTo in past, or activeFrom in future) | ignored; nothing active → null |
| T-016 | unit | garbage: null / '' / `{}` / arrays of junk / value 0 / value 9999 | null or clamped-out → null; NEVER throws |
| T-017 | unit | `makeResolver` | byType hit → per-type days; unknown type → cfg.windowDays; loaded byType null → cfg.windowDays |
| T-018 | unit | cache: fresh ok-envelope → no apiGet call; fresh failed-envelope → source 'config', no call; stale → refetch; fetch failure → negative cached; STOPPED → rethrown | per case |
| T-019 | unit | fetch success: list then per-id calls, parse, cache `{ok:true}` | returns `{source:'api', byType}` and ls has envelope |
| T-020 | unit (reject.test) | `ctx.resolveWindow` = ()=>3 on a 5-day-old doc | `eligible === false` (cfg 14 would allow); result carries `windowDays: 3`; resolver absent → cfg fallback (existing 13 tests untouched) |

## Implementation plan

Files: `src/reject/window.js` (new), `src/reject/rules.js` (eligibility uses resolver, returns
windowDays), `test/window.test.mjs` (new), `test/reject.test.mjs` (T-020 appended).
scan.js already threads `resolveWindow` (SPEC-002 inert passthrough goes live).

window.js exports:
- `parseWorkflowWindows(listJson, detailJsons)` — pure, defensive (arrays under
  `result`/`documentTypes`/root; type name via /invoice|credit|debit/i mapping to the
  documentTypeNamePrimaryLang vocabulary; params under `workflowParameters`; name via
  `parameter||name`; /reject/i filter; active-period check; /hour/i → ÷24; clamp 1..365).
- `loadWindows({ signal, force }, deps={apiGet})` — ls envelope `etaBulk_rejWin`
  `{at, ok, byType}`; TTL_OK 7d / TTL_FAIL 1d; never throws except STOPPED.
- `makeResolver(loaded, cfg)` — pure.

Slices: (1) window.test.mjs + T-020 red → (2) window.js + rules.js green, full suite → commit.

## Risks & rollback
Highest-risk feature of the milestone by design; every risk is fenced to `source:'config'`
fallback = current behavior. Unit ambiguity (days vs hours) handled by name-hint conversion and
clamping; real values land with the live-capture follow-up (recorded in STATE.md). Rollback:
revert commit (rules.js fallback path is the v0.3 behavior).
Size: ~half a day.
