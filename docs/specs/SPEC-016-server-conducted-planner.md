# SPEC-016 — Server-conducted chunk planner (S2)

> Feature F-20 · Phase: BUILD · Depends on: SPEC-015 (A0 split), ADR-002 (D1)
> Goal: the extension stops deciding how to slice a date range. A patched build has no plan, and
> therefore nothing to export.

## Why this and not obfuscation

The gate is already server-authoritative in its *decision* (`lead-worker` `/session`). What is
patchable is the two client booleans that obey it — `guard()` at `drawer.js:415` and `licensed` at
`drawer.js:449`. No amount of hardening changes that: code that runs on the user's machine can be
edited.

What can change is whether a patched client has anything worth running. Today it does: every byte
of value is produced in the browser, and `src/core/chunker.js` — the part that makes a >10,000-row
range exportable at all — ships with it.

Moving the planner to the server works where obfuscation does not, for two reasons:

1. **The answers are data-dependent.** A split decision is a function of the live document count in
   a range. A cracked fork cannot record one session and replay it; every folder and every date
   range needs a live, authorised server.
2. **A naive re-implementation silently under-reports.** The DST-safe calendar arithmetic
   (`chunker.js:58-63`) and the inclusive shared boundary (`chunker.js:48`) exist because the
   obvious implementations open sub-millisecond gaps at ETA's timestamp precision. A fork that
   drops invoices from a compliance export is worse than no fork — and that is a public argument,
   not just a technical one.

It also subsumes most of S1. Once planning requires a signed, authorised call, a hand-forged
`reg_verdict` in localStorage unlocks the UI but produces no plan. S1 drops to tidy-up scope,
covering the rejection/PO features that never call the planner.

## What moves, and what cannot

| Stays in the browser | Moves to the worker |
|---|---|
| Probing ETA (needs the user's own portal token) | Deciding where to split |
| Fetching documents, details, PDFs | Minting chunk ids and labels |
| Rendering xlsx, merging | Entitlement, quota, job records |

Crossing the wire: date ranges, document **counts**, chunk ids. No invoice content — the same line
`store.js:27-34` already draws for `eta_progress.json`.

## Architecture

### The client becomes a probe executor

`src/core/chunker.js` is deleted from the extension and replaced by `src/core/planclient.js`:

```
POST /plan/start  {source, from, to, field, dir, statuses, version}
  → {jobId, cursor, instruction}
loop:
  instruction  →  probe ETA  →  POST /plan/step {jobId, cursor, observation}
                                  → {cursor, instruction}   or   {done, chunks[]}
```

Three instruction kinds, mirroring the three things the current planner asks of the world:

| kind | payload | observation |
|---|---|---|
| `probe` | `fromISO`, `toISO` | `{count}` |
| `probeSub` | `issF`, `issT`, `subF`, `subT` | `{count}` |
| `detectMaxSub` | `issF`, `issT` | `{maxSub}` (ISO or null) |

### Recursion becomes an explicit stack

The worker cannot hold a call stack between requests, so `split()`/`ss()` are rewritten as a
work-stack machine. Ordering is load-bearing: the recursive form returns `[...L, ...R]`, so the
machine pushes the right frame before the left and appends accepted chunks to a flat, indexed
output. **This is the only part of the algorithm that changes shape, and the equivalence test below
exists because of it.**

### Sealed cursor — a stateless worker for the probe conversation

Traversal state (work stack, counters, step number) is AES-GCM sealed with a worker-held key,
`jobId` as additional authenticated data, and echoed by the client each step. The worker therefore
needs no per-step storage: no Durable Object, no KV write per probe, and the free tier is not a
constraint on a 400-probe plan.

The stack holds at most one pending frame per level (depth capped at 80), so the sealed blob stays
in the low kilobytes regardless of how many chunks the plan ends up with.

Accepted chunks do **not** ride in the cursor — they are inserted into D1 as they are decided, so
cursor size is independent of plan size.

### Idempotency

The cursor carries a monotonic step number. A step replayed with the same cursor returns the same
instruction. The client's retry loop depends on this: the user chose hard-fail-and-retry over any
offline fallback, so a flaky connection means repeated identical steps, not a corrupted plan.

### Enforcement

`/plan/start` is where the gate actually bites: allowed / locked / killed / RIN / version / quota
are checked before a job id is minted. No entitlement → no job → no plan → no chunks. `guard()`
stays in the client, demoted to explaining *why* rather than deciding.

### D1 schema

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, rin TEXT, source TEXT, date_field TEXT,
  dir TEXT, from_iso TEXT, to_iso TEXT, statuses TEXT, state TEXT NOT NULL,
  total_chunks INTEGER DEFAULT 0, total_rows INTEGER DEFAULT 0,
  done_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
  version TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE job_chunks (
  job_id TEXT NOT NULL, idx INTEGER NOT NULL, chunk_id TEXT, from_iso TEXT, to_iso TEXT,
  sub_f TEXT, sub_t TEXT, count INTEGER, warn TEXT, state TEXT DEFAULT 'pending',
  PRIMARY KEY (job_id, idx));
CREATE INDEX jobs_device ON jobs(device_id, created_at);
```

`state`: `planning` → `planned` → `running` → `done` | `incomplete` | `halted` | `abandoned`.

## Build order

1. **`lead-worker/src/planner.js`** — the pure step machine. No env, no I/O, node-testable exactly
   as `chunker.js` is today.
2. **`lead-worker/src/cursor.js`** — seal/unseal.
3. **D1 schema + `lead-worker/src/jobs.js`.**
4. **Routes** `/plan/start`, `/plan/step`, `/job/checkpoint`.
5. **`src/core/planclient.js`** + orchestrator wiring; delete `chunker.js`.

Stages 1–2 are pure and land with tests before anything touches the deployed worker.

## Test cases

| ID | Case |
|---|---|
| T-137 | **Equivalence — the centrepiece.** For each existing chunker fixture, driving the step machine and `buildChunks` from the same `makeProbe` corpus yields an identical chunk array: same ids, order, ranges, counts and warnings. |
| T-138 | Equivalence holds for the granular time-bisection corpus (dense cluster) |
| T-139 | Equivalence holds across the Cairo DST fall-back day — the 25-hour day is not double-counted |
| T-140 | Equivalence holds for the sub-split corpus (issuance day over cap → submission-time split) |
| T-141 | Equivalence holds when `detectMaxSub` returns null (degrades to a warned single-day chunk) |
| T-142 | A doc in the final sub-second of the last day is still covered |
| T-143 | Sealed cursor round-trips; a tampered cursor is rejected, not silently accepted |
| T-144 | A cursor sealed for job A is refused for job B (jobId is the AAD) |
| T-145 | A replayed step returns the identical instruction (idempotency) |
| T-146 | A step out of order (stale step number) is refused |
| T-147 | Cursor stays under 8 KB for a plan that accepts 400+ chunks |
| T-148 | `/plan/start` refuses a locked / killed / unentitled device before minting a job |
| T-149 | `/plan/start` refuses a RIN the device does not hold |
| T-150 | Job row reaches `planned` with `total_chunks` matching the chunks inserted |
| T-151 | Depth cap and probe cap terminate rather than looping |

T-137 through T-142 are the ones that matter. If the step machine and the recursive planner ever
disagree on a real corpus, the rewrite has introduced a silent data gap — the exact failure this
whole feature is meant to make forks vulnerable to. The old `chunker.js` is kept in the repo as a
test-only reference implementation after it is removed from the bundle.

## Honest status

Nothing here is built yet. This spec is the design; T-137 is written before the machine it tests.
