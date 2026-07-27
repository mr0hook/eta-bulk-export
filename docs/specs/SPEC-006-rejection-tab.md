# SPEC-006 — Rejection tab + PO card wiring (F-06)

**Feature:** F-06 · **Design:** design doc §1/§2 + plan "Drawer restructure"
**Requirement:** (AC-15) third top-level tab Invoices/Receipts/Rejection; the Rejection tab
hosts the Auto-Reject console (moved, card 1) and the new PO Reconciliation card (card 2);
(AC-16) tab state is separate from the export `source` — visiting Rejection never invalidates a
built export plan and never hits `SOURCES` lookups; (AC-17) PO card: upload input sheet
(bilingual headers), own From/To (default last 30 days), template download, Analyze →
fetch received+details → engine → on-screen stats + PO_Analytics workbook in the output folder;
(AC-18) rejection-window badge always states the source (ETA per-type vs fallback days) and the
Auto-Reject scan uses the resolver; (AC-19) gate/busy/Pause/Sync interplay preserved
(gate takeover; tab switch blocked mid-run; Pause aborts scan AND analyze via the shared
controller; Sync pulls back to the export view); (AC-20) full AR/EN i18n, language toggle
re-renders rejection views.

**NOT in this spec:** live rejection submission (still dry-run, v0.3 spec); portal documenttypes
verification (post-merge live capture); receipts anything.

## Test cases

UI has no DOM harness; per 31-build the markup/handlers are thin glue over the tested engines
(SPEC-002..005). The enforcement net that MUST stay green (CI-equivalent `npm test`):
i18n.test (new keys EN↔AR parity + params + non-empty), shadows.test (no import shadowing in
mountUI), full suite. Plus:

| ID | Level | Check | Expected |
|---|---|---|---|
| T-036 | build | `npm run build` + grep dist | bundle contains `view-rejection`, `po-analyze`, `PO_Analytics_` markers |
| T-037 | package | `npm run package` | version-sync guard passes; zip produced |
| T-038 | manual (portal smoke — VERIFY phase, user-run) | gate takeover on Rejection tab while unlicensed; tab switch blocked mid-run; Pause aborts an analyze; Sync returns to export view; language toggle re-renders RTL; report opens in Excel; Merge ignores + Repair preserves PO_Analytics_*; template downloads and re-uploads cleanly | per item |

## Implementation slices

1. i18n keys EN+AR (ui.rejection, ui.capRejection, ft.rejTab, rej.winApi/winCfg, po.*).
2. Tab machine: `tab` state, data-tab seg buttons + third button, selectTab(), renderCap(),
   #view-export / #view-rejection containers, Auto-Reject card moved (renumber 5→1),
   Sync → selectTab, log-copy header tab-aware, applyLang re-renders.
3. PO card markup (ids po-pick/po-file/po-status/po-from/po-to/po-template/po-analyze/po-note/
   po-sum) + rj-winsrc badge; setBusy/refreshLicense coverage in BOTH license branches (also
   fixes the parked v0.3 gap: ungated branch didn't re-enable rj-scan).
4. Handlers: file parse (reset input value after read), template write (permission inside the
   gesture), analyze flow (license → ensureDir+ensurePermission FIRST → busy + shared rjCtrl →
   loadWindows → badge → fetchReceivedDetails → projectInvoice+analyzePo(makeResolver) →
   renderPoAnalytics → writeBlob → stats + log); rj-scan gains loadWindows + resolver.
5. Full suite + build + package; STATE.md/VERIFY updates.

## Risks & rollback
Riskiest slice is the markup surgery (2): guarded by manual smoke + the fact that export
sections move as an unmodified block. Rollback: revert merge commit (engines stay — they have
no other consumers). Size: ~1 focused day.
