# SPEC-001 — References linkage: credit/debit note → original invoice UUIDs (F-01)

**Feature:** F-01 · **Design:** 2026-07-27-rejection-tab-po-analytics-design.md §4
**Requirement:** the user must see, in the normal Excel export, which original invoice(s) a
credit/debit note refers to (`o.references` UUIDs), on BOTH the summary and per-line sheets,
blank-safe when absent. (AC-01: linkage visible on summary sheet — partially shipped in v0.3;
AC-02: linkage visible on line sheet; AC-03: empty/absent handled — blank cell, no column when
no doc has references.)

**NOT in this spec:** receipts (no references concept in ETA receipt /details); UI changes;
Columns-chips registration (column stays dynamic like all sparse v62 fields); PO analytics.

## Test cases (before implementation — file `test/references.test.mjs`, local fixtures; do NOT
touch `test/fixtures.mjs`, parity.test pins it)

| ID | Level | Given / When / Then | Expected |
|---|---|---|---|
| T-001 | unit | credit note with `references: ['A','B']` → renderInvoices | summary row `referenceUUID === 'A, B'` |
| T-002 | unit | same corpus | line sheet HAS a `referenceUUID` column AND every line row of that note carries `'A, B'` |
| T-003 | unit | same corpus | line col sits immediately before `uuid`; summary col sits immediately before `signature` (not appended after `url`) |
| T-004 | unit | corpus where NO doc has references | neither sheet has a `referenceUUID` column; rows carry no such key |
| T-005 | unit | `references: ['A', null, '', 'B']` | joined value `'A, B'` (falsy entries filtered) on both sheets |
| T-006 | integration (merge) | old part file without `الرقم المرجعي` in the LINE sheet + new part with it → mergeFolder | merged line sheet contains the header; old-file rows render `''` there (model merge.test.mjs:46-78) |

## Implementation plan

Files: `src/export/xlsx.js` (3 edits), `test/references.test.mjs` (new), `test/merge.test.mjs`
(extend with T-006). No new deps, no API/schema changes outside the design doc.

Slices:
1. `test/references.test.mjs` with T-001..T-005 + merge T-006 → run → watch fail (T-002/T-003/T-006 must fail; T-001 passes already — asserted anyway as regression).
2. xlsx.js: (a) line 163 `sumCols.push` → `insertBefore(sumCols, 'signature', …)`; (b) after
   line 161 add line-sheet conditional col `insertBefore(lineCols, 'uuid', …)`; (c) after line
   235 add `lr.referenceUUID` join. Full suite green → commit.

## Risks & rollback
Risk: ExcelJS silently drops row keys without col defs (xlsx.js:153-155) — covered by T-002.
Neighbor risk: parity.test.mjs pins summary behavior (presence + join + undefined) — asserts
nothing about position, so the move is safe; full suite is the gate. Rollback: revert commit.

Size: well under a day.
