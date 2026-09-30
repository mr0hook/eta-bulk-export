// SPEC-017 — the user / client / device domain in D1 (schema.sql).
//
// Why these are not KV: a `dev:` record IS the user today — name, email, company, quota and
// boundRins, keyed by BROWSER — so the same accountant on two machines is two users holding two
// quotas. Quota belongs to the person; a device inherits it. Enforcing that needs a real key (email)
// and joins, which prefix scans cannot give.
//
// Additive by design. KV keeps the `dev:` records and the extension API keeps enforcing from them
// until slice 3; /register dual-writes here so the two stores cannot drift, and /api/migrate
// backfills. Nothing here stores invoice content.
//
// Every function tolerates a missing env.JOBS by returning null/empty rather than throwing — the
// same contract jobs.js keeps, so an environment deployed without the D1 binding degrades to an
// empty portal instead of 500s. (The binding is still named JOBS: renaming it would need a
// wrangler.toml change on every environment for no behavioural gain.)
import { cleanRin, jobStaleBefore } from './lib/util.js';
import { rinOwnerGet } from './lib/kv.js';

export const hasDb = (env) => !!(env && env.JOBS);

const nowIso = () => new Date().toISOString();
const S = (v, n = 200) => String(v == null ? '' : v).slice(0, n);
const N = (v) => Math.max(0, Math.min(1e9, Math.trunc(Number(v) || 0)));
export const PAGE = 50;

// ── schema ────────────────────────────────────────────────────────────────────────────────────────
const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
     email TEXT PRIMARY KEY, name TEXT, company TEXT, phone TEXT,
     plan TEXT DEFAULT 'free', quota INTEGER DEFAULT 1, device_quota INTEGER, valid_until TEXT,
     status TEXT DEFAULT 'active', superadmin INTEGER DEFAULT 0, features TEXT,
     note TEXT, tags TEXT, country TEXT, created_at TEXT, updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS users_status ON users (status, email)`,
  `CREATE TABLE IF NOT EXISTS clients (
     rin TEXT PRIMARY KEY, user_email TEXT, company TEXT,
     voided INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS clients_user ON clients (user_email)`,
  `CREATE TABLE IF NOT EXISTS devices (
     device_id TEXT PRIMARY KEY, user_email TEXT, client_key TEXT,
     version TEXT, country TEXT, last_seen TEXT, last_rin TEXT,
     exports INTEGER DEFAULT 0, docs INTEGER DEFAULT 0, pdfs INTEGER DEFAULT 0, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS devices_user ON devices (user_email)`,
  `CREATE TABLE IF NOT EXISTS plans (
     id TEXT PRIMARY KEY, name TEXT, quota INTEGER, device_quota INTEGER DEFAULT 1,
     features TEXT, price TEXT, active INTEGER DEFAULT 1)`,
  // SPEC-019 — the feature catalogue. `auto-reject` and `po-analytics` were a vocabulary hard-coded
  // in the portal UI and nowhere else, so selling anything new meant editing a list in a file. A row
  // here is the commercial decision; the extension still has to ASK for the id by name for it to
  // gate anything (see the honest-limit note in the spec).
  `CREATE TABLE IF NOT EXISTS features (
     id TEXT PRIMARY KEY, name TEXT, description TEXT, active INTEGER DEFAULT 1, created_at TEXT)`,
];

// 'custom' is a users.plan value, never a plans row: it means "this account's numbers are written on
// the account itself". Reserved here so POST /api/plan can refuse it — two meanings for one id would
// make an account's allowance depend on which one the resolver looked at first.
export const CUSTOM_PLAN = 'custom';

// The floor a device allowance falls back to when nothing says otherwise (plan row missing, plan
// deactivated, column not yet added). NEVER 0: a plan row that vanished would otherwise lock every
// browser of every user on it out of registering, silently, with no error naming the cause.
const DEFAULT_DEVICE_QUOTA = 1;

// SPEC-017 slice 3 — the plans the product actually sells. Seeded from ensureSchema() rather than
// from migrate(), because plans are not backfilled data: every users row points at one by name, and
// on an environment where /api/migrate has never run a missing 'free' row would resolve every user's
// features to nothing. INSERT OR IGNORE, never REPLACE — re-running must not undo an admin's edits.
const DEFAULT_PLANS = [
  { id: 'free', name: 'Free', quota: 1, deviceQuota: 1, features: [], price: '' },
  { id: 'standard', name: 'Standard', quota: 5, deviceQuota: 3, features: ['auto-reject'], price: '' },
  { id: 'pro', name: 'Pro', quota: 25, deviceQuota: 10, features: ['auto-reject', 'po-analytics'], price: '' },
];

// SPEC-019 — the two features that exist today, seeded so the catalogue is never empty on an
// environment nobody has curated yet. INSERT OR IGNORE, like the plans: an admin who renames
// 'Auto rejection' must not find it renamed back on the next request.
const DEFAULT_FEATURES = [
  { id: 'auto-reject', name: 'Auto rejection', description: 'The Rejection tab and its scan/submit flow' },
  { id: 'po-analytics', name: 'PO reconciliation', description: 'The purchase-order matching card' },
];

/** Does this table already carry this column? Names are literals from this file, never user input. */
async function hasColumn(env, table, column) {
  const r = await env.JOBS.prepare(
    `SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = '${column}'`,
  ).first();
  return !!(r && r.n);
}

/**
 * Create the portal tables if they are absent, seed the default plans and features, and add the
 * columns that arrived after the tables did.
 *
 * The columns are the awkward part: SQLite has no `ADD COLUMN IF NOT EXISTS`, and a duplicate-column
 * error thrown mid-migration would abort everything after it. So ask the catalogue rather than
 * relying on the error text (which is not part of D1's contract), and still swallow a throw in case
 * two callers race each other.
 */
export async function ensureSchema(env) {
  if (!hasDb(env)) return false;
  for (const sql of DDL) await env.JOBS.prepare(sql).run();
  if (!(await hasColumn(env, 'jobs', 'user_email'))) {
    try { await env.JOBS.prepare('ALTER TABLE jobs ADD COLUMN user_email TEXT').run(); } catch {}
  }
  // SPEC-019 device allowance. The ALTER carries NO default on purpose: existing rows land on NULL,
  // and NULL is what lets the backfill below hand standard and pro their real allowances exactly
  // once. With `DEFAULT 1` every shipped plan would silently become a one-device plan and the
  // backfill would have no way to tell "1 because that is the plan" from "1 because SQLite said so".
  if (!(await hasColumn(env, 'plans', 'device_quota'))) {
    // Backfill inside the same try as the ALTER: if the column could not be added, the UPDATE cannot
    // run either, and this function is now called by every portal request — a throw here would take
    // the whole console down over a schema step that is allowed to lose a race and retry.
    try {
      await env.JOBS.prepare('ALTER TABLE plans ADD COLUMN device_quota INTEGER').run();
      await env.JOBS.batch(DEFAULT_PLANS.map((p) => env.JOBS.prepare(
        'UPDATE plans SET device_quota = ? WHERE id = ? AND device_quota IS NULL',
      ).bind(p.deviceQuota, p.id)));
    } catch {}
  }
  // NULL on a user means "inherit the plan", so no backfill here — writing a number would turn every
  // existing account into one carrying a per-account override nobody chose.
  if (!(await hasColumn(env, 'users', 'device_quota'))) {
    try { await env.JOBS.prepare('ALTER TABLE users ADD COLUMN device_quota INTEGER').run(); } catch {}
  }
  await env.JOBS.prepare('CREATE INDEX IF NOT EXISTS jobs_user_created ON jobs (user_email, created_at DESC)').run();
  const at = nowIso();
  await env.JOBS.batch([
    ...DEFAULT_PLANS.map((p) => env.JOBS.prepare(
      `INSERT OR IGNORE INTO plans (id, name, quota, device_quota, features, price, active) VALUES (?,?,?,?,?,?,1)`,
    ).bind(p.id, p.name, p.quota, p.deviceQuota, JSON.stringify(p.features), p.price)),
    ...DEFAULT_FEATURES.map((f) => env.JOBS.prepare(
      `INSERT OR IGNORE INTO features (id, name, description, active, created_at) VALUES (?,?,?,1,?)`,
    ).bind(f.id, f.name, f.description, at)),
  ]);
  return true;
}

// ── upserts ───────────────────────────────────────────────────────────────────────────────────────
// Two user upserts, deliberately. /* migrate */ is AUTHORITATIVE for the fields KV owns (quota,
// status, superadmin) because the migration recomputes them from the whole KV group on every run —
// that is what makes re-running it a repair rather than a ratchet. /* merge */ is what a single
// registration may do: it may raise, never lower, because one device knows nothing about its
// siblings. Neither ever touches plan / valid_until / note / tags, which exist only in the portal.
const USER_UPSERT_MIGRATE = `/* migrate */
INSERT INTO users (email, name, company, phone, plan, quota, valid_until, status, superadmin, features, note, tags, country, created_at, updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(email) DO UPDATE SET
  name        = COALESCE(NULLIF(users.name,''), excluded.name),
  company     = COALESCE(NULLIF(users.company,''), excluded.company),
  phone       = COALESCE(NULLIF(users.phone,''), excluded.phone),
  country     = COALESCE(NULLIF(users.country,''), excluded.country),
  quota       = excluded.quota,
  status      = excluded.status,
  superadmin  = excluded.superadmin,
  features    = CASE WHEN users.features IS NULL OR users.features IN ('','[]') THEN excluded.features ELSE users.features END,
  plan        = COALESCE(NULLIF(users.plan,''), excluded.plan),
  valid_until = COALESCE(NULLIF(users.valid_until,''), excluded.valid_until),
  note        = COALESCE(NULLIF(users.note,''), excluded.note),
  tags        = COALESCE(NULLIF(users.tags,''), excluded.tags),
  created_at  = COALESCE(NULLIF(users.created_at,''), excluded.created_at),
  updated_at  = excluded.updated_at`;

const USER_UPSERT_MERGE = `/* merge */
INSERT INTO users (email, name, company, phone, plan, quota, valid_until, status, superadmin, features, note, tags, country, created_at, updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(email) DO UPDATE SET
  name       = COALESCE(NULLIF(excluded.name,''), users.name),
  company    = COALESCE(NULLIF(excluded.company,''), users.company),
  phone      = COALESCE(NULLIF(excluded.phone,''), users.phone),
  country    = COALESCE(NULLIF(excluded.country,''), users.country),
  quota      = MAX(users.quota, excluded.quota),
  status     = CASE WHEN users.status = 'killed' OR excluded.status = 'killed' THEN 'killed'
                    WHEN users.status = 'locked' OR excluded.status = 'locked' THEN 'locked'
                    ELSE 'active' END,
  superadmin = MAX(users.superadmin, excluded.superadmin),
  updated_at = excluded.updated_at`;

const userBinds = (u, at) => [
  S(u.email, 254).toLowerCase(), S(u.name, 120), S(u.company, 160), S(u.phone, 40),
  S(u.plan || 'free', 40), N(u.quota), S(u.validUntil, 40), S(u.status || 'active', 16),
  u.superadmin ? 1 : 0, JSON.stringify(Array.isArray(u.features) ? u.features.map(String) : []),
  S(u.note, 2000), (Array.isArray(u.tags) ? u.tags : []).map(String).join(','), S(u.country, 8),
  S(u.createdAt || at, 40), at,
];

const upsertUserStmt = (env, sql, u, at) => env.JOBS.prepare(sql).bind(...userBinds(u, at));

// A client row is never REASSIGNED by an upsert — the guarded WHERE means a RIN already recorded
// against another email is left exactly as it is. Ownership only moves through the explicit
// `move` action, which is audited. (SPEC-017: "never silently reassigned".)
const CLIENT_UPSERT = `INSERT INTO clients (rin, user_email, company, voided, created_at, updated_at)
VALUES (?,?,?,0,?,?)
ON CONFLICT(rin) DO UPDATE SET
  company    = COALESCE(NULLIF(clients.company,''), excluded.company),
  updated_at = excluded.updated_at
WHERE clients.user_email = excluded.user_email`;

const upsertClientStmt = (env, c, at) => env.JOBS.prepare(CLIENT_UPSERT)
  .bind(cleanRin(c.rin), S(c.userEmail, 254).toLowerCase(), S(c.company, 160), S(c.createdAt || at, 40), at);

// Counters MAX-merge for the same reason seen: does in KV: a device whose localStorage was cleared
// restarts at 0 and must never regress the dashboard.
const DEVICE_UPSERT = `INSERT INTO devices (device_id, user_email, client_key, version, country, last_seen, last_rin, exports, docs, pdfs, created_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(device_id) DO UPDATE SET
  user_email = excluded.user_email,
  client_key = excluded.client_key,
  version    = COALESCE(NULLIF(excluded.version,''), devices.version),
  country    = COALESCE(NULLIF(excluded.country,''), devices.country),
  last_seen  = MAX(COALESCE(devices.last_seen,''), COALESCE(excluded.last_seen,'')),
  last_rin   = COALESCE(NULLIF(excluded.last_rin,''), devices.last_rin),
  exports    = MAX(devices.exports, excluded.exports),
  docs       = MAX(devices.docs, excluded.docs),
  pdfs       = MAX(devices.pdfs, excluded.pdfs)`;

const upsertDeviceStmt = (env, d, at) => env.JOBS.prepare(DEVICE_UPSERT).bind(
  S(d.deviceId, 80), S(d.userEmail, 254).toLowerCase(), S(d.clientKey, 128), S(d.version, 24),
  S(d.country, 8), S(d.lastSeen, 40), cleanRin(d.lastRin), N(d.exports), N(d.docs), N(d.pdfs),
  S(d.createdAt || at, 40),
);

// A job belongs to a person, not only to a browser. Only ever FILLS a blank — a job already stamped
// with an email keeps it, so a device that later changes hands cannot rewrite someone else's history.
const JOB_BACKFILL = `UPDATE jobs SET user_email = ? WHERE device_id = ? AND (user_email IS NULL OR user_email = '')`;

/**
 * Stamp this device's unowned jobs with its user. Called when a job is minted so the portal can
 * answer "who is exporting for this taxpayer" without waiting for the next migration run.
 * Best-effort at the call site: on an environment where /api/migrate has never run the column does
 * not exist yet, and a portal gap must not fail an export.
 */
export async function stampJobs(env, deviceId, email) {
  if (!hasDb(env) || !email) return false;
  await env.JOBS.prepare(JOB_BACKFILL).bind(String(email).toLowerCase(), S(deviceId, 80)).run();
  return true;
}

// ── dual-write from /register ─────────────────────────────────────────────────────────────────────
/**
 * Mirror one KV `dev:` record into D1. Best-effort by contract: the caller must never let a D1
 * failure fail a registration, and until /api/migrate has run once the tables may not exist at all —
 * in that case this throws, is swallowed, and the next migration picks the record up anyway.
 */
export async function mirrorDevice(env, dev) {
  if (!hasDb(env) || !dev || !dev.email) return false;
  const at = nowIso();
  const email = String(dev.email).trim().toLowerCase();
  const stmts = [
    upsertUserStmt(env, USER_UPSERT_MERGE, {
      email, name: dev.name, company: dev.company, phone: dev.phone, country: dev.country,
      quota: dev.quota, status: dev.killed ? 'killed' : dev.locked ? 'locked' : 'active',
      superadmin: dev.superadmin, features: dev.features, createdAt: dev.firstAt,
    }, at),
    upsertDeviceStmt(env, {
      deviceId: dev.deviceId, userEmail: email, clientKey: dev.clientKey, version: dev.version,
      country: dev.country, lastSeen: dev.lastSeen, lastRin: dev.lastRin,
      exports: dev.exports, docs: dev.docs, pdfs: dev.pdfs, createdAt: dev.firstAt,
    }, at),
  ];
  for (const rin of (dev.boundRins || [])) {
    stmts.push(upsertClientStmt(env, { rin, userEmail: email, company: dev.taxpayerName || dev.company, createdAt: dev.firstAt }, at));
  }
  stmts.push(env.JOBS.prepare(JOB_BACKFILL).bind(email, S(dev.deviceId, 80)));
  await env.JOBS.batch(stmts);
  return true;
}

// ── migration ─────────────────────────────────────────────────────────────────────────────────────
/**
 * Rebuild users / clients / devices from the KV `dev:` records handed in (already merged with seen:).
 *
 * Idempotent, and the counts are stable across runs because they describe what the migration OWNS
 * after the run, not what was newly inserted — "ran it twice, same report" is the only version of
 * that promise a caller can check.
 */
export async function migrate(env, devices) {
  const report = { users: 0, clients: 0, devices: 0, conflicts: [] };
  if (!hasDb(env)) return report;
  const at = nowIso();

  // Deterministic order so "first record wins" means the same thing on every run.
  const ordered = [...devices].sort((a, b) =>
    String(a.firstAt || '').localeCompare(String(b.firstAt || '')) ||
    String(a.deviceId || '').localeCompare(String(b.deviceId || '')));

  const groups = new Map();
  for (const d of ordered) {
    const email = String(d.email || '').trim().toLowerCase();
    if (!email) continue;                       // pre-email records: a device row, but no user to own it
    let g = groups.get(email);
    if (!g) g = groups.set(email, { email, name: '', company: '', phone: '', country: '', note: '', createdAt: '', quota: 0, killed: false, locked: false, superadmin: false, features: new Set(), tags: new Set() }).get(email);
    g.name ||= S(d.name, 120); g.company ||= S(d.company, 160);
    g.phone ||= S(d.phone, 40); g.country ||= S(d.country, 8); g.note ||= S(d.note, 2000);
    // MAX, never the sum. The sum would bless exactly the hole this migration exists to close: two
    // browsers, two quotas, one licence.
    g.quota = Math.max(g.quota, N(d.quota));
    g.killed = g.killed || !!d.killed;
    g.locked = g.locked || !!d.locked;
    g.superadmin = g.superadmin || !!d.superadmin;
    for (const f of (d.features || [])) g.features.add(String(f));
    for (const t of (d.tags || [])) g.tags.add(String(t));
    const first = String(d.firstAt || '');
    if (first && (!g.createdAt || first < g.createdAt)) g.createdAt = first;
  }

  // Which email holds which RIN. A RIN under two emails is a CONFLICT: reported, and left with
  // whatever the rinowner: Durable Object already says, never silently reassigned to one of them.
  const byRin = new Map();
  for (const d of ordered) {
    const email = String(d.email || '').trim().toLowerCase();
    if (!email) continue;
    for (const raw of (d.boundRins || [])) {
      const rin = cleanRin(raw);
      if (!rin) continue;
      let e = byRin.get(rin);
      if (!e) e = byRin.set(rin, { emails: new Set(), company: '' }).get(rin);
      e.emails.add(email);
      e.company ||= S(d.taxpayerName || d.company, 160);
    }
  }

  const clientRows = [];
  for (const [rin, e] of byRin) {
    if (e.emails.size > 1) {
      let owner = '';
      try { owner = String((await rinOwnerGet(env, rin)) || ''); } catch {}
      report.conflicts.push({ rin, emails: [...e.emails].sort(), owner: owner.slice(0, 8) });
      continue;
    }
    clientRows.push({ rin, userEmail: [...e.emails][0], company: e.company });
  }

  const stmts = [];
  for (const g of groups.values()) {
    stmts.push(upsertUserStmt(env, USER_UPSERT_MIGRATE, {
      email: g.email, name: g.name, company: g.company, phone: g.phone, country: g.country,
      quota: g.quota, status: g.killed ? 'killed' : g.locked ? 'locked' : 'active',
      superadmin: g.superadmin, features: [...g.features], tags: [...g.tags], note: g.note,
      createdAt: g.createdAt,
    }, at));
  }
  for (const c of clientRows) stmts.push(upsertClientStmt(env, c, at));
  for (const d of ordered) {
    const email = String(d.email || '').trim().toLowerCase();
    stmts.push(upsertDeviceStmt(env, {
      deviceId: d.deviceId, userEmail: email, clientKey: d.clientKey, version: d.version,
      country: d.country, lastSeen: d.lastSeen, lastRin: d.lastRin,
      exports: d.exports, docs: d.docs, pdfs: d.pdfs, createdAt: d.firstAt,
    }, at));
    if (email) stmts.push(env.JOBS.prepare(JOB_BACKFILL).bind(email, S(d.deviceId, 80)));
  }

  // Chunked: a D1 batch is one transaction and one request, and a namespace with thousands of
  // devices would otherwise be a single statement list large enough to be refused outright.
  for (let i = 0; i < stmts.length; i += 40) await env.JOBS.batch(stmts.slice(i, i + 40));

  report.users = groups.size;
  report.clients = clientRows.length;
  report.devices = ordered.length;
  return report;
}

// ── reads ─────────────────────────────────────────────────────────────────────────────────────────
const rows = (r) => (r && r.results) || [];

const USER_COLS = `u.email, u.name, u.company, u.plan, u.quota, u.device_quota, u.status, u.valid_until, u.tags,
       u.note, u.features, u.superadmin, u.country, u.created_at,
       (SELECT COUNT(*) FROM clients c WHERE c.user_email = u.email AND c.voided = 0) AS client_count,
       (SELECT COUNT(*) FROM devices d WHERE d.user_email = u.email) AS device_count,
       (SELECT COUNT(*) FROM jobs j WHERE j.user_email = u.email) AS job_count,
       (SELECT COALESCE(SUM(d2.docs),0) FROM devices d2 WHERE d2.user_email = u.email) AS docs,
       (SELECT MAX(d3.last_seen) FROM devices d3 WHERE d3.user_email = u.email) AS last_seen`;

const USER_WHERE = `WHERE (? = '' OR u.email LIKE ? OR u.name LIKE ? OR u.company LIKE ?)
   AND (? = '' OR u.status = ?)
   AND (? = '' OR u.plan = ?)`;

const userFilterBinds = (f) => {
  const q = S(f.q, 80).toLowerCase(), like = '%' + q + '%';
  return [q, like, like, like, S(f.status, 16), S(f.status, 16), S(f.plan, 40), S(f.plan, 40)];
};

export async function listUsers(env, f = {}) {
  if (!hasDb(env)) return { users: [], total: 0 };
  const page = Math.max(1, N(f.page) || 1);
  const binds = userFilterBinds(f);
  const total = await env.JOBS.prepare(`SELECT COUNT(*) AS n FROM users u ${USER_WHERE}`).bind(...binds).first();
  const r = await env.JOBS.prepare(
    `SELECT ${USER_COLS} FROM users u ${USER_WHERE} ORDER BY last_seen DESC, u.email ASC LIMIT ? OFFSET ?`,
  ).bind(...binds, PAGE, (page - 1) * PAGE).all();
  return { users: rows(r), total: (total && total.n) | 0 };
}

export async function getUser(env, email) {
  if (!hasDb(env)) return null;
  const r = await env.JOBS.prepare(
    `SELECT ${USER_COLS} FROM users u WHERE u.email = ?`,
  ).bind(String(email || '').toLowerCase()).first();
  return r || null;
}

const CLIENT_COLS = `c.rin, c.company, c.user_email, c.voided, c.created_at,
       (SELECT us.name FROM users us WHERE us.email = c.user_email) AS user_name,
       (SELECT COUNT(*) FROM jobs j WHERE j.rin = c.rin) AS job_count,
       (SELECT COALESCE(SUM(j2.total_rows),0) FROM jobs j2 WHERE j2.rin = c.rin) AS docs,
       (SELECT MAX(j3.updated_at) FROM jobs j3 WHERE j3.rin = c.rin) AS last_export_at`;

const CLIENT_WHERE = `WHERE (? = '' OR c.rin LIKE ? OR c.company LIKE ? OR c.user_email LIKE ?)
   AND (? = '' OR c.user_email = ?)`;

const clientFilterBinds = (f) => {
  const q = S(f.q, 80).toLowerCase(), like = '%' + q + '%';
  const email = S(f.userEmail, 254).toLowerCase();
  return [q, like, like, like, email, email];
};

export async function listClients(env, f = {}) {
  if (!hasDb(env)) return { clients: [], total: 0 };
  const page = Math.max(1, N(f.page) || 1);
  const binds = clientFilterBinds(f);
  const total = await env.JOBS.prepare(`SELECT COUNT(*) AS n FROM clients c ${CLIENT_WHERE}`).bind(...binds).first();
  const r = await env.JOBS.prepare(
    `SELECT ${CLIENT_COLS} FROM clients c ${CLIENT_WHERE} ORDER BY c.rin ASC LIMIT ? OFFSET ?`,
  ).bind(...binds, PAGE, (page - 1) * PAGE).all();
  return { clients: rows(r), total: (total && total.n) | 0 };
}

export async function getClient(env, rin) {
  if (!hasDb(env)) return null;
  const r = await env.JOBS.prepare(`SELECT ${CLIENT_COLS} FROM clients c WHERE c.rin = ?`).bind(cleanRin(rin)).first();
  return r || null;
}

/** client_key is deliberately NOT selected — it is the device's HMAC secret, not display data. */
export async function listDevices(env, email) {
  if (!hasDb(env)) return [];
  const r = await env.JOBS.prepare(
    `SELECT device_id, user_email, version, country, last_seen, last_rin, exports, docs, pdfs, created_at
       FROM devices WHERE user_email = ? ORDER BY last_seen DESC LIMIT 100`,
  ).bind(String(email || '').toLowerCase()).all();
  return rows(r);
}

/**
 * SPEC-017 slice 4 — one device by id, for the bug↔user join.
 *
 * listDevices() answers "this person's browsers"; a bug report knows a deviceId and may know no
 * email at all (an old client, or a report filed before the person was migrated), so the join has to
 * be able to walk the other way. client_key is omitted for the same reason it is omitted there: it
 * is the device's HMAC secret, not display data.
 */
export async function getDevice(env, deviceId) {
  if (!hasDb(env)) return null;
  const r = await env.JOBS.prepare(
    `/* device row */ SELECT device_id, user_email, version, country, last_seen, last_rin, exports, docs, pdfs, created_at
       FROM devices WHERE device_id = ?`,
  ).bind(S(deviceId, 80)).first();
  return r || null;
}

// Every column the SPEC-017 job shape needs, in one list — /api/jobs, /api/job and the drill-ins all
// render the same row, and a column missing from one of them would show as a blank field rather than
// as an error.
const JOB_COLS = `id, user_email, device_id, rin, source, date_field, dir, from_iso, to_iso, state,
       total_chunks, total_rows, done_count, failed_count, probes, version, created_at, updated_at`;

/** One statement serves three callers: a user's jobs, a client's jobs, and the dashboard feed. */
export async function listJobs(env, f = {}) {
  if (!hasDb(env)) return [];
  const email = S(f.userEmail, 254).toLowerCase(), rin = cleanRin(f.rin);
  const r = await env.JOBS.prepare(
    `SELECT ${JOB_COLS}
       FROM jobs WHERE (? = '' OR user_email = ?) AND (? = '' OR rin = ?)
      ORDER BY created_at DESC LIMIT ?`,
  ).bind(email, email, rin, rin, N(f.limit) || 50).all();
  return rows(r);
}

/**
 * SPEC-017 slice 4 — the runs a DEVICE has made, newest first, so a bug report filed from that
 * browser can be matched against the run that was in flight when it was filed. Device-keyed rather
 * than person-keyed on purpose: the report names the browser it came from, and two of a person's
 * browsers can be exporting different things at the same moment.
 */
export async function listJobsForDevice(env, deviceId, limit = 20) {
  if (!hasDb(env)) return [];
  const r = await env.JOBS.prepare(
    `/* bug jobs */ SELECT ${JOB_COLS} FROM jobs WHERE device_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).bind(S(deviceId, 80), N(limit) || 20).all();
  return rows(r);
}

// The Jobs section (slice 2). `stuck` is the support question "is anything wedged right now" as one
// predicate: only a run that claims to be MOVING can be wedged, so 'planned' — a plan waiting for
// the user to press Download — is deliberately excluded however old it is.
const JOB_WHERE = `WHERE (? = '' OR state = ?)
   AND (? = '' OR user_email = ?)
   AND (? = '' OR rin = ?)
   AND (? = 0 OR (state IN ('running','merging') AND updated_at < ?))`;

const jobFilterBinds = (f) => {
  const state = S(f.state, 16), email = S(f.userEmail, 254).toLowerCase(), rin = cleanRin(f.rin);
  return [state, state, email, email, rin, rin, f.stuck ? 1 : 0, S(f.staleBefore, 40)];
};

export async function listJobsPage(env, f = {}) {
  if (!hasDb(env)) return { jobs: [], total: 0 };
  const page = Math.max(1, N(f.page) || 1);
  const binds = jobFilterBinds(f);
  const total = await env.JOBS.prepare(`/* jobs page */ SELECT COUNT(*) AS n FROM jobs ${JOB_WHERE}`).bind(...binds).first();
  const r = await env.JOBS.prepare(
    `/* jobs page */ SELECT ${JOB_COLS} FROM jobs ${JOB_WHERE} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...binds, PAGE, (page - 1) * PAGE).all();
  return { jobs: rows(r), total: (total && total.n) | 0 };
}

/**
 * One job for the portal. NOT device-scoped, unlike jobs.js getJob(): there the job id is a
 * bearer-ish handle and one device must never drive another's run, here the admin token is the
 * authority and the whole point is to look at somebody else's job.
 */
export async function getJobRow(env, id) {
  if (!hasDb(env)) return null;
  const r = await env.JOBS.prepare(`/* job row */ SELECT ${JOB_COLS} FROM jobs WHERE id = ?`).bind(S(id, 64)).first();
  return r || null;
}

/** Admin state change on a job (abandon). Counters are left alone — they are the run's history. */
export async function setJobState(env, id, state) {
  if (!hasDb(env)) return false;
  await env.JOBS.prepare('UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?')
    .bind(S(state, 16), nowIso(), S(id, 64)).run();
  return true;
}

/**
 * Drop a job's working rows, keeping its history row — the SAME retention rule checkpoint() applies
 * when a run reaches 'done'. Not device-scoped for the same reason as getJobRow. The user-visible
 * cost is real and worth stating: /job/plan answers 410 afterwards, so a run purged mid-flight can
 * no longer be resumed. That is why this is an explicit admin action and not something inferred.
 */
export async function purgeJobChunks(env, id) {
  if (!hasDb(env)) return false;
  await env.JOBS.prepare('/* admin */ DELETE FROM job_chunks WHERE job_id = ?').bind(S(id, 64)).run();
  return true;
}

/**
 * Runs the dashboard should treat as live. Bounded by jobStaleBefore(): a job left in 'planning' or
 * 'planned' because the tab was closed used to sit in "Running now" and in the activeJobs counter
 * for ever, so the panel that exists to show what is happening NOW filled up with last month.
 * After 24 hours without a checkpoint it drops out of both — the history row is untouched.
 */
export async function listActiveJobs(env) {
  if (!hasDb(env)) return [];
  const r = await env.JOBS.prepare(
    `SELECT id, user_email, rin, source, state, done_count, total_chunks, updated_at
       FROM jobs WHERE state IN ('planning','planned','running','merging') AND updated_at >= ?
      ORDER BY updated_at DESC LIMIT 50`,
  ).bind(jobStaleBefore()).all();
  return rows(r);
}

/** Every dashboard counter in one round trip — the landing page should cost one query, not seven. */
export async function dashboardStats(env, { since, horizon }) {
  if (!hasDb(env)) return {};
  const r = await env.JOBS.prepare(
    `SELECT (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM clients WHERE voided = 0) AS clients,
            (SELECT COUNT(*) FROM devices) AS devices,
            (SELECT COUNT(*) FROM jobs WHERE state IN ('planning','planned','running','merging') AND updated_at >= ?) AS active_jobs,
            (SELECT COUNT(*) FROM jobs WHERE created_at >= ?) AS jobs_today,
            (SELECT COALESCE(SUM(total_rows),0) FROM jobs WHERE created_at >= ?) AS docs_today,
            (SELECT COUNT(*) FROM users WHERE valid_until IS NOT NULL AND valid_until <> '' AND valid_until <= ?) AS expiring_soon`,
  ).bind(jobStaleBefore(), since, since, horizon).first();   // bind order follows the ?s above: stale bound, since, since, horizon
  return r || {};
}

export async function listExpiring(env, horizon) {
  if (!hasDb(env)) return [];
  const r = await env.JOBS.prepare(
    `SELECT email, name, valid_until FROM users
      WHERE valid_until IS NOT NULL AND valid_until <> '' AND valid_until <= ?
      ORDER BY valid_until ASC LIMIT 10`,
  ).bind(horizon).all();
  return rows(r);
}

// ── plans + entitlement (slice 3) ─────────────────────────────────────────────────────────────────
const parseList = (v) => { try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } };

export async function listPlans(env) {
  if (!hasDb(env)) return [];
  const r = await env.JOBS.prepare(
    '/* plans */ SELECT id, name, quota, device_quota, features, price, active FROM plans ORDER BY quota ASC, id ASC',
  ).all();
  return rows(r);
}

export async function getPlan(env, id) {
  if (!hasDb(env)) return null;
  const r = await env.JOBS.prepare('/* plan */ SELECT id, name, quota, device_quota, features, price, active FROM plans WHERE id = ?')
    .bind(S(id, 40).toLowerCase()).first();
  return r || null;
}

export async function upsertPlan(env, p) {
  if (!hasDb(env)) return false;
  // device_quota is the ONE column an omitted field must not overwrite: every other field is on the
  // portal form, but an API caller (or an older form) that never mentions device_quota would
  // otherwise silently cut Pro from ten devices to one. Bind NULL for "not mentioned" and keep what
  // is already there.
  await env.JOBS.prepare(
    `INSERT INTO plans (id, name, quota, device_quota, features, price, active) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, quota = excluded.quota,
       device_quota = COALESCE(excluded.device_quota, plans.device_quota),
       features = excluded.features, price = excluded.price, active = excluded.active`,
  ).bind(
    S(p.id, 40).toLowerCase(), S(p.name, 60), N(p.quota),
    p.deviceQuota == null ? null : N(p.deviceQuota),
    JSON.stringify(Array.isArray(p.features) ? p.features.map(String) : []), S(p.price, 60),
    p.active ? 1 : 0,
  ).run();
  return true;
}

// ── feature catalogue (SPEC-019) ──────────────────────────────────────────────────────────────────
export async function listFeatures(env) {
  if (!hasDb(env)) return [];
  const r = await env.JOBS.prepare(
    '/* features */ SELECT id, name, description, active, created_at FROM features ORDER BY id ASC',
  ).all();
  return rows(r);
}

export async function getFeature(env, id) {
  if (!hasDb(env)) return null;
  const r = await env.JOBS.prepare('/* feature */ SELECT id, name, description, active, created_at FROM features WHERE id = ?')
    .bind(featureId(id)).first();
  return r || null;
}

/** Slug rules for a catalogue id — it is written verbatim into every grant, so keep it boring. */
export const featureId = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);

/**
 * Create or edit a catalogue entry. The id is the primary key and is NEVER rewritten: a grant on a
 * plan or a user stores the id as a string, so renaming one would revoke the feature everywhere it
 * had been sold, silently. Renaming a feature means creating the new id and granting it.
 * created_at survives an edit for the same reason — it is the row's birthday, not a field.
 */
export async function upsertFeature(env, f) {
  if (!hasDb(env)) return false;
  await env.JOBS.prepare(
    `INSERT INTO features (id, name, description, active, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
       active = excluded.active`,
  ).bind(featureId(f.id), S(f.name, 80), S(f.description, 400), f.active ? 1 : 0, nowIso()).run();
  return true;
}

export async function deleteFeature(env, id) {
  if (!hasDb(env)) return false;
  await env.JOBS.prepare('DELETE FROM features WHERE id = ?').bind(featureId(id)).run();
  return true;
}

/**
 * How many plans and how many users currently grant this feature. The delete route refuses on any
 * count: grants are JSON arrays of ids, so deleting the catalogue row would leave a live grant
 * pointing at nothing and the portal would render a feature nobody can explain.
 *
 * LIKE on the JSON text rather than a join, because the grant lists are TEXT columns. The pattern
 * includes the quotes — '"po"' cannot match inside '"po-analytics"' — so a prefix is not a match.
 */
export async function countFeatureGrants(env, id) {
  if (!hasDb(env)) return { plans: 0, users: 0 };
  const like = '%"' + featureId(id) + '"%';
  const r = await env.JOBS.prepare(
    `/* feature grants */ SELECT (SELECT COUNT(*) FROM plans WHERE features LIKE ?) AS plans,
            (SELECT COUNT(*) FROM users WHERE features LIKE ?) AS users`,
  ).bind(like, like).first();
  return { plans: (r && r.plans) | 0, users: (r && r.users) | 0 };
}

/**
 * Split a requested grant list into what the catalogue will allow and what it will not.
 *
 * The point of a catalogue is that it can say no: before this, a typo in the features box produced a
 * feature nobody would ever hold and no error at all. `inactive` is refused separately from
 * `unknown` because they are different answers to the admin — one is a typo, the other is a feature
 * that has been retired and can no longer be sold (though everyone already holding it keeps it).
 */
export async function checkFeatureIds(env, ids) {
  const want = [...new Set((ids || []).map(featureId).filter(Boolean))];
  if (!want.length) return { unknown: [], inactive: [], bad: [] };
  const cat = new Map((await listFeatures(env)).map((f) => [f.id, f]));
  const unknown = want.filter((id) => !cat.has(id));
  const inactive = want.filter((id) => cat.has(id) && !cat.get(id).active);
  return { unknown, inactive, bad: [...unknown, ...inactive] };
}

/** How many users would be orphaned by deleting this plan. The delete route refuses on any count. */
export async function countPlanUsers(env, id) {
  if (!hasDb(env)) return 0;
  const r = await env.JOBS.prepare('/* plan users */ SELECT COUNT(*) AS n FROM users WHERE plan = ?')
    .bind(S(id, 40).toLowerCase()).first();
  return (r && r.n) | 0;
}

export async function deletePlan(env, id) {
  if (!hasDb(env)) return false;
  await env.JOBS.prepare('DELETE FROM plans WHERE id = ?').bind(S(id, 40).toLowerCase()).run();
  return true;
}

/**
 * What this PERSON is entitled to, resolved once and used by every gate.
 *
 * Returns null when there is no D1 row for them — a pre-migration install, or a device that has
 * never registered since slice 1 shipped. Callers must fall back to the KV `dev:` record in that
 * case: activation is meant to bind the plan, not to strip entitlements off installs the portal has
 * not met yet.
 *
 *   features   the per-user override when set, otherwise the plan's grant. An empty override means
 *              "unset", the same reading migrate() uses ('' / '[]'), so clearing an override hands
 *              the user back to their plan rather than to nothing.
 *   quotaEff   MAX(user, plan). The user column is what an admin typed by hand or what the migration
 *              recovered from KV; the plan column is what the label promises. Taking the larger of
 *              the two means moving somebody onto a bigger plan actually raises their cap, while a
 *              bespoke allowance survives a plan rename. Lowering a cap stays an explicit setQuota.
 *   devicesEff the same rule for browsers (SPEC-019), so assigning a bigger plan is never a
 *              downgrade by accident either.
 *   source     where each number came from — 'plan' | 'custom' | 'override'. The portal has to be
 *              able to show "25 clients (from pro)" against "12 clients (custom)": an admin who has
 *              to guess which will eventually edit the plan to fix one account and move everybody.
 *
 * plan = 'custom' detaches the account from the plans table completely: quota, device_quota and
 * features are read VERBATIM and the MAX rule does NOT apply. That is the whole point of a custom
 * account — MAX would make it impossible to negotiate a cap LOWER than a standard plan, which is
 * the most common reason one is opened.
 */
export async function resolveEntitlement(env, email) {
  if (!hasDb(env) || !email) return null;
  // SELECT * rather than a column list: device_quota arrives with SPEC-019 and an environment that
  // has not run ensureSchema() since would answer "no such column" — this function is on the
  // /register and /session paths, where a schema lag must degrade, never throw.
  const u = await env.JOBS.prepare(
    `/* entitlement */ SELECT * FROM users WHERE email = ?`,
  ).bind(String(email).trim().toLowerCase()).first();
  if (!u) return null;
  const plan = S(u.plan || 'free', 40);
  const own = parseList(u.features);
  const ownDevices = u.device_quota == null || u.device_quota === '' ? null : N(u.device_quota);
  const base = {
    email: S(u.email, 254), plan, status: S(u.status || 'active', 16), validUntil: S(u.valid_until, 40),
    superadmin: !!u.superadmin, quota: N(u.quota), deviceQuota: ownDevices,
  };

  if (plan === CUSTOM_PLAN) {
    return {
      ...base, custom: true,
      planQuota: 0, quotaEff: N(u.quota),
      planDeviceQuota: 0, deviceQuotaEff: ownDevices == null ? DEFAULT_DEVICE_QUOTA : ownDevices,
      features: own, override: true,
      source: { quota: 'custom', devices: 'custom', features: 'custom' },
    };
  }

  const p = await getPlan(env, plan);
  const live = !!(p && p.active);
  const planFeatures = live ? parseList(p.features) : [];
  const planQuota = live ? N(p.quota) : 0;
  // A missing or retired plan row falls back to the one-device floor rather than to 0 — see
  // DEFAULT_DEVICE_QUOTA. The client quota keeps its existing 0 fallback: there the user column
  // carries a real number recovered from KV, so nobody ends up at zero because of it.
  const planDevices = (live && p.device_quota != null) ? N(p.device_quota) : DEFAULT_DEVICE_QUOTA;
  return {
    ...base, custom: false,
    planQuota, quotaEff: Math.max(N(u.quota), planQuota),
    planDeviceQuota: planDevices, deviceQuotaEff: Math.max(ownDevices == null ? 0 : ownDevices, planDevices),
    features: own.length ? own : planFeatures, override: own.length > 0,
    source: {
      quota: N(u.quota) > planQuota ? 'override' : 'plan',
      devices: (ownDevices != null && ownDevices > planDevices) ? 'override' : 'plan',
      features: own.length ? 'override' : 'plan',
    },
  };
}

// ── writes from the portal ────────────────────────────────────────────────────────────────────────
// Whitelisted column names only: the value is bound, but the column is interpolated, so the set of
// legal columns must be closed here rather than anywhere a caller can reach.
const USER_FIELD = {
  status: 'status', quota: 'quota', device_quota: 'device_quota', plan: 'plan',
  valid_until: 'valid_until', features: 'features', note: 'note', tags: 'tags',
  superadmin: 'superadmin',
};

export async function setUserField(env, email, field, value) {
  if (!hasDb(env)) return false;
  const col = USER_FIELD[field];
  if (!col) return false;
  const r = await env.JOBS.prepare(`UPDATE users SET ${col} = ?, updated_at = ? WHERE email = ?`)
    .bind(value, nowIso(), String(email || '').toLowerCase()).run();
  return !!r;
}

/**
 * Portal delete. Removes the person and their device rows but keeps their clients, blanking the
 * owner: a TRN that vanished from the portal would look like it was never exported for, when in
 * fact the jobs history still names it. The KV `dev:` records are untouched — enforcement still
 * runs off them until slice 3, and a re-run of /api/migrate restores the row.
 */
export async function deleteUser(env, email) {
  if (!hasDb(env)) return false;
  const e = String(email || '').toLowerCase();
  await env.JOBS.batch([
    env.JOBS.prepare(`UPDATE clients SET user_email = '', updated_at = ? WHERE user_email = ?`).bind(nowIso(), e),
    env.JOBS.prepare('DELETE FROM devices WHERE user_email = ?').bind(e),
    env.JOBS.prepare('DELETE FROM users WHERE email = ?').bind(e),
  ]);
  return true;
}

export async function setClientVoided(env, rin, voided) {
  if (!hasDb(env)) return false;
  await env.JOBS.prepare('UPDATE clients SET voided = ?, updated_at = ? WHERE rin = ?')
    .bind(voided ? 1 : 0, nowIso(), cleanRin(rin)).run();
  return true;
}

export async function moveClient(env, rin, toEmail) {
  if (!hasDb(env)) return false;
  await env.JOBS.prepare('UPDATE clients SET user_email = ?, updated_at = ? WHERE rin = ?')
    .bind(String(toEmail || '').toLowerCase(), nowIso(), cleanRin(rin)).run();
  return true;
}
