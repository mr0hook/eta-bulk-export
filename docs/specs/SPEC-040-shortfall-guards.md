# SPEC-040 — Never finish a chunk, or a merge, that is short of its own plan

**Status:** BUILT · 2026-08-21 · ships as v0.15.0 (fix + feature → minor)
**Driver:** the 2026-08-20 2024 Q1 export. The plan said **240,351** documents. The chunk files held
**230,545**. Zero duplicates, zero failed chunks, no `eta_failures.jsonl`, and a merge that finished
with `✅ Merged 69/69 files → 230,545 unique`. **9,806 documents left the export and nothing anywhere
said so.** Reconstructed after the fact with `tools/verify-chunks.mjs`: three chunks stopped early —
**3 of 8,879**, **5,200 of 5,847**, **5,900 of 6,183** — and every actual count landed on an exact
multiple of the 100-row page size.

## Mechanism

`fetchAllRows` ended pagination on `if (r.length < ps) break` — a short page means the end of the
data. That rule is correct against a truthful server and is why pagination never over-reads a stale
probed count. But the portal also answers `200` with a **short or empty page while the window still
holds documents**, and there is no way to tell the two apart from one response. Read as a clean end,
the chunk returned partial rows, was written, and was marked done.

Two existing guards should have caught it and could not:

- the **empty-chunk guard** (2026-08-19) fires only on **exactly zero** rows — a partially-filled
  chunk walks straight past it;
- the **merge summary** counts files, not documents. `69/69 files` means every file was *read*,
  never that every document was *in* them.

## Change — three layers, because one is not enough

**1. `src/api/client.js` — do not believe a short page while short of the plan.**
When a page comes back short *and* the rows in hand are still fewer than the chunk's planned count,
the same page is re-requested up to `SHORT_PAGE_RETRIES = 3` times (1.5s / 3s / 4.5s). The page is
**replaced, never appended**, so a retry can only add documents the first answer omitted. A real end
of data repeats itself; a hiccup does not. Nothing changes for a chunk that has already fetched its
planned count — the ordinary end of every chunk pays no extra request.

**2. `src/core/orchestrator.js` — a materially short chunk is a FAILED chunk.**
Sibling of the empty-chunk guard. Below `max(2, 0.5%)` of its planned count, the window is
**re-probed**, and the probe decides: still claiming the planned count → documents are missing, the
chunk fails and resume refetches it whole; now agreeing with what we hold → the window itself shrank
(a document leaving the status set between planning and fetching is not a lost document) and the
chunk is accepted **with a warning**, never silently. Filtered runs (status subset, RIN list, UUID
mode) are exempt for the same reason the empty-chunk guard exempts them: their row counts are
legitimately below the plan's unfiltered counts.

**3. `src/core/merge.js` — the merge reconciles against the run's own plan and says so.**
The last line of every merge is now planned-vs-present. The comparison is against summary **rows
read** (unique + deduped), not unique: the planner cuts on an inclusive shared boundary, so a
document sitting exactly on a cut is fetched by both neighbours and counted twice in the plan —
comparing unique would report that as loss on a perfectly healthy export. Chunks with **no file at
all** are reported separately, because an unfinished run and a silently-short one need different
answers from the user. Reconciliation is skipped, with no message, when the folder holds no
comparable plan.

## Why 0.5%

The tolerance exists only for probe drift between planning and fetching. The losses this guard
exists for were 4.6%, 11% and 99.97% of a window — orders of magnitude above it — and the re-probe,
not the tolerance, is what prevents a false failure on a window that genuinely shrank.

## Tests

- **T-285** a chunk short of its planned count while the portal still claims the count → no file
  written, `failedIds: ['c1']`, and the log names the shortfall.
- **T-286** the counterweight: short only because the window shrank → completes, file written, and
  the discrepancy is still reported.
- **T-287** a chunk that fetches its full count is not warned about.
- **T-288** a transient **empty page** mid-pagination no longer ends the run — the same page is
  re-asked, the run reaches the true end, and the retry does not duplicate rows.
- **T-289** a genuine end still ends: bounded at 5 requests, 130 rows, no spin and no re-append.
- **T-290** no re-asks once the planned count is in hand.
- **T-291** merge reports a short chunk as `INCOMPLETE` — after, and despite, `Merged 2/2 files`.
- **T-292** boundary duplicates reconcile clean (4 rows, 3 unique, plan 4) — the false alarm that
  would have trained the user to ignore the check.
- **T-293** a chunk with no file at all is counted and named separately.
- **T-294** a filtered run is not reconciled at all.

## Limits

The run-time guards protect **new and resumed** fetching. They cannot repair an export already on
disk: for that, `tools/verify-chunks.mjs` locates the short chunks and `tools/drop-short-chunks.mjs`
deletes them and heals `doneIds` so a Resume refetches exactly those windows. The merge
reconciliation *does* apply retroactively — it reads the plan already in the folder, so re-merging
any past export now states whether it is complete.

## Self-review findings (2026-08-21, /code-review on this spec's own diff)

**R-1 · Real, shipped in v0.15.0, fixed in v0.15.2 — the first incremental merge after upgrading
reported a healthy folder as INCOMPLETE.** Every state file written by ≤v0.14.2 has no `extraRows`,
so the boundary duplicates its earlier passes deduped are invisible to the reconciliation. It counts
`unique + 0`, under-counts by exactly those duplicates, and reports documents lost that were never
lost — on the first merge the user runs after installing the fix. `canCount` now skips the
reconciliation entirely on a pre-SPEC-040 base; it self-heals on the next full rebuild. **T-296**
reproduces it: without the guard the log reads `the plan says 6 documents, the files hold 5`.

**R-2 · Not a defect — the shortfall guard on Pause.** `fetchAllRows` breaks out of pagination on
`signal.aborted` and returns partial rows, which would let a Pause be reported as a shortfall. It
does not, because `sleep(ms, signal)` REJECTS with STOPPED (`client.js:22`), so an abort makes
`fetchAllRows` throw and the guard is never reached. The abort check added in v0.15.2 is defence for
the one path that does return partial — an abort landing at the top of the loop — and **T-295**
exists to stop a future change making `fetchAllRows` swallow aborts from quietly turning every Pause
into a shortfall report. It passes with and without the check today, and says so.

## Consequence that was under-stated when this shipped

A chunk that used to complete silently short now FAILS, and `orchestrator.js:658` halts the whole
run after **three consecutive failed chunks**. Before this spec those chunks completed, so `consec`
never incremented and the run always finished. A run against a window the portal will not serve now
stops instead of finishing with a hole in it — correct, but it is a visible change in run behaviour,
and each failure costs three full attempts with 60s and 120s backoffs (~3½ minutes per chunk).
