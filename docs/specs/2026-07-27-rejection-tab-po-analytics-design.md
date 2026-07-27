# v0.4 Design — Rejection Tab · PO Reconciliation · Real Rejection Window · References Linkage

**Status:** Approved design (brainstorm-checked) · **Prior art:** `2026-07-27-auto-reject-design.md` (v0.3)
**Implementation plan:** `~/.claude/plans/atomic-forging-lovelace.md` (validated against source, file:line anchored)

## What & why

Four upgrades to the ETA Bulk extension, requested after v0.3 shipped the Auto-Reject console:

1. **Rejection is a first-class tab.** The drawer gets Invoices / Receipts / Rejection. The
   Rejection tab hosts the existing Auto-Reject console plus the new PO Reconciliation card.
   Internally the active tab is tracked separately from the export `source` — 'rejection' is a
   view, not an export source (a source key would crash `SOURCES` lookups and invalidate built
   export plans).
2. **PO reconciliation analytics.** The user uploads an input Excel — Company Name, Registration
   Number (supplier TIN), PO Number, PO Total Amount, PO Valid From, PO Valid To (bilingual
   headers accepted; downloadable template provided) — picks a search period, and the tool fetches
   received Valid invoices with details and reports:
   - invoices per supplier (count + totals),
   - per-invoice PO match — invoice `purchaseOrderReference` → PO Number first, else supplier TIN
     + issue date inside PO validity; unmatched → warning,
   - **out-of-PO-period invoices are WARNINGS, never rejections/cancellations,**
   - PO utilization: consumed vs. PO total, warning when exceeded,
   - per-invoice rejection-window status: *can still reject* vs. *window passed — request a credit
     note from the seller* vs. *unknown* (unverifiable timestamp).
   Output: on-screen summary + `PO_Analytics_<date>_<time>.xlsx` (4 Arabic RTL sheets: Summary,
   POs, Suppliers, Invoices) written to the output folder.
3. **Real rejection window.** A window service fetches the portal-origin
   `documenttypes` / `documenttypes/{id}` (`workflowParameters`) through the existing hardened
   API client, parses the per-document-type receiver-rejection window, caches it (7d success /
   1d failure), and falls back to the user-configurable day count. The integration API URL
   (`api.invoicing.eta.gov.eg`) is unreachable from the extension by design (origin guard,
   host_permissions, portal CSP, OAuth2) — the portal path is the only viable route and its shape
   is unverified, so the parser never throws and the UI always shows the window source.
4. **Credit/debit → original invoice linkage.** The summary-sheet `الرقم المرجعي` column already
   exists (comma-joined `references` UUIDs, blank when absent); this completes it: same column on
   the per-line sheet, placement before `signature`, multi-reference + merge-union tests.
   Invoices only — receipts carry no references.

## Decisions (user-approved)

| Decision | Choice |
|---|---|
| Analytics search-period basis | **Submission date** (same proven fetch path as the Auto-Reject scan); PO-validity checks still use the invoice **issue date** |
| Credit notes in PO utilization | **Subtract** (net consumption; mirrors the export's negativeCredit treatment) |
| PO match precedence | `purchaseOrderReference` = PO Number (TIN-preferring tiebreak) → TIN + issue date in validity (lowest validFrom on ambiguity, warned) → unmatched warning |
| Out-of-period handling | Warning only — never feeds the reject flow |
| Analytics delivery | On-screen + Excel report |
| Window-source badge | "ETA (per type)" vs "{days}d fallback" — no single day-count when per-type values differ; exact per-type days appear in the report Summary sheet |

## Design corrections from the check pass

- `poKeyOf` normalization (was undefined): NFC → trim → collapse internal whitespace → uppercase;
  when one side is purely numeric, compare digits-only.
- Default analytics period: **30 days** (was 90 — heavy receivers would hit the 2,000-doc scan cap
  immediately; the TOO_MANY error still guides narrowing).
- Window badge is per-type-aware (see table above).

## Architecture (units & boundaries)

- `src/reject/received.js` — shared period fetcher (probe→rows→details), extracted from scan.js;
  consumed by both the Auto-Reject scan and PO analytics. Throws BAD_RANGE / TOO_MANY / STOPPED.
- `src/reject/window.js` — window service: pure `parseWorkflowWindows` (never throws), cached
  `loadWindows` (never throws except STOPPED), pure `makeResolver(loaded, cfg)`.
- `src/reject/po.js` — pure PO engine: cell coercion (Date-UTC/serials/richText/formula/string
  dates), bilingual tolerant `headerMapOf`, `parsePoWorkbook` (IO-free), `matchInvoice`,
  `analyzePo` (ordered utilization, credit-negative, window status, aggregates, fetch-failure
  counting — fail-closed reporting).
- `src/reject/po_xlsx.js` — report + template renderers (xlsx.js house style; `cleanRow` on every
  row so Repair never rewrites the report; filename dodges the Merge glob).
- `rules.js` gains injected `ctx.resolveWindow` (purity kept); scan.js threads it through.
- Drawer: `tab` state machine, `#view-export` / `#view-rejection` containers, PO card, window
  badge; gate/busy/Pause/Sync interplay preserved (Pause aborts analytics via the shared
  controller; Sync returns to the export view).

## Non-goals

Receipts rejection/references · automatic rejection of out-of-period invoices · live rejection
submission (still dry-run gated behind endpoint capture, per v0.3 spec) · multi-sheet PO
workbooks (first worksheet only).

## Verification

All existing suites green untouched (parity/serialize/merge/i18n/shadows/reject) + new suites:
references, received, window, po, po_xlsx. Manual portal smoke: gate takeover on the Rejection
tab, tab switching blocked mid-run, Pause aborts analyze, language toggle re-renders RTL, Merge
ignores / Repair preserves `PO_Analytics_*`. Live follow-ups: capture the portal documenttypes
response (freeze as fixture), round-trip a real PO sheet.
