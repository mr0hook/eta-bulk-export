# STATE — ETA Bulk Export (cleanroom)

> Chrome MV3 extension: bulk-export Egyptian ETA e-invoices/receipts past portal caps; v0.4
> milestone adds a Rejection tab, PO reconciliation analytics, real rejection windows, and
> credit/debit-note reference linkage.
> Track: STANDARD · Started: 2026-07-27 (Agent OS adopted mid-project at v0.3.0) · Client: internal

## NEXT ACTION
→ USER SMOKE TEST, then package v0.4.1. F-10..F-15 are all code-complete and unit-green (252/252)
but NONE has been exercised against real portal data. Load the rebuilt extension and, in one
session: (1) Merge the big folder that used to fail — confirm it completes and leaves no .jsonl;
(2) Merge again immediately — must say "Already up to date" and write nothing; (3) sync a day, merge
— must say "Incremental" and rewrite only the last part; (4) point the tool at a folder belonging to
a DIFFERENT company — must refuse and name the owner; (5) kill the tab mid-run and check
eta_runlog_*.log holds the narrative; (6) MOST IMPORTANT — open both COMBINED files in real Excel.
F-15 replaced ExcelJS with our own xlsx writer for merge output, so Excel's own verdict is the one
test the suite cannot run. Report anything that differs. Only then bump the version and package.

Parked (user smoke, not blocking): overnight smoke below; plus confirm the F-10 merge fix against
the real big folder that used to fail.

→ (parked) User-run overnight smoke: remove/re-add the extension, reload the portal tab, start a long run
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
| F-10 | Merge survives big folders + never strands scratch files | VALIDATED | (fix, no spec) | T-072..T-075; root cause = OOM part sizes + O(n²) append + happy-path-only cleanup; suite 198→202 |
| F-11 | TIN-scoped export folders (block a second company) | VALIDATED | SPEC-010 | T-076..T-090; suite 202→213. Guard in ensureDir+start+resume+plan; merge may proceed logged-out on a claimed folder |
| F-12 | Run log persisted to the folder | VALIDATED | SPEC-011 | T-091..T-102; suite 213→226. Batched open/append/close (NOT a held stream — FSA is only durable on close) |
| F-13 | Incremental merge (only new chunk files) | VALIDATED | SPEC-012 | T-103..T-114; suite 226→238. Stable COMBINED names; T-111 pins incremental output == full rebuild |
| F-14 | Period-labeled, day-aligned output | VALIDATED | SPEC-013 | T-115..T-121; period now REPORTED (log + state), not in filenames — names stay stable so increments don't rename |
| F-15 | Streaming xlsx writer — one file, not 17 | VALIDATED | SPEC-014 | T-122..T-128; suite 245→252. Own zip+SpreadsheetML writer; 1M rows at 22MB heap; summary/details are separate single-sheet files |

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
- 2026-08-08 · F-10: user reported Merge always failing on big folders and leaving a .jsonl behind.
  Three measured root causes, all fixed: (1) Phase-2 part caps (60k/900k rows) were sized against
  Excel's sheet limit, not against memory — the vendored browser ExcelJS has no streaming writer,
  so a part lives in its object model until writeBuffer(); benchmarked ~9.5KB heap/row, 72k rows
  peaks ~950MB and passes, 90k rows OOMs. Caps are now 12k/60k. (2) Phase 1 appended via
  appendText, which re-opens with keepExistingData — Chromium copies the whole file each time, so
  a multi-GB scratch cost O(n²) disk I/O; now one long-lived stream (fs.openWrite). (3) The
  scratch .jsonl was unlinked only on the happy path, so every crash stranded it; cleanup is now
  in a finally and stale ones are swept at merge start. Trade-off accepted: parts are smaller, so
  big folders produce more COMBINED files — a merge that finishes beats one that kills the tab.
