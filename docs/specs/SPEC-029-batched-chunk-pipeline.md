# SPEC-029 — Batched chunk pipeline: 10k chunks restored, memory bounded by batch not chunk

**Status:** BUILT · 2026-08-20 · ships as v0.10.0 (feature → minor bump) · supersedes SPEC-026
**Driver:** user directive ("restore chunking to 10,000"). SPEC-026's 2,000-doc Received cap was a
seatbelt for one fact: the run held a WHOLE chunk's raw detail JSONs until render (~540KB per
line-heavy received invoice → a 9.5k chunk needed ~5GB against Chrome's ~4.2GB ceiling). This
removes the fact instead of capping around it.

## Change

`orchestrator.js` processes a chunk's documents in **batches of `BATCH_DOCS = 2000`**:

- Per batch: details (adaptive pool, one straggler-retry pass) → that batch's official PDFs →
  reference-number resolution → `buildRows(batch, { serialBase })` → the batch's line rows go
  straight to `_det_pNN` part files (SPEC-027 streaming writer) → **the batch's raw JSON and line
  rows are dropped**. Only the small summary rows accumulate (10k rows ≈ tens of MB).
- The summary workbook is rendered once at the end from the union of the batches' columns (parts
  may carry different dynamic columns per batch — merge has always unioned headers by name), with
  a header-only lines sheet, written LAST under the unchanged chunk filename (resume's marker).
- `serialBase` (new option in xlsx.js's builders) keeps مسلسل continuous across batches.
- **A chunk that fits one batch (≤2,000 docs — every current plan, every uuid batch) takes the
  pre-SPEC-029 single-pass path unchanged**, including the inline-lines workbook under 30k rows.

Peak memory for ANY chunk size ≈ one batch of raw JSON (~1GB worst measured) + accumulated summary
rows + one part's streaming buffer. The tab no longer cares whether the planner cuts at 2k or 10k.

## Cap restored

`lead-worker/src/routes/plan.js`: `capReceived` removed — every direction plans at the full cap
(invoices 10,000 / receipts 3,000) again. `capFor` stays as the hook if a deliberate per-direction
cap ever returns. Smoke T-257 re-pinned to assert the revert (Sent and Received identical).

Honest note, also said to the user: chunk size does NOT change fetch throughput (the portal is the
bound, the adaptive pool is the lever). 10k chunks buy fewer files and fewer boundaries, not speed.

## Tests

- T-264 (batchrun.test.mjs) serialBase: batches keep one continuous index.
- T-265 (batchrun.test.mjs) a 4,500-doc chunk over a PAGED synthetic portal: three batches → three
  part files carrying all 4,500 line rows, one summary sheet with serial 1…4500, header-only lines
  sheet, chunk marked done, no failure log.
- Merge-side compatibility is already pinned by SPEC-027's T-260 (split chunk == legacy output).
