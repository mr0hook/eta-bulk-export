# SPEC-018 — Extension flow (slice 5) and run logging

> Two independent pieces, specified together because both land in the extension and both were asked
> for in the same breath: the Download flow the user actually touches, and the log that makes a run
> visible in the portal.

## Part A — the Download flow

Today reaching "data is downloading" costs about a dozen decisions across three views: source toggle,
year, from, to, direction, date field, statuses, columns, PDFs, folder, **Build**, then **Start**.
The drawer carries 107 identified elements.

### The flow

```
┌ ETA Bulk ─────────────┐
│  ◉ Download           │   ← one primary action
│  ↻ Resume · 2025 Sales│   ← only when /job/resumable returns one
│      190 / 412 chunks │
└───────────────────────┘
        ↓ folder picker
┌ What to export ───────┐
│  Sales │ Purchases │ Receipts │
│  From [2026-01-01] To [today] │
│  ▸ Advanced                   │
│              [ Start ]        │
└───────────────────────┘
        ↓
┌ Running ──────────────┐
│  chunk 12/412  ███░░░ │
│  log streams here     │
└───────────────────────┘
```

### Rules

- **Sales / Purchases / Receipts** replaces the source toggle *and* the direction select.
  `Sales → invoices + dir Sent`, `Purchases → invoices + dir Received`, `Receipts → receipts`.
- **Default range: current calendar year**, 1 Jan → today.
- **Everything else moves behind `▸ Advanced`**, collapsed, remembering its last value: date field,
  statuses, columns, PDFs. Defaults: all statuses, all columns, PDFs off.
- **The separate Receipts tab is deleted.** It is the same job as Sales/Purchases, reached twice.
- **Merge runs automatically** when the fetch completes — the job is not done until the output
  exists. It then checkpoints `done`, which is what purges the plan server-side. Merge stays
  available as a standalone action for a folder the user did not just export into.
- **Repair is not in the flow.** `repair.js` fixes illegal XML characters in files produced by OTHER
  tools — its own header says this tool never writes them. It surfaces only when merge reports
  skipped-unreadable files, as an offer attached to that message.
- **The rejection tab is gated** on `features.includes('auto-reject')`. When absent it is hidden and
  a single line explains why. The drawer reads `features` NOWHERE today; this is the first consumer.

### Non-negotiable

The Advanced defaults must reproduce today's behaviour exactly. A user who presses Download and
never opens Advanced must get the same documents they would have got by configuring it by hand. A
default that silently narrows an export is the worst failure this tool can have.

## Part B — run logging

The portal can show what a run *is*; it cannot show what a run *did*. `runlog.js` holds the lines in
memory and `folderlog.js` persists them to the user's folder (SPEC-011), but nothing reaches the
operator unless the user files a bug.

### What ships

Status lines only — the same strings the drawer already displays and the bug reporter already
sends, which are counts and progress, never invoice content. `"▶ Chunk 3/412 fetching 200/1000…"`
is shippable; a document number is not.

### Contract

```
POST /job/log   signed   { jobId, lines:[ {at, level, kind, text} ] }  → { ok }
```

- **Batched**: the client buffers and flushes every 15 s or 50 lines, whichever first, and always on
  a terminal line. A per-line request would be one write per progress tick.
- **Capped**: 200 lines per job server-side, keeping the newest. A run emits thousands; the last 200
  are what a support conversation needs.
- **Coalesced**: lines carrying `kind` (`rate`, `page`, `probe`) are high-frequency by design —
  the client keeps only the most recent of each per flush, as the folder log already does.
- Stored in a `job_events` table, **purged with the job's chunks** on `done`. Same retention rule:
  the history of what ran survives, the minute-by-minute detail does not.

```sql
CREATE TABLE IF NOT EXISTS job_events (
  job_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT, level TEXT, kind TEXT, text TEXT,
  PRIMARY KEY (job_id, seq));
```

Portal: `GET /api/job?id=` gains `events:[…]`, rendered as a live tail on the job detail. The
dashboard's live-run rows link to it.

### Failure policy

Log shipping is best-effort and must never fail, slow or block a run. A failed flush drops that
batch and moves on — the authoritative log is the one in the user's folder, which SPEC-011 already
guarantees.

## Test cases

| ID | Case |
|---|---|
| T-163 | Sales/Purchases/Receipts maps to the right source+direction pair |
| T-164 | Download with untouched Advanced produces the same plan request as today's configured run |
| T-165 | Default range is 1 Jan of the current year → today |
| T-166 | Advanced remembers its last values across drawer close/open |
| T-167 | The rejection tab is hidden without `auto-reject` and shown with it |
| T-168 | Merge runs automatically on fetch completion, then checkpoints `done` |
| T-169 | Repair is offered only when merge reports unreadable files |
| T-170 | Resume appears only when `/job/resumable` returns a job, and resumes from its stored plan |
| T-171 | Log lines batch by count and by interval, and flush on a terminal line |
| T-172 | High-frequency `kind` lines coalesce to the newest per flush |
| T-173 | `job_events` is capped at 200 newest per job |
| T-174 | A failed log flush does not fail, slow or halt the run |
| T-175 | Events purge with the chunks when a job reaches `done` |
