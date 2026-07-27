# Auto-Reject (Scan → Review → Confirm) — Design

**Status:** Approved 2026-07-27 · **Origin:** eta-agent (Tahaqquq) Decision Engine spec, adapted for the ETA Bulk extension.

## Goal

A new drawer panel that scans **Received, Valid invoices** in a date range, evaluates each against
user-configured criteria rules, and produces a review list. The user ticks/unticks matches and
confirms; the tool then submits receiver rejections to the portal, one per document, with an
audit trail. Nothing is ever rejected without the explicit confirm click.

## Decisions (user-approved)

- **Automation level:** scan → review → bulk confirm. Never fully automatic.
- **Criteria v1:** issuer allow/block list · amount thresholds · VAT recompute mismatch · duplicates + doc-type filter.
- **Reasons:** auto-filled from the fired rule (AR/EN template), editable per row before confirm.
- **Fail-closed** (from the Tahaqquq spec): a document is pre-ticked only when a hard rule fired
  deterministically on verified data. Missing data, fetch failures, or allow-list mode produce
  un-ticked *flag* rows. Ambiguity never becomes an automatic rejection.
- **Dry-run first release:** the live portal rejection endpoint is not yet captured. `submit.js`
  ships with `LIVE_REJECT_PATH = ''` → all confirms run the full pipeline but simulate the final
  call and say so in the UI. Wiring the real path (captured once from DevTools while rejecting one
  document manually on the portal) is a one-line change.

## Modules

- `src/reject/rules.js` — pure rule engine. `normalizeCfg(raw)`, `defaultCfg()`,
  `evaluateDoc(cfg, detail, ctx)` → `{ verdict: 'reject'|'flag'|'pass', eligible, firings, dupKey }`.
  Rules: ISSUER-BLOCKED (reject) / ISSUER-NOT-ALLOWED (flag) · AMOUNT-OVER / AMOUNT-UNDER (reject)
  · VAT-MISMATCH (reject) / VAT-UNVERIFIABLE (flag) · DUP (reject) · TYPE-DISALLOWED (reject)
  · DATA-MISSING (flag). Eligibility: rejection window (`windowDays`, default 14) computed from
  `dateTimeRecevied` (the API's real spelling) — expired docs are listed but not tickable.
- `src/reject/scan.js` — `scanReceived({ from, to, cfg, hooks })`. Uses `SOURCES.invoices`,
  Direction=Received, Submission date field, server Status=Valid. Probe first; refuse > 2000 docs
  (narrow the range). Fetches **details for every candidate** (12-way `mapLimit`) so every rule
  reads canonical fields; a failed detail fetch yields a flag row, never a guess. Duplicate keys
  (`issuerId|internalID|totalAmount`) persist across scans in `etaBulk_arSeen` (capped).
- `src/reject/submit.js` — `submitRejections(items, { dryRun, onItem, signal })`; per-item retry
  (3 attempts, backoff, 429-aware), origin-guarded to the portal API origin; one failure never
  aborts the batch. Audit records appended to `etaBulk_arAudit` (last 20 runs), copyable as JSON.
- `src/ui/drawer.js` — section 5 card "Auto-Reject": collapsible criteria settings (persisted in
  `etaBulk_arCfg`), its own From/To (default last 14 days), Scan button, review list (DOM built
  with `textContent` — document data is untrusted), editable per-row reason, confirm button
  showing the exact count, per-row results, audit copy. Shares `setBusy` with the exporter so
  scans and exports can't overlap. Registration gate applies (panel lives inside `#main`).
- `src/core/i18n.js` — `ar.*` keys, EN + AR.

## Testing

`test/reject.test.mjs` (node:test): rule evaluation per criterion, fail-closed paths (missing
lines, missing fields), dup keying within and across scans, cfg normalization from garbage,
verdict precedence, window eligibility, dry-run submit results + audit shape.

## Non-goals (v1)

Risk-score weighting, LLM narration, scheduled scans, receipts, automatic (no-review) rejection.
