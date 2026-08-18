# SPEC-022 — List-driven export: by UUID list (a) and by counterparty RIN (b)

> Features F-22 (UUID-list export, part a) · F-23 (RIN filter, part b) · Phase: BUILD
> Depends on: SPEC-016 (server-conducted planner / signed calls), SPEC-010 (folder ownership),
> SPEC-021 (served mapping). Approved in chat 2026-08-18 (Option A: a new signed gate route).
> Goal: the user pastes a list — document UUIDs or counterparty registration numbers — and gets
> exactly those documents as Excel and/or official portal PDFs, without hand-building date ranges.

## Scope

- **Part a (F-22)**: paste 1..10,000 invoice UUIDs → fetch each document's details (and optionally
  its official signed PDF) → per-batch xlsx chunk files → one scoped COMBINED workbook, with a
  `Missed` sheet naming every UUID that could not be fetched. Server-gated by a new signed
  `POST /plan/uuids` that mints a real job (count only — **no UUID ever reaches the backend**).
- **Part b (F-23)**: paste 1..200 counterparty RINs → the normal range export (Sales / Purchases /
  All, any date range or the full e-invoicing era) writes only documents whose issuer **or**
  receiver is in the list. Client-side filter applied after search, **before** details/PDF fetch.

**NOT in this spec**: receipts by UUID (extension point: `SOURCES.receipts` already carries
`detailsBase`; the run path is written source-generic but only `invoices` is offered in the UI);
RIN filter for receipts (seller/buyer field mapping unverified); client-rendered PDFs (user chose
official printouts); any change to the planner conversation or to `MAX_STEPS`/`CHUNK_STATES_MAX`.

**Amendment (2026-08-19, v0.6.1 — T-236)**: server-side RIN narrowing IS in scope for a
single-RIN list. Verified live against the portal: `/api/v1/documents/search` accepts `Query=`,
documented on the Documents page as matching Receiver ID/Name and Issuer ID/Name (exact or
fragment), and it composes with the date filters. With one RIN, probes and page fetches both
carry `Query=<rin>`, so the plan sizes to that party's real volume instead of the whole account's
— a standalone one-party export costs a handful of probes, not thousands. The client-side
`rinMatch` still runs on every row (Query can over-match across fields; it cannot under-match a
full exact RIN). Multiple RINs keep the un-narrowed plan + client filter (the portal takes one
query per request).

## Decisions (made with the user, 2026-08-18)

1. PDFs are the **official portal printouts** via the existing `fetchPdf()`/`apiGetBlob()` pipeline
   (rate-limit honest: the drawer shows a duration estimate before start).
2. Input is a **paste textarea**. Content is auto-classified per token: 26-char base-31-ish
   alphanumeric → UUID; 8–15 digits → RIN. A mixed or unrecognisable paste is refused with counts.
3. RIN mode works both **with the selected range** and **standalone** (no dates → full era,
   2020-11-15 → today, exactly the year-2020 default `plan()` already uses).
4. Excel is always written in UUID mode (it is the record of what was fetched, including the
   `Missed` sheet); official PDFs ride the existing `downloadPdf` checkbox.

## Test cases FIRST

| ID | Level | Given / When / Then | Expected |
|---|---|---|---|
| T-219 | unit | messy paste (newlines, commas, spaces, dupes, mixed case) → `parseList()` | `{ kind:'uuid', items:[…] }` deduped, uppercased, invalid tokens listed separately |
| T-220 | unit | empty paste · garbage-only paste · 10,001 UUIDs · UUIDs mixed with RINs | `{ kind:'empty' }` · all tokens in `invalid` · `{ error:'too_many' }` · `{ error:'mixed' }` |
| T-221 | unit | 1,234 UUIDs + server batch reply → local uuid plan | chunks map 1:1 to batches, `count`s sum to 1,234, deterministic `key` (list hash), `filePrefix()` = `eInvoicesUuid`, `chunkFile()` names collision-free |
| T-222 | integration (worker) | signed, allowed device POSTs `/plan/uuids {count:1234}` | 200: jobId, batches summing to 1,234 (server-chosen size); D1: job `state='planned'`, `total_rows=1234`, `dir='uuids'`, chunk rows per batch; **no request field other than `count` is persisted** |
| T-223 | integration (worker) | unsigned · not-allowed verdict · `count` 0 / 10,001 / NaN · 61st plan in an hour | 401 · 403 (reason) · 400 · 429 |
| T-224 | unit | uuid plan + fake `fetchDetails` → `start()` | one xlsx per batch, checkpoints `running`→`merging` with `chunkStates`, done summary counts rows |
| T-225 | unit | one uuid 404s (NOT_FOUND) mid-batch | run continues; uuid on the `Missed` sheet **and** in `eta_failures.jsonl`; chunk still completes; summary names the miss count |
| T-226 | unit | `downloadPdf` on; one PDF fetch fails | PDFs under `pdfs/`, failure logged + counted, chunk not failed (mirrors range-run behaviour) |
| T-227 | unit | pause after batch 1; re-paste same list → resume | same `key` from the list hash; `scanDoneFromFolder` skips batch 1; batch 2 runs; nothing refetched |
| T-228 | unit | `/plan/uuids` refuses (no jobId) | run never starts, no file written, no local fallback (SPEC-016 rule) |
| T-229 | unit | folder holds `eInvoices_*` range files + `eInvoicesUuid_*` list files | uuid-scoped merge reads ONLY its own files → `eInvoicesUuid_COMBINED…`; the folder-wide merge regex matches none of them (both directions asserted) |
| T-230 | unit | RIN paste: 9- and 14-digit ids, dupes, a 7-digit typo | `{ kind:'rin' }`, deduped, typo in `invalid` |
| T-231 | unit | `rinMatch(set)` over search rows | keeps a row when issuerId **or** receiverId ∈ set (string-compared, trimmed); drops otherwise; missing ids never throw |
| T-232 | unit | range run with `rinFilter` + fake API | details fetched **only** for matching rows; xlsx holds only matches; drop accounting and probed-count display unaffected |
| T-233 | unit | standalone RIN run (no dates picked) | plan range = 2020-11-15 → today; `runKey` distinct from an unfiltered run over the same span |
| T-234 | unit | RIN filter + multi-status filter together | both predicates applied (status first, then RIN — same rows either way, asserted) |
| T-235 | unit | every new i18n key | present in BOTH `en` and `ar` tables (extends the existing i18n parity test) |

## Implementation plan

New/changed files, in slice order (each slice ends green and committable):

- **a1 — the gate** · `lead-worker/src/routes/plan.js` (add `/plan/uuids`): `verifySigned` →
  `deviceRate('plan', …)` (shared budget with `/plan/start`) → `computeVerdict` → validate
  `count ∈ [1,10000]` → `createJob({ dir:'uuids', dateField:'Uuid', fromIso=toIso=today(Cairo),
  source:'invoices' })` → batch list (server decides size: `ceil` to ≤25 batches of ≤500) →
  `finishPlan()` with synthetic chunks (`id: uuids_<idx>`, `label: 'UUIDs a–b'`, `count`) → return
  `{ jobId, batches }`. No cursor, no conversation — the list length is the whole problem.
  Tests in `smoke-worker.mjs` (T-222, T-223). **No schema change** (reuses jobs/job_chunks).
- **a2 — parsing + plan client** · new `src/core/listinput.js` (`parseList`, `listKey` hash) ·
  `src/core/registration.js` (+`planUuids`) · new `planUuidList()` in `src/core/planclient.js`
  building the local plan object from the server's batches. Tests `test/listinput.test.mjs`,
  extend `test/planner.test.mjs`-adjacent client tests (T-219, T-220, T-221, T-228).
- **a3 — the run** · `src/core/orchestrator.js`: in `start()`, when `plan.mode === 'uuids'` the
  row-acquisition step builds synthetic rows `{ source:{ uuid } }` from the batch instead of
  calling `fetchAllRows` (details fill every exported column — verified: invoices render from
  `detail` alone, xlsx.js:3). Missed-uuid collection → `Missed` sheet appended after
  `renderWorkbook` + `eta_failures.jsonl`. `src/core/store.js`: `filePrefix()` learns
  `eInvoicesUuid`, `runKey` accepts the list hash. Scoped merge entry (explicit file list into
  `runMerge`, prefix `eInvoicesUuid`). Tests T-224..T-227, T-229.
- **a4 — UI** · `src/ui/drawer.js`: “By list” box in the Download sheet (textarea + detected-count
  hint + PDF-duration estimate when `downloadPdf`); routes to uuid plan or attaches the RIN set.
  `src/core/i18n.js` en+ar. T-235.
- **b1 — RIN filter** · `src/core/listinput.js` (`rinMatch`) · `orchestrator.js`: `sel.rinFilter`
  → rows filtered after `fetchAllRows` (before details/PDFs); standalone default range;
  `runKey`/`planSig` include the RIN-set hash so progress files never alias. T-230..T-234.
- **b2 — UI polish** · drawer: standalone-RIN entry point (same textarea, no date change needed),
  status line “N of M matched your list”. i18n.

No new dependencies. No API contract invented outside DESIGN docs: `/plan/uuids` amends the
SPEC-016 route family and is recorded here (this section is the amendment).

## Risks & rollback

- **Merge cross-talk**: guarded by the distinct `eInvoicesUuid_` prefix + T-229 in both directions.
- **PDF pacing**: unchanged machinery; the only new exposure is list size — the drawer's estimate
  and the resumable run are the mitigation. Worst case identical to today's `downloadPdf` runs.
- **Privacy surface**: `/plan/uuids` carries a count; assert-tested (T-222). The pasted list lives
  only in the run's local progress file inside the user's own export folder.
- **Rollback**: both parts are additive — revert the commits; no migration to unwind. A job minted
  by a reverted route stays a valid, resumable-then-abandonable jobs row.

## Size

a ≈ 1 focused day (a1..a4) · b ≈ ½ day (b1..b2). Gated independently; b never blocks shipping a.
