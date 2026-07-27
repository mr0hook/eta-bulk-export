export const meta = {
  name: 'eta-bulk-review-and-ideate',
  description: 'Multi-dimension adversarial review of the ETA Bulk Export extension + backend, plus admin-dashboard feature ideation',
  phases: [
    { title: 'Review', detail: '7 dimension reviewers read the real files' },
    { title: 'Verify', detail: '3 perspective-diverse skeptics per finding' },
    { title: 'Features', detail: '3-lens dashboard feature panel' },
    { title: 'Judge', detail: 'score + synthesize feature set' },
  ],
}

const ROOT = 'C:/CCProject/E-Invoice/cleanroom'

const CONTEXT = `
PROJECT: "ETA Bulk Export" — a Chrome MV3 extension + Cloudflare Worker backend.
The extension injects a Shadow-DOM drawer onto the Egyptian Tax Authority portal (invoicing.eta.gov.eg),
reads the portal's own OIDC access_token + tax registration number (RIN) from page localStorage, and
bulk-exports the signed-in taxpayer's OWN e-invoices/e-receipts to xlsx/JSON past the portal's per-search
caps (10,000 invoices / 3,000 receipts). Chunking engine recursively bisects the date range; orchestrator
has its own run loop with resume, 429 backoff, token pre-expiry pause, durable failure log.
The backend (lead-worker/worker.js) is a managed access gate + lead capture: free one-time registration,
then HMAC-signed /session check-ins so the owner can lock/kill/void/version-block installs and manage an
allow-list of RINs. It ships a full admin dashboard (inline HTML template string named DASH at the bottom of worker.js).
CSP bridge: MAIN-world bundle -> window.postMessage -> bridge.js (ISOLATED) -> bg.js (service worker, origin-pinned) -> fetch.

ROOT (absolute, all files under here): ${ROOT}

CRITICAL INSTRUCTIONS FOR YOU, THE REVIEWER:
- READ THE ACTUAL FILES with the Read tool before making ANY claim. Verify every line number against the real file.
- worker.js trips ripgrep's binary heuristic (huge inline HTML string) — use Read (with offset/limit), NOT Grep, on lead-worker/worker.js.
- Report ONLY real defects you can point to in the code with a concrete, reproducible failure scenario. No speculation, no "consider adding". If you cannot construct a concrete failure, do not report it.
- Baseline: 70 node tests pass; dist/etaBulk.js must stay 0-non-ASCII (portal is UTF-8 strict). Any fix must preserve both.
- This is a clean-room reimplementation; do not suggest importing third-party gated code.
- Rank findings most-severe-first. Give each a precise file+line, a failure scenario (inputs/state -> wrong outcome), and a concrete suggested fix.
`

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'nit'] },
          category: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          summary: { type: 'string' },
          detail: { type: 'string' },
          failure_scenario: { type: 'string' },
          suggested_fix: { type: 'string' },
        },
        required: ['severity', 'category', 'file', 'line', 'summary', 'failure_scenario', 'suggested_fix'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    real: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'string' },
    correction: { type: 'string' },
  },
  required: ['real', 'confidence', 'reasoning'],
}

const FEATURE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    features: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string' },
          problem: { type: 'string' },
          description: { type: 'string' },
          impact: { type: 'string', enum: ['high', 'medium', 'low'] },
          effort: { type: 'string', enum: ['high', 'medium', 'low'] },
          implementation_notes: { type: 'string' },
          backend_changes: { type: 'string' },
        },
        required: ['name', 'problem', 'description', 'impact', 'effort', 'implementation_notes'],
      },
    },
  },
  required: ['features'],
}

const FEATURE_PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    recommended: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string' },
          why: { type: 'string' },
          priority: { type: 'integer' },
          effort: { type: 'string', enum: ['high', 'medium', 'low'] },
          scope: { type: 'string' },
          endpoints: { type: 'string' },
        },
        required: ['name', 'why', 'priority', 'effort', 'scope'],
      },
    },
  },
  required: ['summary', 'recommended'],
}

const DIMENSIONS = [
  {
    key: 'worker-security',
    files: 'lead-worker/worker.js (read in pages via offset/limit; it is 836 lines), lead-worker/wrangler.toml',
    focus: `Backend security & correctness. Scrutinize: HMAC verifySigned (skew window, nonce single-use, KV eventual consistency race), admin auth (Bearer constant-time compare, any path that skips admin()), CORS (Access-Control-Allow-Origin:* with credentials implications), RIN ownership atomicity (Locks DO claimRin/releaseRin/#seed, blockConcurrencyWhile, the KV fallback read-back race), rate limiting (per-IP, bypass via missing CF-Connecting-IP), version kill switch (isVersionBlocked fail-closed logic), input validation & length caps (KV key-size limits, cleanRin), the /register flow (quota ?? 1, claim-only-when-bound, half-bound records), /session telemetry seen: separation, CSV formula injection in /export, isVoided propagation, superadmin bypass scope, error info leakage. Look for auth bypasses, injection, races that let two accounts claim one RIN, DoS via unbounded KV listPrefix, and any endpoint missing the admin() guard.`,
  },
  {
    key: 'ext-security',
    files: 'bg.js, bridge.js, csp-shim.js, src/core/registration.js, src/api/client.js, src/core/token.js, manifest.json',
    focus: `Extension security. Scrutinize: bg.js origin pinning (can the relay be tricked into fetching another origin? redirect handling?), bridge.js postMessage trust (e.source===window only; can the page forge __eta res/req? id correlation; is the reply posted with a restricted targetOrigin?), the MAIN-world bundle running in the page's shared global (window.__etaBulk*, orchestrator NOT on window — is anything sensitive reachable by a hostile page script?), token.js reading USER_DATA (any way page JS abuses the drawer to exfiltrate token? but note page already has it), client.js API_ORIGIN guard + redirect-off-origin check + %PDF magic check, registration.js clientKey in localStorage + bridgeFetch timeout/leak, HMAC signing correctness client-side, CSP shim safety. Also manifest host_permissions scope and world:MAIN exposure.`,
  },
  {
    key: 'core-engine',
    files: 'src/core/chunker.js, src/core/orchestrator.js, src/api/client.js, src/api/sources.js, src/core/store.js, src/core/fs.js, src/core/time.js, src/core/keepalive.js',
    focus: `Correctness of the chunking + run loop. Scrutinize: chunker date bisection for GAPS (silent row loss) or non-termination (DST, sub-ms, depth caps, atFloor), inclusive-boundary dedup assumption, the subSplit submission-time path, probeCount BAD_COUNT handling, fetchAllRows pagination end conditions (short page vs 404 vs maxPage cap, the maxPage = ceil(cap/ps)+5 truncation — can it drop rows?), the filterSet client-side filter interaction with the cap, orchestrator resume correctness (doneIds vs scanDoneFromFolder vs filter signature), token pre-expiry headroom math, per-chunk retry/abort/AUTH/STOPPED handling, droppedByChunk reconciliation, store.js chunkFile hashing collisions, fs.js appendText position correctness + readLines chunk-boundary handling, time.js Cairo DST edge days. Hunt for any path that silently under-reports documents in a compliance export.`,
  },
  {
    key: 'export-correctness',
    files: 'src/export/xlsx.js, src/export/sanitize.js, src/export/dates.js, src/export/codes.js, src/core/merge.js, src/core/repair.js',
    focus: `Export/merge correctness. Scrutinize: xlsx.js column-union stability (dynamic tax/currency/discount columns added conditionally — can a later chunk have a column an earlier chunk lacked, so merge misaligns?), sign handling (negativeCredit, T4 special-case) for correctness, dateEg DST boundary replica correctness, sanitize.js illegal-char + lone-surrogate scrubbing completeness, merge.js UUID dedup + NFC header normalization + streaming JSONL correctness + auto-split serial continuity + the uuidKeyOf heuristic, repair.js illegal-char detection regex (lastIndex bug already noted — verify), codes.js lookup fallbacks. Focus on data-integrity: wrong numbers, dropped rows on merge, column misalignment across chunks, corrupted xlsx.`,
  },
  {
    key: 'drawer-ux',
    files: 'src/ui/drawer.js, src/main.js',
    focus: `Drawer UX, accessibility, and state-machine correctness. Scrutinize: busy-lock correctness (setBusy across plan/start/resume/merge/repair — can the UI wedge?), the licensed/gate state interplay with setBusy, error paths that leave buttons stuck, accessibility (aria-modal=false on a modal drawer, focus trap, keyboard nav, the status chips, color-only status), the MutationObserver re-append cost, window.prompt for bug report (blocked by some CSPs? UX), progress/label correctness, the Escape/scrim behavior, any XSS via innerHTML with interpolated data (removableColumns headers, folder name, status messages). Assess overall usability gaps a real taxpayer running a huge multi-hour export would hit.`,
  },
  {
    key: 'dashboard-ux',
    files: 'lead-worker/worker.js — ONLY the DASH template literal (the admin dashboard HTML/CSS/JS, roughly lines 460-836; read that range)',
    focus: `The admin dashboard as a PRODUCT. The owner explicitly said "I don't like the backend website, it doesn't have features." Assess the CURRENT dashboard honestly: what does it do well, what is missing, what feels bare. Catalog existing capabilities (users table, RIN requests, bugs, tools/version/void, CSV export, stats cards, search/filter/sort, theme). Then identify concrete UX/functionality GAPS: no charts/trends, no per-user detail drill-down, no activity timeline, no bulk actions, no pagination for large user lists, no date-range analytics, no email/notification, no notes on users, no audit log of admin actions, no CSV of requests/bugs, no keyboard shortcuts, no empty-state guidance, etc. Report gaps as findings (severity = impact on the owner's daily use). Be specific and concrete.`,
  },
  {
    key: 'store-compliance',
    files: 'manifest.json, build.mjs, package-ext.mjs, package-source.mjs, package.json, README.md, STORE.md, PUBLISHING.md, PRIVACY.md, privacy.html, NOTICE, LICENSE',
    focus: `Chrome Web Store readiness, build reproducibility, and compliance. Scrutinize: manifest permissions justification (host_permissions incl. the worker origin — CWS single-purpose + data-use disclosure), the privacy policy completeness vs what is actually collected (name/email/phone/company/RIN/version/country/IP), the REPLACE-with-your-privacy-url placeholder still in drawer.js consent line, build determinism (esbuild version pinning, bg.js generation), package-ext file list correctness, version-sync guard, the "Omar Soliman" data-controller hardcode, ExcelJS/JSZip license attribution in NOTICE, any remaining placeholder/REPLACE-ME strings that would ship. Report anything that would cause a CWS rejection or a privacy/legal problem.`,
  },
]

function reviewPrompt(dim) {
  return `${CONTEXT}

YOU ARE THE "${dim.key}" REVIEWER.
Files in your scope: ${dim.files}

Your focus:
${dim.focus}

Read the files in full first. Then return your findings via the structured schema. Most-severe first. If a concern turns out to be already-guarded in the code, do NOT report it — say so only in your own reasoning, not as a finding. Aim for high signal: 0 findings is a valid answer if the code is genuinely clean in your dimension, but look hard — this is a compliance-grade tax tool and a security-sensitive gate.`
}

const SKEPTIC_LENSES = [
  { key: 'code-reality', instr: 'Read the exact cited file+lines. Does the code ACTUALLY do what the finding claims? Check for an existing guard, early-return, or type coercion the finding overlooked. Default to real=false if the cited code does not actually exhibit the described behavior.' },
  { key: 'impact', instr: 'Assume the mechanism is real. Is the IMPACT as claimed — does it actually cause data loss, an auth bypass, a crash, a wrong number, or a genuine UX failure for a real user? A theoretical issue with no reachable real-world consequence is real=false. Weigh severity honestly.' },
  { key: 'reproduce', instr: 'Try to construct the concrete input/state sequence that triggers the failure, tracing through the real code paths (callers, hooks, options defaults). If you cannot build a plausible trigger that reaches the buggy line with the required state, real=false.' },
]

function verifyPrompt(f, dim, lens) {
  return `${CONTEXT}

You are an ADVERSARIAL VERIFIER. A reviewer for the "${dim}" dimension filed this finding. Your job is to REFUTE it unless it genuinely holds. Be skeptical; reviewers over-report.

FINDING:
- severity: ${f.severity}
- category: ${f.category}
- file: ${f.file}:${f.line}
- summary: ${f.summary}
- failure scenario: ${f.failure_scenario}
- suggested fix: ${f.suggested_fix}

YOUR VERIFICATION LENS (${lens.key}): ${lens.instr}

Read the actual file(s) at ${ROOT}/${f.file} around line ${f.line} and wherever else is needed to judge. Then return your verdict: real=true only if the finding survives your lens. Include a short correction if the finding is partially right but mis-stated.`
}

const FEATURE_LENSES = [
  {
    key: 'admin-power-user',
    instr: `Lens: the OWNER (Omar) using this dashboard daily to run a small paid/free tool. What features make his day-to-day management faster and more powerful? Think: per-user detail drawer, inline notes/tags on users, activity timeline per device, bulk actions (multi-select lock/kill/delete), pagination + server-side search for when users grow, audit log of admin actions, CSV export of requests & bugs (not just users), saved filters, quick RIN transfer between accounts, resend/impersonate-verdict, keyboard shortcuts.`,
  },
  {
    key: 'growth-analytics',
    instr: `Lens: GROWTH & INSIGHT. This is also a lead-capture funnel. What analytics/visualization turns the raw KV data into decisions? Think: registrations-over-time chart, active-vs-dormant, funnel (registered -> checked-in -> exported), version-adoption breakdown, geographic (country) breakdown, top RINs by activity, retention cohorts, sparklines on the stat cards, a "new this week" feed. Note: the extension does NOT currently send export-volume telemetry — call out cheaply-addable client pings if a metric needs new data, but prefer metrics computable from existing KV (dev/seen/req/bug/void).`,
  },
  {
    key: 'ops-trust',
    instr: `Lens: OPERATIONS, TRUST & POLISH. What makes the console feel trustworthy and complete? Think: an audit/action log (who did what when), confirmation + undo for destructive actions, a global "announcement/banner" pushed to all extensions via /session (e.g. maintenance notice), a broadcast message to a single user, health/self-check panel (KV reachable, DO bound, config sane), rate-limit/abuse visibility, export of full backup, dark/light already exists — what about density toggle, empty-state onboarding, error surfaces. Also real-world hardening the owner would want surfaced in UI.`,
  },
]

function featurePrompt(lens) {
  return `${CONTEXT}

The owner said: "I don't like the backend website, it doesn't have features." Your job is to propose concrete, buildable features for the admin dashboard (the DASH template in lead-worker/worker.js) and the small backend endpoints they need.

First READ the current dashboard: read lead-worker/worker.js lines ~346-836 (the admin API endpoints and the DASH HTML/CSS/JS) so you know exactly what already exists and don't propose duplicates. Also skim the data model (dev:/seen:/req:/bug:/void:/cfg keys) around lines 100-345.

${lens.instr}

Propose 4-8 features. For each: the user problem it solves, a concrete description of the UI + behavior, impact, effort, implementation_notes (how it fits the existing vanilla-JS single-file dashboard + Worker), and backend_changes (any new endpoint or KV key — keep them minimal and computable from existing data where possible). Favor features that are genuinely useful to a solo operator, high-impact, and implementable in this single-file no-framework codebase. Return via the schema.`
}

function judgePrompt(allIdeas) {
  const flat = allIdeas.filter(Boolean).flatMap((r, i) => (r.features || []).map(f => ({ lens: FEATURE_LENSES[i]?.key || 'lens' + i, ...f })))
  return `${CONTEXT}

Three feature panels proposed dashboard features from different lenses. Here is the combined raw list (JSON):

${JSON.stringify(flat, null, 1)}

You are the JUDGE. Deduplicate, merge overlapping ideas, and produce a PRIORITIZED, buildable feature set for THIS single-file vanilla-JS dashboard + Cloudflare Worker (no frameworks, no build step for the worker). Optimize for: high daily value to a solo operator, self-contained (computable from existing KV data or a tiny new endpoint), and shippable without heavy risk. Assign priority 1..N (1 = build first). For each, give why, effort, a crisp scope (what exactly to build), and endpoints (new/changed). Aim for a coherent set of ~6-10 that together transform the dashboard from "bare" to "feature-rich", plus a one-paragraph summary of the overall direction. Return via the schema.`
}

// ---- run review + feature ideation concurrently ----
log('Starting: 7-dimension adversarial review + 3-lens dashboard feature ideation')

const reviewP = pipeline(
  DIMENSIONS,
  (dim) => agent(reviewPrompt(dim), { label: `review:${dim.key}`, phase: 'Review', schema: FINDINGS_SCHEMA, effort: 'high' })
    .then(r => ({ dim: dim.key, findings: (r && r.findings) || [] })),
  (reviewed) => {
    const fs = reviewed.findings
    if (!fs.length) return { dim: reviewed.dim, verified: [] }
    return parallel(fs.map(f => () =>
      parallel(SKEPTIC_LENSES.map(lens => () =>
        agent(verifyPrompt(f, reviewed.dim, lens), { label: `verify:${reviewed.dim}:${lens.key}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' })
      )).then(votes => {
        const v = votes.filter(Boolean)
        const yes = v.filter(x => x.real).length
        return { ...f, dim: reviewed.dim, votes: v, realCount: yes, survives: yes >= 2 }
      })
    )).then(verified => ({ dim: reviewed.dim, verified }))
  }
)

const featureP = (async () => {
  const ideas = await parallel(FEATURE_LENSES.map(lens => () =>
    agent(featurePrompt(lens), { label: `feature:${lens.key}`, phase: 'Features', schema: FEATURE_SCHEMA, effort: 'high' })
  ))
  const plan = await agent(judgePrompt(ideas), { label: 'feature-judge', phase: 'Judge', schema: FEATURE_PLAN_SCHEMA, effort: 'high' })
  return { rawByLens: ideas, plan }
})()

const [reviewResults, featureResults] = await Promise.all([reviewP, featureP])

// ---- assemble report ----
const allVerified = reviewResults.flatMap(r => (r.verified || []))
const survivors = allVerified.filter(f => f.survives)
const rejected = allVerified.filter(f => !f.survives)
const order = { critical: 0, high: 1, medium: 2, low: 3, nit: 4 }
survivors.sort((a, b) => (order[a.severity] - order[b.severity]) || (b.realCount - a.realCount))

log(`Review done: ${allVerified.length} findings verified, ${survivors.length} survived (>=2/3 skeptics), ${rejected.length} rejected`)
log(`Features: judge recommended ${(featureResults.plan?.recommended || []).length}`)

return {
  survivors: survivors.map(f => ({ severity: f.severity, dim: f.dim, category: f.category, file: f.file, line: f.line, summary: f.summary, failure_scenario: f.failure_scenario, suggested_fix: f.suggested_fix, realCount: f.realCount, votes: f.votes.map(v => ({ real: v.real, confidence: v.confidence, note: v.correction || v.reasoning.slice(0, 200) })) })),
  rejected: rejected.map(f => ({ severity: f.severity, dim: f.dim, file: f.file, line: f.line, summary: f.summary, realCount: f.realCount, why: f.votes.map(v => v.reasoning.slice(0, 140)) })),
  featurePlan: featureResults.plan,
  featureRawByLens: featureResults.rawByLens,
  counts: { dimensions: DIMENSIONS.length, verified: allVerified.length, survived: survivors.length, rejected: rejected.length },
}
