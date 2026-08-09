# SPEC-017 — Admin portal v2

> Supersedes `2026-08-09-admin-backend-roadmap.md` (A0..A6). A0 shipped as SPEC-015; the rest of that
> roadmap is folded into the slices below. Do not build from the old roadmap.
>
> Slice 1 only is specified for build. Slices 2-5 are scoped, not designed.

## Why

The portal today is a customer list. It cannot answer "what is happening right now", "who is this
user", "which clients does she manage", or "who locked this account". It also enforces the licence
against the wrong entity.

**The defect that shapes this spec:** a `dev:` record IS the user — it holds name, email, company,
`quota` and `boundRins`, keyed by browser. So an accountant who registers on a laptop and again on
the office PC gets two records, each with its own quota, and can manage twice the clients they are
licensed for. `rinClaim` stops the same RIN twice; nothing stops a second device claiming different
ones. The `email:` index exists and nothing enforces against it.

## Model

```
USER (email)  name · company · phone · plan · quota · valid_until · status · note · tags
  ├─ CLIENT (rin)     the TRNs this user manages. quota caps the count. voidable.
  ├─ DEVICE (id)      a browser registration. clientKey, version, country, last_seen.
  └─ JOB              an export run: one device, one client, one date range.
```

Quota is enforced **once, on the user**. A device inherits its user's entitlement.

### D1 schema (additive; KV keeps audit, errors, snapshots, config, nonces, rate limits)

```sql
CREATE TABLE users (
  email TEXT PRIMARY KEY, name TEXT, company TEXT, phone TEXT,
  plan TEXT DEFAULT 'free', quota INTEGER DEFAULT 1, valid_until TEXT,
  status TEXT DEFAULT 'active',        -- active | locked | killed
  superadmin INTEGER DEFAULT 0,
  features TEXT,                       -- JSON array; plan fills it, per-user override wins
  note TEXT, tags TEXT, country TEXT,
  created_at TEXT, updated_at TEXT);

CREATE TABLE clients (
  rin TEXT PRIMARY KEY, user_email TEXT, company TEXT,
  voided INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
CREATE INDEX clients_user ON clients(user_email);

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY, user_email TEXT, client_key TEXT,
  version TEXT, country TEXT, last_seen TEXT, last_rin TEXT,
  exports INTEGER DEFAULT 0, docs INTEGER DEFAULT 0, pdfs INTEGER DEFAULT 0,
  created_at TEXT);
CREATE INDEX devices_user ON devices(user_email);

CREATE TABLE plans (
  id TEXT PRIMARY KEY, name TEXT, quota INTEGER, features TEXT, price TEXT, active INTEGER DEFAULT 1);
```

`jobs` and `job_chunks` already exist (SPEC-016). `jobs` gains `user_email TEXT`.

### Migration

One-shot, idempotent, admin-triggered (`POST /api/migrate`), reversible by re-running:

1. Read every `dev:` record from KV.
2. Group by lowercased email. First record wins for name/company/phone; **quota becomes the MAX of
   the group, not the sum** — the sum would bless the hole this migration exists to close.
3. `status`: killed if any record killed; locked if any locked. `superadmin` if any.
4. Every `boundRins` entry becomes a `clients` row owned by that email. A RIN appearing under two
   emails is reported as a **conflict** and left with its current `rinowner:` DO owner — never
   silently reassigned.
5. Every `dev:` becomes a `devices` row; `seen:` telemetry merges in.
6. KV records are **left in place**. The extension API keeps reading them until slice 3; the portal
   reads D1. Dual-write is added in slice 1 so they cannot diverge.

Report: users created, clients created, devices created, conflicts (listed, not resolved).

## API contract

All under `/api/`, all requiring the admin bearer token, all returning `{ok:true, ...}` or
`{ok:false, error}`. **This section is the interface between the backend and frontend work — neither
may change it unilaterally.**

```
GET  /api/dashboard          → { stats, active, recent, alerts }
       stats  { users, clients, devices, activeJobs, jobsToday, docsToday, openBugs,
                pendingRequests, expiringSoon }
       active [ { jobId, user, rin, source, state, done, total, updatedAt } ]   running now
       recent [ { at, kind, text, ref } ]                                       last 20 events
       alerts [ { level, text, ref } ]      stuck jobs · expiring plans · error spikes

GET  /api/users?q=&status=&plan=&page=     → { users:[…], total }
       user   { email, name, company, plan, quota, clientCount, deviceCount, jobCount,
                docs, status, validUntil, lastSeen, tags }
GET  /api/user?email=                      → { user, clients:[…], devices:[…], jobs:[…], bugs:[…], audit:[…] }
POST /api/user   { email, action, value }  actions: lock|unlock|kill|revive|setQuota|setPlan|
                                           setValidUntil|setFeatures|setNote|setTags|super|unsuper|delete

GET  /api/clients?q=&page=                 → { clients:[…], total }
       client { rin, company, userEmail, userName, voided, jobCount, docs, lastExportAt }
GET  /api/client?rin=                      → { client, user, jobs:[…] }
POST /api/client { rin, action, value }    actions: void|unvoid|move (value = target email)

GET  /api/jobs?state=&user=&rin=&page=     → { jobs:[…], total }          (slice 2)
GET  /api/job?id=                          → { job, chunks:[…] }         (slice 2)
GET  /api/audit?page=                      → { entries:[…] }             (slice 4)
POST /api/migrate                          → { users, clients, devices, conflicts:[…] }
```

Every mutating call writes an audit entry carrying the **actor**. Until slice 4 gives real admin
identity, the actor is `"token"` — recorded honestly rather than left blank.

## API contract — slices 2 and 3

Same rules: admin token, `{ok:true,…}`/`{ok:false,error}`, and neither the backend nor the frontend
may change these unilaterally.

```
GET  /api/jobs?state=&user=&rin=&stuck=&page=   → { jobs:[…], total }
GET  /api/job?id=                               → { job, chunks:[…], purged }
       purged  true when the plan was dropped by retention. An empty chunks[] means TWO opposite
               things — retention worked, or the run died before planning — so it is stated, never
               inferred by the caller.
POST /api/job     { id, action }                actions: abandon | purge
       job    { jobId, user, rin, source, dateField, dir, from, to, state, done, failed,
                total, rows, probes, version, createdAt, updatedAt }
       chunk  { idx, chunkId, from, to, subF, subT, label, count, warn, state }

GET  /api/plans                                 → { plans:[…] }
POST /api/plan    { id, name, quota, features, price, active }   upsert
POST /api/plan/delete { id }                    refused while any user references it
```

`stuck=1` filters to jobs in `running`/`merging` whose `updated_at` is older than 30 minutes — the
support question "is anything wedged right now" needs one click, not a mental date comparison.

## Slice 3 — what "activation" actually changes

Three behaviours move from decorative to binding:

1. **Features come from the plan.** `/session` fills `features` from the user's plan, with a per-user
   override winning. The extension already receives `features` on every check-in and reads it
   NOWHERE — slice 3 is the first consumer. `auto-reject` gates the rejection tab.
2. **Expiry binds.** `valid_until` in the past → `/session` returns `allowed:false, reason:'expired'`
   and `/plan/start` refuses. A distinct reason, not a generic lock, so the drawer can say "your
   plan expired" instead of "you are locked" — those need different actions from the user.
3. **Quota moves to the person.** `/register` and RIN approval count clients across ALL of that
   user's devices instead of per device. This is the change that closes the double-quota hole, and
   it is a REAL behaviour change: a user who currently holds more clients than their plan allows
   keeps them (never confiscate silently) but cannot add more until under the cap. That grandfather
   rule is deliberate — retroactively removing a client would break exports mid-quarter.

Default plans seeded by the migration, editable in the portal:

| id | quota | features |
|---|---|---|
| `free` | 1 | — |
| `standard` | 5 | `auto-reject` |
| `pro` | 25 | `auto-reject`, `po-analytics` |

Pricing is not modelled beyond a free-text `price` — billing is out of scope until it hurts.

## Sections (slice 1)

**Dashboard** — the answer to "what is happening". Live runs with progress, today's totals, alerts
that demand action (stuck jobs, plans expiring within 14 days, error spikes), and a recent-events
feed. This is the landing page; it replaces Users as the default tab.

**Users** — searchable, filterable list. Row: name, company, plan, quota used/total, devices, jobs,
documents, status, last seen. Drilling in gives one page with their clients, devices, jobs, bugs and
audit history — the timeline that currently requires visiting five tabs.

**Clients** — one row per TRN. Which user manages it, void state, jobs and documents. Drilling in
gives that client's export history. Answers "who is exporting for this taxpayer" directly, which
today needs `/api/rin` plus manual cross-referencing.

## Slices

| | Contains | State |
|---|---|---|
| **1** | Spine + migration + shell + Dashboard + Users + Clients | **specified — build this** |
| 2 | Jobs section + live tool log | scoped |
| 3 | Activation, plans, feature gating (server + extension) | scoped |
| 4 | Bugs + audit trail with real admin identity | scoped |
| 5 | Extension: Download flow, drop the receipts tab | scoped |

Slice 3 is where the licensing hole actually closes. Until then quota stays per-device in the
extension API, and the portal reports the truth about that rather than hiding it.

## Test cases

| ID | Case |
|---|---|
| T-152 | Migration groups two devices sharing an email into ONE user |
| T-153 | Migrated quota is the MAX of the group, never the sum |
| T-154 | A RIN under two emails is reported as a conflict and left unassigned |
| T-155 | Migration is idempotent — running twice changes nothing and reports the same counts |
| T-156 | `/api/dashboard` reports a running job as active and a stale one as an alert |
| T-157 | `/api/users` paginates and filters by status and plan |
| T-158 | `/api/user` returns clients, devices and jobs for that email only |
| T-159 | `/api/clients` shows the managing user for each TRN |
| T-160 | `POST /api/client action=move` reassigns ownership and writes an audit entry |
| T-161 | Every mutating endpoint writes an audit entry carrying an actor |
| T-162 | Dual-write keeps a KV `dev:` record and its D1 `devices` row in step |

## Client-side (slice 5, specified here so it is not lost)

- **Drop the receipts tab.** The new flow selects Sales / Purchases / Receipts, so a parallel tab is
  a leftover of the old model.
- **Gate the rejection tab** on `features.includes('auto-reject')`. Note: the drawer currently reads
  `features` NOWHERE — `/session` returns it and nothing consumes it. This is the first gate, not a
  change to an existing one.

---

## API contract — slice 4 (bugs + audit trail)

Appended by the slice 4 build. Same rules as every section above: admin bearer token,
`{ok:true,…}` / `{ok:false,error}`, and **neither the backend nor the frontend may change these
unilaterally.**

```
GET  /api/bugs?status=&q=&page=      → { bugs:[…], total, page, pages, openCount }
       status  open | resolved | '' (all)      q  matches name·email·rin·message·deviceId·diag.version
       bug   { id, at, status, message, name, email, rin, deviceId, ua, version,
               diag, note, resolvedAt,                    ← the record as filed, fields unchanged
               user:   { …the /api/users user shape } | null,
               device: { deviceId, version, country, lastSeen, lastRin, … } | null,
               job:    { …the slice-2 job shape } | null,
               jobMatch: 'exact' | 'inferred' | 'none' }
       note  { text, at, by }                  by = the actor who assigned it

GET  /api/bug?id=                    → { bug, user, device, job, jobMatch, events:[…], eventWindowMs }
       events  the shipped run log AROUND the moment the report was filed (±10 min), oldest first.
               Empty for a run that reached 'done' — the log is purged with the chunks. The tail the
               CLIENT attached survives that, in bug.diag.log, because it is part of the report.

POST /api/bug   { id, action, value }  actions: resolve | reopen | delete | note (value = text)
                                     → { ok, bug:{ id, status, note, resolvedAt } } | { ok, deleted }

GET  /api/audit?page=&actor=&target=&action=   → { entries:[…], audit:[…], total, page, pages,
                                                   scanned, truncated }
       entry { at, action, actor, via, target, detail }
       via   'access' | 'token'   where the actor's name came from — never inferred by the reader
       audit an alias for `entries`; the legacy KV dashboard reads that key. Drop it with that page.
```

**The job join.** A report knows the browser it came from; the diag bundle already carries the plan
summary the user had on screen. The runs of that device made at or before the report are scored
against it (source ·2, from ·2, to ·2, chunk count ·3); ≥5 is `exact`. Otherwise the newest run that
device touched within 6 hours is offered as `inferred` — labelled, never presented as certain. A
browser that had made no run answers `none`, which is the correct answer for most reports.

**Filtering the trail** is a scan: `audit:` keys carry a descending timestamp and no index. It is
bounded at the newest 1000 records, and the answer says how many it read (`scanned`) and whether it
hit that ceiling (`truncated`) — a filtered list that quietly stopped early is worse than a refusal.

### Every mutating call carries an actor — and what changed

`detail` may now carry `before` / `after` (and `field`, where one column moved). Entitlement actions
always do: `setQuota`, `setDeviceQuota`, `setPlan`, `setValidUntil`, `setFeatures`, `setTags`,
`lock`/`unlock`, `kill`/`revive`, `super`/`unsuper`, plus plan and feature upserts and deletes, the
config edit, `void`/`unvoid`, `move`, and the job state changes. "Who set this to 1" is unanswerable
from an entry that records only that a button was pressed.

**Not logged, on purpose:**

| | Why |
|---|---|
| `clientKey`, bearer tokens, signatures, nonces | The trail lives 180 days and is read by more people than the secret store is. A redactor strips any detail key whose NAME looks like a credential, so this stays true when a field is added in a hurry. |
| the body of a support note or admin note | Free text about a named person, quoted from them. The entry records that a note was written and how long it was; the note itself lives on the record where whoever picks it up next will see it. |
| the body of a bug report on delete | The user's own words about their own tax data. Deleting it must not copy it somewhere longer-lived. |
| the text of an admin → device message | Already capped to a 60-character subject, as before. |

### Admin identity

`Cf-Access-Authenticated-User-Email` is read when present and becomes the actor; anything else is
`'token'`, exactly as before. **This is a label, not verification** — proving it means validating the
`Cf-Access-Jwt-Assertion` JWT against the team's public keys, which needs the team domain and
application AUD from the account owner's Cloudflare dashboard and is therefore out of scope here.
The action was already authorised by the bearer token; the header only says who was holding it. `via`
records which of the two the name came from so nobody reading the trail can mistake one for the
other. The day Access is switched on, the trail starts naming people with no code change.

### Audit gaps this slice closed

Two mutating endpoints wrote nothing at all before it, which is worse than having no trail because
the trail looked complete: `POST /api/bug` (resolve, reopen and **delete** — a user's report could be
destroyed without a record) and `POST /api/request` with `action=delete` (clearing clutter and making
an approval disappear are the same keystroke, and only one of them was visible). Both are audited
now. `POST /api/bug` and `GET /api/audit` moved from `routes/admin.js` to `routes/portal.js`, and
both are answered **before** the D1 gate: reading your own history and closing a report must not
depend on a binding the joins need.

### Test cases

| ID | Case |
|---|---|
| T-189 | A bug report joins to its user, its device and the run it came out of; a report with no diagnostics is `inferred`; a device that never ran an export is `none` |
| T-190 | resolve · reopen · delete · note are stored on the report and audited — including the two endpoints that used to mutate in silence |
| T-191 | The actor is the Access identity when the header is present, `'token'` when it is absent or malformed |
| T-192 | An entitlement change records the value on both sides of it; a support note records only its shape |
| T-193 | `/api/audit` pages and filters by actor, target and action |
| T-194 | No endpoint writes an entry without an actor, and no secret ever reaches the trail |
