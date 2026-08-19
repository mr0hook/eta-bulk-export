# SPEC-026 — Direction-aware chunk cap (Purchases plan at 2,000 docs)

**Status:** BUILT · 2026-08-19 · worker-only (no extension change, no version bump)
**Driver:** the live Purchases run (38 chunks / 254,048 rows). Chunk 1 (9,477 received invoices)
failed every attempt with `Invalid array length` and previously killed the tab with Chrome's
"Aw, Snap!" — measured live: heap hit 2,273MB with only 44% of the chunk's details fetched
(~540KB retained per received invoice; line-heavy supplier documents), extrapolating to ~5GB
against Chrome's ~4.2GB per-tab ceiling. Retries can never succeed — every attempt refetches the
same 9,477 docs into the same wall. Sales chunks at 10k never hit this: Sent documents are several
times lighter.

## Change

`lead-worker/src/routes/plan.js` — the SOURCES table gains `capReceived: 2000` for invoices, and
`/plan/start` resolves the planning cap by the request's direction: `dir !== 'Sent'` on invoices
(i.e. `Received` and `all`, which contains received docs too) plans at 2,000 docs per chunk;
Sales keeps 10,000. Receipts are untouched. Server-side only — the cap lives in the worker
precisely so a client cannot raise it (SPEC-016), and that is also why no extension build ships.

SPEC-024 coalescing composes automatically: the merge target is `floor(cap * 0.9)` of the
RESOLVED cap, so Received chunks coalesce toward 1,800, never past it.

## Interim, not final

The durable fix is the streaming chunk render (planned next): map each document to its export
rows as its details arrive, discard the raw JSON, and write the details sheet in parts the way
the merger already does (the details sheet is also the one that can brush Excel's 1,048,576-row
sheet ceiling at extreme line counts — same fix covers both). Once that lands, this cap can rise
again. If a 2,000-doc Purchases chunk still proves too heavy in practice, lowering `capReceived`
is a one-line redeploy.

## Tests

- T-257 (smoke-worker.mjs) the same 5,000-doc probe window plans as ONE chunk under `dir: 'Sent'`
  and SPLITS under `dir: 'Received'` with every chunk under 2,000 and no warns; the pre-existing
  planner scenario now pins `dir: 'Sent'` explicitly (a dir-less request gets the conservative
  cap by design).
