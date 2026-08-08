# SPEC-013 — Period-labeled, day-aligned COMBINED parts (F-14)

**Feature:** F-14 · **Requirement source:** user directive 2026-08-08 — *"if detalied get more than
1m row it can be splitted and log splitting period to the tool log and the summary sheet also use
same idea"*.

## Framing correction (recorded because it changes what this feature is)

Two parts of the request were already true, and one premise was wrong:

- **Two sheets already exist and already split together.** A part holds the summary sheet and the
  line sheet for the *same* invoices, so any split covers both — there is nothing to add.
- **The 1,048,576-row Excel limit is unreachable.** A part is capped at ~60k line rows because the
  vendored browser ExcelJS has no streaming writer and a whole part lives in memory until
  `writeBuffer()` (SPEC-012 / F-10 benchmarks: 72k rows ≈ 950 MB peak, 90k rows OOMs). Memory binds
  roughly 14× tighter than Excel's row limit, so splitting never waits for 1M rows.

What survives — and is genuinely valuable — is the part underneath: **each part should say which
period it covers**, in its name and in the log, so the folder is readable without opening anything.

**Requirement (AC-13):** every COMBINED part states the date range it contains, no two parts claim
the same day, and each split is announced in the run log with the day it occurred on.

## Design

### Naming

`eInvoices_COMBINED_2026-01-01_2026-03-15.xlsx`. Derived from the min/max of `تاريخ الإصدار` — the
same Arabic header in both the invoice and receipt schemas. If that column was excluded by the user,
parts fall back to SPEC-012's `_partN` names and nothing else changes.

Two parts can legitimately cover the same single day (a day larger than one part's cap), which would
collide on one filename; the second gets a `_p{n}` suffix.

`DATED_RE` — which flags the pre-SPEC-012 abandoned sets as superseded — is anchored on the ISO
timestamp shape (`…T14-55-21-919Z`) so these period names are never mistaken for them.

### Day alignment

Splitting is still driven by the memory caps, but a record belonging to the day the current part
already ends on **stays in that part** rather than starting a new one. Otherwise two parts would
both claim e.g. `2026-03-15` and the labels would be lies.

This is bounded: the allowance stops at `1.5 ×` the cap, after which the part splits mid-day
regardless. The cap exists to keep a part inside browser memory, and one enormous day must not be
able to defeat it.

### Ordering

Input files are sorted by name before Phase 1. Chunk filenames embed the date label, so name order
tracks date order within a run — consecutive parts then cover consecutive ranges instead of
interleaving. This is an approximation, not a guarantee: it is cheap and it is what makes the labels
readable. A true global sort would mean externally sorting a multi-GB scratch file, which is not
worth it for a label.

### Interaction with incremental merge

Topping up the last part can widen its period and therefore change its filename. The new file is
written and **the old name removed**, or the folder would accumulate two copies of the same part
under two date ranges. Only the last part can ever be renamed; earlier parts are never reopened.

**NOT in this spec:** sorting the scratch file globally; splitting on month or quarter boundaries;
re-labelling the old timestamped sets; adding a period row inside the sheets themselves.

## Test cases (`test/mergeperiod.test.mjs`)

| ID | Level | Given / When / Then | Expected |
|---|---|---|---|
| T-115 | unit | invoices spanning Jan–Mar | filename carries `2026-01-05_2026-03-11` |
| T-116 | unit | cap forces several splits | each split logged with its day, size; each part logs its range |
| T-117 | unit | 3 invoices on ONE day, cap of 2 | that day is not cut — no day appears in two parts' ranges |
| T-118 | unit | 20 invoices on one day, cap of 4 | still splits — the memory cap outranks day alignment; nothing lost |
| T-119 | integration | increment extends the last part's period | file renamed, **no** stale copy left behind |
| T-120 | unit | issue-date column excluded | falls back to `_partN`; merge still works |
| T-121 | unit | `DATED_RE` | period names not matched; old timestamped names matched |

T-118 and T-119 are load-bearing: the first proves day alignment can't defeat the memory bound that
keeps merge from crashing, the second proves renaming can't silently duplicate a part.

## Risks & rollback

Risk: near-chronological input ordering is an approximation — a folder whose chunk names don't sort
by date produces wider, overlapping-looking ranges. The labels stay truthful (they are computed from
actual rows), they are just less tidy. Risk: a day slightly larger than the cap makes one part up to
1.5× the normal size — deliberately bounded and still inside the measured memory envelope. Risk:
users scripting against `eInvoices_COMBINED.xlsx` see period names instead — noted here as a
behaviour change; the fallback name only appears when the date column is absent. Rollback: revert;
`combinedName` returns to numbered parts and state carries the extra `from`/`to` fields harmlessly.

Size: half a day.
