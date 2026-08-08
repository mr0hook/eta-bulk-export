# Admin backend — next-level roadmap

> Status: **menu, not an approved design.** This is the option space for growing
> `lead-worker/` from a licence check-in endpoint with a single-file dashboard into an
> operations backend. Nothing here is committed. Each phase is written so it can be
> approved, specced (`30-spec`) and built on its own.
>
> Date: 2026-08-09 · Author: delivery OS session · Related: the S1/S2 server-planner
> design still in brainstorming (job model, D1, sealed cursor).

---

## 1. Where the backend is today

`lead-worker/worker.js` — 1,478 lines, one file, one Cloudflare Worker, one KV namespace
(`env.LEADS`). It contains three unrelated things glued together:

| Part | What it is |
|---|---|
| Extension API | `/register`, `/session`, `/rin-request`, `/bug` — HMAC-signed, device-keyed |
| Admin API | `/api/*` — users, requests, bugs, voids, audit, errors, insights, snaps, trash, config, health, void, user actions, export, backup |
| Admin UI | `DASH` — a template-literal HTML/CSS/JS single-page app with six tabs (Users, Insights, RIN requests, Bug reports, Activity, Tools), served from `/admin` |

What already works and should not be rebuilt: the signed check-in protocol, the
lock/kill/void/version/quota verdict model, RIN claiming, the audit log, the 30-day trash,
`/export` and `/backup`, the honest `/privacy` page, and the error log.

What limits it:

- **One file.** A planner, a job store and a richer UI cannot land in a 1,478-line module
  without making it unmaintainable.
- **KV only.** Fine for device records. Wrong for jobs — 1,000 writes/day on the free tier,
  no queries, last-writer-wins with no CAS (the `/session` handler already carries a comment
  explaining the workaround it needed).
- **Shared-secret admin auth.** One bearer token typed at a login screen. No rotation, no
  second factor, no per-admin identity, so the audit log records *what* but never *who*.
- **No job domain at all.** The backend knows a device exists and how many documents it
  claims to have exported. It cannot see a single run.

---

## 2. Phases

Ordered by dependency, not by appeal. Effort is calendar-honest for one person working in
this codebase, assuming the usual spec-first cycle.

### A0 · Platform split — *prerequisite for everything below*

**Why.** Every later phase adds code to a file that is already at its limit. Do this once,
early, or pay for it in every phase.

**Scope.**
- Break `worker.js` into modules: `routes/extension.js`, `routes/admin.js`, `auth.js`,
  `kv.js`, `audit.js`, and lift the `DASH` blob out into its own asset.
- Move the dashboard from a template literal to real files served by Workers Static Assets,
  built with the esbuild setup the extension already uses. Same deployment, one Worker,
  but the UI stops being a string and starts being reviewable, diffable code.
- Split `wrangler` environments: `staging` and `production`, with separate KV/D1 bindings,
  so admin changes stop being tested against live customer records.

**Gate.** Existing endpoints byte-identical in behaviour; a smoke script exercises all
`/api/*` routes against staging; `/api/health` reports which environment answered.

**Effort.** 2–3 days. **Depends on.** nothing.

---

### A1 · Real admin identity and auth

**Why.** A single shared token is the weakest link in a console that can kill every
installation at once (`cfg.globalKill`) and delete accounts. And an audit trail that cannot
name the actor is half an audit trail.

**Scope.**
- Replace the bearer token with **Cloudflare Access** in front of `/admin` and `/api/*`
  (zero code, identity from a Google login, free tier covers a handful of seats). Fall back
  to passkey/WebAuthn sessions only if Access is rejected for some reason.
- Per-admin identity threaded into `audit()` — every entry gains `actor`.
- Roles: `owner` (config, global kill, delete, backup) vs `support` (read, lock/unlock,
  reply to requests). Even as a one-person operation this is worth it the first time you
  hand someone a login.
- Destructive actions (`globalKill`, `delete`, `/api/config`) require a typed confirmation
  and land in audit with a reason string.

**Gate.** Token auth removed entirely; every mutating route recorded with an actor; a
support-role session provably cannot reach an owner-role route.

**Effort.** 1–2 days with Access. **Depends on.** A0.

---

### A2 · Jobs — the operations domain

**Why.** This is the phase that turns the console from a customer list into an operations
tool, and it is the one the server-planner work creates the data for.

**Scope.**
- **D1 schema:** `jobs` (id, device_id, rin, source, date field, direction, range, statuses,
  state, totals, timestamps, extension version) and `job_chunks` (job_id, chunk_id, range,
  count, state, error). D1 rather than KV: 100k writes/day, and the jobs list needs `WHERE`
  and `ORDER BY`.
- **Jobs tab:** filterable list (state, RIN, date, version), newest first.
- **Job detail:** the chunk timeline — which chunks are done, which failed and why, where it
  stopped, how long each phase took. This is the artefact that answers "the export failed"
  support emails without asking the user for a log.
- **Stuck-job detection:** a job in `running` with no checkpoint for N minutes is surfaced.
- **Admin actions:** abandon a job, force-release its folder claim, re-issue its plan.
- **Retention:** jobs older than 90 days pruned by a cron trigger; counts survive as
  aggregates.

**Gate.** A run started in the extension appears in the console within one checkpoint
interval; killing the tab mid-run leaves a job the console correctly shows as stuck; the
chunk timeline matches `eta_progress.json` in the user's folder exactly.

**Effort.** 4–6 days. **Depends on.** A0; the S2 planner/checkpoint work on the client side.

---

### A3 · Integrity — detecting patched clients

**Why.** This is the phase that pays back the server-planner investment. Once planning is a
server conversation, **a patched client becomes visible**: it check-ins with rising usage
counters but produces no jobs, or reports a version that was never published, or exports
documents it never planned.

**Scope.**
- **Integrity tab** with derived signals, each a plain rule over data you already hold:
  - usage counters climbing with zero jobs in the same window;
  - `/session` version not in the published-version list;
  - documents exported far exceeding documents planned;
  - one RIN check-ing in from many device ids in a short window;
  - impossible travel between check-in countries (Cloudflare already gives you the country).
- Each signal is **advisory** — a score and an explanation, never an automatic kill. False
  positives here cost you a paying customer.
- One-click path from a signal to the device record, its jobs, and the lock/kill actions.

**Gate.** Every signal reproducible from stored data by hand; a deliberately patched build
in staging raises at least the "usage without jobs" signal; no signal can trigger an
automated block.

**Effort.** 3–4 days. **Depends on.** A2.

---

### A4 · Commercial layer — plans, quotas, renewals

**Why.** Today entitlement is `boundRins`, `features`, `quota` and a lock switch. That is
enough to give access away and take it back; it is not enough to sell.

**Scope.**
- **Plan objects** (free / standard / whatever the tiers turn out to be) instead of
  per-device feature arrays: a plan defines feature flags, RIN count, monthly document
  quota, and an expiry. Devices reference a plan; overrides stay possible per device.
- **Expiry and renewal:** `validUntil` on the account, a check in `/session`'s verdict
  (a new `reason: 'expired'`), a warning banner in the last N days via the message channel
  that already exists, and a renewals view listing who lapses this month.
- **Quota enforcement that means something:** enforced at `/plan/start` against *planned*
  document counts, not at check-in against self-reported ones.
- **Payments:** deliberately out of scope as code. Record payments manually in the console
  first. Only integrate a gateway (Paymob/Fawry are the realistic Egyptian options) once
  the manual process is annoying enough to justify it.

**Gate.** An account whose `validUntil` has passed is denied with a distinct reason and a
distinct in-extension message; quota denial happens before a job is minted, never mid-run.

**Effort.** 4–5 days without payments. **Depends on.** A1, A2.

---

### A5 · Support surface

**Why.** Everything here removes an email round-trip.

**Scope.**
- **Unified user timeline:** registration → check-ins → jobs → bug reports → admin actions,
  one chronological view per device. Today these live in five separate tabs.
- **Bug reports linked to jobs** — the report already carries a diagnostic bundle; join it
  to the job it happened in.
- **Targeted announcements:** the banner is global today (`cfg.announcement`). Add targeting
  by version, by plan, by RIN — "everyone still on 0.4.0" is the message you actually want
  to send.
- **Reply channel:** the per-device `message` field exists and the extension renders it.
  Give it a threaded history so you can see what you already told someone.
- **Self-service customer page:** a signed link showing a customer their own account — RIN
  bindings, plan, expiry, recent jobs. Every question it answers is one you do not.

**Effort.** 3–4 days. **Depends on.** A2.

---

### A6 · Observability and alerting

**Why.** You currently learn about an outage when a user emails you.

**Scope.**
- **Grouped errors:** the error log is a flat list. Group by kind + shape, with counts and
  first/last seen, so one broken deploy is one row rather than four hundred.
- **Alerts** on: error-rate spike, `globalKill` engaged, a version's failure rate crossing a
  threshold, no check-ins at all for N hours (the backend being down looks exactly like
  nobody using it). Delivery by email — Resend is already in this environment — or Telegram.
- **Version adoption chart:** what share of installs is on each version, which makes the
  version kill-switch a measured decision instead of a guess.
- **Backup verification:** `/backup` exists; add a scheduled restore-into-staging check that
  proves the backup is restorable, and alert when it is not.

**Effort.** 2–3 days. **Depends on.** A0, and A2 for the job-derived metrics.

---

## 3. Recommended order

```
A0 platform split ──┬─→ A1 auth ──────────────┐
                    │                          ├─→ A4 commercial
                    └─→ A2 jobs ──┬─→ A3 integrity
                                  ├─→ A5 support
                                  └─→ A6 observability
```

If only three phases ever get built: **A0, A2, A3.** A0 because everything else is worse
without it, A2 because it is the one that changes what you can do in a support conversation,
A3 because it is the only phase that directly serves the reason this conversation started.

---

## 4. Deliberately not in this plan

- **A separate frontend framework / SPA build.** The dashboard is a few thousand lines of
  vanilla JS and works. Moving it to React buys nothing here and costs a build pipeline.
- **A second database or an ORM.** KV plus D1 covers every phase above.
- **Multi-tenant admin.** One operator, possibly one assistant. Roles (A1) are enough.
- **Automated blocking from integrity signals.** Explicitly rejected in A3 — the false
  positive costs more than the fraud.
- **A payment gateway before manual invoicing hurts.** Stated in A4 and repeated here
  because it is the most tempting premature build on this list.

---

## 5. Decisions that need an ADR before building

1. **D1 vs KV for job records.** (Recommendation: D1 — write limits and query needs. This
   one is already load-bearing for the S2 client work.)
2. **Cloudflare Access vs self-built admin sessions.** (Recommendation: Access.)
3. **Retention periods** for jobs, errors and check-in telemetry — and the matching update
   to `/privacy`, which is a public, honest document and must not drift from what the
   backend actually stores.
4. **Whether job metadata counts as personal data** under Egypt's PDPL for the purposes of
   the erasure workflow. A job record ties a RIN to date ranges and document counts; the
   privacy page must describe it before A2 ships.

---

## 6. Open question for the next session

A2 assumes the client-side server-planner work (S1/S2) lands first, because that is what
produces jobs. If the admin work needs to start sooner, A0, A1 and A6 can all be built
against today's data with no client changes at all.
