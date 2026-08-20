# Security & code review — ETA Bulk Export

**Date:** 2026-08-20 · **Scope:** extension (`cleanroom/`) + backend (`lead-worker/`) at `be3755d..HEAD`
**Method:** six independent reviewers, then an adversarial verification pass that tried to refute every
finding. Refuted items are not listed. Every claim below cites `file:line` that was opened and read.

---

## 1. Verdict

This is in decent shape. The parts that would normally sink a tool like this — the ETA OIDC token, the
invoice data itself, the admin console, the build pipeline — are genuinely well defended: no document
content ever leaves the user's browser (`lead-worker/src/routes/plan.js:96-130`), the service-worker relay
is origin-pinned with the redirect escape closed (`bg.js:88-103`), the admin dashboard escapes every
hostile string, D1 is fully parameterised, and the shipped bundle reproduces byte-for-byte from `src/`.

It is **not** safe to hand to other users as-is, because of one bug. `POST /register` is unauthenticated
and, when the submitted `deviceId` already exists, it hands the caller that device's live HMAC
`clientKey` and rewrites the record's owner — so anyone who learns a device id (from the admin bugs/requests
CSV, a support screenshot, a shared machine) can impersonate that user to the backend indefinitely, and
inherits `superadmin` if the record has it. That is the single most important thing to fix, and it is a
~15-line change.

Two other things deserve attention before wider distribution: the `"storage"` permission is missing from
`manifest.json`, so the SPEC-033 lockout defence that is documented as shipped is in fact inert; and the
split-detail sink silently drops late-appearing columns, which produces a quietly wrong tax deliverable.

---

## 2. Findings

### F-1 · HIGH — `/register` returns any device's HMAC key and lets a stranger take over its record

`lead-worker/src/routes/extension.js:56,63,70,79,140`

`known` (line 56) compares the submitted email against `prev.email`, but its only consumer is the
device-cap branch at line 63. Nothing refuses a registration whose `deviceId` already exists under a
*different* email. Line 79 reuses the victim record verbatim — `const dev = prev || {…}` — so
`clientKey`, `superadmin`, `boundRins`, `features` and `quota` all survive; only name/email/phone/company
are overwritten (80-82). Line 140 returns `clientKey` and `boundRins` to the caller. The device cap cannot
bite either: `allowedDevices = ent ? ent.deviceQuotaEff : Infinity` (line 70), and an attacker using a
fresh email has no D1 row. The RIN step does not block it — the 409 at line 104 fires only for an unbound
RIN owned by another device, which an attacker avoids by echoing the victim's own RIN or being over cap.
The route is unsigned, CORS `*` (`lib/util.js:5`), and needs only `{name,email,consent,registrationNumber,deviceId}`.

**Harm — to another user of the tool.** The stolen `clientKey` is the sole authenticator for `/session`,
`/plan/*`, `/job/*`, `/bug` and `/rin-request` (`lib/auth.js:32-36`). The attacker reads the victim's
`boundRins` (their tax registration numbers), their export history metadata and run-log lines, files bugs
and RIN requests under their name, consumes their plan, and — on a `superadmin` record — bypasses the RIN
void blacklist and the RIN allow-list entirely (`lib/verdict.js:22,45,49,52`). The owner rewrite also
mis-attributes the audit trail and CSV exports for a live account holding real RINs.

The precondition is satisfied by the project's own surfaces: the full `deviceId` is a column in the
requests and bugs CSVs (`routes/admin.js:304,308`), appears in the admin bug feed (`routes/portal.js:538`)
and has a copy button in the dashboard (`src/assets/dash.html:1876`) — while the tests deliberately assert
that `clientKey` never reaches those same surfaces (`smoke-worker.mjs:731,1113`). This route is a direct
bypass of the control the tests pin.

*Not exploitable via:* the failure log, which stores only a 12-char device-id prefix
(`lib/audit.js:74`); or a malicious in-page script, which already finds `clientKey` beside `deviceId` in
the same localStorage (`src/core/registration.js:94,126`). No invoice data and no ETA portal token are
reachable through this.

**Fix.** In `extension.js`, if `prev` exists with a non-empty `email` that differs from the submitted one,
return 409 ("this device belongs to another account — ask the admin to release it"). Return `clientKey`
only when `known` is true. On any accepted email change, rotate `clientKey` and clear `superadmin`. A real
device hand-over should be an audited admin action.

---

### F-2 · MEDIUM — `manifest.json` never requests `"storage"`, so the SPEC-033 lockout defence is inert

`cleanroom/manifest.json:12` · `src/bg.js:67,78-80` · `src/core/registration.js:86,89`

`manifest.json` has no `"permissions"` key at all — only `host_permissions` (lines 12-16) — and `build.mjs`
never adds one (its only manifest mutation is host-permission reconciliation, `build.mjs:58-69`). Chrome
does not expose `chrome.storage` without the permission, so `bg.js:67`'s
`chrome.storage.local.get(ID_KEY)` throws, the catch at `bg.js:78-80` returns `{ok:false}`,
`registration.js:86` collapses that to `null`, and `registration.js:89` swallows the `set` failure.
`idStore.get()` always returns null and `idStore.set()` is a permanent no-op in the shipped build.

**Harm — to a paying user.** SPEC-033 exists to stop the 2026-08-20 lockout: a portal re-login wipes page
localStorage, the extension mints a fresh device id, and re-registration is refused with "device limit
reached" (`lead-worker/src/routes/extension.js:66-75`) — or, worse, with `rin_claimed` 409 even when a
device slot is free (`extension.js:103-104`), because the old device still owns the RIN. That user is
permanently locked out of a tool they paid for, and the owner gets no signal because every failure path is
silently discarded. `test/identity.test.mjs:21-41` gives false assurance: it stubs `window.postMessage`
with an in-process store and never loads `bg.js` or touches `chrome.*`.

**Fix.** Add `"permissions": ["storage"]` to `manifest.json` (and to `build.mjs`'s reconciliation so it
cannot be dropped). Guard in `bg.js` with an explicit `if (!chrome.storage?.local)` reply, surface the
`{ok:false}` at `registration.js:86,89` instead of discarding it, and add a test asserting the manifest
declares every `chrome.*` namespace the generated `bg.js` dereferences.

---

### F-3 · MEDIUM — the split-detail sink silently drops any line column that first appears after a part is open

`src/export/chunkparts.js:62,71,72`

`openPart()` pins `writerCols = cols.slice()` (62) and every row is written as
`writerCols.map((c) => valueOf(rows[i], c))` (72). The only rotation trigger is the row cap (71) — column
growth is not one. Line columns are computed *per batch* from that batch's records
(`src/export/xlsx.js:111-152`: tax types, `itemsDiscount`, `serviceDeliveryDate`, FX columns, reference
columns), and the orchestrator feeds one batch per 2,000 documents into the same sink
(`src/core/orchestrator.js:514-524`). So a tax type or a first foreign-currency invoice appearing in batch
k+1 is written against batch k's narrower header and its values are discarded.

Reproduced against unmodified source: sink `{inlineMax:2}`, batch 1 = one tax-free invoice (opens a
29-column part), batch 2 = one invoice with `lineTaxableItems` T1 and `itemsDiscount`. Union has 32
columns; the part header has 29 and lacks T1, T1% and the discount column; both invoices land in that part.

**Harm — to the user filing the export, and to the counterparties whose amounts go missing.** The loss is
invisible. The summary workbook carries the full union (`orchestrator.js:531-535`), merge unions part
headers by name (`src/core/merge.js:138`) and writes `l[c] ?? ''` (`merge.js:193`), so the merged DETAILS
file shows an *empty* tax or discount cell — indistinguishable from a genuinely untaxed line. Nothing is
written to `eta_failures.jsonl` and no status line is emitted. The inline (non-spilled) path is safe
(`orchestrator.js:535-539`), and the merge drift guard (`merge.js:159-163`) only compares against a prior
incremental state, so neither catches it. `test/chunkparts.test.mjs:102-134` builds all four batches from
one record factory, so no column can ever first appear late.

Bounded by: the chunk must exceed `CHUNK_LINES_INLINE_MAX = 30000` line rows (`chunkparts.js:23`) to spill
at all, and the new column must first occur in a later batch before the 60,000-row rotation refreshes the
header. Line-heavy chunks that spill early are the exposure.

**Fix.** Make column growth a rotation trigger: in `add()`, after `cols = unionCols(cols, built.lineCols)`,
close the writer if `writer && cols.length !== writerCols.length`. Add a test with two batches whose
`lineCols` differ, asserting every value in `built.lineRows` appears in some part.

---

### F-4 · MEDIUM — the mass-403 guard divides by the whole chunk, so a late entity flip is diluted below the threshold

`src/core/orchestrator.js:501-518`

`massForbidden` fires on `forb >= 25 && forb >= processed * 0.25` (501-504, constants at 46-47), but
`processed` and `allFailed` are cumulative over every batch of the chunk (513-518) while a single batch can
contribute at most `BATCH_DOCS = 2000` (36). With the invoices cap at 10,000 (`src/api/sources.js:13`), the
final batch faces a threshold of 2,500 > the 2,000 it can supply — a flip confined to the last batch
*cannot* trip the guard. Reproduced: a 10,000-row chunk whose last 2,000 documents 403 produces one xlsx,
`doneIds ['c1']`, `failedIds []`, 2,000 lines in `eta_failures.jsonl`, and no mass-403 message. Worst case
is 2,499 documents dropped. The same 2,000-document flip in batch 1 fires instantly.

**Harm — to the user's deliverable.** A chunk is written short by up to 2,000 documents and marked done;
`store.scanDoneFromFolder` keys "done" on the file's presence (`src/core/store.js:93`), so Resume never
refetches it. Existing tests place forbidden uuids at the head only (`test/batchrun.test.mjs:40`), so the
tail case is uncovered. Receipts are not exposed (cap 3,000 — a full final batch still trips).

*Mitigating controls the finder did not credit:* `afterRenew` re-pins the entity within seconds of every
renewal (`orchestrator.js:116-127`), the chunk-boundary restore retries up to 3 times then hard-pauses
(379-396), the drop log is fail-closed — an unwritable `eta_failures.jsonl` deletes the chunk file and
fails the chunk (552-559) — the drop count appears in the run's terminal summary (611-612), and SPEC-028's
"Load failed UUIDs" button recovers the documents in one click (`src/ui/drawer.js:907-921`).

**Fix.** Evaluate the ratio per batch as well as cumulatively — trip when either
`massForbidden(failedRows, records.length + failedRows.length)` or the cumulative test crosses the share.
A flip is a burst; a windowed denominator is the right one. `MASS_FORBIDDEN_MIN = 25` keeps T-275's
6-forbidden trickle case unaffected.

---

### F-5 · MEDIUM — entitlement is keyed on a self-asserted, unverified email

`lead-worker/src/lib/verdict.js:31` · `routes/extension.js:17` · `lib/auth.js:11-19` · `users.js:742-744`

`ent = await resolveEntitlement(env, dev.email)` resolves plan, quota and device slots from
`SELECT * FROM users WHERE email = ?`, where `dev.email` is a string from the unsigned `/register` body.
The only screen is a Disify disposable/MX lookup that explicitly fails open (`lib/auth.js:11-19`) — no
confirmation link, no token. `personHeld` then counts RINs and devices across every record indexed under
`email:<address>` (`lib/kv.js:70-84`, index written at `extension.js:112-113`). Registration emails are not
secret: they are printed on the invoices this tool exports.

**Harm — to another user, and to the accuracy of the owner's console.** Registering as
`finance@bigclient.com` puts the attacker's device and RINs into that person's pool, so the victim's next
genuine browser is refused with `device_limit` (`extension.js:66-76`) and their next RIN bind is silently
skipped (`extension.js:102`). `USER_UPSERT_MERGE` overwrites the victim's name/company/phone in the admin
portal (`users.js:167-170`). Admin messages fan out to the attacker's device over the same email index
(`routes/portal.js:221-229`). The 403 refusal body leaks a stranger's device count and plan allowance to an
unauthenticated caller (`extension.js:75`). The sharpest variant is registering *first* under a
not-yet-registered person's address: the D1 row is created at `device_quota=1` and the real owner is then
permanently refused on their own email with no self-service remedy.

*Not a licence bypass, despite appearances:* `features` are never enforced server-side — no worker route
reads them, `/plan/start` gates only on `computeVerdict`'s `allowed` (`routes/plan.js:67-68`), and the
drawer re-applies them from the user's own localStorage (`src/ui/drawer.js:1451`). Raised quota is not
scarce either: every self-chosen identity gets a free 1-RIN/1-device plan (`users.js:69`). And the merge
cannot escalate: `superadmin` and `quota` bind from a fresh KV record the request body cannot set
(`extension.js:79-86`), `killed`/`locked` are sticky (`users.js:171-175`). No victim credential or data is
reachable. Already documented as accepted in `docs/specs/SPEC-020-activation-path.md:176-178,210,433`.

**Fix.** Issue a signed confirmation link at `/register` and have `resolveEntitlement` return null (free
tier) until the address is confirmed. Minimum viable: refuse to attach a new device to an email that
already has a D1 users row without admin approval, and never let a registration rewrite name/company/phone
on an existing row.

---

### F-6 · LOW — the planner's post-start routes carry no entitlement check

`lead-worker/src/routes/plan.js:134,167,180,201`

`/plan/start` and `/plan/uuids` call `computeVerdict` (67-68, 106-107). `/plan/step`, `/job/plan`,
`/job/checkpoint` and `/job/log` do not — they require only a valid signature and
`getJob(env, id, dev.deviceId)`. `verifySigned` (`lib/auth.js:22-43`) never consults `dev.killed`,
`dev.locked` or expiry. Chunk rows are purged only on a client-reported `'done'` (`jobs.js:127`) and
cursors carry no TTL (`cursor.js`). This contradicts the invariant the file asserts at `plan.js:8-9`.

**Harm — bounded, and the emergency stop still works.** A device revoked after `/plan/start` can still
finish that plan conversation and still write checkpoints and log lines. But the shipped client re-checks
the server verdict *before every chunk* — `orchestrator.js:370` halts on `guard()`, which `drawer.js:589-590`
defines as a live signed `/session` call (`registration.js:177-186`, no cache short-circuit) running the
full `computeVerdict`. A kill, `rin_voided`, lock or expiry stops a live run at the next chunk boundary.
And `/job/plan` grants nothing new: resume reads `prog.chunks` from the user's own `eta_progress.json`
(`orchestrator.js:658,669`), so the holder already has the chunk list. Invoice data never traverses the
worker at all (`src/core/planclient.js:1-9`).

**Fix.** Run `computeVerdict` on `/plan/step`, `/job/plan` and `/job/checkpoint` as `/plan/start` does
(403 with the reason so the drawer can explain itself); leave `/job/resumable` ungated. Expire chunk rows
on an age ceiling as well as on `'done'`.

---

### Hardening backlog (low)

| # | Issue | Evidence | Fix |
|---|---|---|---|
| L-1 | `/backup` dumps every device's HMAC `clientKey` to any holder of the single static admin bearer — the one surface that defeats the audit trail's own credential redaction (`lib/audit.js:36-44`). | `lead-worker/src/routes/admin.js:323`; auth at `lib/auth.js:48-53` | Omit `clientKey` from the dump (a restore can mint fresh keys), or encrypt it under a separate secret. |
| L-2 | Any script on the portal page can read `clientKey` out of `chrome.storage.local` via the `id-store` bridge — including in the post-wipe window where the mirror is the *only* copy. | `bridge.js:33-47`; `bg.js:63-83`; `src/core/registration.js:159` | Don't return `creds` to the page. Move signing into `bg.js` and expose `sign(path, body)` → `{ts,nonce,signature}`. |
| L-3 | `eta-lead-fetch` lets the page compose arbitrary path/method/headers/body to the pinned origin, including unauthenticated `/register`. No ambient authority (no cookies), so this is request forgery from the victim's IP, not privilege escalation. | `bridge.js:48-56`; `bg.js:88-95` | Send a route enum + typed payload; build the URL in `bg.js` from an allowlist; drop `msg.headers`. |
| L-4 | `build.mjs` derives the pinned backend origin by regexing the *first* quoted http URL in `registration.js` — a doc-link comment repoints `bg.js` and rewrites manifest `host_permissions`, and the build prints success. Reproduced. | `build.mjs:45-56,62-68` | Use the `leadUrl` already computed at `build.mjs:15` for both, and assert `bundleUrl === bgOrigin === manifestHost` before writing. |
| L-5 | MAIN-world injection plus predictable bridge correlation ids (`'f'+seq+'_'+Date.now()`) means a page script can forge a verdict reply. Inherent to a client-side gate in MAIN world — an attacker there can replace `session` outright — so no new capability. | `manifest.json:31-42`; `src/core/registration.js:38-46,50,64` | If the gate is worth defending, hold the verdict in `bg.js`. Cheap hardening: `crypto.randomUUID()` ids + a per-page-load nonce. |
| L-6 | The tests exercise ExcelJS 4.4.0 (Node build); production ships `vendor/exceljs.min.js`, the 4.3.0 *browser* dist. Different version and different build from the parity evidence. | `package.json:18`; `src/core/orchestrator.js:268,531` | Pin the devDependency to 4.3.0 and import `../vendor/exceljs.min.js` in tests, or assert the vendored sha256. |
| L-7 | A live-captured portal row with a real counterparty name and real registration ids is committed in the test suite and shipped in the reviewer source zip. Every other fixture is synthetic. | `test/listinput.test.mjs:65-77`; `package-source.mjs:18` | Replace with synthetic digits that preserve the asserted shape; scrub the commit; note the rule in the test. |
| L-8 | Bundled fonts register into the *portal's* `document.fonts` under upstream family names (`IBM Plex Sans Arabic` et al.) as glyph-trimmed subsets — the portal's own text could resolve against them. | `src/ui/drawer.js:260-266`; `src/ui/fonts.js:11` | Namespace the family names (`ETABulk Plex Arabic`) in `fonts.js` and the three `--font-*` stacks. |
| L-9 | `orch.chunkBackoff` splices an unbounded raw error message into a line shipped to the backend. No reachable throw currently carries document content — latent, not a leak today. | `src/core/orchestrator.js:562,590` | Whitelist `msg` to `e.code` / `'HTTP '+status` / `e.name`; keep the full text for the local folder log only. |
| L-10 | `pdfSaved`/`pdfDropped` are per-*run* but incremented per *attempt*, so a chunk that succeeds on attempt 3 reports ~3× the PDFs on disk in the counters shipped to the backend. Contrast `droppedByChunk`, deliberately keyed per chunk. | `src/core/orchestrator.js:322-323,477,479,606` | Accumulate into per-chunk locals inside the attempt loop; fold into run totals once on the `ok = true` path. |
| L-11 | The `over_cap` audit append is wrapped in a swallowed `catch {}` while the equivalent dropped-document append fails the chunk on error — opposite durability guarantees for two audit writes. | `src/core/orchestrator.js:431` vs `548-555` | Apply the same rule: fail the chunk, or at minimum emit a `level:'err'` status naming the write failure. |

---

## 3. What is already done right

Do not break these. Each was probed and found solid.

**Extension trust boundary**
- Origin pin is exact, not suffix-matched: `bg.js:88-93` compares `u.origin !== LEAD_ORIGIN`; `build.mjs:42-69` keeps bundle, pin and manifest in step.
- The redirect escape is closed — `redirect:'manual'` plus explicit `opaqueredirect`/off-origin rejection (`bg.js:94,100-103`), so a 3xx cannot replay signed headers to another host.
- Warm/renew take no URL from the page — only a kind (`bridge.js:17-20`, `bg.js:25,31,38`).
- No ambient authority: the relay omits `credentials` (`bg.js:94`).
- No `externally_connectable`, no `all_frames`, replies target `location.origin` not `'*'` (`manifest.json:20-42`, `bridge.js:12,23-58`).
- `csp-shim.js:7` does **not** weaken CSP despite the name — it pre-declares `regeneratorRuntime` so ExcelJS never reaches its `Function(…)` fallback. It removes the need for `unsafe-eval`.
- Host permissions are three exact hosts, no `<all_urls>`, no `tabs` permission (`manifest.json:12-16`).

**Backend auth**
- HMAC: constant-time compare with length check (`lib/util.js:20`, `lib/auth.js:36,52`), ±300s skew with a `Number.isFinite` NaN guard (`auth.js:30-31`), single-use nonce written *after* the signature verifies (`auth.js:38-41`), all attacker headers length-capped (`auth.js:25-28`). Signature binds body and exact path.
- Every job route is device-scoped in both the read and the mutating statements (`jobs.js:25,110-111,121,136,211`); cross-device access is tested (`smoke-worker.mjs:427,439,569`).
- Cursors are AES-GCM sealed with the jobId as AAD and `unseal` returns null on any tamper, which the caller treats as a hard 400 (`cursor.js:45-73`, `plan.js:140-143`).
- One shared `computeVerdict` that reads its own entitlement — a caller cannot fail open (`lib/verdict.js:21,31`).
- RIN claiming is atomic via `blockConcurrencyWhile` in the Locks DO (`locks.js:21-31`), with the KV fallback honestly labelled as narrowing, not closing, the race.
- Admin token is Bearer-header only, never a query param, gated at a single choke point with `/export` and `/backup` re-checking (`auth.js:45-53`, `admin.js:20,297,322`).
- The stale-grace bug is properly fixed: `graceVerdict` reuses the server's verdict verbatim ANDed with a same-RIN check, and fails closed with no cache (`src/core/registration.js:170-173,193,200`).

**Data handling**
- SPEC-022 holds: only a *count* reaches the backend for a uuid-list export (`planclient.js:110`, `plan.js:109-130`).
- No i18n string reachable from `onStatus` splices an invoice number, counterparty, amount or UUID — full EN/AR catalogues read (`src/core/i18n.js:8-590`).
- SQL injection: clean. The only two string interpolations take module literals or a closed whitelist (`users.js:83-87,788-800`).
- Stored XSS: clean at every render site checked in `dash.html` — `esc()` at 650 applied to names, companies, RINs, bug text, shipped log lines and audit detail keys *and* values.
- CSV export neutralises formula injection (`admin.js:301`); `listDevices`/`getDevice` deliberately omit `client_key` (`users.js:434,450`); audit detail scrubs credential-shaped keys and errlog stores a reason tag plus a 12-char prefix, write-budgeted at 6/min (`lib/audit.js:36-44,66-77`).
- The privacy policy matches the code — counters, export record, 200-line cap, deletion-on-success, bug bundle all disclosed (`privacy.html:34-37`), and the drawer links to exactly that URL (`drawer.js:1397`).

**Build & supply chain**
- Reproducible build verified: `dist/etaBulk.js` and `bg.js` re-hash identically after `node build.mjs` on a clean tree.
- `vendor/exceljs.min.js` is bit-identical to upstream 4.3.0 (sha256 `c0951d8c…`), unmodified.
- Third-party inventory in NOTICE is accurate; every absolute URL compiled into the bundle is expected; no eval reaches the portal; no secrets in tracked files; `npm ci` in CI with a fully-integrity-pinned lockfile and one standard install script (esbuild).
- Staging guards work: `package-ext.mjs:7-19` refuses version mismatch, a staging host in the manifest, or a staging-pinned `bg.js`.

**Concurrency & export**
- `mapAdaptive` handles a shrinking limit without stalling, cannot double-spawn or drop an item, cannot leak an unhandled rejection, and the governor floor makes limit 0 unreachable (`src/api/client.js:199-225`).
- The renewal hold cannot deadlock — both legs are timeout-bounded and `releaseRenew()` sits in a `finally` (`orchestrator.js:112-126`, `session.js:54-65`).
- A partially-written chunk cannot look complete: the summary workbook is written last and is what `scanDoneFromFolder` keys on (`orchestrator.js:528,546`).
- Merge state forces a full rebuild when a consumed part is missing or resized (`mergestate.js:64-68`).
- Per-chunk failure accounting is retry-safe (`orchestrator.js:509,556`), and planner coalescing cannot merge across the `subDone` sentinel (`lead-worker/src/planner.js:44-49,159`).

---

## 4. Recommended order of work

1. **F-1 — `/register` takeover.** Refuse a mismatched-email re-registration, stop returning `clientKey`
   unless `known`, rotate the key and clear `superadmin` on any accepted email change. Add a smoke test
   registering an existing `deviceId` under a second email. **~1 hour.**
2. **F-2 — add `"permissions": ["storage"]`,** rebuild, reload, and surface the `{ok:false}` instead of
   swallowing it. Add the manifest-vs-`chrome.*` assertion test. **~1 hour.**
3. **F-3 — rotate the part on column growth** in `chunkparts.js`, with the two-batch test. This is the one
   that silently corrupts a tax deliverable. **~2 hours.**
4. **F-4 — per-batch mass-403 check** alongside the cumulative one, plus a tail-403 test.
   **~1-2 hours.**
5. **L-1, L-2, L-7 — credential and PII hygiene:** drop `clientKey` from `/backup`, stop returning `creds`
   over the bridge (move signing into `bg.js`), scrub the live portal row from `test/listinput.test.mjs`.
   **~half a day.**
6. **F-5 — email verification** at `/register`, or at minimum refuse to attach a new device to an email
   that already has a D1 row. This is the biggest of these but it is a design change, and nothing above it
   depends on it. **~1-2 days.**
7. **F-6 and the remaining lows** (L-3 route allowlist, L-4 build-origin assertion, L-6 ExcelJS parity,
   L-8 font namespacing, L-9/L-10/L-11 log and counter fixes) as a hardening sweep. **~1 day total.**
