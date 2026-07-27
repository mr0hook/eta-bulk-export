# SPEC-004 — PO reconciliation engine (F-04)

**Feature:** F-04 · **Design:** design doc §2 + plan "New modules §1d" + check-pass corrections
**Requirement:** pure, node-tested engine that (AC-08) parses the uploaded PO workbook with
tolerant bilingual headers and messy cell values, (AC-09) matches received invoices to POs —
`purchaseOrderReference` first, TIN+issue-date-in-validity fallback, deterministic tiebreaks —
(AC-10) produces analytics: per-invoice warnings (out-of-period = WARNING ONLY), PO utilization
with credit notes subtracting and over-consumption flagged, per-supplier aggregates, totals with
fail-closed fetch-failure counting, and (AC-11) per-invoice rejection-window status
(can-reject / window-passed / unknown) via the SPEC-003 resolver.

**NOT in this spec:** workbook rendering (F-05), any DOM/network (engine is IO-free — caller
loads the ExcelJS workbook), multi-sheet PO files (first worksheet only).

## Test cases (`test/po.test.mjs`; parse tests use real ExcelJS input workbooks via devDependency)

| ID | Level | Given / When / Then | Expected |
|---|---|---|---|
| T-021 | unit | EN headers; AR headers with tatweel/أ-إ-آ/ى variants and extra spaces; headers missing TIN or PO Number | header map resolves both languages; PO_HEADERS error lists the missing canonical fields |
| T-022 | unit | cells as: UTC Date, 'YYYY-MM-DD', 'DD/MM/YYYY', Excel serial, richText, {formula,result}, number-with-commas string | coercions produce ymd strings / numbers / trimmed text |
| T-023 | unit | real workbook rows incl. duplicate tin+PO and rows missing amount or dates | first-wins + PO-DUP; PO-NO-AMOUNT / PO-NO-DATES row warnings; TINs digits-only |
| T-024 | unit | poKeyOf on ' po-100 ', 'PO-100', 'po 100', numeric 100 vs '100' | case/space-insensitive equality; digits-only equality when one side is purely numeric |
| T-025 | unit | invoice with purchaseOrderReference matching two POs (different TINs) | 'po-ref' match; TIN-matching PO preferred |
| T-026 | unit | no PO ref → TIN+period unique / ambiguous / none; PO ref present but unknown → tin-period fallback + PO-REF-UNKNOWN | 'tin-period' + (PO-AMBIGUOUS lowest-validFrom on ties) / 'none' + NO-PO-MATCH / fallback warned |
| T-027 | unit | 'po-ref' matched but issue date outside validity | match kept; OUT-OF-PO-PERIOD warning only |
| T-028 | unit | PO total 1000; invoices 600, 500, then credit note 300 (issue-date order) | exceeded fires on the 500 (1100>1000) and later docs; credit subtracts → utilized 800; remaining/utilizationPct correct |
| T-029 | unit | mixed corpus + fetchFailed=2 | per-supplier counts/totals/matched/unmatched/warnings; totals { invoices, matched, unmatched, warnings, exceededPos, fetchFailed:2 } |
| T-030 | unit | received 2d ago with resolver 3d → can-reject (daysLeft 1); 20d ago cfg 14 → window-passed; missing/future receivedIso → unknown | per case; resolver receives the invoice's type |

## Implementation plan

Files: `src/reject/po.js` (new), `test/po.test.mjs` (new). No new deps (ExcelJS already a
devDependency for tests; production uses window.ExcelJS — caller-side, F-06).

Exports: `cellText`, `cellNumber`, `cellYmd`, `headerMapOf`, `parsePoWorkbook(wb)`,
`poKeyOf`, `projectInvoice(o)`, `matchInvoice(pos, inv)`,
`analyzePo(pos, invoices, { resolveWindow, windowDays=14, nowMs, fetchFailed=0 })`.
Shapes per plan §1d. Warning ids: PO-DUP, PO-NO-AMOUNT, PO-NO-DATES, NO-PO-MATCH,
PO-AMBIGUOUS, PO-REF-UNKNOWN, OUT-OF-PO-PERIOD, PO-EXCEEDED.

Slices: (1) po.test.mjs T-021..T-030 red → (2) po.js green, full suite → commit.

## Risks & rollback
Engine is additive and pure — no existing consumer until F-06; rollback = revert commit.
Money compared with a 0.005 epsilon; amounts stay JS numbers for display-grade analytics (the
export pipeline precedent), NOT for accounting postings. Size: ~1 focused day.
