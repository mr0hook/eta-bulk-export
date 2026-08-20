# SPEC-034 / SPEC-035 — Resume from the folder alone, and keep the failures log honest

**Status:** BUILT · 2026-08-20 · ships as v0.12.0 (features → minor bump)
**Driver:** both requested by the user immediately after the 2026-08-20 lockout, and both are
direct consequences of it.

## SPEC-034 — "⏵ Resume from folder"

**The gap.** `orchestrator.resume()` has always been fully offline: it reads the folder's
`eta_progress_*.json`, rebuilds the plan (the server-minted chunk list rides inside that file),
restores the column/PDF choices the server never stored, and re-derives the done list from the
chunk files actually present on disk. What was missing was a way to *reach* it: the Resume entry
only rendered when `/job/resumable` offered a job, and jobs are **device-scoped** server-side. When
this browser's device identity changed, 37 of 38 completed chunks and a complete plan sat in the
folder with no button that could continue them.

**The change.** A `⏵ Resume from folder` button in Tools. It takes the same path as the Resume
entry minus the server: folder permission inside the click gesture → licence check → `orch.resume()`
→ a confirm dialog naming what was found (kind, date span, chunks done / left) → run.

Notes that make it safe rather than a back door:
- The plan is **not** newly minted — it was minted by the server when the run was planned and has
  been in the folder ever since. SPEC-016's authority is unchanged.
- The licence check still applies, exactly like every other run entry point.
- The folder-ownership stamp (SPEC-010) is still enforced inside `resume()`, so this cannot adopt
  another taxpayer's folder.
- Checkpoints stay best-effort: `mark()` already swallows a failed `/job/checkpoint`, so a job the
  server no longer associates with this device does not stop the export from finishing.

## SPEC-035 — the failures log is pruned by the run that recovers it

**The gap.** `eta_failures.jsonl` is append-only. After *⟳ Load failed UUIDs* → Start actually
re-fetches those documents, their lines stayed in the file, so the next click handed back documents
that were already exported and the file grew forever. It said "ever failed" when the user needs
"still missing".

**The change.** A run remembers every uuid it exported successfully. When it finishes, exactly
those lines are removed from `eta_failures.jsonl` and the log says how many were recovered and how
many remain. Rules that keep it an audit trail rather than a bin:

- Only **document-drop** lines whose uuid is in the recovered set are removed.
- A `kind:'pdf'` line is **kept** even when its document was re-exported: it says the official PDF
  is missing, which stays true. (T-226 caught the first version of this rule getting it wrong.)
- Lines with no uuid (`over_cap` range warnings) are **kept**: they are history about a range, not
  a document.
- Unparsable/torn lines are **kept**. A crash can tear the last line, and deleting what cannot be
  read would silently destroy evidence.
- Documents dropped by *this* run were appended during it and are absent from the recovered set, so
  they correctly survive.
- No rewrite happens when nothing overlaps — a multi-megabyte log is not rewritten for nothing.
- Best-effort: a failure here never fails a finished run.

## Tests

- T-276 `resume()` rebuilds a runnable plan from the folder with a jobId no device can claim: chunk
  list, source/direction, excluded columns and PDF choice preserved; recorded dones with no file
  behind them healed away.
- T-277 a folder-resumed run completes and writes its chunks with **every** server checkpoint
  failing (the test environment has no bridge, which is exactly that condition).
- T-278 pruning removes both lines of a recovered document, keeps a still-missing one, keeps
  range-level history, keeps a torn line.
- T-279 pruning is a no-op with no overlap / no recovery set / no file, and empties the file when
  everything in it was recovered.
