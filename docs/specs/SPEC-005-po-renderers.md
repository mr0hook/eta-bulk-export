# SPEC-005 — PO analytics report + input template renderers (F-05)

**Feature:** F-05 · **Design:** design doc §2 delivery + plan "Analytics workbook §3"
**Requirement:** (AC-12) a 4-sheet Arabic RTL analytics workbook rendered from a SPEC-004
`analysis` object in the exact xlsx.js house style (frozen header, thin borders, status fills,
`cleanRow` on every row so Repair never rewrites the report); (AC-13) a downloadable input
template whose headers OUR OWN parser accepts (round-trip guarantee); (AC-14) a report filename
that can never be swallowed by Merge (`/^e(Invoices|Receipts)_/`) or collide with `COMBINED`,
and contains no characters Windows rejects.

**NOT in this spec:** drawer wiring / writeBlob (F-06); i18n catalog keys (workbook headers are
Arabic constants like xlsx.js, not i18n).

## Test cases (`test/po_xlsx.test.mjs`; structure via the parity-style mock, serialization via real ExcelJS)

| ID | Level | Given / When / Then | Expected |
|---|---|---|---|
| T-031 | unit | renderPoAnalytics(mock, analysis, meta) | 4 sheets الملخص/أوامر الشراء/الموردون/الفواتير, RTL views everywhere, autoFilter on the 3 tabular sheets, summary carries period/version/window-source/fetchFailed rows |
| T-032 | unit | analysis with exceeded PO, warned invoice, clean matched invoice | PO row fill = bad on exceeded; invoice fills: bad on PO-EXCEEDED, debit on other warnings, valid on clean matched; window column shows متاح الرفض / انتهت النافذة — اطلب إشعار دائن من البائع / غير مؤكد |
| T-033 | integration | renderPoTemplate(real ExcelJS) → writeBuffer → load → parsePoWorkbook | parses cleanly: 1 example PO, digits-only TIN, ymd dates, no row warnings |
| T-034 | unit | poAnalyticsName(fixed Date) | starts `PO_Analytics_`, ends `.xlsx`, no `:`, fails merge glob and /COMBINED/i |
| T-035 | integration | supplier name with U+FFFE in analysis → real ExcelJS write→load | loads fine; no cell string contains U+FFFE/U+FFFF (cleanRow applied) |

## Implementation plan

Files: `src/reject/po_xlsx.js` (new), `test/po_xlsx.test.mjs` (new). Imports from
`../export/xlsx.js`? No — RTL/THIN/FILL/solid are module-private there; po_xlsx.js declares its
own identical constants (copying 6 lines beats exporting private style guts) plus `cleanRow`
from `../export/sanitize.js` and `dateEg` from `../export/dates.js`.

Exports: `renderPoAnalytics(ExcelJS, analysis, meta)` → `{ workbook }`;
`renderPoTemplate(ExcelJS)` → `{ workbook }`; `poAnalyticsName(now: Date)`;
`WARN_AR` / `WINDOW_AR` label maps (exported for the drawer's on-screen rows in F-06).
meta = `{ from, to, generatedAt (ISO string), version, windowSource: 'api'|'config', windowDays }`.

Slices: (1) tests red → (2) implementation green, full suite → commit.

## Risks & rollback
Additive module, no consumers until F-06 — rollback = revert commit. The template/parser
round-trip (T-033) is the guard against the two drifting apart. Size: ~3 hours.
