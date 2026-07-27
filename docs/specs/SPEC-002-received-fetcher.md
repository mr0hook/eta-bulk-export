# SPEC-002 — Shared received-details fetcher (F-02)

**Feature:** F-02 · **Design:** design doc "Architecture" + plan "New modules §1"
**Requirement:** both the Auto-Reject scan (existing) and PO analytics (F-04..F-06) need the same
"fetch Received+Valid invoices in a period, with per-document /details" pipeline. Extract it from
scan.js into `src/reject/received.js` so there is exactly one implementation (AC-04). Pure
refactor for the scan path: reject.test.mjs must pass UNMODIFIED.

**NOT in this spec:** any PO logic; any window logic; changes to what scanReceived returns.

## Test cases (file `test/received.test.mjs`; client fns injected via a `deps` parameter —
functional core / imperative shell, no network stubs needed)

| ID | Level | Given / When / Then | Expected |
|---|---|---|---|
| T-007 | unit | probe returns cap+1 | throws code TOO_MANY with `{count, cap}` attached |
| T-008 | unit | from>to, or missing from/to | throws code BAD_RANGE (before any probe call) |
| T-009 | unit | probe returns 0 | `{ results: [], count: 0 }`; fetchAllRows/fetchDetails never called |
| T-010 | unit | 3 uuids; details for the 2nd rejects with HTTP error | result[1] = `{uuid, o:null, err}`; others carry full `o`; order preserved |
| T-011 | unit | details rejects with code STOPPED | fetchReceivedDetails rethrows STOPPED (abort is never swallowed) |
| T-012 | unit | default args | probe/rows called with dir='Received', field='Submission', statusParam='Valid'; hooks onStatus('rows'|'details') + onProgress(cur,max) fire |
| — | regression | full existing suite | reject.test.mjs (13 tests) green unmodified |

## Implementation plan

Files: `src/reject/received.js` (new), `src/reject/scan.js` (consume it), `test/received.test.mjs`
(new). No deps.

`fetchReceivedDetails({ from, to, field='Submission', status='Valid', cap=SCAN_CAP, hooks={} }, deps=CLIENT)`
→ `{ results: [{ uuid, o|null, err? }], count }` — where CLIENT = real `{ probeCount,
fetchAllRows, fetchDetails }` from ../api/client.js; `SRC = SOURCES.invoices` fixed;
`SCAN_CAP = 2000`, `DETAIL_CONC = 12` exported. Behavior byte-equivalent to scan.js:24-44 today.

Slices:
1. received.test.mjs (T-007..T-012) against the not-yet-existing module → red.
2. received.js implemented; scan.js refactored to consume it (keeps loadSeen/evaluate/sort and
   its narrow doc projection). Full suite green → commit.

## Risks & rollback
Risk: subtle behavior drift in the scan path (status filtering, 404 semantics) — guarded by the
untouched reject.test.mjs plus T-012's argument assertions. Rollback: revert commit.
Size: ~2 hours.
