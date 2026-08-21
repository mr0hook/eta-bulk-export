# SPEC-041 — Detecting a short chunk is useless unless the folder can be fixed

**Status:** BUILT · 2026-08-21 · ships as v0.16.0 (feature → minor)
**Driver:** user, 2026-08-21, on the Q2 2024 folder: *"your checker just give the warning, the json
file in the folder not fixed to resume from folder."* Correct, and it was a dead end by construction.

SPEC-040 taught the merge to say a folder is incomplete. It could not say **which chunks**, and
nothing it wrote could make a Resume fetch them. `tools/verify-chunks.mjs` on
`Pr2\2024\Q2`:

```
41 chunks · planned 278,541 · actual 265,359 · missing 13,182
chunk 11:  9 of 7,052        chunk 8:  1 of 6,140
```

## Why editing doneIds could never have worked

`orchestrator.js` resume, for an unfiltered range run:

```js
p.doneIds = (p.mode !== 'uuids' && !filtered) ? fileDone : [...new Set([...p.doneIds, ...fileDone])];
```

The progress file's own list is **discarded** and rebuilt from file PRESENCE — a deliberate rule from
the 2026-08-19 empty-page incident, where doneIds had been poisoned with chunks that had no files
(T-238 pins it). The consequence nobody drew: a 9-row file for a 7,052-document window is *present*,
so it is *done*, permanently, and no edit to `doneIds` survives one resume. That is why
`tools/drop-short-chunks.mjs` had to **delete** files to work at all.

## Change

**1. Per-chunk attribution.** Phase 1 already reads every chunk file, so it now records summary rows
per file (`fileRows`, carried in the merge state across incremental merges). `reconcile()` compares
each chunk's file against that chunk's planned count, using the same `max(2, 0.5%)` tolerance as the
run-time guard — the two must never disagree about what "short" means.

**2. The short chunk file is DELETED.** Phase 1 has already consumed its rows into this merge's
output, so nothing in flight is lost, and its rows are a fragment of a window about to be refetched
whole. Its SPEC-027 `_det_pNN` parts go with it — an orphaned part has no summary to join. A delete
that fails is reported, not swallowed.

**3. `shortIds` in the progress file, honoured by resume.** Recorded by `store.markShortChunks()`,
subtracted in resume — **the one list resume trusts over the files on disk**. Belt and braces for a
failed delete, and the mechanism that makes the fix work even when the file survives. It is
**self-clearing**: `writeProgress` drops any id that is in `doneIds`, so a refetched chunk stops
being short without anyone tidying up.

## Also fixed here

`readProgress` picks the most-recently-updated progress file by string-comparing `updatedAt`. Two
writes inside the same millisecond produce an identical timestamp, so the tie fell to directory
order — arbitrary. Rare in the field (real writes are seconds apart), possible with two runs sharing
a folder, and the cause of a flaky T-238 under load. `writeProgress` now stamps a monotonic `seq`
and `readProgress` breaks ties with it.

## Tests

- **T-297** a short chunk file is deleted, its id lands in `shortIds`, status becomes `incomplete`,
  the healthy chunk beside it is untouched. Mutation-checked: fails without the delete.
- **T-298** with the file still on disk and the folder scan calling it done, resume returns it as
  NOT done, carries `shortIds` forward, and the list clears once the chunk is refetched.
  Mutation-checked: fails without the subtraction.
- T-238 unchanged — the file-presence rule it pins is still the rule; `shortIds` is the exception.

## Limit

The merge can only judge a chunk it read. On an incremental merge over files consumed by an older
version there is no recorded row count for them, and those chunks are skipped rather than guessed
at. A full re-merge of the folder judges every chunk.
