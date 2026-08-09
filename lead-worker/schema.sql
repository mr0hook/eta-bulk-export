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

-- ═══ SPEC-018 Part B · the run log ═══════════════════════════════════════════════════════════════
-- Status lines shipped by the extension while a run is in flight — the same strings the drawer
-- displays and the bug reporter already sends. Counts and progress; NEVER document content.
--
-- Capped at 200 rows per job (newest kept) by jobs.js appendEvents, and purged with the job's chunks
-- when it reaches 'done'. Same retention rule as the plan: the history of WHAT ran survives, the
-- minute-by-minute detail does not. seq is the client's arrival order, which is what makes "the
-- newest 200" a well-defined set when several flushes land in the same second.
--
-- The Worker also creates this table lazily (jobs.js ensureEvents), so an environment deployed
-- before this file was re-applied starts logging on its next flush rather than 500ing.
CREATE TABLE IF NOT EXISTS job_events (
  job_id  TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  at      TEXT,
  level   TEXT,
  kind    TEXT,
  text    TEXT,
  PRIMARY KEY (job_id, seq)
);

-- ═══ SPEC-017 · admin portal v2 ══════════════════════════════════════════════════════════════════
-- The defect these tables exist to close: a KV `dev:` record IS the user — it carries name, email,
-- company, quota and boundRins, keyed by BROWSER. The same accountant on a laptop and an office PC
-- is therefore two users holding two quotas. Quota belongs to the person; a device inherits it.
-- That needs a real key (email) and joins, which KV prefix scans cannot give.
--
-- Additive: KV keeps audit, errors, snapshots, config, nonces and rate limits, and the extension API
-- keeps enforcing from `dev:` until slice 3. /register dual-writes into these tables so the two
-- stores cannot drift, and POST /api/migrate backfills them from KV (idempotent).

CREATE TABLE IF NOT EXISTS users (
  email       TEXT PRIMARY KEY,
  name        TEXT,
  company     TEXT,
  phone       TEXT,
  plan        TEXT DEFAULT 'free',    -- a plans.id, or the reserved 'custom' (numbers live on the row)
  quota       INTEGER DEFAULT 1,
  device_quota INTEGER,               -- SPEC-019 per-account override; NULL = inherit the plan
  valid_until TEXT,
  status      TEXT DEFAULT 'active',    -- active | locked | killed
  superadmin  INTEGER DEFAULT 0,
  features    TEXT,                     -- JSON array; plan fills it, per-user override wins
  note        TEXT,
  tags        TEXT,
  country     TEXT,
  created_at  TEXT,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS users_status ON users (status, email);

CREATE TABLE IF NOT EXISTS clients (
  rin        TEXT PRIMARY KEY,
  user_email TEXT,
  company    TEXT,
  voided     INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS clients_user ON clients (user_email);

CREATE TABLE IF NOT EXISTS devices (
  device_id  TEXT PRIMARY KEY,
  user_email TEXT,
  client_key TEXT,
  version    TEXT,
  country    TEXT,
  last_seen  TEXT,
  last_rin   TEXT,
  exports    INTEGER DEFAULT 0,
  docs       INTEGER DEFAULT 0,
  pdfs       INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS devices_user ON devices (user_email);

CREATE TABLE IF NOT EXISTS plans (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  quota        INTEGER,               -- clients (TRNs) the plan allows
  device_quota INTEGER DEFAULT 1,     -- SPEC-019: browsers the plan allows
  features     TEXT,
  price        TEXT,
  active       INTEGER DEFAULT 1
);

-- Every users row points at a plan by name, and slice 3 resolves features and the plan cap through
-- it, so the three defaults are part of the schema rather than of the migration: a database without
-- a 'free' row would silently resolve every user's features to nothing. OR IGNORE, never REPLACE —
-- the Worker re-runs the identical statements from ensureSchema() and must not undo an admin's edits.
INSERT OR IGNORE INTO plans (id, name, quota, device_quota, features, price, active) VALUES
  ('free',     'Free',     1,  1,  '[]',                                '', 1),
  ('standard', 'Standard', 5,  3,  '["auto-reject"]',                   '', 1),
  ('pro',      'Pro',      25, 10, '["auto-reject","po-analytics"]',    '', 1);

-- ═══ SPEC-019 · the feature catalogue ════════════════════════════════════════════════════════════
-- Features were a vocabulary hard-coded in the portal UI and nowhere else, so selling anything new
-- meant editing a list in a source file — the wrong place for a commercial decision to live.
--
-- `active = 0` means "cannot be NEWLY granted". It never revokes: everyone already holding the
-- feature keeps it, because taking a feature away mid-quarter is a support call, not a config
-- change. Grants are stored as JSON arrays of these ids on plans.features and users.features, which
-- is why an id is never renamed and why deleting a row is refused while any grant names it.
CREATE TABLE IF NOT EXISTS features (
  id          TEXT PRIMARY KEY,       -- slug, written verbatim into every grant
  name        TEXT,
  description TEXT,
  active      INTEGER DEFAULT 1,
  created_at  TEXT
);

-- The two that exist today. A catalogue row does not gate anything by itself: 'auto-reject' opens
-- the Rejection tab because src/ui/flow.js asks for that id by name, so a NEW feature is a sellable
-- label until someone wires the one line that checks it.
INSERT OR IGNORE INTO features (id, name, description, active, created_at) VALUES
  ('auto-reject',  'Auto rejection',    'The Rejection tab and its scan/submit flow', 1, ''),
  ('po-analytics', 'PO reconciliation', 'The purchase-order matching card',           1, '');

-- NOTE for an EXISTING database: this file is the fresh-install shape. `users.device_quota` and
-- `plans.device_quota` cannot be added by re-running it (the CREATEs are IF NOT EXISTS and do
-- nothing). The Worker adds both, guarded by pragma_table_info, in src/users.js ensureSchema() —
-- which every /api/* portal request calls — and backfills the three shipped plans' device
-- allowances exactly once, so an upgraded database converges on the shape above by itself.

-- A job belongs to a person, not only to a browser. Backfilled from devices by /api/migrate.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, so a SECOND run of this file stops on the next line with
-- "duplicate column name: user_email". That is harmless — every statement above is IF NOT EXISTS and
-- has already applied — but it does abort the run, which is why the index below sits after it and
-- why the Worker performs the identical step guarded (pragma_table_info) in src/users.js
-- ensureSchema(), called by /api/migrate. Running the migration once gives you both without this file.
ALTER TABLE jobs ADD COLUMN user_email TEXT;
CREATE INDEX IF NOT EXISTS jobs_user_created ON jobs (user_email, created_at DESC);
