# ADR-002 — Job and progress records go in D1, not KV

Date: 2026-08-09 · Status: proposed (blocks roadmap A2) · Context: admin roadmap A2

## Context

The backend stores everything in one KV namespace (`env.LEADS`): device records, RIN ownership,
requests, bugs, audit, errors, daily snapshots. A2 introduces a new kind of record — a **job**: one
export run, its chunk list, and its progress, checkpointed by the extension as the run proceeds.

Jobs differ from everything KV currently holds in two ways that matter.

**Write volume.** A device record is written on registration and on admin action — a handful of
writes per user per month. A job is written on every checkpoint. A run with 200 chunks checkpointing
per chunk is 200 writes. Cloudflare KV's free tier allows **1,000 writes/day**, so a single wide
export consumes a fifth of the daily budget, and five of them exhaust it — taking registration and
audit writes down with it, because they share the namespace.

**Query shape.** The admin jobs list needs filtering (by state, RIN, version, date) and ordering.
KV offers prefix listing only. Every existing admin list already pays for this: `listPrefix` scans
all keys and bulk-gets them 100 at a time, then filters in JavaScript. That is tolerable for a few
hundred devices. It is not tolerable for jobs, which grow with usage rather than with customers.

KV also has no compare-and-set. The `/session` handler already carries a comment explaining the
workaround it needed — writing telemetry to a *separate* `seen:` key so a stale snapshot cannot
clobber admin-owned fields. Job progress has the same hazard with more writers.

## Decision

Job and chunk records go in **Cloudflare D1**. KV keeps device, RIN, request, bug, audit, error and
snapshot records — where its access pattern fits and its write volume is low.

## Why D1 over the alternatives

- **D1 free tier**: 100k writes/day and 5M row reads/day — two orders of magnitude more headroom
  than the KV budget being contended for, and it is a *separate* budget, so a runaway job loop can
  no longer starve registration.
- Relational queries are what the jobs list and every A3 integrity signal are made of ("devices
  with usage counters rising and no jobs in the same window" is a join, not a prefix scan).
- **Durable Objects** would give strong consistency per job, and `Locks` proves the pattern is
  already viable here — but DO storage is priced per object and gives no cross-job query surface.
  A jobs list would mean fanning out across thousands of objects.
- **Keeping it in KV** is rejected on the write budget alone.

## Consequences

- A second storage system to back up. `/backup` currently dumps the whole KV namespace and is the
  only restorable artifact; it must grow a D1 export or explicitly document that jobs are not
  covered. Losing job history is survivable — losing device records is not — but that must be a
  stated decision, not an oversight.
- Schema migrations become a thing this project has to manage.
- The extension's checkpoint frequency becomes a design parameter with a real budget behind it.
  Batching (every N chunks or every T seconds) should be specced in A2, not left to taste.
- `/privacy` must be updated before A2 ships: job records tie a RIN to date ranges and document
  counts, which the current policy does not describe.

## Status

Proposed, not implemented. A2 has not started; this ADR exists so the decision is settled before
the schema is written.
