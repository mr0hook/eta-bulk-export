# STATE — ETA Bulk Export (cleanroom)

> Chrome MV3 extension: bulk-export Egyptian ETA e-invoices/receipts past portal caps; v0.4
> milestone adds a Rejection tab, PO reconciliation analytics, real rejection windows, and
> credit/debit-note reference linkage.
> Track: STANDARD · Started: 2026-07-27 (Agent OS adopted mid-project at v0.3.0) · Client: internal

## Vocabulary — two different "merges", do not confuse them
- **merge (client)** — `src/core/merge.js`. Combines the per-chunk xlsx files in the USER'S FOLDER
  into the COMBINED output. Incremental (F-13). Never leaves the device.
- **migration (server)** — SPEC-017. A one-time reshuffle of the backend's OWN account records
  (name/email/company/TRN/quota) from KV into D1 so a user is one row instead of one per browser.
  Touches no export files and no invoice data. Nothing a taxpayer's documents ever pass through.

## Build targets
`npm run build` → production · `npm run build:staging` → staging. The flag switches all THREE things
that must agree or the backend is silently unreachable: the LEAD_URL compiled into the bundle, the
single origin bg.js is allowed to fetch, and manifest.json's host_permissions. A staging build shows
up in `git status` (manifest.json changes) and `package-ext.mjs` refuses to zip one.

## NEXT ACTION
→ **Reload the extension to v0.15.0, then Resume + re-merge the two damaged exports, in this order:**
  1. `Pr2\2024\Q1` — its 3 short chunks were deleted and `doneIds` healed on 2026-08-20 (34/37,
     status=incomplete, `.bak` written). Resume refetches exactly those windows. Then Merge: the
     new closing line must read `Reconciled against the plan: 240,351 … 240,351 present`.
  2. `Pr2\2023R` — **not yet touched.** `tools/verify-chunks.mjs` found 4,748 documents missing:
     chunk 38 holds **5** of a planned 4,753. (Chunks 2 and 16 are short by 3 and 1 — 0.06% and
     0.01%, benign probe drift, inside the 0.5% tolerance; leave them.) Chunk 38 is the tail of the
     run that was interrupted by the registration lockout and later "synced"; the sync marked it
     done with 5 rows. Fix: `node tools/drop-short-chunks.mjs "…\2023R" 38`, then Resume, then
     re-merge. The already-merged COMBINED files for 2023R are 4,748 documents short — do not ship
     them to anyone until this is redone.
  Run `tools/verify-chunks.mjs` on every OTHER previously-exported folder too. Every export made
  before v0.15.0 could carry this loss and none of them were checked.

  Still open from earlier, unrelated: F-5 (unverified registration emails), F-6 (entitlement on
  post-start plan routes), L-3, L-5, L-6, L-8 from docs/security-review-2026-08-20.md.

### Superseded (kept for the record)
2026-08-20 ~11:00 INCIDENT + SPEC-033 (v0.11.2): mid-run the tool threw the user back to the
  REGISTRATION GATE with "device limit reached". Assessment: docs/incidents/2026-08-20-
  registration-lockout.md. NO DATA LOST (verified on disk: 37/38 chunks, 24 detail parts,
  291.6MB, progress says 37 done / 0 failed / 254,048 rows). NOT caused by 429/WAF: creds are
  wiped ONLY on the literal '/session → not registered', and the refusal was /register's
  device_limit business rule; the observed 429s were all on ETA's api-portal host.
  Fix shipped: identity (device id + creds) is mirrored into chrome.storage.local via the bridge
  (extension-owned; a portal re-login cannot clear it), localStorage becomes a cache restored from
  the mirror, and the 'not registered' path clears CREDS but keeps the DEVICE ID so a re-register
  is always the never-refused returning-device case. T-271..T-273; 401/401.
  USER MUST: (1) Merge now — local, no backend, yields COMBINED from the 37 done chunks;
  (2) in /admin raise the device allowance or delete the stale device, then Register & unlock;
  (3) finish chunk 38 via "Sync new since last run" (old job is device-scoped, cannot resume under
  a new id); (4) optional: ⟳ Load failed UUIDs for the 3,484 FORBIDDEN + 4 NOT_FOUND documents.
  OPEN QUESTION for the owner (needs the admin token): does /admin show this account holding an
  OLD device id (→ local id loss) or none at all (→ server-side record loss)?

→ Previous (2026-08-20 ~02:40), SPEC-032 BUILT (v0.11.1): user caught SPEC-029 fragmenting output — it opened
  a part file PER 2,000-doc BATCH, so a 10k chunk became 5 files even with a few thousand detail
  rows. Batching is for MEMORY and must not decide layout. createDetailSink now holds line rows
  while the chunk may still fit one file (30k budget): under it → ONE workbook with inline lines,
  exactly like pre-batching; over it → parts rolling only at the 60k read-back cap, never
  mid-invoice, header pinned per part. Limits kept straight in the spec: the DELIVERABLE (merge
  output) already rolls at Excel's 1,000,000; chunk files are intermediate and bounded by merge's
  ExcelJS read-back (~9.5KB/row, F-10: 72k passes / 90k OOMs) — raising a part to 1M rows requires
  streaming reads in merge first (future work). T-265 rewritten, T-270; 398/398.
  USER: reload the unpacked extension (v0.11.1).

→ Previous (2026-08-20 ~01:15), SPEC-031 BUILT (v0.11.0) — the "is the 15-min refresh necessary?" answer:
  NO for the part that was ours. ETA's ~15-min token TTL is theirs and harmless (the portal SPA
  self-renews while a tab is open — orchestrator.js:40, field-proven). What was ours was SPEC-009's
  30-MIN FORCED TAB BOOT, which re-runs OIDC and lets the portal re-select the login's default
  entity — THE flip vector, and why flips track working hours and never happen at 4am. Retired.
  Now: (a) the warm is issued FIRST-PARTY from the page (carries the SameSite cookie the
  service-worker warm could not), (b) an ADVANCING token expiry is proof the session is alive, so
  a tab boots ONLY when the portal stops renewing and the token runs down (<10 min), (c) during
  any renewal every document fetch is HELD and the entity re-pinned before release, so no request
  can go out under the wrong company. T-071 rewritten, T-267..T-269; 397/397.
  USER MUST: reload the unpacked extension (v0.11.0). Expect ZERO background tabs on a healthy run
  and a "🔄 The portal refreshed the session token by itself" line instead.

→ Previous (2026-08-20 ~00:50), SPEC-029 + SPEC-030 BUILT (v0.10.0), four user directives:
  (1) 10k CHUNKS RESTORED — orchestrator now processes chunks in 2,000-doc batches (details →
  pdfs → refs → rows → parts per batch, raw JSON dropped; serialBase keeps مسلسل continuous;
  ≤2,000-doc chunks keep the old single-pass path bit-for-bit). capReceived REMOVED from the
  worker (SPEC-026 superseded; smoke T-257 re-pinned to the revert).
  (2) Random pauses: fixed in v0.9.1 (phantom STOPPED from mid-body deadline aborts).
  (3) Company flips: ROOT-CAUSED — SPEC-009's renewal tab boot re-selects the login's default
  entity server-side (flip + "session running low" in the same log second). Now: afterRenew hook
  re-pins the entity seconds after every renewal, and a mass-403 chunk (≥25 FORBIDDEN, ≥half)
  FAILS instead of completing thin (chunk-7 class). T-264..T-266; suite 394/394; SMOKE OK.
  USER MUST: (a) `cd lead-worker && npm run deploy:prod` (cap revert; agent is permission-blocked
  from deploys), (b) reload the unpacked extension (v0.10.0), (c) plans made under the 2k cap
  keep working (batching is orthogonal); NEW plans cut 10k chunks again.
  Chunk-7's 974 flip-era UUIDs: run finishes → "⟳ Load failed UUIDs" → Start.

→ Previous (2026-08-19 ~23:45), PHANTOM-PAUSE FIX (v0.9.1): the live Purchases run "paused itself" three
  times mid-details with NO 'Pausing…' line (23:13:05, 23:16:16, 23:25:59). Root cause: the
  v0.6.4 request deadline firing MID-BODY (r.json() on a slow stream under 40-deep details)
  rejects with plain AbortError — not TimeoutError — and apiGet's `e.name === 'AbortError'`
  check turned that into STOPPED, which the run loop printed as a bare user pause. Fix: STOPPED
  is keyed ONLY on the caller's signal (apiGet + apiGetBlob), and the run loop treats a STOPPED
  with neither flag set as a spurious abort that falls into ordinary retry (T-263; 391/391).
  USER: reload the unpacked extension (v0.9.1) and Resume the paused Purchases run (8/43).
  ALSO from the same log: an entity flip at 23:24:29 was auto-restored in 12s (SPEC-023 working),
  but chunk 7 completed with 112/1086 — the 974 flip-era 403s are in eta_failures.jsonl and are
  EXACTLY what the new Load-failed-UUIDs button is for, after the run finishes. FUTURE SPEC
  CANDIDATE: mass-FORBIDDEN in one chunk (e.g. >50%) should FAIL the chunk as a flip symptom
  instead of completing thin.

→ Previous (2026-08-19 ~21:30), SPEC-028 BUILT (v0.9.0): "⟳ Load failed UUIDs" button in the By-list box —
  reads eta_failures.jsonl (folder-gated via ensureFolder), fills the paste box with retryable
  document uuids (pdf-only/over-cap/receipts lines excluded, deduped), user presses Start as a
  normal SPEC-022 uuid run. T-262; suite 390/390; dist at v0.9.0. USER: reload the unpacked
  extension when convenient (the running Purchases run is on the loaded build — reloading
  mid-run pauses it; Resume continues). The worker deploy landed earlier (~198-chunk plan with
  2,000-cap Received chunks observed live at 64 req/s, zero 429s, heap ~340MB).
  NEXT SPEC when the run completes: map-on-arrival (drop raw JSON as rows are built) so the
  Received cap can rise from 2,000 (revert-to-10k question answered: not until then).

→ Previous (2026-08-19 ~20:15), SPEC-027 BUILT (v0.8.0): split chunk render. A chunk whose line rows exceed
  30k now streams details into `_det_pNN.xlsx` part files (≤60k rows each, SPEC-014 writer,
  constant memory; an invoice never straddles parts) and keeps only a styled summary workbook in
  ExcelJS (lines sheet header-only), written LAST as the resume marker; stale parts are swept on
  retry. Merge Phase 1 groups a chunk's parts onto its summary (orphan part → skip-with-warn in
  full mode, DRIFT full rebuild in incremental). T-258..T-261; suite 389/389; dist at v0.8.0.
  USER MUST, in order: (1) run `cd lead-worker && npm run deploy:prod` (SPEC-026 Received cap
  2,000 + SPEC-024 coalescing + cursor fix — the agent's deploy was permission-blocked),
  (2) reload the unpacked extension (v0.8.0), (3) start a FRESH Purchases plan — never resume the
  dead 38-chunk plan (its 9,477-doc chunk 1 can never fit pre-deploy).

→ Previous (2026-08-19 ~19:45), SPEC-026 BUILT: the Purchases run's chunk-1 failure
  ("Invalid array length", earlier an Aw-Snap tab kill) is MEMORY, not data — heap measured at
  2,273MB with 44% of 9,477 received invoices fetched (~540KB/doc; line-heavy). Worker now plans
  Received/all invoice runs at cap 2,000 (Sales stays 10k). After deploy: user starts a FRESH
  Purchases plan (the old 38-chunk plan is a dead end — its chunk 1 can never fit). NEXT SPEC
  after that: streaming chunk render (map rows on arrival, drop raw JSON, part-split the details
  sheet like the merger) — then the cap can rise again.

→ 2026-08-19 ~17:30, SPEC-025 (v0.7.1): the live Sales run's details phase hit a portal 429 storm
  (fixed 40-worker pool; 77 rate-hits in an 81s monitor window; drawer stuck in "Rate-limited (429)
  — waiting" loops; NOT an entity flip — searches returned rows and details returned 200 whenever
  admitted). Details concurrency is now an AIMD governor (start 12, halve on 429 with floor 3 and
  10s growth freeze, +1 per 25 clean fetches, ceiling at the old 40/30). USER MUST: reload the
  unpacked extension (dist/ rebuilt at v0.7.1), then Resume the paused Sales run — the current
  chunk refetches and the pool self-tunes to whatever the portal allows today.

→ Previous (2026-08-19 03:00): v0.6.3 committed after the live 4M-doc run surfaced the ENTITY-SWITCH class
  of failure (one login, several entities EACH WITH ITS OWN RIN; a cold portal load re-auths and
  can flip the active entity for every tab → empty searches + per-doc 403s. The per-chunk RIN
  guard passed because the switched-to entity was ALSO registered on the account — it checked
  entitlement, not run identity). Run defenses: empty-chunk
  guard (T-237), file-truth resume heal (T-238), profile-stamp pause (T-239), 403 = drop-row not
  AUTH. User must: reload the unpacked extension (v0.6.3), confirm the portal shows the intended
  company, then Resume the Sales run — chunks 1..192 (empty-marked) refetch automatically.
  RULE FOR AGENTS: never open invoicing.eta.gov.eg in the user's browser — a cold load
  re-authenticates and flips their active taxpayer profile mid-run.
  2026-08-19 ~04:30, USER-VALIDATED: the entity selection is server-side PER LOGIN — switching in
  Edge flipped Chrome (different browser, no shared cookies), and SPEC-023's pinning (v0.7.0) was
  observed reverting it live. Corollary: the run's restore also yanks OTHER sessions back; a
  colleague actively working another entity on the same login ends in the 3-restore pause by
  design. Long-term advice given: separate ETA user accounts per person/entity.

→ THEN: DEPLOY THE WORKER TO PRODUCTION — it now carries THREE things: the cursor stack-overflow
  fix (80d615a), SPEC-022's /plan/uuids route (without it, the new By-list export gets
  'not found' from the backend and refuses to run), and SPEC-024's chunk coalescing (adjacent
  under-filled chunks merge up to 90% of cap — roughly halves the chunk count of the 8M-doc plan;
  cursor-compatible with in-flight plans, so deploying mid-probe is safe):
      cd lead-worker && npx wrangler deploy --env production
  Then: (1) re-run the 2M-invoice stress test (should plan clean past probe ~1036), and
  (2) reload the unpacked extension (dist/ is rebuilt) and try the new By-list box:
  paste UUIDs → exact export with optional official PDFs; paste RINs → filtered range export.

SPEC-022 (F-22 uuid-list export, F-23 RIN filter) is BUILT and green: T-219..T-234 across
smoke-worker + listinput/uuidplan/uuidrun/rinrun/merge/sync suites; 367 extension tests + smoke
all pass; production build clean. Not yet validated against the live portal (needs your login).

Previous stress-test context:
  2026-08-18: a real stress run (~2M invoices) crashed /plan/step at probe ~1036 —
  `Maximum call stack size exceeded` in cursor.js b64url (byte spread), confirmed in production
  err: KV records. Fixed in 80d615a (T-148 regression test). The fix is committed but NOT deployed:
      cd lead-worker && npx wrangler deploy --env production
  Production bundle was verified to be exactly at 24ee843 before the fix, so this deploy ships the
  one-line fix and nothing else.
  KNOWN CEILINGS the same stress test will hit next, by design (decide before raising):
  - Receipts at 42M docs ≈ 14k chunks (cap 3000) ≈ ~28k probes > MAX_STEPS 20000 → clean
    'plan too large' refusal (routes/plan.js). CHUNK_STATES_MAX 4096 also exceeded.
  - The cursor carries accepted chunks (st.out), contradicting T-147's stated design
    ("chunks go to D1 as they are decided" — never implemented). A 14k-chunk plan would ride
    ~3MB per step. Real fix: persist chunks incrementally, seal only the stack.
  - finishPlan writes the whole plan as ONE D1 batch (1 stmt/chunk) — untested past ~700 chunks.

Previous next action (still pending, now second):
→ ONE REAL RUN AGAINST STAGING. Everything built since 2026-08-09 is verified only by tests and
  synthetic probes; no real ETA data has ever passed through the server planner or the new flow.
  `npm run build:staging`, reload the unpacked extension, press Download → folder → Sales → current
  year → Start. Watch four things: the plan builds (chunk decisions stream from the server), the run
  completes, merge fires by itself, and the COMBINED files open in real Excel. Then `npm run build`
  to retarget production. Needs the portal login, so only you can do it.

Then, in order:
  (1) Promote the worker to production (`npm run deploy:prod` — NEVER a bare `wrangler deploy`: the
      top-level config carries the same worker name with no d1_databases block, so it would overwrite
      production and silently strip the JOBS binding, which the planner routes treat as "unavailable"
      rather than an error). Low risk — A0 verified byte-identical on 29 routes, everything since only
      ADDS routes. Required before the extension can ship at all: production has no /plan/* and the
      extension now needs it. Also carries /export/mapping (SPEC-021) and the /job/checkpoint
      chunkStates field — both additive, so deploy order against the extension does not matter.
      LOOK FIRST at the one production account holding four devices — after slice 3 its quota binds
      on the person.
  (2) Run the staging migration (Migration card in /admin — one click, keeps the token out of a
      transcript).
  (3) Slice 4: bugs joined to users/jobs, audit trail with real admin identity (Cloudflare Access).
      A single shared bearer token still guards a console that can kill every installation.

Parked (extension milestone, unchanged): USER SMOKE TEST of v0.4.1 — F-10..F-15 have still never
met real portal data. The run above covers much of it if the folder used is the big one that
used to fail. (built + packaged: dist-package/eta-bulk-export-v0.5.0.zip). F-10..F-15 are all code-complete and unit-green (252/252)
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

## Features (admin backend milestone — roadmap A0..A6)
Roadmap: `docs/specs/2026-08-09-admin-backend-roadmap.md`. A menu, not a commitment; A0 first
because every other phase adds code to the file it breaks up.

| ID | Feature | Status | Spec | Notes |
|---|---|---|---|---|
| F-16 | A0 · worker platform split + env separation | VALIDATED | SPEC-015 | T-129..T-136 + live staging verification. 1479-line worker.js → 91-line entry + src/** (726) + 2 html assets. DEPLOYED TO STAGING and exercised end-to-end: /admin 200 (74,580B from the text module), /privacy 200, /api/health 401, register + signed session/rin-request/bug all pass, and a duplicate RIN claim is refused 409 — the FIRST post-split test of the Locks Durable Object, which the local harness never reached (it ran without the binding, on the KV fallback). Production still runs the pre-split build |
| F-19 | Drawer on the omarsoliman.dev design system | VALIDATED | (no spec — direct user direction) | Palette (clay & paper, dark set), all 54 font declarations tokenised, real typefaces bundled as bytes and registered via FontFace (bypasses the portal CSP — user confirmed they render), brand mark on both the header seal and the opener pill, byline. Suite 252→262. Colours are the design system UNMODIFIED by explicit decision: 11 pairs sit below WCAG AA, each pinned with its measured ratio in test/theme.test.mjs |
| F-17 | A1 · admin identity (Cloudflare Access, roles, actor in audit) | NOT STARTED | — | unblocked by F-16 |
| F-18 | A2 · jobs domain (D1 schema, jobs list, chunk timeline) | NOT STARTED | — | needs ADR-002 (accepted-in-principle, status proposed) + the client-side S2 planner work |

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
- 2026-08-19 · SPEC-027 split chunk render BUILT (v0.8.0). User-identified root: summary count ≠
  line count — 10k invoices can be 1M+ line rows, and BOTH ends choke on the one-workbook shape
  (ExcelJS object model at creation; merge's ExcelJS load at read-back). xlsx.js split into
  buildRows/renderFromRows; chunkparts.js streams capped detail parts; orchestrator sweeps stale
  parts, writes parts first, summary last; merge groups parts per parent. Legacy chunk files
  unchanged and still merge identically (T-260 pins split == legacy output). Suite 385→389.
- 2026-08-19 · SPEC-025 adaptive details concurrency BUILT + shipped as v0.7.1. The monitored
  Sales run (13 chunks / 66,719 rows) proved the fixed CONC=40 details pool draws a 429 storm:
  all 40 workers stall on each wave, then stampede back in lockstep. Now an AIMD governor
  (makeGovernor + mapAdaptive in client.js, wired in orchestrator's getDetails): 429 → halve
  (floor 3) + 10s growth freeze; 25 clean fetches → +1; old CONC values are the ceiling. apiGet/
  apiGetBlob mark real 429s via onRate's second arg so network blips never shrink the pool.
  T-254..T-256 (+T-255b); suite 385/385; dist rebuilt. Diagnosis note for posterity: the user
  suspected an entity flip — the monitor disproved it in one screenshot (rows flowing, details
  200 in ~250ms when admitted, no 403s/empty searches; the drawer was in a rate-limit wait).
  New-test numbering starts at T-250: T-24x was already taken (v0.6.4 deadlines T-240, SPEC-023
  pinning T-241..T-244) — SPEC-024's tests renumbered T-250..T-253 before commit.
- 2026-08-19 · SPEC-024 chunk coalescing BUILT (server + reference chunker + tests; no extension
  code shipped, so no version bump — dist/ is byte-unchanged). Driver: the live 8M-doc probe showed
  "4 chunks one day, 1 chunk the next" — bisection's ~50–60% average fill. Adjacent un-warned
  chunks now merge greedily up to floor(cap·0.9) (plain with plain; sub only inside one issuance
  window), streaming at emit() server-side so the cursor ALSO shrinks during planning, post-pass
  fold in chunker.js — planner.test proves the two forms identical (T-250..T-253; T-147 re-pinned
  with non-mergeable leaves; smoke's synthetic windows raised 100→9500 to deliberately keep its
  2-chunk plumbing checks). Suite 381/381 + SMOKE OK. NOT DEPLOYED.
  Live ETA telemetry captured during the same probe (monitor tab, ~38 min): /documents/search is
  strictly sequential at ~1.3 req/s, ~18KB/page, zero 429s in 2,000+ calls, ONE 503, but p50
  latency CLIMBED 428→711ms over the session (soft-throttle or load ramp — an adaptive pacer and
  parallel search paging are the next networking levers; a portal inlinecontent call hung 90s,
  re-validating the v0.6.4 deadlines).
- 2026-08-10 · Run visibility: the backend's picture of a live run was blind in four places, all one
  root cause — the server was only told about a run at a few late transition points. (1) job_chunks
  .state was written once as the literal 'pending' by finishPlan and never updated by anything, so
  four of the admin timeline's five legend colours were unreachable and its "the chunk still in
  running is where it stopped" callout promised a diagnosis the data could not give. The client now
  ships a per-chunk snapshot (one char per chunk, idx order) and checkpoint() applies it with
  substr(?, idx+1, 1) — an IN-list would have blown D1's ~100 bound-parameter ceiling on a real
  plan. A snapshot, not a delta: checkpoints are best-effort and a dropped one must not leave a
  square permanently wrong. No migration — the column was always in the schema. (2) The first
  checkpoint of a run landed only when its first CHUNK finished, so a resumed export sat on the
  portal in the state it was interrupted in (user-reported: "resume and it still says paused") with
  a stale updated_at for the 30-minute stuck detector to judge it by. mark() now leads the work at
  every chunk, including ones a resume skips. (3) The end of a clean fetch called writeProgress
  directly instead of mark(), so a finished run stayed 'running' until the user got round to
  merging — long enough to trip the stuck alert on a job that had in fact finished. (4) writeProgress
  never persisted jobId, so orchestrator.resume() on its own could never check point again; the
  drawer's /job/plan answer had been covering for it. Suite 343/343, smoke OK (+4 worker checks,
  +5 extension tests). v0.5.0 packaged. The dashboard needed no change: .ck.run was already there.
- 2026-08-09 · A0 DEPLOYED TO STAGING and verified live. Staging has its own KV namespace, its own
  worker name and its own ADMIN_TOKEN — nothing shared with production. seed-staging.mjs (npm run
  seed:staging) populates it through the real extension endpoints and doubles as the Durable Object
  regression test; it refuses any target whose URL lacks "staging", because it writes permanent
  records. All nine checks pass. Two traps recorded in wrangler.toml: a bare key after a [[table]]
  header joins that table (this silently dropped the KV binding once), and --dry-run never validates
  a namespace id — a wrong one passes the dry run and fails only on a real deploy (API error 10042).
- 2026-08-09 · F-19: drawer moved onto the omarsoliman.dev design system across four passes. The one
  worth remembering: bundling the real typefaces works ONLY because they are registered with
  FontFace(name, ArrayBuffer) rather than a url() @font-face — the drawer runs in the MAIN world, so
  a fetched font is subject to the portal CSP that already forced csp-shim.js to exist. User
  confirmed the faces render. Also caught pre-ship: the bulk font rewrite replaced family names
  inside the token definitions themselves (--font-ui:var(--font-ui)), a CSS cycle that would have
  left all 54 call sites with no font-family and that nothing in 259 tests could see.
- 2026-08-09 · A0 BUILT (F-16, SPEC-015, ADR-001, ADR-002). worker.js 1479 → 91 lines; the rest is
  src/lib/{util,kv,audit,auth}.js, src/routes/{extension,admin}.js, src/locks.js, src/assets/*.html.
  Split done MECHANICALLY (sliced, never retyped) for two reasons found first: worker.js:102 held
  raw control chars in a regex, and the DASH literal held \n / \' / \\ escapes that only survive
  evaluation. Verified by a throwaway parity harness driving the pre-split worker (from git) and the
  new tree through identical KV stubs — 29 routes byte-identical, plus 18/18 smoke. The smoke harness
  no longer rewrites its source under test; smoke-hooks.mjs supplies cloudflare:workers and .html.
  ADR-001 chose text-module imports over Workers Static Assets (assets are served AHEAD of the
  Worker, which would change who answers / and /admin). Caught and fixed a TOML footgun mid-work:
  a bare key after a [[table]] header joins that table — the KV binding silently vanished from the
  dry-run until the keys were reordered. Staging env added but NOT usable until you create its KV
  namespace. Nothing deployed.
- 2026-08-09 · Anti-tamper direction explored (no code changes). Findings: the current cheapest
  bypass needs no patching at all — `reg_verdict` is hand-editable localStorage and `graceVerdict`
  (registration.js:150) honours it whenever the worker is unreachable. Direction agreed so far:
  move the chunk planner server-side (its answers are data-dependent, so they can't be replayed,
  and a naive re-implementation silently drops invoices), add server-side job records + progress
  checkpointing, keep invoice content in the browser. Resume scope settled: same-machine crash
  recovery + admin visibility only — NOT cross-device. Planning offline = hard fail with retry.
  Wrote docs/specs/2026-08-09-admin-backend-roadmap.md (A0..A6 menu, not approved). The S1/S2
  design is still mid-brainstorm — section 1 (architecture/boundaries) presented, awaiting sign-off.
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
- 2026-08-21 · SPEC-040 (v0.15.0) — SILENT PARTIAL DATA LOSS, found and closed. 2024 Q1 planned
  240,351 documents and the chunk files held 230,545: 0 duplicates, 0 failed chunks, no failures
  file, and a merge that ended "Merged 69/69 files → 230,545 unique". Mechanism: fetchAllRows ended
  pagination on `r.length < ps`, and the portal answers 200 with a short/empty page while the window
  still holds documents. Three chunks stopped early (3 of 8,879 · 5,200 of 5,847 · 5,900 of 6,183),
  every actual count an exact multiple of the 100-row page size. Neither existing guard could see
  it: the empty-chunk guard fires only on EXACTLY zero rows, and the merge summary counts FILES —
  "69/69 files" only ever meant every file was read, never that every document was in it.
  Three layers shipped: (1) a short page is re-asked up to 3× while still short of the planned
  count, page REPLACED not appended; (2) below max(2, 0.5%) of its planned count a chunk re-probes
  and the probe decides — still claiming the count → FAIL and resume refetches whole; agreeing →
  the window shrank, accept with a warning; (3) every merge ends with planned-vs-present, compared
  against summary ROWS READ so inclusive-boundary duplicates cannot masquerade as loss, with
  no-file-at-all chunks reported separately. T-285..T-294, 421/421.
  Validated on real data: verify-chunks.mjs on 2023R (already merged, believed complete, never
  checked) found 4,748 missing — chunk 38 holds 5 of 4,753 — while correctly ignoring two chunks
  short by 3 and 1. The guard fires on the real loss and stays quiet on both benign drifts.
  LIMIT: the run-time guards protect new/resumed fetching only. The merge reconciliation DOES apply
  retroactively — re-merging any old folder now states whether it is complete.
- 2026-08-21 · KNOWN FLAKE, not chased: during one full `npm test` under heavy CPU contention a
  single test asserting `progress(dir).failedIds === ['c1']` saw `[]`. Not reproducible — 6
  consecutive full-suite runs and 5 isolated runs of batchrun.test.mjs since are clean (421/421).
  Four tests share that assertion (T-266, T-274, T-281, T-285).
  RULED OUT: it is not the progress write racing the assertion. Every mark() is awaited, including
  the terminal one (orchestrator.js:687), and mark() awaits store.writeProgress. (An earlier version
  of this note guessed otherwise — wrong.)
  LIVE SUSPECT: orchestrator.js:654 deliberately suppresses the failed-marking when a Pause/Halt
  lands mid-attempt, so an async pause from the session keeper or the profile guard — both on timers
  these tests stub to fire at 0ms — would leave failedIds empty and end the run 'paused'/'halted'.
  NOT a data-integrity issue either way: done.add() runs only when a chunk SUCCEEDS, so a chunk in
  neither set is still refetched by a resume. The distinction only affects the retry UI.
  DONE instead of chasing it: assertChunkFailed() now asserts the terminal status too and prints the
  run's last log lines in the assertion message, so the next occurrence names its own cause.
