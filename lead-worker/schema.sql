-- SPEC-016 / roadmap A2 — job records.
--
-- D1 rather than KV, per ADR-002: a run checkpointing 200 chunks would consume a fifth of KV's
-- 1,000 free daily writes in a single export, and the admin jobs list needs WHERE and ORDER BY that
-- prefix scans cannot give. KV keeps device, RIN, request, bug, audit and snapshot records.
--
-- Apply:  npx wrangler d1 execute eta-bulk-jobs --file=schema.sql --remote --env staging
-- Nothing here stores invoice content. A job records WHICH ranges were asked for and HOW MANY
-- documents they held — the same shape store.js already writes to eta_progress.json in the user's
-- own folder. /privacy must describe this before it reaches production.

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL,
  rin           TEXT,
  source        TEXT,               -- 'invoices' | 'receipts'
  date_field    TEXT,               -- Issue | Submission | DateTimeReceived | DateTimeIssued
  dir           TEXT,
  from_iso      TEXT,
  to_iso        TEXT,
  statuses      TEXT,               -- JSON array
  state         TEXT NOT NULL,      -- planning|planned|running|done|incomplete|halted|abandoned
  total_chunks  INTEGER DEFAULT 0,
  total_rows    INTEGER DEFAULT 0,
  done_count    INTEGER DEFAULT 0,
  failed_count  INTEGER DEFAULT 0,
  probes        INTEGER DEFAULT 0,
  version       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- The admin jobs list is "this device's runs, newest first"; the integrity signals in A3 are
-- "jobs for this device within a window". Both are served by this index.
CREATE INDEX IF NOT EXISTS jobs_device_created ON jobs (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_state_updated  ON jobs (state, updated_at DESC);

-- One row per accepted chunk, written as the planner decides it. idx preserves plan ORDER, which is
-- load-bearing: the client fetches chunks in it, and a reordered plan would change which documents
-- land in which file.
CREATE TABLE IF NOT EXISTS job_chunks (
  job_id    TEXT NOT NULL,
  idx       INTEGER NOT NULL,
  chunk_id  TEXT NOT NULL,
  from_iso  TEXT,
  to_iso    TEXT,
  sub_f     TEXT,
  sub_t     TEXT,
  label     TEXT,
  count     INTEGER,
  warn      TEXT,
  state     TEXT DEFAULT 'pending',  -- pending|done|failed
  PRIMARY KEY (job_id, idx)
);
