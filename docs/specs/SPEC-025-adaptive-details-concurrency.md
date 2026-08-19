# SPEC-025 — Adaptive details concurrency (AIMD governor)

**Status:** BUILT · 2026-08-19 · ships as v0.7.1 (fix → patch bump)
**Driver:** live monitored run, 2026-08-19 ~17:00. A 13-chunk / 66,719-row Sales export entered
the details phase and hit a 429 storm: in an 81-second monitor window, 77 of 926 API calls were
rate-limited/blocked against 849 OK, the drawer sat in "Rate-limited (429) — waiting 6s…" loops,
and p99 latency reached 60s. The user read it as a company-profile flip; the traffic proves
otherwise — searches return rows and details return 200 in ~250 ms whenever they are allowed
through (an entity flip shows empty searches + per-doc 403s, SPEC-023/STATE). The cause is the
FIXED details concurrency: `CONC = { invoices: 40, receipts: 30 }`. Forty parallel workers exceed
the portal's rate ceiling; every 429 wave stalls all forty in lockstep, and after the shared
backoff all forty slam back at once — sawtooth throughput and, in the worst case, rows that burn
all 7 apiGet retries and fail the chunk.

Same session's earlier evidence points the same way: the sequential search phase (~1.3 req/s) ran
2,000+ calls with ZERO 429s, but p50 crept 428→711 ms — the portal applies soft pressure well
before it starts refusing.

## Change

One shared **AIMD governor** per run (classic TCP congestion control, the standard answer to an
opaque server-side rate limit):

- **Start** at 12 concurrent details fetches (invoices) / 10 (receipts) — comfortably under the
  observed ceiling, so a run starts clean instead of starting with a 429 storm.
- **Multiplicative decrease:** any 429 observed by any worker halves the limit (floor 3) and
  freezes growth for a 10 s cool-down. The in-flight surplus simply drains — workers over the new
  limit park as they finish.
- **Additive increase:** every 25 consecutive successful fetches raise the limit by 1, capped at
  the old static values (40/30), which now act as the ceiling instead of the constant.
- The governor lives for the whole run, not per chunk — what the portal taught us on chunk 1 is
  still true on chunk 13.

### Pieces

- `client.js apiGet`/`apiGetBlob`: the 429 branch now calls `onRate(waitMs, true)` — a second
  argument distinguishing a real rate-limit from the generic error backoff (existing callers
  ignore it; no signature break).
- `client.js makeGovernor({start,min,max,rise,cooldownMs,now})`: the AIMD state machine. Pure,
  clock-injectable for tests.
- `client.js mapAdaptive(items, gov, fn)`: `mapLimit` with a live limit — a pump spawns work while
  `active < gov.limit()`, so the pool shrinks by draining and grows on the next completion.
  Same contract as mapLimit otherwise (ordered results, first rejection wins).
- `orchestrator.js`: details fetches move from `mapLimit(list, CONC[key])` to
  `mapAdaptive(list, detGov, …)`; each success calls `detGov.ok()`, each 429 (via the onRate flag)
  calls `detGov.slow()`. The drawer's rate-wait line is unchanged. PDF (8) and reject-scan (12)
  pools are out of scope — they were not the ones stampeding.

## Acceptance criteria

- AC-250 A 429 halves the details concurrency immediately (floor 3) and growth stays frozen for
  the cool-down; sustained clean traffic climbs back +1 per 25 successes up to the old maximum.
- AC-251 mapAdaptive never has more than `gov.limit()` calls in flight, at any instant, even as
  the limit moves mid-run; results keep item order; a thrown AUTH/STOPPED still rejects the batch.
- AC-252 The rate-limit signal reaches the governor only for real 429s, not for ordinary retry
  backoff (network blips must not shrink the pool).

## Tests

- T-254 (client.test.mjs) governor semantics: start/halve/floor/cool-down/climb/ceiling, with an
  injected clock.
- T-255 (client.test.mjs) mapAdaptive under a moving limit: peak in-flight tracks the governor
  (shrink drains, growth re-expands), ordered output, rejection propagation.
- T-256 (client.test.mjs) apiGet flags a 429 to onRate with `true`, and plain error backoff
  without it.

## Explicitly not doing

- Per-request client-side rate metering (token bucket): the portal's ceiling is opaque and moves;
  AIMD discovers it continuously instead of hard-coding today's guess.
- Governing the search-page loop: it is sequential by design and has never drawn a 429; the
  latency creep there is a portal-load signal the governor already responds to indirectly.
