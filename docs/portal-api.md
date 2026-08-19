# ETA portal — observed API behaviour

Living reference. Everything under **Measured** was captured live from the user's own session
(request/response SHAPES and timings only — no document values were recorded). Everything under
**Inferred** is reasoning from those observations and is labelled as such. Last capture:
2026-08-20 ~02:47 Cairo, during a live Purchases run (8 chunks / 54,722 documents).

## Hosts

| Host | Role |
|---|---|
| `invoicing.eta.gov.eg` | SPA + **session/SSO**. Mints the access token. Our content script runs here. |
| `api-portal.invoicing.eta.gov.eg` | The data API. Every run request goes here. |

The split is the reason SPEC-009/031 exist at all: a run can hammer the API host for hours while the
session host sees nothing.

## Measured — endpoints

### `GET /api/v1/documents/search`
- Params observed in use: `Direction`, `IssueDateFrom`, `IssueDateTo`, `Page`, `PageSize`
  (`Status` absent when all statuses are selected).
- Response envelope:
  ```
  { result: [ { publicUrl, freezeStatus, index, type, id, score, source, highlight, sorts } … ],
    metadata: { totalPages, totalCount, maxScore } }
  ```
- **p50 ≈ 126 ms, p90 ≈ 159 ms** for a 100-document page. ~200 KB/page.

### `GET /api/v1/documents/{uuid}/details`
- Param: `documentLinesLimit` (we send 1000).
- Top-level fields include: `submissionUUID`, `dateTimeRecevied` *(the portal's own misspelling —
  our mapping mirrors it deliberately)*, `validationResults { status, validationSteps[7] }`,
  `transformationStatus`, `statusId`, plus the document body we export.
- **p50 ≈ 1,045 ms, p90 ≈ 1,303 ms — for ONE document.**
- Sustained **~21.6 calls/s**, 973 consecutive calls, zero non-200s, under the SPEC-025 governor.

### Others seen this session
`/api/v1/users/current`, `/api/v1/taxpayers/{id}/light`, `/api/v1/intermediaries/config`,
`/api/v1/inlinecontent/view` (has been observed hanging ~90 s — the tarpit the request deadlines
exist for), `/api/v1/notifications/preferences/my/hasnewnotifications`.

## The cost asymmetry (the single most important number)

Per document, search costs ~1.3 ms (126 ms ÷ 100) and details cost ~1,045 ms. **Details are roughly
800× more expensive per document than enumeration.** Every performance decision in this tool follows
from that: enumeration of even millions of documents is hours, full detail export is days, and the
only real levers are concurrency (SPEC-025) and not fetching details you do not need.

## Inferred — why the 10,000 cap exists

The search hit shape (`index`, `type`, `id`, `score`, `source`, `highlight`, `sorts`) plus
`metadata.maxScore` is the classic **Elasticsearch** hit envelope. Elasticsearch's default
`index.max_result_window` is **exactly 10,000** — the invoices cap; receipts' 3,000 looks like the
same setting tuned lower on its index.

Consequences, if the inference holds:
- The cap is a deep-pagination limit **per query**, not a business rule — which is precisely why
  narrowing the date window works: each narrower query gets its own fresh 10,000-document window.
- Sorting affects *which* 10,000 are reachable, so a run must never rely on paging past it.
- A `search_after`-style cursor would sidestep the window entirely, but only if the portal exposes
  it; nothing observed suggests it does. Not actionable today — recorded so it is not re-derived.

## Scale anchor

The portal's own Documents page reported **299,492 results for a single month** (21/7–20/8) on this
entity. Useful when sanity-checking a plan's total against expectation.

## Session / entity behaviour (see SPEC-030, SPEC-031)

- The access token lives in `localStorage.USER_DATA` with a **~15-minute** lifetime and is renewed
  silently by the SPA for as long as a portal tab is open.
- Entity selection is **server-side per login**: a cold SPA boot can re-select the login's default
  entity, and that change is visible to other browsers on the same login.
- Symptom of running under the wrong entity: searches return rows but `/details` answers **403**
  per document — not an error the run can see any other way, hence the mass-403 guard.

## How to capture more

Attach the observer used for this page to an already-open portal tab (never open one — a cold load
can flip the active entity mid-run). It wraps `fetch`/XHR, records endpoint, status, timing and
response *shape* only, and samples at most two bodies per endpoint.
