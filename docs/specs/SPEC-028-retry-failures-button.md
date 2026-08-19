# SPEC-028 — "Load failed UUIDs" button: one click from eta_failures.jsonl to a retry run

**Status:** BUILT · 2026-08-19 · ships as v0.9.0 (feature → minor bump)
**Driver:** user request during the live Purchases run ("19:55:10 ⚠️ 3 document(s) in chunk 9
unavailable after retries — logged to eta_failures.jsonl"). The capture side has existed since the
never-silently-drop rule; what was missing is the recovery ergonomics: the user had to open a
.jsonl by hand, extract UUIDs, and paste them into the By-list box. That whole loop becomes one
button.

## Behaviour

A button inside the By-list box: **Load failed UUIDs**. On click:

1. `ensureFolder()` — same folder/permission gate as every other entry point; no folder → the
   existing "Pick an output folder first" message.
2. Read `eta_failures.jsonl` from the folder and collect document UUIDs from its lines,
   - **excluding** `kind:'pdf'` lines (the document itself was exported; only its optional
     official PDF failed — re-fetching the doc would not bring the PDF back on its own),
   - **excluding** `kind:'over_cap'` lines (they carry no uuid; they describe a range, not a doc),
   - **excluding** `source:'receipts'` lines (the uuid-list export is invoices-only by SPEC-022),
   - de-duplicated, order preserved (a doc that failed in two attempts appears once).
3. Fill the existing `#lst` textarea with the UUIDs (one per line), fire its `input` event so the
   live SPEC-022 classifier renders "N UUIDs", open the By-list box, and show a footer status with
   the count. The user reviews and presses the normal **Start** — every existing validation
   (mixed-list refusal, 10k cap, entitlement, server batching) applies unchanged because this IS a
   paste, just typed by the extension instead of the user.
4. No file, an empty file, or nothing eligible → a plain "no failed documents recorded" status.
   Unparseable lines are skipped, never fatal — the file is an append-only log a crash may have
   torn mid-line.

Deliberately a LOADER, not an auto-runner: the user sees what will be fetched and keeps the
Advanced options (PDFs, columns) they want for the retry. The failures file is not truncated by
loading it — it is the permanent audit trail; a retried document that succeeds simply lands in the
new run's output (and merge dedups by UUID if both ever meet in one folder).

## Pieces

- `src/core/failures.js` — `parseFailureUuids(text)` pure parser (node-testable): JSONL → eligible
  uuid list per the rules above + counts `{ uuids, pdfOnly, receipts, badLines }`.
- `src/ui/drawer.js` — the button (`#lstFails`) in the By-list `advbody`, wired through
  `ensureFolder()` + `fs.readText`; fills `#lst` and reports.
- i18n: `flow.loadFails`, `flow.failsLoaded`, `flow.failsNone` (EN + AR).

## Tests

- T-262 (failures.test.mjs) parser: dedup across attempts; pdf/over_cap/receipts lines excluded;
  torn/garbage lines skipped with a count; empty/absent text → empty result; order preserved.
