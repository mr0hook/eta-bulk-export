# SPEC-020 — The activation path

> Extends SPEC-017 (users own clients and devices) and SPEC-019 (plans grant features, a client quota
> and a device quota). Those two specs describe the MODEL. This one describes the JOURNEY through it:
> how a stranger becomes a captured user, how their browsers become enrolled devices, and how a RIN
> becomes an activated client — plus every point where that journey currently dead-ends into
> "ask the admin".
>
> Slice 1 and slice 2 are specified for build. Slices 3-5 are scoped, not designed.

## Why

We have a licence model and no funnel. Every entity in SPEC-017 exists only as a side effect of one
unsigned POST, and every way that POST can fail produces either nothing at all or a message telling
the user to contact a person whose address the message does not contain.

**The defect that shapes this spec:** a RIN already claimed by another device is refused at
`routes/extension.js:104` with a 409 — and that refusal returns **before** `putDev` at line 110.
Nothing is written. No device record, no `clientKey`, no `users` row, no `clients` row, no
`email:` index entry. The user is told:

> "This registration number is already registered to another account. If this is your RIN (e.g. you
> cleared browser storage or moved devices), ask the admin to move it to your account."

They cannot ask in the tool: `/rin-request` is a **signed** endpoint and signing needs the
`clientKey` the refusal just declined to issue. The drawer's "Request access for this account"
button is bound to `rinIssue` on an already-registered device (`src/ui/drawer.js:666`) and is
therefore not on screen. And the operator cannot see it happened: the only trace is one `err:`
record carrying `{ reason: 'rin_claimed' }` — no email, no RIN, no device (the `x-device-id` header
is not sent on `/register`), rate-dropped above 6 writes/minute/isolate, gone after 30 days
(`lib/audit.js:67-77`).

So the most common support event in the system is simultaneously the one the user cannot report and
the one the operator cannot see. Everything else in this spec follows from fixing that.

---

## 1. The journey

```
  ┌─ install ─┐   ┌─ capture ──┐   ┌─ enrol ──┐   ┌─ activate ──┐   ┌─ steady ─┐
  │  CWS/zip  │→  │ /register  │→  │  device  │→  │ RIN → client│→  │ /session │
  │  no trace │   │ name·email │   │  row     │   │  rinClaim   │   │  verdict │
  └───────────┘   └────────────┘   └──────────┘   └─────────────┘   └──────────┘
                        │                              │
                        ├─ refused ─→ (nothing)        ├─ contested ─→ 409, (nothing)
                        └─ over client quota ─→ registered, unbound, blocked
```

Stages 2, 3 and 4 are the same HTTP request. That is the root of most of what follows: capture,
enrolment and activation succeed or fail together, so a failure at the last one erases the first two.

### Stage 0 · Install

Nothing is recorded. The drawer injects on the ETA portal, `gateEnabled()` is true for a production
build, and the gate takes over the panel. A person who installs, reads the gate and closes the tab
leaves no trace of any kind. **We cannot count installs, gate views, or abandonment.**

### Stage 1 · Capture — `POST /register` (unsigned)

The user types name, email, phone, company and ticks consent. The RIN is **not** typed: it is read
from the portal's own `USER_DATA.profile.TaxRin` (`src/core/registration.js:76-85`) and shown
read-only. The body carries a fresh `regId`, the persistent `deviceId` and the extension version.

The server, in order (`routes/extension.js:15-140`):

| # | Check | Refusal |
|---|---|---|
| 1 | name · email · consent present | `missing_fields` 400 |
| 2 | email shape | `invalid_email` 400 |
| 3 | RIN readable | `no_rin` 400 |
| 4 | deviceId present | `no_device` 400 |
| 5 | ≤40 registrations/hour/IP (Locks DO, atomic) | `rate_limit` 429 |
| 6 | email not disposable, domain has MX | `email_rejected` 400 |
| 7 | RIN not on the `void:` blacklist | `rin_voided` 403 |
| 8 | version not blocked by `cfg` | `version_blocked` 426 |
| 9 | **device cap** (SPEC-019) | `device_limit` 403 + `held` / `allowed` |
| 10 | **RIN claim** (Locks DO, atomic) | `rin_claimed` 409 |

Check 6 is a best-effort call to a third party (`disify.com`, 4 s timeout, `lib/auth.js:11-19`); any
failure returns `{ reject:false, verified:false }` and the registration proceeds. `emailVerified` is
stored and **read nowhere**. There is no confirmation email, no link, no code. The identity that
plan, quota, expiry and every audit entry bind to is a self-asserted string.

### Stage 2 · Enrolment

There is no enrolment step. A `dev:` KV record is created inline, and `mirrorDevice()`
(`users.js:244`) dual-writes a `users` row, a `devices` row and one `clients` row per bound RIN into
D1 — best-effort and last, so a D1 outage never fails a registration that already succeeded.

The device cap binds on the **second** browser: `resolveEntitlement()` is read before the row is
written, so a first-ever registration has no D1 row, `ent` is null, and the allowance is `Infinity`
by deliberate design (`extension.js:68-70`) — a pre-migration install, or an environment with no
portal, must degrade rather than be refused by a number no admin can raise. A returning `deviceId`
is never counted as new (`extension.js:56`).

A new user lands on the schema defaults: `plan='free'`, `quota=1`, `device_quota=1`,
`valid_until=NULL`. **Nothing ever sets `valid_until` on registration**, so a free licence for one
client never expires and no operator action stands between "installed" and "exporting".

### Stage 3 · Activation — RIN becomes a client

Three outcomes, and only the first is the one anybody designed:

| | Condition | Result | Self-service? |
|---|---|---|---|
| **A** | RIN unclaimed, person under client quota | bound, claimed in the DO, `allowed:true` | n/a — it worked |
| **B** | RIN unclaimed, person **at** quota | registered, **unbound**, `allowed:false`, `reason:'rin_not_allowed'` | ✅ the blocked screen shows "Request access" → `/rin-request` |
| **C** | RIN **claimed by another device** | **409, nothing written** | ❌ none. See §2. |

Outcome B is the grandfather rule from SPEC-017 working as intended: a person over their cap keeps
every client they hold and simply cannot add another. Outcome C is the dead end.

### Stage 4 · Steady state — `POST /session` (signed)

Every drawer open and every guarded action re-checks in. `computeVerdict()` (`lib/verdict.js`) is the
single source of truth, shared with `/plan/start` so a device reported as blocked cannot mint a job.
It returns `allowed`, a `reason`, the resolved `features` and `quota`, plus the optional broadcast
`announcement` and the personal `message`. Telemetry lands in a separate `seen:` key so a check-in
can never clobber an admin-owned field.

### Stage 5 · The second client — `POST /rin-request` (signed)

Creates a `req:` KV record `{ id, deviceId, email, name, requestedRin, note, status:'pending' }`,
deduped against an existing pending request for the same device+RIN. It appears in the portal's
Requests section. Approval (`routes/admin.js:240-255`) re-counts the person's holdings across every
device, refuses if they are at cap (naming the numbers), claims the RIN in the DO, pushes it into
`dev.boundRins` and `putDev`s.

---

## 2. Where it breaks today

Each of these is a place the journey requires a human, or produces nothing.

**F-1 · The 409 dead end.** As above. No record, no credentials, no channel, and the instruction
"ask the admin" names no address. This is the failure a user hits after clearing browser storage,
after replacing a laptop, or after an accountant's colleague registers the same client first.

**F-2 · The funnel has no top.** Every refusal in the table above writes at most one anonymous,
rate-dropped, expiring `err:` line. We cannot answer "how many people tried to register this week",
"how many bounced off the device cap", or "which RIN keeps getting contested".

**F-3 · `registerRefusal()` can never fire in the shipped drawer.** SPEC-019 gave the device cap its
own machine reason so the drawer could say "this account already uses 4 of 1 devices" instead of a
generic failure. `src/ui/flow.js:124` keys on `res.reason` — and `register()` at
`src/core/registration.js:119-122` returns `{ ok:false, error }`, dropping `reason`, `held` and
`allowed` from the parsed body before the drawer ever sees them. T-185 passes because it drives the
pure function with a synthetic body. **In the real drawer the dedicated reason reaches nothing.**
One line; it lives in this spec because the activation path is where it is felt.

**F-4 · The portal's Move button does not move what the extension obeys.**
`POST /api/client action=move` rewrites `clients.user_email` in D1 and explicitly does **not** touch
the `rinowner:` Durable Object or either device's `boundRins` (`routes/portal.js:292-294` — a
deliberate, commented decision under SPEC-017). The operator presses Move, the portal shows the new
owner, and the blocked user's next `/register` still 409s. The action that actually resolves F-1 is
the **legacy per-device** `moveRin` on the old KV dashboard, which needs the source device id *and*
the target device id — and in the F-1 case the target device does not exist, because the failure
prevented it from being created. **The resolution path requires a record the failure destroyed.**

**F-5 · Approval writes one store.** Request approval calls `putDev` (KV) and never `mirrorDevice`,
so the newly granted client does not appear in the portal's Clients section until that user's next
`/register` — which, for a user who is already registered, never happens.

**F-6 · Requests are not people.** `req:` records carry a `deviceId`; the Requests section lists them
raw, unjoined to the `users`, `clients` and `jobs` rows that would tell the operator whether this
person is at their cap, who currently holds the RIN, or whether they are mid-quarter on an export.
Deciding requires visiting three sections and doing the arithmetic by hand.

**F-7 · There is no outbound channel.** The worker sends no email — no confirmation, no "your
request was approved", no renewal notice. The only path from operator to user is `dev.message`,
delivered on the next `/session`, i.e. only when the user next opens the ETA portal with the drawer.
An approval is therefore not a notification, and the dashboard's `expiringSoon` alert is visible to
the operator alone.

**F-8 · Identity is a typed string.** No proof of possession of the email. Two people can share one
entitlement by typing the same address; one person can mint unlimited free licences by typing
different ones. The device cap is per-email, so it caps browsers per identity, not identities.

**F-9 · A device cannot be retired by the person who owns it.** Hitting `device_limit` requires an
operator even when the user knows perfectly well that two of their four devices are a decommissioned
laptop and a browser profile they deleted. The only removal path is the legacy per-device `delete`
action in the admin console.

**F-10 · "Stuck at the gate" is not a state.** A user with a device and no client (outcome B, or a
denied request) is indistinguishable in `/api/users` from a fully active one except by reading
`clientCount` and inferring. The dashboard has no count of people who registered and never activated.

---

## 3. What is built vs what is missing

| Capability | State |
|---|---|
| Capture form, consent, RIN auto-detect | ✅ built (`drawer.js` gate, `registration.js:110`) |
| Rate limit, disposable-email screen, void screen, version gate | ✅ built |
| Atomic RIN ownership (Locks DO) | ✅ built (`lib/kv.js:41`) |
| Device row + user row + client row on register (dual-write) | ✅ built (`users.js:244`) |
| Client quota on the person, across devices | ✅ built (SPEC-017 slice 3, `personHeld`) |
| Device quota with its own refusal reason | ✅ built server-side (SPEC-019) · ❌ **unreachable in the drawer (F-3)** |
| Plans, feature catalogue, custom accounts, expiry | ✅ built (SPEC-017 §slice 3, SPEC-019) |
| Operator sections: Users, Clients, Requests, Activation, Features, Audit | ✅ built (`assets/dash.html`) |
| RIN request → approve → bind | ✅ built · ⚠️ KV only (F-5), unjoined (F-6) |
| **A record of registrations that were refused** | ❌ missing (F-2) |
| **A path out of a contested RIN that does not need an operator** | ❌ missing (F-1) |
| **A transfer that actually transfers** | ❌ missing (F-4) |
| **Self-service device retirement** | ❌ missing (F-9) |
| **An account view the user can see** (their plan, clients, devices) | ❌ missing |
| **Any notification** | ❌ missing (F-7) |
| **Email verification** | ❌ missing (F-8) — and out of scope here, see §7 |

---

## 4. The design

Five changes, in dependency order. None of them adds an entitlement anybody does not already have;
they add **records, channels and states**.

### 4.1 A registration attempt is recorded before it is judged

Every `/register` that passes checks 1-3 (name, email, consent) writes one `signups` row, whatever
happens next. Consent is the line: an attempt that never carried consent is never stored, so the
funnel begins exactly where permission does.

```sql
CREATE TABLE IF NOT EXISTS signups (
  id         TEXT PRIMARY KEY,
  at         TEXT,
  email      TEXT, name TEXT, company TEXT, phone TEXT,
  rin        TEXT, device_id TEXT, version TEXT, country TEXT,
  outcome    TEXT,      -- granted | pending | refused
  reason     TEXT,      -- '' when granted; the machine reason otherwise
  claim_id   TEXT       -- set when the attempt opened a claim (§4.2)
);
CREATE INDEX signups_email ON signups(email);
CREATE INDEX signups_rin   ON signups(rin);
```

Best-effort and last, exactly like `mirrorDevice`: a D1 failure must never fail a registration, and
must never turn a refusal into a 500. The `err:` line stays as it is — it is the wrong record for
this (no PII by design), and this table is the right one (consented PII by definition).

### 4.2 A contested RIN becomes a claim, not a 409

Outcome C stops being a refusal and becomes **outcome B with a claim attached**:

1. The device record is written and a `clientKey` is issued. `boundRins` stays empty.
2. A `claims` row opens, naming the RIN, the incumbent device (from the DO), the challenger device
   and the person behind each.
3. The response is `{ ok:true, allowed:false, state:'pending', reason:'rin_contested', claimId }`.
4. `/session` carries `claim: { id, rin, status, at }` while one is open. `computeVerdict()` is
   **not** touched — it stays the shared enforcement function and keeps answering
   `rin_not_allowed`; the claim is context the drawer renders, not a new verdict dimension. Adding a
   data-dependent reason to the function `/plan/start` also enforces is how a gate drifts open.

Nothing is granted by this. A pending device fails `computeVerdict` on exactly the same rule it
fails today, so `/plan/start` refuses it and no job can be minted. What changes is that the person
now exists, is visible, and holds credentials good enough to use the request channel that already
works.

**This is backward compatible with every shipped extension version.** An old drawer receiving
`{ok:true, clientKey, allowed:false}` stores the credentials, calls `refreshLicense()`, gets
`reason:'rin_not_allowed'` from `/session`, shows the blocked screen — and `blk-req` is visible for
exactly that reason, so the "Request access" button appears with no client change at all. New
clients render the claim status instead.

```
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, rin TEXT, at TEXT,
  challenger_email TEXT, challenger_device TEXT,
  incumbent_email  TEXT, incumbent_device  TEXT,
  status TEXT,        -- open | approved | denied | withdrawn
  note TEXT, decided_at TEXT, decided_by TEXT
);
```

One open claim per (RIN, challenger email) — a second attempt returns the same `claimId`, the same
dedupe rule `/rin-request` already uses.

### 4.3 Approving a claim performs the whole transfer

One operator action, one atomic-as-we-can-make-it sequence, modelled on the legacy `moveRin`
(`routes/admin.js:167-185`) which already gets the ordering right:

1. Release the `rinowner:` DO from the incumbent device.
2. Claim onto the challenger's device. **A lost race restores the incumbent and refuses** — the RIN
   never ends up orphaned, and the incumbent is never logged out by a failed transfer.
3. Only then: remove the RIN from every incumbent device's `boundRins`, add it to every challenger
   device's `boundRins`, and `putDev` both sides. (Sibling devices of one person all carry the RIN;
   the DO holds one designated device, which is what `/register` arbitrates on — `/session` checks
   `boundRins` only. This mirrors what the current re-affirm claim already assumes.)
4. Upsert the D1 `clients` row to the new owner.
5. Write a `message` on **both** sides: the challenger learns they can start, the incumbent learns
   their client moved and who to talk to. Losing a client silently is worse than losing it.
6. One audit entry per side, carrying the actor, `before` and `after` (SPEC-017 slice 4 rules).

`POST /api/client { action:'move' }` is redefined to perform this same sequence rather than the
D1-only relabel it does today. That is a deliberate reversal of a SPEC-017 decision: the reasoning
there (moving a management record is a different question from re-pointing a live registration) is
sound in the abstract and wrong in practice, because the portal offers exactly one button called
Move and an operator who presses it means the transfer. A `move` whose target user has no device is
refused, naming that — a client with no device to hold it is not a move, it is a data edit.

Request approval (`/api/request action=approve`) gains step 4 as well, closing F-5.

### 4.4 The user can see and manage their own account

Two new signed endpoints. Signing is POST-only (`registration.js:97-107` signs
`ts\nnonce\nPOST\npath\nsha256(body)`), so both are POSTs whose bodies may be empty.

- **`POST /account`** returns what this person has: entitlement (plan name, clients used/allowed,
  devices used/allowed, `valid_until`, and for each number **where it came from** — `plan`,
  `override` or `custom`, which `resolveEntitlement()` already computes), their clients, their
  devices (id prefix, version, country, last seen, and which one is *this* browser), and any open
  claim or request. The drawer renders it as an Account panel. Today a user cannot see their own
  plan, and every question about it is a support message.
- **`POST /device/retire { deviceId }`** — the person drops one of their **own** devices. Refuses
  any device not on their email. Frees a slot immediately, so the next `/register` on a new browser
  succeeds without an operator. If the retired device holds the DO claim for a RIN, the claim
  transfers to a sibling device of the same user, or is released when there is none. The retired
  record is deleted, so that browser's next `/session` answers `not registered` and the gate
  reappears — which `registration.js:152` already handles by wiping local creds.

Retiring your own device is the smallest change that turns `device_limit` from a support call into a
click, and it is safe in a way that raising the cap is not: the total never goes up.

### 4.5 Activation state is a word, not an inference

`users` gains a derived `state` reported by `/api/users` and `/api/user`:

| state | meaning |
|---|---|
| `lead` | registered, holds no client — outcome B, a denied request, or an open claim |
| `active` | holds ≥1 non-voided client |
| `expired` · `locked` · `killed` | as today, from `status` and `valid_until` |

Derived at read time from `clientCount` and `status` — not a stored column, so it cannot drift out of
step with the rows it describes. The dashboard gains `leads` and `openClaims` counters, and the
Requests rail badge is joined by a Claims one.

---

## 5. What the operator sees, at each step

| Stage | Today | With this spec |
|---|---|---|
| Install / gate view | nothing | still nothing — no beacon before consent, on purpose |
| Registration granted | a user row appears | unchanged, plus a `granted` signup row |
| Registration refused | one anonymous `err:` line, maybe | a `refused` signup row with the email, the RIN and the reason, in a Signups list filterable by reason |
| Contested RIN | **nothing at all** | a `lead` user, a pending device, and an item in the Claims queue naming incumbent and challenger with both users' holdings |
| Over client quota | a user with no clients, findable only by reading counts | `state:'lead'` with the reason on the signup row |
| Device limit hit | one anonymous `err:` line | a `refused` signup row with `held`/`allowed`, and the user's device list one click away |
| RIN request filed | a raw `req:` row in Requests | the same row joined to the person, their cap, and the RIN's current owner |
| Request/claim decided | an audit entry; the user learns on next check-in, if the operator remembers to write a message | an audit entry per side and an automatic message on every affected device |
| Client moved | a relabelled D1 row that changes nothing the extension obeys | the real transfer, both sides messaged |

---

## 6. API contract

House rules, as SPEC-017: extension endpoints are signed unless marked otherwise; `/api/*` requires
the admin bearer token; everything returns `{ok:true, …}` or `{ok:false, error}`. **This section is
the interface between the backend and the frontend work — neither may change it unilaterally.**

```
POST /register                       (unsigned — shape below is ADDITIVE to the shipped contract)
       → { ok:true, clientKey, features, boundRins, quota, allowed,
           state,                            'active' | 'pending'
           claim: { id, rin } | null }       present only when the RIN is contested
       → { ok:false, error, reason, … }      reason is ALWAYS present on a refusal
         reason  missing_fields | invalid_email | no_rin | no_device | rate_limit |
                 email_rejected | rin_voided | version_blocked | device_limit
         device_limit additionally carries  held, allowed        (unchanged, SPEC-019)
       NOTE: rin_claimed is GONE as a refusal. A contested RIN now answers ok:true with
             allowed:false and state:'pending'. Nothing is entitled by it — /plan/start still
             refuses on the same verdict — but the person exists and can be helped.

POST /session                        (signed — additive)
       → { …unchanged…, claim: { id, rin, status, at } | null }
         claim is CONTEXT, not a verdict. `reason` stays 'rin_not_allowed'; computeVerdict()
         is untouched so /session and /plan/start cannot drift.

POST /account                        (signed)   {} → { user, entitlement, clients:[…], devices:[…],
                                                        claim | null, request | null }
       user        { name, email, company, state }
       entitlement { plan, quota, quotaSource, clientsUsed,
                     deviceQuota, deviceQuotaSource, devicesUsed, validUntil, features:[…] }
                     *Source is 'plan' | 'override' | 'custom' — a user must be able to see that a
                     negotiated number is negotiated, for the same reason the portal must.
       device      { id, thisOne, version, country, lastSeen }      id is the 8-char prefix only
       client      { rin, company, voided }

POST /device/retire                  (signed)   { deviceId } → { ok, retired, freed:{ devicesUsed,
                                                                  deviceQuota }, movedClaims:[rin] }
       Refuses a deviceId not owned by the caller's email: { ok:false, error:'not your device' } 403.
       Refuses retiring the LAST device: use the gate, not a self-delete that hides the account.

GET  /api/signups?outcome=&reason=&q=&page=  → { signups:[…], total, page, pages }
       signup { id, at, email, name, company, rin, deviceId, version, country,
                outcome, reason, claimId,
                user: { …the /api/users user shape } | null }     null until they succeed

GET  /api/claims?status=&page=       → { claims:[…], total, openCount }
       claim  { id, rin, at, status, note, decidedAt, decidedBy,
                challenger: { email, name, deviceId, clientsUsed, quota, state },
                incumbent:  { email, name, deviceId, clientsUsed, quota, state, lastExportAt } }
                *Both sides carry their holdings: the decision is "who should hold this TRN", and it
                 cannot be made from two names alone.
GET  /api/claim?id=                  → { claim, jobs:[…] }
       jobs   the runs made against this RIN, either side — "who has actually been exporting for
              this taxpayer" is the question that decides most claims.
POST /api/claim  { id, action, note }   actions: approve | deny
       approve performs the FULL transfer (§4.3) and is refused, without side effects, when the
       challenger is at their client cap or the DO race is lost — naming which.

POST /api/client { rin, action, value }  action='move' now performs the full transfer (§4.3),
                                          not the D1-only relabel it performs today.
POST /api/request { id, action }         action='approve' additionally upserts the D1 clients row.

GET  /api/dashboard                  → { …unchanged…, stats:{ …, leads, openClaims, signupsToday } }
```

Every mutating call writes an audit entry carrying the actor, with `before`/`after` on both sides of
a transfer — SPEC-017 slice 4's rules apply unchanged, including the redactor: a `clientKey` must
never reach the trail through a claim record.

---

## 7. Not in this spec, on purpose

| | Why |
|---|---|
| **Email verification** (link or code) | It is the right fix for F-8 and it needs an outbound mail provider the stack does not have, a delivery/bounce story, and a decision about what happens to the thousands of unverified rows that already exist. It is its own spec. This one makes the funnel visible; verifying it comes next. |
| **Any notification email** | Same missing dependency (F-7). The design instead guarantees a `message` on every decision, and is honest that a message is delivered only when the user next opens the portal — an approval is not a notification. When mail arrives it is one route plus a binding, and the audit trail already carries the events to send. |
| **Self-serve payment / plan upgrade** | `plans.price` is free text by SPEC-017's decision: billing stays out until it hurts. An upgrade is an operator action. |
| **Proving RIN ownership from the portal session** | The extension holds the ETA OIDC bearer for the logged-in taxpayer (`src/core/token.js`), which is the strongest possible evidence that this browser is that taxpayer — and relaying it to our worker would make the worker a holder of portal credentials for every user. That is a boundary this product has never crossed (invoice content never leaves the browser) and this spec does not cross it either. The claim queue is a human decision with good evidence, not an automated one with a stolen token. |
| **Cross-device resume / roaming state** | Settled scope from the admin-backend roadmap: same-machine recovery only. Retiring a device does not migrate its runs. |

---

## 8. Slices

| | Contains | State |
|---|---|---|
| **1** | Signups table + `reason` on every refusal + the F-3 one-liner (`register()` forwards `reason`/`held`/`allowed`) + drawer lines for each reason + `/api/signups` and the Signups section | **specified — build this** |
| **2** | Claims: contested RIN → pending device + claim, `/api/claims`, the full transfer, `action=move` redefined, automatic messages, request approval writes D1 | **specified — build this** |
| 3 | `/account` + Account panel in the drawer + `/device/retire` | scoped |
| 4 | `state` on users, dashboard `leads`/`openClaims`/`signupsToday`, Requests joined to people | scoped |
| 5 | Trials as a plan property (`plans.trial_days` → `valid_until` at registration); email verification and notifications as their own spec | scoped |

Slice 1 is first because it is the cheapest thing that makes the problem measurable, and because
F-3 is a live defect shipping today. Slice 2 is where "ask the admin" stops being the end of the
road.

---

## 9. Test cases

| ID | Case |
|---|---|
| T-195 | A refused `/register` writes a `signups` row carrying the email, the RIN and the machine reason |
| T-196 | An attempt that fails the consent check writes NO signup row — the funnel starts where permission does |
| T-197 | A D1 failure while writing a signup neither fails a registration nor turns a refusal into a 500 |
| T-198 | Every `/register` refusal carries a `reason`, and `register()` forwards `reason`/`held`/`allowed` to the caller (the F-3 gap) |
| T-199 | The drawer renders `device_limit` with both counts and `rin_contested` as its own line, in EN and AR |
| T-200 | A contested RIN answers `ok:true, allowed:false, state:'pending'` with a `clientKey`, writes the device record, and opens exactly one claim |
| T-201 | A second registration on the same contested RIN returns the SAME `claimId` and does not stack a duplicate |
| T-202 | A pending device is refused by `/plan/start` and reports `allowed:false` from `/session` — credentials are not entitlement |
| T-203 | `/session` carries the open claim as context while `reason` stays `rin_not_allowed`; `computeVerdict()` is byte-identical to before |
| T-204 | Approving a claim moves the DO owner, both sides' `boundRins`, and the D1 `clients` row in one operation |
| T-205 | A claim approval that loses the DO race restores the incumbent, changes nothing else, and reports which account won |
| T-206 | A claim approval is refused, without side effects, when the challenger is at their client cap — naming the two numbers |
| T-207 | Denying a claim leaves every record untouched and messages the challenger |
| T-208 | Every claim decision writes a message on BOTH sides and one audit entry per side, with actor, before and after |
| T-209 | `POST /api/client action=move` performs the real transfer, and is refused when the target user has no device |
| T-210 | Approving a RIN request writes the D1 `clients` row, not only KV (the F-5 divergence) |
| T-211 | `/account` returns only the caller's own devices, clients and entitlement, and names the source of every number |
| T-212 | `/device/retire` frees a slot: the next `/register` from a new browser succeeds where it previously hit `device_limit` |
| T-213 | Retiring the device holding a DO claim transfers it to a sibling device, or releases it when there is none |
| T-214 | `/device/retire` refuses a deviceId belonging to another email, and refuses retiring the last device |
| T-215 | A retired device's next `/session` answers `not registered`, and the drawer wipes creds and re-shows the gate |
| T-216 | A user holding no client reads as `lead`; binding one moves them to `active`; a voided client moves them back |
| T-217 | `/api/signups` pages and filters by outcome and reason; `/api/claims` filters by status and reaches the rail badge |
| T-218 | No claim record, signup row or message ever carries a `clientKey`, token, nonce or signature |
