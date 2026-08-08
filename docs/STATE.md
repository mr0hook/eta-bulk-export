# STATE — ETA Bulk Export (cleanroom)

> Chrome MV3 extension: bulk-export Egyptian ETA e-invoices/receipts past portal caps; v0.4
> milestone adds a Rejection tab, PO reconciliation analytics, real rejection windows, and
> credit/debit-note reference linkage.
> Track: STANDARD · Started: 2026-07-27 (Agent OS adopted mid-project at v0.3.0) · Client: internal

## NEXT ACTION
→ User-run overnight smoke: remove/re-add the extension, reload the portal tab, start a long run
and leave it overnight. Next morning, read the run log and report which happened — (a) it ran
clean through, (b) `⏳ Portal session running low` lines appear and it recovered, or (c) it sat
waiting and resumed only after login. That answers whether the ETA session is idle-sliding or
absolute-capped (SPEC-009 is honest that only an overnight run can tell). Fold the SPEC-006 T-038
portal smoke + the documenttypes/LIVE_REJECT_PATH DevTools captures into the same session.

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
| F-02 | Shared received-details fetcher (received.js) | VALIDATED | SPEC-002 | T-007..T-012; reject.test untouched; 138/138 |
| F-03 | Rejection-window service (window.js + rules resolver) | VALIDATED | SPEC-003 | T-013..T-020; source:'config' fallback until live capture; 146/146 |
| F-04 | PO engine (po.js: parse/match/analyze) | VALIDATED | SPEC-004 | T-021..T-030; 156/156 |
| F-05 | PO report + template renderers (po_xlsx.js) | VALIDATED | SPEC-005 | T-031..T-035; template↔parser round-trip guarded; 161/161 |
| F-06 | Rejection tab UI + PO card wiring | TESTING | SPEC-006 | suite green + build + package (T-036/T-037); T-038 manual portal smoke pending (user-run) |
| F-07 | Credit notes export every figure negative | VALIDATED | SPEC-007 | T-039..T-048; also fixed a latent defect that negated T4 on PLAIN invoices; merged ed6c14c |
| F-08 | Note reference → original invoice NUMBER | VALIDATED | SPEC-008 | T-049..T-059; free from the corpus, cached lookup otherwise; merged 0a18559 |
| F-09 | Overnight session keep-warm | TESTING | SPEC-009 | T-060..T-071 green; unit-complete, but only an overnight run can confirm the real cause — user smoke pending |

## Blockers
- none (live-verification items are post-merge follow-ups, not blockers: portal documenttypes
  capture; LIVE_REJECT_PATH capture from v0.3)
- open question, not a blocker: whether the ETA portal session is idle-sliding (SPEC-009 fixes it)
  or absolute-capped (SPEC-009 only makes it survivable). Answered by the overnight smoke above.

## Decisions
- Design decisions table in docs/specs/2026-07-27-rejection-tab-po-analytics-design.md
  (period basis = Submission; credit notes subtract; PO-ref-first matching; warn-never-cancel;
  per-type window badge). Pre-existing v0.3 decisions in 2026-07-27-auto-reject-design.md.
- Git adopted at v0.3.0 baseline (Agent OS git discipline; repo was previously un-versioned).

## Parking notes
- (resolved) refreshLicense ungated-branch rj-scan gap — fixed in F-06.

## Session log
- 2026-07-27 · v0.4 design approved + plan validated; Agent OS adopted; git baseline; STATE created
- 2026-07-27 · F-01..F-06 built spec-first (SPEC-001..006, T-001..T-038); suite 126→161 green;
  v0.4.0 packaged (eta-bulk-export-v0.4.0.zip); remaining: user portal smoke + live captures
- 2026-08-08 · F-07..F-09 built spec-first from three user directives (credit-note signs, note→
  original invoice number, overnight logout). Suite 161→194 green; v0.4.0 repackaged. Two
  behaviour changes worth remembering: credit-note T4 withholding is now negated (parity.test:94
  deliberately re-pinned), and a run now waits up to 8 h for a token instead of 15 min.
