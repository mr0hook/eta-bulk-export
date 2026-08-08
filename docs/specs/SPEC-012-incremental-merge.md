# SPEC-012 — Incremental merge (F-13)

**Feature:** F-13 · **Requirement source:** user directive 2026-08-08 — *"we have resync feature to
redownload data again to only get what we didn't get on last run can we make same thing on the
merger if i usually create daily download or monthly or weekly"*.

## Diagnosis

Merge is all-or-nothing. Every press re-reads **every** chunk file in the folder and rewrites
**every** output part, however little changed. After `sync` adds one day's chunks, a 200k-invoice
folder still pays the full cost.

There is a second, quieter defect. The output name embeds a timestamp
(`${prefix}_COMBINED_${stamp}.xlsx`, `merge.js:25,68`) and the input glob excludes anything matching
`/COMBINED/i` (`merge.js:21`). So each merge writes a **complete new dated set and abandons the
previous one**. A user merging daily accumulates one full duplicate output set per day, and none of
them is identifiably "the current one".

**Requirement (AC-12):** after a sync that adds N new chunk files, a merge must read only those N
files and rewrite only the part(s) they affect, while the folder holds exactly one COMBINED set
whose serial numbering and dedup are indistinguishable from a full rebuild.

## Design

### Stable names

The master set drops the timestamp: `eInvoices_COMBINED.xlsx`, `eInvoices_COMBINED_part2.xlsx`, …
Stable names are what let untouched parts genuinely stay untouched, and they end the daily pile-up.
Pre-existing dated sets are **never deleted** — they are logged once as superseded so the user can
remove them deliberately.

### State

`eta_merge_state.json`, beside `eta_progress_*.json`:

```json
{ "v": 1, "prefix": "eInvoices", "updatedAt": "...",
  "consumed": [ { "name": "eInvoices_2026_Sent_….xlsx", "size": 918273 } ],
  "sumCols": ["مسلسل", "..."], "lineCols": ["..."],
  "sheetNames": { "s0": "جميع الفواتير", "s1": "بيانات الفواتير" },
  "nextSerial": 17201,
  "parts": [ { "name": "eInvoices_COMBINED.xlsx", "sum": 12000, "line": 58200 } ],
  "uuids": ["...", "..."] }
```

`uuids` is the cross-run dedup set — without it an incremental pass cannot tell a genuinely new
invoice from one merged last week. ~8 MB per 200k invoices; written once per merge. Deleting the
file costs exactly one full re-merge and nothing else.

### Mode selection

| Condition | Mode |
|---|---|
| No state file, or `v` mismatch, or prefix mismatch | **full** |
| A consumed file is now missing, or its size changed | **full** |
| A part named in `parts` is missing from the folder | **full** |
| New chunk files introduce a column not already in the unions | **full** (detected mid-run, restarts) |
| Otherwise, and new chunk files exist | **incremental** |
| Otherwise, and none exist | **up to date** — writes nothing |

Every non-obvious mode choice is logged with its reason. Column drift is the case that really
happens (SPEC-008 added `رقم الفاتورة الأصلية` mid-corpus); rebuilding keeps every part's headers
uniform, which is the property that makes the parts one dataset.

### Incremental pass

1. Seed `seen` from `state.uuids`; seed the column unions from `state.sumCols` / `state.lineCols`.
2. Phase 1 over **new files only**, streaming to the same scratch JSONL as F-10 (one held writable,
   removed in a `finally`).
3. If the unions grew → abandon, log the column name, restart in full mode. Nothing has been written
   to the output set at this point, so the restart is clean.
4. Phase 2 opens the **last** part, re-applies the RTL view (not trusted to survive a load/save
   round-trip), and appends until the caps, then spills into new parts. Serial continues from
   `state.nextSerial`. Earlier parts are never opened.
5. State is written **only after every part has landed**, so a crash mid-merge leaves the previous
   state intact and the next merge re-does that increment rather than skipping it.

Memory: topping up a part loads at most one part's rows, which F-10 already bounded to ~72k rows /
~950 MB peak. The caps are unchanged and still binding.

**NOT in this spec:** period-labeled part names (F-14, next); deleting superseded dated sets;
merging across two folders; changing the dedup rule (still first-file-wins by UUID).

## Test cases (`test/mergestate.test.mjs` + additions to `test/merge.test.mjs`)

| ID | Level | Given / When / Then | Expected |
|---|---|---|---|
| T-103 | unit | full merge on a fresh folder | state written: consumed, uuids, nextSerial, parts, unions |
| T-104 | unit | merge, then merge again with no new files | **up to date**; not one output byte rewritten |
| T-105 | integration | merge, add a new chunk file, merge | only the new invoices appended; earlier parts byte-identical |
| T-106 | integration | as above | serial continues unbroken across the increment |
| T-107 | integration | new file repeats an already-merged UUID | deduped against state — appears once, not twice |
| T-108 | integration | new file carries a NEW column | full rebuild; **every** part ends with identical headers |
| T-109 | integration | a consumed chunk file changed size | full rebuild (its rows may have changed) |
| T-110 | integration | a part file was deleted by the user | full rebuild |
| T-111 | integration | state file deleted | full rebuild reproducing the same rows as a never-incremental merge |
| T-112 | integration | increment overflows the last part's cap | spills into a new part; no rows lost at the boundary |
| T-113 | unit | corrupt / wrong-version state file | treated as absent → full; never throws |
| T-114 | integration | output names | stable, timestamp-free; a second merge does not create a second dated set |

T-105 and T-111 are load-bearing: the first proves work is actually skipped, the second proves the
fast path cannot drift from the slow one.

## Implementation plan

Files: `src/core/mergestate.js` (new — read / write / decide-mode, pure), `src/core/merge.js`
(stable names, seeded unions + `seen`, top-up path, mode logging), `src/core/i18n.js` (~5 keys ×
EN/AR), `test/mergestate.test.mjs` (new), `test/merge.test.mjs` (incremental cases).

Slices:
1. `test/mergestate.test.mjs` T-103/T-104/T-113 → fail. 2. `mergestate.js`.
3. Stable names + state writing on the full path (T-114, T-103). 4. Incremental path
(T-105..T-112). Full suite + build → commit.

## Risks & rollback

Risk: the UUID list makes the state file large — bounded by invoice count, written once per merge,
and disposable. Risk: an incremental pass silently diverging from a full rebuild — T-111 pins them
together, and every invalidation defaults to full rather than to clever. Risk: users who relied on
dated COMBINED sets as history lose that on new merges — the old sets are left in place, and history
was never the intent (they were abandoned duplicates). Risk: a crash between writing the last part
and the state file re-does one increment — chosen deliberately over the alternative, skipping it.
Rollback: revert; delete `eta_merge_state.json`; the next merge is a normal full merge.

Size: about a day.
