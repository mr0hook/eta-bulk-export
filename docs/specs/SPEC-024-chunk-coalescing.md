# SPEC-024 — Chunk coalescing: fill-target merge of adjacent under-filled chunks

**Status:** BUILT · 2026-08-19
**Driver:** live 8M-document probe (2026-08-19). The user watched the plan produce a 4-chunk day
next to 1-chunk days. Pure bisection accepts the FIRST window that probes under cap, so average
fill is ~50–60% of cap and adjacent small fragments are never re-joined. At 8M invoices that is
~1,600 chunks where ~900 would do — double the per-chunk overhead (xlsx render + write, details
phase ramp-up, checkpoint paints) and double the weight of the cursor that rides every /plan/step.

## Problem

`planner.js` (server, authoritative) and `chunker.js` (reference impl, test-only) bisect a date
range until every window probes `< cap`, emitting leaves left→right. Bisection never looks back:
two adjacent leaves of 2,100 and 1,800 stay two chunks although one 3,900-doc chunk is legal.

Live numbers backing the cost (this session's monitor, ETA production portal): one `documents/
search` page costs p50 ≈ 450–650 ms; every chunk additionally pays details ramp, xlsx render and a
file write. Chunk count is the single multiplier the planner controls.

## Change

One rule, applied identically in both implementations: **when a newly accepted chunk and the
previously accepted chunk are compatible and their combined count fits the fill target, replace
them with one merged chunk.**

- Fill target: `floor(cap * 0.9)` — 9,000 for invoices (cap 10,000), 2,700 for receipts (cap
  3,000). The 10% headroom absorbs documents that arrive between plan time and fetch time and the
  shared-boundary double-counts. (Bisection today accepts single leaves up to `cap - 1` with zero
  headroom; those still pass through untouched — the target governs only merges.)
- Compatible = neither chunk carries `warn`, and either both are plain date chunks, or both are
  sub-split chunks of the SAME issuance window (`fromISO`/`toISO` equal). Plain and sub never mix.
- Merged plain chunk: `[a.fromISO … b.toISO]`, `count = a.count + b.count`. The span between the
  two (if any) probed zero at plan time, so widening over it is safe; any document that appears
  there later is picked up rather than lost — over-report is recoverable (merge dedups by UUID),
  under-report is not.
- Merged sub chunk: same issuance window, `[a.subF … b.subT]`, counts summed.
- `warn` chunks are never merged, in either direction.

### Where it runs

- **`lead-worker/src/planner.js`** — streaming, inside `emit()`: the merge happens as each chunk
  is accepted, so `st.out` (which rides inside the sealed cursor on EVERY /plan/step) stays small
  for the whole conversation — this matters at 8M-doc scale, where the cursor already carries the
  accepted-chunk list (known ceiling in STATE.md). The `subDone` sentinel's `out.length === mark`
  emptiness check is unaffected: a subtree's first emission can never merge backwards across the
  mark, because the previous chunk is either plain or a sub chunk of a different issuance window.
- **`src/core/chunker.js`** — post-pass fold over the finished leaf list. A left-to-right greedy
  fold is mathematically identical to the streaming form (each decision depends only on the
  accumulated last chunk), and the equivalence suite proves it on real corpora.

### Cursor / deploy compatibility

No new state fields; `st.out` only holds (fewer) chunks of the same shape. A cursor sealed by the
pre-coalescing worker unseals and continues on the new one — chunks accepted before the deploy
stay unmerged, everything after merges. Gap-freedom is unaffected either way.

## Explicitly not doing (recorded so nobody re-litigates)

- **Interpolation-guided boundary search** (probe-count-guided cuts to hit ~target directly, saving
  probes): changes the conversation protocol and the risk class — bisection + merge keeps the
  gap-free proof untouched. Future work if probe cost ever dominates.
- **Client-side post-merge in planclient.js**: the plan must stay server-authoritative (SPEC-016's
  entire point); D1's chunk rows and the admin timeline must match what the client runs.

## Acceptance criteria

- AC-240 Adjacent under-filled compatible chunks merge up to `floor(cap*0.9)`; no merged chunk
  exceeds the target; chunks that were already ≥ target pass through unchanged.
- AC-241 `warn` chunks never participate in a merge.
- AC-242 Sub-split chunks merge only within one issuance window; plain and sub chunks never mix.
- AC-243 Coverage stays gap-free and no document is double-fetched beyond the pre-existing
  shared-boundary case (which merging strictly reduces).
- AC-244 Server planner and reference chunker still produce byte-identical plans (equivalence
  suite extended with merge-heavy corpora).

## Tests

- T-240 (planner.test.mjs) equivalence on a merge-heavy corpus: many sparse days → multi-day
  merged chunks; both impls identical; every chunk ≤ target unless it is a single unmerged leaf;
  greedy maximality (no adjacent compatible pair sums ≤ target); coverage gap-free.
- T-241 (planner.test.mjs) pathological over-cap corpus: warned chunks stay one-per-day,
  unmerged (extends T-151's ground).
- T-242 (planner.test.mjs) two consecutive over-cap issuance days, both sub-split: merges stay
  inside each day's window; cross-day sub merge never happens; both impls identical.
- T-243 (chunker.test.mjs) fill property on the year corpus: for every adjacent compatible pair,
  `a.count + b.count > target` (greedy left nothing mergeable on the table).
- smoke-worker.mjs planner scenario re-pinned: synthetic under-cap windows raised 100 → 9,500 so
  the two-chunk structure (deliberately) survives coalescing; totals updated.

## Effect at the driving scale

8M invoices, cap 10,000: bisection alone ≈ 1,400–1,800 chunks (observed fill ~50–60%); with
coalescing ≥ `ceil(8M / 9000)` ≈ 889 and in practice ~950–1,050. Roughly HALVES chunk count, plan
cursor weight, checkpoint string length (CHUNK_STATES_MAX headroom), and per-chunk fixed costs.
Probe count is unchanged — merging spends observations already paid for.
