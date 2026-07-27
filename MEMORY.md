# ETA Bulk Export — Project Memory / Handoff

> Handoff doc for a fresh Claude Code terminal session. Read this top-to-bottom before touching code.
> Last updated: end of the session that built the managed backend, the Durable Object, the full security
> audit fixes, and the registration-form change.

---

## 0. TL;DR — where things stand

- **Product:** `ETA Bulk Export` — a Chrome MV3 extension that bulk-exports the signed-in user's OWN
  Egyptian Tax Authority (`invoicing.eta.gov.eg`) e-invoices / e-receipts to Excel/JSON, past the portal's
  per-search cap. Plus a **managed backend** (Cloudflare Worker + admin dashboard) that gates the tool
  behind a free one-time registration and lets the owner lock/kill/void/manage users.
- **Two deployables:**
  1. **The extension** — `cleanroom/` (built to `dist/etaBulk.js` + `bg.js` + `bridge.js` + `manifest.json`).
  2. **The backend** — `cleanroom/lead-worker/worker.js` (Cloudflare Worker: API + admin dashboard + Durable Object).
- **Status:** All code written, builds clean, **70/70 tests pass**, `dist` is ASCII-clean (0 non-ASCII).
  Extension is packaged. **The user must REDEPLOY the Worker and REBUILD/RE-ADD the extension** to get the
  latest changes (see §8 Deploy). The currently-deployed Worker is an OLDER version.
- **Owner:** Omar Soliman (PwC indirect-tax consultant). Cloudflare account subdomain: `omsoliman95`.

### ⚠️ HARD CONSTRAINT (user instruction — do not violate)
**Never reference, echo, or use as an example the user's real ETA portal data** (their real RIN / tax
registration number, email, phone, company name). Earlier in the project these were read live to confirm
where the RIN comes from; the user then said *"don't refer to any of the data you got ever even as example."*
Use obviously-fake placeholders (e.g. `123456789`, `ops@acme.example`) in any test/mock/doc.

---

## 1. What the tool does (the extension)

- Injected as a **content script on `https://invoicing.eta.gov.eg/*`**. Renders a Shadow-DOM drawer (pill →
  drawer UI) for configuring and running a bulk export.
- Talks to the portal API at `https://api-portal.invoicing.eta.gov.eg/api/v1` using the portal's own
  `access_token` (read from `localStorage.USER_DATA.access_token`). RIN comes from
  `localStorage.USER_DATA.profile.TaxRin`.
- **Chunking engine** (`src/core/chunker.js`): the portal caps each query at ~10,000 docs, so the exporter
  recursively splits the date range (year → month → day → sub-day submission-time bisection) until each
  chunk is under the cap, then paginates each chunk. Writes per-chunk `.xlsx` to a user-picked output folder
  (File System Access API), with a durable `eta_failures.jsonl` log, crash-resume (`eta_progress.json`),
  and an in-tool "merge to one workbook" + "repair" step.
- **Clean-room:** written from scratch, no third-party gated code. Vendored ExcelJS (MIT) + JSZip.

### Registration gate (managed access)
- When `LEAD_URL` is set (it IS now), a **full-screen registration page** takes over the drawer until the
  user registers. After registering, the gate disappears and the tool shows directly (no scroll).
- Registration form: **auto-detects ONLY the TIN** (read-only field), user types Name / Email / Phone /
  Company + consent. (Changed this session — email/phone/company are NOT pre-filled from the portal anymore.)
- Server-authoritative: after register, the extension does HMAC-signed `/session` check-ins ("pulses") so
  the backend can enforce lock / kill / version-block / void / allow-list live.

---

## 2. Architecture (READ THIS — non-obvious)

### The CSP / network bridge (why bg.js + bridge.js exist)
The ETA portal has a **strict CSP** (no `unsafe-eval`; `connect-src` allows only ETA hosts). Consequences:
- The content script runs in **`world: MAIN`** (needed to read `USER_DATA`/token from the page). A MAIN-world
  `fetch()` to the `workers.dev` backend is **blocked by the page CSP**. Also ExcelJS's regenerator-runtime
  would `eval` — blocked — so `csp-shim.js` pre-creates `regeneratorRuntime` before ExcelJS loads.
- **Fix:** backend calls are relayed off the page:
  `MAIN bundle → window.postMessage → bridge.js (ISOLATED, document_start) → chrome.runtime → bg.js (service worker) → fetch`.
  A service worker is NOT bound by page CSP. `bg.js` **pins the destination to the exact backend origin**
  (baked from `LEAD_URL` at build time) so the relay can't be abused to exfiltrate to another worker.
- **Manifest** therefore has: `background.service_worker = bg.js`, a second content script `bridge.js`
  (`world: ISOLATED`, `run_at: document_start`), the MAIN bundle (`document_idle`), and
  `host_permissions` including `https://eta-bulk-leads.omsoliman95.workers.dev/*`.
- **Gotcha:** after reloading/re-adding the extension, already-open ETA tabs run orphaned content scripts →
  `chrome.runtime.sendMessage` throws **"Extension context invalidated"**. This is EXPECTED and harmless
  (session falls back to grace). **Always reload the ETA portal tab after re-adding the extension.**

### Backend data model (KV namespace `LEADS`, id `7d039a655c434302a5e8fcae6a5450d0`)
- `dev:<deviceId>` — the user/lead record: `{ deviceId, clientKey, name, email, phone, company, taxpayerName,
  boundRins[], features[], quota, locked, killed, superadmin, emailVerified, version, country, firstAt, count }`.
- `seen:<deviceId>` — volatile telemetry `{ lastSeen, lastRin, version }`, written by `/session` ONLY
  (so a check-in can never clobber admin-owned fields on the dev record). Admin reads merge it via `withSeen()`.
- `email:<email>` — index → `[deviceId, …]`.
- `void:<rin>` — RIN blacklist.
- `rinowner:<rin>` — **legacy** primary-owner claim (KV fallback path only; superseded by the Durable Object).
- `req:<id>` / `bug:<id>` — RIN requests / bug reports.
- `cfg` — `{ globalKill, defaultQuota, minVersion, killedVersions[] }`.
- `nonce:<deviceId>:<nonce>` — single-use HMAC nonce (TTL 360s, anti-replay).
- `rl:<ip>:<hour>` — legacy KV rate-limit bucket (fallback path only).

### Durable Object `Locks` (atomic coordination — the real fix for KV's lack of compare-and-set)
- Class `Locks extends DurableObject` in `worker.js`, bound as `LOCKS`, migration `new_sqlite_classes=["Locks"]`.
  **Free on the Workers Free plan.** Created automatically on `wrangler deploy`.
- One instance **per RIN** (`idFromName('rin:'+rin)`) → `claimRin(deviceId, rin)` = atomic first-writer-wins
  ownership (wrapped in `blockConcurrencyWhile` because `#seed`'s KV read would otherwise reopen the input gate).
  `#seed` lazily adopts any pre-DO `rinowner:` KV ownership so migration doesn't strand existing claims.
- One instance **per IP** (`idFromName('rl:'+ip)`) → `rateHit(40, 3600000)` = atomic fixed-window limiter,
  self-cleaning via `alarm()`.
- **Every DO use has a KV fallback** (`if (env.LOCKS) … else … KV`) so the Worker still runs before the migration.
- Helpers: `rinOwnerGet` / `rinClaim` / `rinRelease` route to DO-or-KV. `claimRin` is called at bind time in
  `/register`, `addRin`, and request-approval; `rinRelease` on `removeRin`/`delete`.

### Backend endpoints (`worker.js`)
- **Extension (CORS; `/session`,`/rin-request`,`/bug` are HMAC-signed):** `POST /register`, `POST /session`,
  `POST /rin-request`, `POST /bug`.
- **Admin (`Authorization: Bearer <ADMIN_TOKEN>` header ONLY — never `?token=`):** `GET /admin` (dashboard),
  `GET /api/stats|users|requests|bugs|voids`, `GET /api/rin?rin=`, `POST /api/user` (lock|unlock|kill|revive|
  super|unsuper|setQuota|addRin|removeRin|setFeatures|delete), `POST /api/request|bug|void|config`, `GET /export` (CSV).
- HMAC: `hmacHex(clientKey, ts\nnonce\nPOST\npath\nsha256(body))`, headers `x-device-id/x-ts/x-nonce/x-signature`,
  300s skew window, single-use nonce.
- **Superadmin:** works on ANY account — bypasses its own lock + void + RIN allow-list. Only global kill /
  its own killed flag / version block still stop it.
- **Version kill switch:** extension sends its `version` (baked at build); `/session` returns
  `reason:'update_required'` if `< cfg.minVersion` or in `cfg.killedVersions` (numeric compare, fail-closed
  when a kill-list is set and the client omits its version).

---

## 3. Build / test / package (commands)

From `cleanroom/`:
- `npm run build` → esbuild bundles `src/main.js` → `dist/etaBulk.js` (IIFE, `charset:'ascii'`,
  `target chrome111`). **Also**: bakes `__EXT_VERSION__` (from manifest version) into the bundle, AND
  **generates `bg.js`** from `src/bg.js` by injecting `new URL(LEAD_URL).origin` (read from
  `src/core/registration.js`). So `LEAD_URL` is the single source of truth; `bg.js` origin auto-follows it.
- `npm test` → `cross-env TZ=Africa/Cairo node --test` → **70 tests** (chunker, client, merge, parity,
  repair, serialize, store, token, tz, + the `gate.test.mjs` grace regression suite).
- `npm run package` → build + zip runtime files → `dist-package/eta-bulk-export-v0.1.0.zip` (11 files).
- `npm run package:source` → reviewer source zip.
- **INVARIANT:** `dist/etaBulk.js` must have **0 non-ASCII bytes** (portal is UTF-8-strict). Check:
  `node -e "const b=require('fs').readFileSync('dist/etaBulk.js');let n=0;for(const c of b)if(c>127)n++;console.log(n)"`.

Worker syntax check (no build step — wrangler deploys `worker.js` as-is):
`cd lead-worker && cp worker.js _c.mjs && node --check _c.mjs && rm _c.mjs`.
> NOTE: `worker.js` trips ripgrep's binary heuristic (the big inline dashboard HTML string). Use `Read`
> (with offsets) or `node -e` to inspect/search it, not `Grep`.

---

## 4. Everything we did this session (chronological-ish)

1. **Ported v62 invoice fields**, fixed a drawer busy-lock ship-blocker, hardened for a big run (token
   pre-expiry pause, durable `eta_failures.jsonl` reconciliation, 429 Retry-After+jitter, TZ-pinned CI).
2. **Shippable batch:** real icons, 1280×800 screenshots + promo, reviewer source zip,
   `minimum_chrome_version:111`, version guard.
3. **4 features:** receipts one-pass (API hard-caps 3000/query; already one-pass), per-chunk progress bar,
   official ETA PDF export (`GET {apiBase}/documents/{uuid}/pdf` + `/receipts/{uuid}/pdf`), removable-columns UI.
4. **Ultra code review** (multi-agent) → fixed 2 blockers (sub-minute chunk filename collision; DST fall-back
   double-count) + ~9 HIGH + ~10 MEDIUM.
5. **Managed backend + free lead-capture gate:** registration form (name/email/phone/company + consent),
   one-taxpayer-per-device binding, RIN match-verify, bug tracker, "request another RIN", server-authoritative
   lock/kill/features/void/superadmin, email validation (Disify, fail-open), Cloudflare KV.
6. **Cloudflare config review** (`/cloudflare`): bumped `compatibility_date` to current + `nodejs_compat`,
   enabled `[observability]` logs, documented KV eventual-consistency + subrequest limits.
7. **Fixed the "Network error":** MAIN-world fetch was CSP-blocked → built the **bg.js + bridge.js** relay
   (see §2). Root cause of a later failure: `LEAD_URL` was never set (was `REPLACE-ME`) → set it to
   `https://eta-bulk-leads.omsoliman95.workers.dev`.
8. **Fixed "stuck on Submitting…":** registration state moved from IndexedDB to **localStorage** (synchronous,
   no transaction/quota failure); submit handler wrapped in try/catch/finally.
9. **Version kill switch** added (min version + killed versions).
10. **Fixed the gate "scroll down" bug:** `.gate{display:flex}` overrode the `hidden` attribute → added
    `[hidden]{display:none!important}` globally (this class of bug — CSS `display` beating `[hidden]` — bit
    `.gate`, `#modal-root`, and the dashboard Sign-out button; the global rule kills it everywhere).
11. **FULL SYSTEM AUDIT** (6-dimension multi-agent, 23 verified findings) → fixed 19 (see §5), documented 4
    inherent ones (see §7).
12. **Built the `Locks` Durable Object** (atomic RIN ownership + rate limit) + adversarial review of it →
    fixed a blocker (migration strands legacy KV ownership), a high (my backfill reopened the input-gate race
    → `blockConcurrencyWhile`), and 3 more.
13. **Delete cleanup + deregister:** deleting a user now removes their req/bug/seen/email-index too (fixed the
    "delete shows temp pending" leftover); `/session` distinguishes a deleted device (→ client wipes creds,
    gate reappears) from a transient auth blip (→ grace).
14. **Registration form change (latest):** auto-detect ONLY the TIN (read-only), no portal pre-fill of
    email/phone/company, removed the "type your RIN" input + its validation.

---

## 5. Security/correctness fixes applied (from the audits — all verified)

**HIGH**
- Chunker `ss()` sub-ms gap → **silent row loss**: switched to inclusive shared boundary (dedup by UUID on merge).
- Version kill switch was **evadable** (omit/`0.1.00` variant) → fail-closed + numeric compare.
- **Quota 0 was treated as 1** (`|| 1` → `?? 1`) everywhere.
- **RIN account-takeover** via an email-based reclaim I'd added → REMOVED; re-binding goes through admin only.
- **`/session` blind full-record rewrite** silently reverted admin kill/lock/quota → telemetry moved to a
  separate `seen:` key; admin display merges it via `withSeen()`.
- **rinowner double-claim race** + **rate-limit non-atomic** → fixed by the Durable Object (KV has no CAS).

**MEDIUM**
- Resume after reload threw `NotAllowedError` (folder handle in 'prompt' state) → `fs.ensurePermission` before
  `readProgress` + drawer `resume` try/finally.
- HMAC **replay** (nonce never checked) → single-use nonce in KV + reject non-numeric `ts`.
- `regId`/`email` unbounded → length caps (prevented admin-dashboard memory-exhaustion via `listPrefix`).
- N+1 KV scans → `listPrefix` uses **bulk get** (100 keys/subrequest).
- Sign-out button visible on login screen → global `[hidden]!important`.

**LOW/NIT** — hyperlink target sanitize (`sanitize.js` scrubs `v.hyperlink`), RIN-squat guard (claim only when
bound), narrowed `host_permissions` to the exact origin, dashboard tab a11y (`aria-selected`/`role=tabpanel`),
constant-time admin-token compare, void-propagation copy ("within ~60s"), `/bug` uses live RIN from `seen:`.

---

## 6. Client fixes recap (registration/gate specifics)
- Registration state (device id, creds, cached verdict) in **localStorage** under `etaBulk_` prefix
  (`lsGet/lsSet/lsDel`). NOT IndexedDB (IndexedDB is only for large File System Access handles in `fs.js`).
- `graceVerdict(cached, rin)` (pure, exported, tested): offline grace reuses the server's LAST verdict
  **verbatim** — never upgrades a deny to allow, only for the same logged-in RIN. Tests in `test/gate.test.mjs`.
- `/session` reasons the drawer handles: `killed`, `global_stop` (reversible pause), `locked`, `rin_voided`,
  `rin_not_allowed`, `no_usable_rin`, `update_required` (⬆️ update required). Server also returns
  `not registered` for a deleted device → client wipes creds.

---

## 7. Known limitations — deliberately NOT fixed (inherent, documented)
1. **Client-side kill-switch is defeatable by the account owner.** The gate is server-decided but
   client-enforced; a user who edits their own extension / injects a page script can forge an "allowed"
   verdict. It exposes nothing they lack (export is RIN-gated to their own data, and ETA data goes
   page→api-portal directly, never through the backend, so the operator can't gate it server-side).
2. **Void enforcement has a ~60s KV cross-POP propagation window** (self-healing). Move `void:` to a DO if
   instant global enforcement is ever required.
3. **`clientKey` (device HMAC secret) lives in page-origin localStorage** (and transits one postMessage on
   register). Same exposure as any same-origin script already has; true fix = sign in the SW, never expose
   the key to MAIN world (bigger refactor).

Optional future hardening also noted: Cloudflare WAF Rate-Limiting rule on `POST /register` (belt-and-braces
on top of the DO limiter).

---

## 8. DEPLOY — exact steps (user does these; Claude CANNOT run `wrangler`, it needs their login)

### A. Backend Worker (gets the DO, delete-cleanup, deregister, ALL audit fixes)
```
cd cleanroom/lead-worker
npm install                 # gets wrangler locally (first time)
npx wrangler login          # once, opens browser
npx wrangler secret put ADMIN_TOKEN   # once — long random string = dashboard password
npx wrangler deploy         # deploys worker.js AND creates the Locks Durable Object via the migration
```
- KV namespace already exists and is wired in `wrangler.toml` (id `7d039a655c434302a5e8fcae6a5450d0`).
- The DO migration runs automatically on deploy — no extra command.
- Admin dashboard: `https://eta-bulk-leads.omsoliman95.workers.dev/admin` → enter the `ADMIN_TOKEN`.

### B. Extension
```
cd cleanroom
npm run build && npm run package
```
- `LEAD_URL` is already set (in `src/core/registration.js`) to the deployed Worker, so the gate is ON and
  `bg.js` is auto-pinned to that origin on build.
- Load: `chrome://extensions` → **remove** ETA Bulk Export → **Load unpacked** the `cleanroom` folder.
  (Remove + re-add, not just reload — the background SW + content scripts changed.)
- **Then reload the ETA portal tab** (or open a fresh one) to avoid "Extension context invalidated".

### Still TODO by the user (not code — config)
- Set the **privacy-policy URL** in `src/ui/drawer.js` (search `REPLACE-with-your-privacy-url`) and rebuild.
- The consent line hardcodes "Omar Soliman" as data controller (intended).

---

## 9. File map (key files under `cleanroom/`)

**Extension runtime**
- `manifest.json` — MV3: MAIN bundle + ISOLATED `bridge.js` + `background.service_worker: bg.js`;
  host_permissions incl. the exact worker origin.
- `src/bg.js` → built to `bg.js` (root) with `LEAD_ORIGIN` baked in. Service-worker fetch proxy, origin-pinned.
- `bridge.js` — ISOLATED relay (window.postMessage ↔ chrome.runtime).
- `csp-shim.js` — pre-creates `regeneratorRuntime` so ExcelJS doesn't eval under CSP.
- `src/core/registration.js` — `LEAD_URL` (single source of truth), `gateEnabled`, HMAC signing, `bridgeFetch`,
  `register/session/graceVerdict/requestRin/reportBug`, `taxpayerId/taxpayerName/portalProfile`, localStorage state.
- `src/ui/drawer.js` — the Shadow-DOM drawer + registration gate + all UI. CSS has `[hidden]{display:none!important}`.
- `src/core/orchestrator.js`, `chunker.js`, `token.js`, `keepalive.js`, `store.js`, `merge.js`, `repair.js`,
  `fs.js` (IndexedDB handles + File System Access); `src/api/client.js`, `sources.js`;
  `src/export/xlsx.js`, `sanitize.js`, `dates.js`, `codes.js`.
- `build.mjs` (bakes version + generates bg.js), `package-ext.mjs`, `package-source.mjs`.
- `test/` — 70 node:test cases (`*.test.mjs`), incl. `gate.test.mjs`.

**Backend**
- `lead-worker/worker.js` — the Worker: helpers + `Locks` DO class + `export default { fetch }` + the `DASH`
  dashboard (HTML+CSS+inline JS as a template literal at the bottom).
- `lead-worker/wrangler.toml` — name `eta-bulk-leads`, KV `LEADS`, DO `LOCKS` + migration, observability,
  `compatibility_date 2026-07-09` + `nodejs_compat`.
- `lead-worker/README.md` — deploy + admin capabilities + access rules.

**Docs/compliance:** `privacy.html`, `STORE.md`, `PUBLISHING.md`, `PRIVACY.md`, `LICENSE`, `NOTICE`.

**SEPARATE, do not touch:** `C:/CCProject/SAPGETALL/eta-extractor/` is a different project ("ETA Extractor
v6.0", `eta-license.omsoliman95.workers.dev`). It was briefly merged then fully reverted — keep it separate.

---

## 10. Gotchas / conventions for the next session
- **Privacy constraint** (§0) — non-negotiable.
- `worker.js` breaks `Grep` (binary heuristic) — use `Read`/`node -e`.
- `dist/etaBulk.js` must stay ASCII-clean; the worker/dashboard can use Unicode freely (deployed via wrangler).
- `Bash` tool is sandboxed — outbound `curl` can be stubbed/unreliable; use the Cloudflare MCP tools
  (`workers_list`, `search_cloudflare_documentation`, `kv_*`) or `WebFetch` for real network facts.
- Claude cannot run `wrangler deploy` (needs the user's Cloudflare login) or create accounts / enter secrets.
- The multi-agent **Workflow** tool was used for every audit; re-run a focused adversarial pass after any
  security-relevant change and fix only what survives skeptic verification.
- Preview verification of the dashboard: build a mock-backed HTML from the `DASH` template
  (`scratchpad/build-preview.js`) and drive it with the browser preview tools; the extension drawer can be
  previewed via `cleanroom/screenshot.html` (`#gate` forces the registration page).

## 11. Suggested next steps (open items)
- User: redeploy Worker + rebuild/re-add extension (§8), then smoke-test register → export → admin lock/kill/delete.
- Set the privacy-policy URL and rebuild.
- (Optional) Move `void:` to the DO for instant enforcement; add the Cloudflare WAF rate-limit rule for launch.
- (Optional) Chrome Web Store submission (assets/screenshots/source-zip already prepared).
