# Best-practice audit — MV3 extension + Cloudflare Worker

> 2026-08-10 · read-only audit against the `chrome-extension-development` and
> `workers-best-practices` skills. No code changed. Cloudflare limits below were re-fetched from
> the live docs (2026-08-10), not recalled.
>
> Baseline at time of audit: `npx cross-env TZ=Africa/Cairo node --test` → **338/338**;
> `cd lead-worker && node smoke-worker.mjs` → **SMOKE OK**.

Ranked by what breaks first at scale, not by tidiness. Section 3 lists what is already right for a
considered reason, so nobody "fixes" it later.

---

## 1. Findings

### F-A1 · CRITICAL — one export exhausts the entire service's daily KV write budget

Every HMAC-signed request writes a single-use nonce key:

```js
// lead-worker/src/lib/auth.js:39-41
const nKey = 'nonce:' + deviceId + ':' + String(nonce).slice(0, 64);
if (await env.LEADS.get(nKey)) return null;
await env.LEADS.put(nKey, '1', { expirationTtl: 360 });
```

The run loop makes far more signed calls than the design assumed:

| Call site | Cadence | KV writes each |
|---|---|---|
| `/session` — `drawer.js:569` `guard`, invoked at `orchestrator.js:234` | **once per chunk** | 2 (nonce + `seen:` at `routes/extension.js:163-172`) |
| `/job/checkpoint` — `orchestrator.js:343` `mark(plan,'running')` | **once per chunk** | 1 (nonce) |
| `/plan/step` — `planclient.js:85` | once per probe | 1 (nonce) |
| `/job/log` — `logship.js:23`, flush every 15 s | ~240/hour of run | 1 (nonce) |

So `writes ≈ 3·chunks + plan_steps + log_flushes`. A one-year invoice export at 120 chunks,
~250 probes, running 3 hours ≈ **1,330 KV writes**.

Verified limit: Workers Free is **1,000 KV writes/day, namespace-wide**, resetting 00:00 UTC, and
"if you exceed any one of these limits, further operations of that type will fail with an error".
Workers Paid is 1M/month included then $5/M.

**The blast radius is worse than a slow-down.** When `put` starts rejecting:

1. `verifySigned` throws → `worker.js:70-71` top-level catch → JSON **500**.
2. `registration.js:106` sets `network: res.status === 0`, so a 500 is `network:false`.
3. `planclient.js:44` — `if (!res || !res.network) throw new PlanDenied(...)`.

A quota exhaustion therefore surfaces to the user as a **permanent licensing refusal**, not as a
retryable outage — for *every* user, because the budget is namespace-wide. `/register` breaks the
same way (`putDev` throws).

The irony is that `cursor.js:6-8` identifies this exact hazard and solves it for the cursor —
"a 400-probe plan would otherwise mean 400 writes, and KV's free tier allows 1,000 a day" — and
then `verifySigned` re-adds one write per step anyway.

Fixes, cheapest first:

- **Move the nonce out of KV.** The `Locks` DO already exists and its storage does not draw on the
  KV write budget. A `noncehit(deviceId, nonce)` method mirrors `rateHit` exactly.
- **Stop calling `/session` per chunk.** The verdict is already re-affirmed by `/plan/start` and is
  cached in `reg_verdict`. Re-check on a clock (every 10–15 min) or piggyback the verdict onto the
  `/job/checkpoint` response the run already makes — one round trip instead of two.
- **Coalesce the `seen:` write.** It is telemetry; once every few minutes is indistinguishable.
- **Exempt the counter routes from nonce replay protection.** `/job/checkpoint` and `/job/log` are
  idempotent-ish by construction (last-writer-wins counters, server-assigned `seq`); the 5-minute
  timestamp skew window already bounds replay to something harmless.

Add a **regression test** that asserts the *client* behaviour when a signed endpoint returns 500 —
today nothing pins that a backend error becomes a hard `PlanDenied`.

---

### F-A2 · HIGH — `/session` per chunk is also a read, latency and D1 cost

Each call: nonce get, `dev:` get, `seen:` get, `cfg` get, one `void:` get per bound RIN, plus
`computeVerdict` → `resolveEntitlement` (D1 `users`) → `getPlan` (D1 `plans`). ~8 subrequests and
two D1 queries **per chunk**, on the critical path of the run's chunk boundary. Free-plan reads are
100,000/day and bulk reads are billed per key. Fixing F-A1 by de-duplicating `/session` fixes this
too.

---

### F-A3 · HIGH — the sealed cursor carries the whole accepted plan (O(n²) traffic)

`cursor.js` seals the entire machine state, and `planner.js` accumulates decided chunks into
`st.out` (`planner.js:36`, `emit()` at :49). Each chunk JSON is ~220 B, so the cursor grows linearly
and is re-sent, re-encrypted, and re-hashed (client SHA-256 in `registration.js:102`, server
SHA-256 in `auth.js:35`) **on every step**. A 300-chunk / 600-step plan moves roughly 100 MB and
burns CPU on both ends for it.

`out` does not belong in the cursor. `job_chunks` already exists in D1 and `finishPlan` already
writes the whole plan transactionally; accepted chunks could be appended as they are decided (or
held in the job's DO), leaving the cursor to carry only `stack`, `pending`, `probes`, `step`. The
ordering guarantee that `planner.js:10-12` protects is preserved by `idx`, which the schema already
declares load-bearing.

---

### F-A4 · HIGH — no `ctx`, so nothing can use `waitUntil()`

```js
// lead-worker/worker.js:67
async fetch(request, env) {
```

`scheduled(event, env)` likewise. Every best-effort write — `errlog`, `audit`, `mirrorDevice`,
the `seen:` telemetry put, `stampJobs` — is `await`ed inline and adds its latency to the user's
response. The skill's rule is explicit: post-response work goes in `ctx.waitUntil()`, and `ctx` must
not be destructured (`const { waitUntil } = ctx` loses `this` and throws "Illegal invocation").

This is a one-line signature change plus `ctx.waitUntil(errlog(...))` at ~20 call sites, and it is
the single cheapest latency win in the Worker.

---

### F-A5 · MEDIUM-HIGH — full-namespace `listPrefix` scans, one of them on a user-facing route

`lib/kv.js:11-20` pages the whole prefix then bulk-gets in 100s. Callers:

- `/api/stats` — three full scans + a key scan (`admin.js:28-31`)
- `/api/users`, `/api/insights`, `/export`, `/backup` — `dev:` scan **and** `seen:` scan
- `scheduled()` — the same, daily (`worker.js:77`)
- **`/rin-request` — `extension.js:202` scans every `req:` record ever written, to dedupe.**

The last one is the problem: it is an *extension-facing* endpoint whose cost grows with total
lifetime request volume, and `req:` / `bug:` records are written with **no `expirationTtl`**
(`extension.js:205`, `extension.js:233`), so they accumulate forever. `/api/user` action `delete`
scans both prefixes too.

Bulk reads are billed **per key**. At 5,000 devices a single `/api/users` load costs ~10,000 key
reads; ten dashboard refreshes exhaust the free 100,000/day read budget. Subrequests are not the
wall (Free allows 1,000 to internal services per invocation) — reads, list operations (1,000/day
free) and CPU time are.

Fixes: replace the `/rin-request` dedupe scan with a deterministic key
(`reqidx:<deviceId>:<rin>` with a TTL), give `req:`/`bug:` a TTL or archive resolved ones, and back
the admin lists with the D1 tables SPEC-017 already built rather than KV scans.

---

### F-A6 · MEDIUM — unbounded body read before authentication

`plan.js:34`, `extension.js:145`/`:192`/`:211`, `exportmap.js:29` all do `await request.text()`
*before* `verifySigned`. `/register` (`extension.js:16`) does `await request.json()` with no
authentication at all. Worker isolate memory is 128 MB; the request body limit is 100 MB.

A `content-length` guard before the read — reject > 256 KB generally, with a higher ceiling on
`/plan/step` until F-A3 shrinks the cursor — closes this in a few lines. The skill flags exactly
this shape (`await …text()` on unbounded data) as a memory-exhaustion anti-pattern.

---

### F-A7 · MEDIUM — `host_permissions` lists a host no privileged context uses

```json
// manifest.json:14
"https://api-portal.invoicing.eta.gov.eg/*",
```

That origin appears only in `src/api/sources.js:2-3`, which is bundled into the **MAIN-world**
content script. MAIN-world code runs in the page's JS context: its `fetch()` is a page fetch,
governed by the portal's own CORS and CSP, not by extension host permissions. (That is precisely
why `csp-shim.js` and the bg.js relay had to exist.)

`https://invoicing.eta.gov.eg/*` **is** required — `bg.js:31` issues a credentialed cross-origin
fetch from the service worker. The api-portal entry is dead breadth on the CWS permission
justification form. Verify against a staging build with it removed, then drop it.

---

### F-A8 · MEDIUM — `window.ExcelJS` is a page-controllable object that receives every invoice row

`main.js:9-11` deliberately keeps the orchestrator (and its readwrite `FileSystemDirectoryHandle`)
out of `window`, "so a page-XSS / compromised portal asset [cannot] reach the export folder". Good
reasoning — but the export path then reads a builder back **out** of that same shared global:

```js
// src/core/orchestrator.js:163, :291
if (!window.ExcelJS) { … }
const r = renderWorkbook(window.ExcelJS, records, plan.source, opts);
```

`records` is every fetched document, details included. Any portal script that runs before
`document_idle` can define `window.ExcelJS` first (the vendored bundle assigns unconditionally, but
a page script can re-shadow it afterwards at any time) and receive the lot. `csp-shim.js:7` creates
a second such global.

Two fixes, and the second retires 1.1 MB of vendored code:

1. Capture `const XL = window.ExcelJS` once at bundle load and use the captured reference.
2. Better — move chunk rendering onto `src/export/xlsxstream.js`. F-15 already proved that writer
   against real Excel for merge output; using it for chunks too removes `vendor/exceljs.min.js`,
   `csp-shim.js` and this finding in one change.

---

### F-A9 · MEDIUM — ~1.9 MB of JS injected into every portal page load

`dist/etaBulk.js` (718 KB) + `vendor/exceljs.min.js` (1.1 MB), MAIN world, `document_idle`,
matching `https://invoicing.eta.gov.eg/*` — every path. Roughly 210 KB of the bundle is
`src/ui/fonts.js` (base64 typefaces), and `installFonts()` runs at `mountUI()` whether or not the
user ever opens the drawer.

Cheap wins: narrow `matches` to the portal paths that actually host the app; make `installFonts()`
lazy on first drawer open (it is already idempotent and best-effort, so this is a call-site move);
and drop ExcelJS per F-A8.

---

### F-A10 · LOW-MEDIUM — `portalRenew` can orphan a background tab

```js
// bg.js:35-43
tab = await chrome.tabs.create({ url: PORTAL_ORIGIN + '/', active: false });
await new Promise((r) => setTimeout(r, RENEW_DWELL_MS));   // 12 s, bare setTimeout
…
finally { if (tab && tab.id != null) { try { await chrome.tabs.remove(tab.id); } catch {} } }
```

In practice this survives: `chrome.tabs.create` is an extension API call, which resets the SW's 30 s
idle timer, and the pending `sendResponse` holds the message channel open. But a bare `setTimeout`
is not itself a lifetime guarantee — a browser-initiated SW restart, an extension reload, or a crash
during the dwell skips the `finally` and leaves a background portal tab open forever. Renew fires
every 30 min (`session.js:26`) for the length of an overnight run, so the failure repeats.

Hardening: write the tab id to `chrome.storage.session` before the dwell and sweep any stale id at
the top of the next `portalWarm`/`portalRenew`. (This is the only place in the extension where the
service worker holds state across an `await` at all — see §3.)

---

### F-A11 · LOW — admin console has no security headers; CORS is `*` on `/api/*`

`admin.js:14` serves the 74 KB dashboard **unauthenticated** (deliberate — the token is entered
client-side and held in `sessionStorage`, `dash.html:1033`, which is the right call). But the
response carries no `X-Frame-Options` / `frame-ancestors`, no CSP, no `Referrer-Policy`, and
`util.js:5` sends `Access-Control-Allow-Origin: '*'` on every route including `/api/*`.

The extension never calls `/api/*` — only `/register`, `/session`, `/plan/*`, `/job/*`,
`/rin-request`, `/bug`, `/export/mapping`. Scoping the wildcard to the extension routes and adding
`frame-ancestors 'none'` to `/admin` costs nothing and shrinks the surface around a console that,
per STATE.md, "can kill every installation" behind one shared bearer token (A1 is the real fix).

Related, and correct but worth writing down where operators will see it: **`/backup`
(`admin.js:321`) returns every device's `clientKey`** — the HMAC key that authorises signed calls.
It has to, to be a restorable backup. The backup file is a credential store and should be handled
as one.

---

### F-A12 · LOW — `/api/health` writes a KV key on every call

`admin.js:98` does `LEADS.put('health:probe', …)` to prove KV is writable. Correct as a
self-check, but if anything polls it, each poll spends one of the 1,000 daily writes. Gate it
behind a query parameter, or read-only by default.

---

## 2. Untested that matters

| Gap | Why it matters |
|---|---|
| **`src/core/planclient.js` — zero tests** | This is the module that *replaced* `chunker.js` in the shipped bundle. Untested: `insist()`'s backoff and its retry-forever-vs-hard-fail decision (`:44`, the exact branch F-A1 lands on), `PlanDenied` vs `PlanStopped`, and the "server ended the conversation without a plan" guard at `:96`. `test/planner.test.mjs` proves the *server* machine matches `chunker.js`; nothing drives the client conversation. |
| **`bg.js` / `bridge.js` — zero tests** | The origin pin and the `redirect:'manual'` off-origin guard (`bg.js:63-72`) are documented as security controls, and the bridge's "only the KIND crosses" contract (`bridge.js:17`) is a deliberate confinement. All three are pure functions of a message plus a `fetch` stub — a small harness would cover them, and the existing `smoke-hooks.mjs` pattern shows how. |
| **The worker smoke suite is not in CI** | `.github/workflows/test.yml` runs `npm test` and `npm run build` only. `lead-worker/smoke-worker.mjs` (109 checks — the gate, the verdict, the DO fallback, the D1 routes, the audit trail) never runs on push. One extra step: `- run: cd lead-worker && node smoke-worker.mjs`. |
| **Client behaviour on a backend 5xx** | Nothing pins what the drawer/run does when a signed endpoint returns 500 rather than failing to connect. Given F-A1 turns a quota exhaustion into a 500, this is the single highest-value new test. |
| **`src/core/mergeout.js` — zero tests** | Smaller, but it is on the output path F-15 rewrote. |

---

## 3. Already right — do not "fix" these

- **The MV3 service worker is genuinely stateless.** `bg.js` holds no module-level mutable state,
  registers no alarms, and nothing in the run loop assumes it stays alive — the loop lives in the
  page, and the SW is woken per message. This is the most common MV3 mistake and it is absent here.
  (F-A10 is the one place state crosses an `await`, and it is 12 seconds.)
- **The relay cannot be repurposed.** `bg.js` pins the exact backend origin *and* refuses off-origin
  redirects (`:63-72`); the warm/renew path sends only a `kind` across the bridge (`bridge.js:17`)
  so the page can never turn it into a general fetch or tab-open primitive. Both reasons are in the
  comments.
- **`manifest.json` has no `permissions` array at all** and no `web_accessible_resources`. Least
  privilege is real here (modulo F-A7). `minimum_chrome_version: 111` correctly matches the MAIN-world
  content-script requirement.
- **`FontFace(name, ArrayBuffer)` is the right trick and for the stated reason** — the constructor
  performs no fetch, so `font-src` never applies. `installFonts()` is idempotent, swallows every
  failure, and the CSS stacks keep system fallbacks (`drawer.js:246-267`, `:50-55`). The only cost
  is bundle weight (F-A9).
- **`csp-shim.js`** is a minimal, eval-free fix for a real regenerator-runtime × `unsafe-eval`
  interaction, and it keeps the vendored bundle pristine.
- **`build.mjs` keeps the three target-dependent facts in step** (bundle `LEAD_URL`, bg.js pinned
  origin, manifest `host_permissions`) and fails loudly on a malformed URL rather than shipping a
  silently-broken gate. `package-ext.mjs` refuses to zip a staging build, twice.
- **The `Locks` DO is written correctly**: `extends DurableObject`, `this.ctx` / `this.env`, and
  `blockConcurrencyWhile` used *precisely* where an external KV read inside the critical section
  would otherwise reopen the input gate (`locks.js:22-25`) — and deliberately **not** used in
  `rateHit`, where the input gate alone suffices. That distinction is usually got wrong.
- **Crypto hygiene**: `ctEq` constant-time compare for both the admin bearer token and the HMAC
  signature; `crypto.getRandomValues` throughout, no `Math.random()`; secrets via
  `wrangler secret put`, none in config or source; the admin token is header-only and never read
  from the query string (`auth.js:45-53`).
- **The cursor is AES-GCM with `jobId` as AAD**, and `unseal` returning `null` is explicitly never
  treated as empty state (`cursor.js:51-56`) — the failure that would let a client declare its own
  plan.
- **`finishPlan` and `appendEvents` use `D1.batch`** for real transactional atomicity, with the
  half-written-plan hazard written down (`jobs.js:47-49`).
- **D1-over-KV for jobs (ADR-002) is the right call**, and the write-budget arithmetic at the top of
  `schema.sql` is exactly the reasoning F-A1 says was not carried through to the nonce.
- **`observability` enabled with `invocation_logs`**, `compatibility_date` recent, `nodejs_compat`
  set, per-environment KV/D1/DO bindings repeated (they do not inherit) with the two TOML traps
  recorded in comments.
- **Spreadsheet formula injection is neutralised** in the CSV export (`admin.js:301`).
- **`errlog` has a per-isolate write budget** (`audit.js:66-70`) and is honest in the comment that
  it is per-isolate rather than global.
- **`computeVerdict` is one function serving both `/session` and `/plan/start`**, with the
  fail-open-drift hazard spelled out (`verdict.js:5-11`). That is the right shape for a gate.
- **The audit trail's `SECRET_KEY` scrubber** exists specifically to stay true when someone adds a
  detail field in a hurry (`audit.js:32-36`).

---

## 4. Suggested order of work

1. **F-A1** — nonce off KV (or `/session` de-duplicated). Everything else is theoretical until this
   one is fixed; it is a hard service-wide outage on the free plan and it is reachable by one user
   doing one export.
2. **F-A4** — add `ctx`, move best-effort writes to `waitUntil`. Mechanical, low risk, immediate
   latency win, and it makes F-A1's remaining writes cheaper to live with.
3. **CI: add the worker smoke step**, then write the two missing test files (`planclient`, and the
   500-response behaviour). Do this before the remaining changes, not after.
4. **F-A6** (body size guard) and **F-A5** (`/rin-request` dedupe key + TTLs) — both small, both on
   user-facing paths.
5. **F-A3** — move `out` out of the cursor into `job_chunks`. Larger; needs the equivalence tests
   re-run, since ordering is load-bearing.
6. **F-A8 + F-A9** together — retire ExcelJS in favour of `xlsxstream.js`, lazy-load the fonts,
   narrow `matches`. One change removes a 1.1 MB dependency, a page-controllable global, and
   `csp-shim.js`.
7. **F-A7**, **F-A11**, **F-A12**, **F-A10** — cheap hardening, any time.
