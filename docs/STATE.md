# STATE — ETA Bulk Export (cleanroom)

> Chrome MV3 extension: bulk-export Egyptian ETA e-invoices/receipts past portal caps; v0.4
> milestone adds a Rejection tab, PO reconciliation analytics, real rejection windows, and
> credit/debit-note reference linkage.
> Track: STANDARD · Started: 2026-07-27 (Agent OS adopted mid-project at v0.3.0) · Client: internal

## NEXT ACTION
→ Run 30-spec.md for F-02: write docs/specs/SPEC-002-received-fetcher.md (test cases first)

## Phase gates
- [x] PLAN     · brief ✓ (user requirements captured in design spec) · PRD ✓ (superseded by design spec — brownfield adoption)
- [x] DESIGN   · architecture ✓ docs/specs/2026-07-27-rejection-tab-po-analytics-design.md + implementation plan (~/.claude/plans/atomic-forging-lovelace.md, file:line-anchored) · database n/a · api ✓ (portal endpoints catalogued in plan) · ui ✓ (tab machine + PO card in plan)
- [ ] BUILD    · all milestone features VALIDATED
- [ ] VERIFY   · test plan ✓/✗ · validation report ✓/✗ · review ✓/✗
- [ ] SHIP     · packaged zip ✓/✗ · portal smoke ✓/✗ · Web Store n/a this milestone

## Features (v0.4 milestone)
| ID | Feature | Status | Spec | Notes |
|---|---|---|---|---|
| F-01 | References linkage (credit/debit → original UUID, both sheets) | VALIDATED | SPEC-001 | T-001..T-006 green; suite 132/132; merged 972411a |
| F-02 | Shared received-details fetcher (received.js) | IDEA | — | pure refactor out of scan.js |
| F-03 | Rejection-window service (window.js + rules resolver) | IDEA | — | portal documenttypes UNVERIFIED → honest fallback |
| F-04 | PO engine (po.js: parse/match/analyze) | IDEA | — | pure, biggest test surface |
| F-05 | PO report + template renderers (po_xlsx.js) | IDEA | — | 4 RTL sheets; filename dodges Merge glob |
| F-06 | Rejection tab UI + PO card wiring | IDEA | — | tab≠source machine; i18n EN+AR same commit |

## Blockers
- none (live-verification items are post-merge follow-ups, not blockers: portal documenttypes
  capture; LIVE_REJECT_PATH capture from v0.3)

## Decisions
- Design decisions table in docs/specs/2026-07-27-rejection-tab-po-analytics-design.md
  (period basis = Submission; credit notes subtract; PO-ref-first matching; warn-never-cancel;
  per-type window badge). Pre-existing v0.3 decisions in 2026-07-27-auto-reject-design.md.
- Git adopted at v0.3.0 baseline (Agent OS git discipline; repo was previously un-versioned).

## Parking notes
- refreshLicense ungated branch (drawer.js:416) doesn't re-enable rj-scan — fix rides F-06.

## Session log
- 2026-07-27 · v0.4 design approved + plan validated; Agent OS adopted; git baseline; STATE created
