# SPEC-011 — Run log persisted to the export folder (F-12)

**Feature:** F-12 · **Requirement source:** user directive 2026-08-08 — *"if the tool suddenly
locked or tab is closed you don't book that log but you keep it in json ... so we lost logs when we
crash"*.

## Diagnosis

`createRunLog()` (`runlog.js:5`) is in-memory only; the drawer mirrors it to `localStorage`. So the
folder ends a crashed run holding `eta_progress_*.json` (what to resume) and `eta_failures.jsonl`
(which rows failed) but **no narrative of what happened**. A tab kill, a profile clear, or moving
the folder to another machine loses it.

Two properties of the existing log make it unfit to simply dump on exit:

1. **It is ring-bounded** — `max = 200` entries / 32 KB, and `trim()` drops the oldest
   (`runlog.js:7-10`). A 9-hour run has already discarded its own beginning. A folder log that
   mirrors it inherits that amnesia, so the folder log must be **append-only** and independent of
   the ring.
2. **It coalesces** — consecutive same-`kind` entries replace rather than append (`runlog.js:15`),
   which is right for a live UI pane and wrong for a forensic record. The folder log records the
   coalesced line **once with its final count** rather than N times, so a 3-hour 429 storm costs
   one line, not thousands.

### The durability constraint

A `FileSystemWritableFileStream` does **not** durably land data until `close()`. So the streaming
approach F-10 just adopted for the merge scratch file — one long-lived writable — is exactly wrong
here: a tab kill would lose everything buffered, which is the case this feature exists to survive.

The folder log therefore uses **open → append → close per batch**. That is `appendText`, whose
`keepExistingData` re-open copies the whole file each time (the O(n²) behaviour F-10 removed from
merge) — acceptable here *only because the file is small*: a coalesced text log of a long run is
well under 1 MB, versus the multi-GB merge scratch. The spec caps it so this stays true.

**Requirement (AC-11):** after a hard tab kill mid-run, the export folder must contain a readable,
chronological record of that run up to the last few seconds, and it must survive a browser profile
reset and a move to another machine.

## Design

### File

`eta_runlog_<safeKey>.log` — one per run key, beside `eta_progress_<safeKey>.json`, reusing
`safeName()` so the two are visibly paired. Plain text, one line per entry:

```
2026-08-08T14:03:11.204Z  info  ▶ Chunk 12/45 — 2026-03-01 → 2026-03-07
2026-08-08T14:07:52.881Z  wait  ⏳ Rate limited — waiting 30s ×212
2026-08-08T14:09:02.115Z  err   ■ Halted — folder permission lost
```

ISO timestamp (sortable, timezone-unambiguous — the UI's `HH:MM:SS` is not enough to reconstruct an
overnight run), level, then the message exactly as the user saw it. `×N` carries the coalesced
count. Text rather than JSONL because a human opens this file after a crash; nothing parses it.

### Writer (`src/core/folderlog.js` → `createFolderLog`)

- `push(msg, meta)` appends to an in-memory pending buffer. Never touches disk.
- Flushes when **either** ~2 s has passed since the last flush **or** the buffer reaches 64 lines,
  whichever comes first — so a burst costs one write and a quiet run still lands within seconds.
- `flush()` is explicit and awaited at every point that already writes progress (chunk done, pause,
  halt, auth-expired, completion), so the log is at least as current as `eta_progress`.
- A failed write is swallowed and retried on the next flush, and **never** disturbs the run. A log
  that breaks the export it is recording would be worse than no log.
- Coalescing is resolved at push time from the same `meta.kind` rule the ring uses, so the file and
  the UI pane agree on what happened.
- **Size cap:** at 5 MB the writer stops appending and writes one final `… log truncated` line.
  This bounds the `appendText` copy cost by construction rather than by hope.

### Rotation

A new run with the same key truncates rather than appends — the previous run's log is renamed once
to `eta_runlog_<safeKey>.prev.log` (overwriting any older `.prev`). One generation back is enough
to compare "last night failed, tonight worked" without unbounded files accumulating.

### Wiring

`orchestrator.js` already funnels every user-visible line through `onStatus(msg, meta)`. The folder
log attaches there — one call site — so nothing else has to know it exists. It starts when a run
starts (folder known and allowed, per SPEC-010) and final-flushes on every terminal path.

**NOT in this spec:** persisting the drawer's own local lines emitted before a folder is chosen;
uploading logs anywhere; changing the in-memory ring or the UI pane; parsing the log back into the
UI; the `eta_failures.jsonl` durability path, which already works and is deliberately separate.

## Test cases (before implementation — `test/folderlog.test.mjs`)

| ID | Level | Given / When / Then | Expected |
|---|---|---|---|
| T-091 | unit | 3 pushes, then `flush()` | one file, 3 lines, ISO-timestamped, in order |
| T-092 | unit | push without flush | **nothing** written yet (batching is real, not per-line) |
| T-093 | unit | 64 pushes, no explicit flush | auto-flushed on the size trigger |
| T-094 | unit | clock advanced past 2 s, then a push | auto-flushed on the time trigger |
| T-095 | unit | 200 same-`kind` pushes then flush | ONE line carrying `×200`, not 200 lines |
| T-096 | unit | two flushes | second **appends**, first batch still present (no truncation) |
| T-097 | unit | `appendText` throws on flush #1, succeeds on #2 | no throw escapes; the lost lines are re-sent on #2 |
| T-098 | unit | writer exceeds the 5 MB cap | stops appending, final `truncated` line, still no throw |
| T-099 | unit | a second run with the same key | prior log moved to `.prev.log`, new log starts empty |
| T-100 | integration | orchestrator run, then a chunk completes | folder holds the log with the chunk line, without an explicit flush call |
| T-101 | integration | run halts (terminal) | terminal line is on disk — the crash-equivalent case |

T-092 and T-097 are load-bearing: batching that secretly writes per line reintroduces the O(n²)
cost, and a logger that throws would abort the export it exists to document.

## Implementation plan

Files: `src/core/folderlog.js` (new — injected clock + `appendText`), `src/core/orchestrator.js`
(create/flush at the existing `onStatus` and progress-write points), `src/core/i18n.js` (1 key ×
EN/AR for the truncation line), `test/folderlog.test.mjs` (new).

Slices:
1. `test/folderlog.test.mjs` T-091..T-099 → run → watch fail.
2. `folderlog.js`. 3. Orchestrator wiring + T-100/T-101. Full suite + build → commit.

## Risks & rollback

Risk: `appendText`'s whole-file copy — bounded by the 5 MB cap and the coalescing, and measured
against a merge scratch that was three orders of magnitude larger. Risk: the last ≤2 s of lines are
lost in a hard kill — inherent to any batched writer, and the alternative (per-line `close()`) costs
a full file copy per line; 2 s is the accepted trade. Risk: a flush racing a folder-permission loss
mid-run — swallowed like any other write failure. **Honest limit:** this cannot capture the very
last line before a kill, only everything up to the previous flush. Rollback: revert the commit; the
log file is inert and read by nothing.

Size: well under a day.
