// Functional smoke test for worker.js — runs in plain Node with an in-memory KV stub (no wrangler).
//   node smoke-worker.mjs
// Covers: /register → signed /bug with+without diag (sanitize+cap) → /rin-request dedupe → sig-fail
// error logging → /session stats max-merge + per-user message delivery (incl. locked) → trash
// delete/restore (RIN re-claim, lostRins, 409) → scheduled() snapshot → admin reads.
import { webcrypto } from 'crypto';
import { register } from 'node:module';
const { subtle } = webcrypto;

// Node can't resolve 'cloudflare:workers' or import *.html — smoke-hooks.mjs supplies both, so the
// whole src/ tree loads exactly as written (no text rewriting of the source under test).
register('./smoke-hooks.mjs', import.meta.url);
const worker = (await import(new URL('./worker.js', import.meta.url).href)).default;

const store = new Map();
const LEADS = {
  async get(k, type) {
    if (Array.isArray(k)) { const m = new Map(); for (const n of k) m.set(n, store.has(n) ? (type === 'json' ? JSON.parse(store.get(n)) : store.get(n)) : null); return m; }
    if (!store.has(k)) return null;
    return type === 'json' ? JSON.parse(store.get(k)) : store.get(k);
  },
  async put(k, v) { store.set(k, String(v)); },
  async delete(k) { store.delete(k); },
  async list({ prefix }) { return { keys: [...store.keys()].filter((n) => n.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true, cursor: null }; },
};
// Minimal D1 stub for the planner (SPEC-016) and portal (SPEC-017) routes. Deliberately NOT a SQL
// engine — it recognises the statements jobs.js and users.js issue and nothing else, so an
// unrecognised query throws loudly rather than silently returning empty and making a broken route
// look like it passed. Each branch reimplements that statement's SEMANTICS (the guarded client
// upsert, the MAX-merged counters, the escalating status), because those are the parts worth
// testing; getting them wrong here would make a wrong route pass.
function makeD1() {
  const jobs = new Map(), chunks = [], events = [], users = new Map(), clients = new Map(), devices = new Map(), plans = new Map(), features = new Map();
  const kept = (cur, ex) => (cur !== null && cur !== undefined && cur !== '') ? cur : ex;   // COALESCE(NULLIF(cur,''), ex)
  const owned = (email, m) => [...m.values()].filter((r) => r.user_email === email);

  const exec = (sql, a) => {
    if (/^\s*(CREATE|ALTER)\s/.test(sql)) return { success: true };                    // DDL: ensureSchema()
    if (sql.includes('INSERT INTO jobs')) { jobs.set(a[0], { id: a[0], device_id: a[1], rin: a[2], source: a[3], date_field: a[4], dir: a[5], from_iso: a[6], to_iso: a[7], statuses: a[8], state: 'planning', version: a[9], created_at: a[10], updated_at: a[11], total_chunks: 0, total_rows: 0, done_count: 0, failed_count: 0, probes: 0, user_email: '' }); return { success: true }; }
    if (sql.includes('INSERT OR REPLACE INTO job_chunks')) { chunks.push({ job_id: a[0], idx: a[1], chunk_id: a[2], from_iso: a[3], to_iso: a[4], sub_f: a[5], sub_t: a[6], label: a[7], count: a[8], warn: a[9], state: 'pending' }); return { success: true }; }
    if (sql.includes("SET state='planned'")) { const j = jobs.get(a[4]); if (j) Object.assign(j, { state: 'planned', total_chunks: a[0], total_rows: a[1], probes: a[2], updated_at: a[3] }); return { success: true }; }
    if (sql.includes('SET state=?, done_count=?')) { const j = jobs.get(a[4]); if (j && j.device_id === a[5]) Object.assign(j, { state: a[0], done_count: a[1], failed_count: a[2], updated_at: a[3] }); return { success: true }; }
    // The timeline half of a checkpoint: substr(map, idx+1, 1) per row, device-scoped through jobs.
    if (sql.includes('UPDATE job_chunks')) {
      const map = String(a[0]), j = jobs.get(a[2]);
      const WORD = { d: 'done', f: 'failed', r: 'running' };
      if (j && j.device_id === a[3]) for (const c of chunks) if (c.job_id === a[1]) c.state = WORD[map[c.idx]] || 'pending';
      return { success: true };
    }
    // The portal's purge is NOT device-scoped (admin token is the authority) — matched first, since
    // the device-scoped delete below shares its opening clause.
    if (sql.includes('/* admin */ DELETE FROM job_chunks')) { for (let i = chunks.length - 1; i >= 0; i--) if (chunks[i].job_id === a[0]) chunks.splice(i, 1); return { success: true }; }
    if (sql.includes('DELETE FROM job_chunks')) { const j = jobs.get(a[1]); if (j && j.device_id === a[2]) { for (let i = chunks.length - 1; i >= 0; i--) if (chunks[i].job_id === a[0]) chunks.splice(i, 1); } return { success: true }; }
    // SPEC-018 — the shipped run log. seq is assigned by jobs.js from the current MAX, so the stub
    // stores it verbatim and reimplements the two deletes that bound the table: the cap trim
    // (seq <= newest-200) and the device-scoped purge that rides along with the chunks at 'done'.
    if (sql.includes('INSERT OR REPLACE INTO job_events')) { events.push({ job_id: a[0], seq: a[1], at: a[2], level: a[3], kind: a[4], text: a[5] }); return { success: true }; }
    if (sql.includes('/* purge events */')) { const j = jobs.get(a[1]); if (j && j.device_id === a[2]) for (let i = events.length - 1; i >= 0; i--) if (events[i].job_id === a[0]) events.splice(i, 1); return { success: true }; }
    if (sql.includes('DELETE FROM job_events')) { for (let i = events.length - 1; i >= 0; i--) if (events[i].job_id === a[0] && events[i].seq <= a[1]) events.splice(i, 1); return { success: true }; }

    if (sql.includes('UPDATE jobs SET user_email')) { for (const j of jobs.values()) if (j.device_id === a[1] && !j.user_email) j.user_email = a[0]; return { success: true }; }
    if (sql.includes('UPDATE jobs SET state = ?')) { const j = jobs.get(a[2]); if (j) { j.state = a[0]; j.updated_at = a[1]; } return { success: true }; }

    if (sql.includes('INSERT INTO users')) {
      const k = ['email', 'name', 'company', 'phone', 'plan', 'quota', 'valid_until', 'status', 'superadmin', 'features', 'note', 'tags', 'country', 'created_at', 'updated_at'];
      const ex = {}; k.forEach((n, i) => { ex[n] = a[i]; });
      const cur = users.get(ex.email);
      if (!cur) { users.set(ex.email, { ...ex }); return { success: true }; }
      if (sql.includes('/* migrate */')) Object.assign(cur, {
        name: kept(cur.name, ex.name), company: kept(cur.company, ex.company), phone: kept(cur.phone, ex.phone), country: kept(cur.country, ex.country),
        quota: ex.quota, status: ex.status, superadmin: ex.superadmin,
        features: (!cur.features || cur.features === '[]') ? ex.features : cur.features,
        plan: kept(cur.plan, ex.plan), valid_until: kept(cur.valid_until, ex.valid_until),
        note: kept(cur.note, ex.note), tags: kept(cur.tags, ex.tags),
        created_at: kept(cur.created_at, ex.created_at), updated_at: ex.updated_at,
      });
      else Object.assign(cur, {
        name: ex.name || cur.name, company: ex.company || cur.company, phone: ex.phone || cur.phone, country: ex.country || cur.country,
        quota: Math.max(cur.quota | 0, ex.quota | 0),
        status: (cur.status === 'killed' || ex.status === 'killed') ? 'killed' : (cur.status === 'locked' || ex.status === 'locked') ? 'locked' : 'active',
        superadmin: Math.max(cur.superadmin | 0, ex.superadmin | 0), updated_at: ex.updated_at,
      });
      return { success: true };
    }
    if (sql.includes('UPDATE users SET')) { const col = sql.match(/UPDATE users SET (\w+) = \?/)[1]; const u = users.get(a[2]); if (u) { u[col] = a[0]; u.updated_at = a[1]; } return { success: true }; }
    if (sql.includes('DELETE FROM users')) { users.delete(a[0]); return { success: true }; }

    if (sql.includes('INSERT INTO clients')) {
      const [rin, user_email, company, created_at, updated_at] = a;
      const cur = clients.get(rin);
      if (!cur) clients.set(rin, { rin, user_email, company, voided: 0, created_at, updated_at });
      else if (cur.user_email === user_email) { cur.company = kept(cur.company, company); cur.updated_at = updated_at; }   // guarded WHERE: never reassigns
      return { success: true };
    }
    if (sql.includes("UPDATE clients SET user_email = ''")) { for (const c of owned(a[1], clients)) { c.user_email = ''; c.updated_at = a[0]; } return { success: true }; }
    if (sql.includes('UPDATE clients SET user_email = ?')) { const c = clients.get(a[2]); if (c) { c.user_email = a[0]; c.updated_at = a[1]; } return { success: true }; }
    if (sql.includes('UPDATE clients SET voided')) { const c = clients.get(a[2]); if (c) { c.voided = a[0]; c.updated_at = a[1]; } return { success: true }; }

    if (sql.includes('INSERT INTO devices')) {
      const k = ['device_id', 'user_email', 'client_key', 'version', 'country', 'last_seen', 'last_rin', 'exports', 'docs', 'pdfs', 'created_at'];
      const ex = {}; k.forEach((n, i) => { ex[n] = a[i]; });
      const cur = devices.get(ex.device_id);
      if (!cur) { devices.set(ex.device_id, { ...ex }); return { success: true }; }
      Object.assign(cur, {
        user_email: ex.user_email, client_key: ex.client_key,
        version: ex.version || cur.version, country: ex.country || cur.country,
        last_seen: String(cur.last_seen || '') > String(ex.last_seen || '') ? cur.last_seen : ex.last_seen,
        last_rin: ex.last_rin || cur.last_rin,
        exports: Math.max(cur.exports | 0, ex.exports | 0), docs: Math.max(cur.docs | 0, ex.docs | 0), pdfs: Math.max(cur.pdfs | 0, ex.pdfs | 0),
      });
      return { success: true };
    }
    if (sql.includes('DELETE FROM devices')) { for (const d of owned(a[0], devices)) devices.delete(d.device_id); return { success: true }; }

    // plans: the seed is INSERT OR IGNORE (an admin's edits survive every ensureSchema), the portal
    // upsert overwrites every column. Two different statements, two different meanings.
    if (sql.includes('INSERT OR IGNORE INTO plans')) {
      if (!plans.has(a[0])) plans.set(a[0], { id: a[0], name: a[1], quota: a[2], device_quota: a[3], features: a[4], price: a[5], active: 1 });
      return { success: true };
    }
    if (sql.includes('INSERT INTO plans')) {
      const cur = plans.get(a[0]);
      // COALESCE(excluded.device_quota, plans.device_quota): an upsert that never mentions the
      // device allowance must not silently cut it — that semantic IS the test.
      plans.set(a[0], { id: a[0], name: a[1], quota: a[2], device_quota: a[3] == null ? (cur ? cur.device_quota : null) : a[3], features: a[4], price: a[5], active: a[6] });
      return { success: true };
    }
    if (sql.includes('UPDATE plans SET device_quota')) { const p = plans.get(a[1]); if (p && p.device_quota == null) p.device_quota = a[0]; return { success: true }; }
    if (sql.includes('DELETE FROM plans')) { plans.delete(a[0]); return { success: true }; }

    // SPEC-019 features: same two-statement split as plans. OR IGNORE seeds; the portal upsert
    // rewrites name/description/active but NEVER the id or created_at.
    if (sql.includes('INSERT OR IGNORE INTO features')) {
      if (!features.has(a[0])) features.set(a[0], { id: a[0], name: a[1], description: a[2], active: 1, created_at: a[3] });
      return { success: true };
    }
    if (sql.includes('INSERT INTO features')) {
      const cur = features.get(a[0]);
      features.set(a[0], { id: a[0], name: a[1], description: a[2], active: a[3], created_at: cur ? cur.created_at : a[4] });
      return { success: true };
    }
    if (sql.includes('DELETE FROM features')) { features.delete(a[0]); return { success: true }; }

    throw new Error('D1 stub: unrecognised statement → ' + sql.slice(0, 70));
  };

  // Derived columns the portal reads as scalar sub-selects.
  const userRow = (u) => ({
    ...u,
    client_count: owned(u.email, clients).filter((c) => !c.voided).length,
    device_count: owned(u.email, devices).length,
    job_count: [...jobs.values()].filter((j) => j.user_email === u.email).length,
    docs: owned(u.email, devices).reduce((n, d) => n + (d.docs | 0), 0),
    last_seen: owned(u.email, devices).map((d) => d.last_seen || '').sort().pop() || null,
  });
  const clientRow = (c) => {
    const js = [...jobs.values()].filter((j) => j.rin === c.rin);
    const us = users.get(c.user_email);
    return { ...c, user_name: us ? us.name : null, job_count: js.length, docs: js.reduce((n, j) => n + (j.total_rows | 0), 0), last_export_at: js.map((j) => j.updated_at || '').sort().pop() || null };
  };
  const like = (v, q) => String(v || '').toLowerCase().includes(q);

  const read = (sql, a) => {
    // Every column exists here: the stub's rows are plain objects built from the bind list, so the
    // guarded ALTERs in ensureSchema() (jobs.user_email, plans/users.device_quota) are always
    // skipped. Their correctness is SQLite's, not this file's — what IS tested is that the seeds
    // and the reads agree about the columns.
    if (sql.includes('pragma_table_info')) return [{ n: 1 }];

    // ── slice 4: the two reads the bug↔user↔job join needs ──
    // A device BY ID (listDevices only answers "this person's browsers", and a bug report may know a
    // device and no email), and the runs a device has made, newest first.
    if (sql.includes('/* device row */')) { const d = devices.get(a[0]); return d ? [d] : []; }
    if (sql.includes('/* bug jobs */')) {
      return [...jobs.values()].filter((j) => j.device_id === a[0])
        .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, a[1]);
    }

    // ── slice 3: plans + the entitlement resolve ──
    if (sql.includes('/* plans */')) return [...plans.values()].sort((x, y) => (x.quota | 0) - (y.quota | 0) || String(x.id).localeCompare(String(y.id)));
    if (sql.includes('/* plan */')) { const p = plans.get(a[0]); return p ? [p] : []; }
    if (sql.includes('/* plan users */')) return [{ n: [...users.values()].filter((u) => (u.plan || 'free') === a[0]).length }];
    if (sql.includes('/* entitlement */')) { const u = users.get(a[0]); return u ? [u] : []; }

    // ── SPEC-019: the feature catalogue ──
    if (sql.includes('/* features */')) return [...features.values()].sort((x, y) => String(x.id).localeCompare(String(y.id)));
    if (sql.includes('/* feature */')) { const f = features.get(a[0]); return f ? [f] : []; }
    // The LIKE counts, reimplemented as the same substring test the SQL performs — the quotes are
    // what stop '"po"' matching inside '"po-analytics"', so the stub must include them too.
    if (sql.includes('/* feature grants */')) {
      const hit = (rows_, pat) => rows_.filter((r) => String(r.features || '').includes(pat.slice(1, -1))).length;
      return [{ plans: hit([...plans.values()], a[0]), users: hit([...users.values()], a[1]) }];
    }

    // ── slice 2: the jobs page. `stuck` is state ∈ (running, merging) AND updated_at older than the
    // bound cut-off — reimplemented rather than stubbed true, because that predicate IS the test.
    if (sql.includes('/* jobs page */')) {
      const [state, , email, , rin, , stuck, stale] = a;
      const hit = [...jobs.values()].filter((j) =>
        (!state || j.state === state) && (!email || j.user_email === email) && (!rin || j.rin === rin) &&
        (!stuck || (['running', 'merging'].includes(j.state) && String(j.updated_at || '') < String(stale))));
      if (sql.includes('SELECT COUNT(*)')) return [{ n: hit.length }];
      return hit.sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(a[9], a[9] + a[8]);
    }
    if (sql.includes('/* job row */')) { const j = jobs.get(a[0]); return j ? [j] : []; }
    if (sql.startsWith('SELECT (SELECT COUNT(*) FROM users)')) {
      const js = [...jobs.values()];
      return [{
        users: users.size, clients: [...clients.values()].filter((c) => !c.voided).length, devices: devices.size,
        active_jobs: js.filter((j) => ['planning', 'planned', 'running', 'merging'].includes(j.state)).length,
        jobs_today: js.filter((j) => String(j.created_at) >= a[0]).length,
        docs_today: js.filter((j) => String(j.created_at) >= a[0]).reduce((n, j) => n + (j.total_rows | 0), 0),
        expiring_soon: [...users.values()].filter((u) => u.valid_until && u.valid_until <= a[2]).length,
      }];
    }
    if (sql.includes('ORDER BY valid_until')) return [...users.values()].filter((u) => u.valid_until && u.valid_until <= a[0]).sort((x, y) => String(x.valid_until).localeCompare(String(y.valid_until))).slice(0, 10);

    // NB the trailing space: the clients query joins `FROM users us`, which "FROM users u" also matches.
    if (sql.includes('FROM users u ')) {
      if (sql.includes('WHERE u.email = ?')) { const u = users.get(a[0]); return u ? [userRow(u)] : []; }
      const [q, , , , status, , plan] = a;
      const hit = [...users.values()].filter((u) =>
        (!q || like(u.email, q) || like(u.name, q) || like(u.company, q)) &&
        (!status || u.status === status) && (!plan || u.plan === plan));
      if (sql.startsWith('SELECT COUNT(*)')) return [{ n: hit.length }];
      const page = hit.map(userRow).sort((x, y) => String(y.last_seen || '').localeCompare(String(x.last_seen || '')) || String(x.email).localeCompare(String(y.email)));
      return page.slice(a[9], a[9] + a[8]);
    }
    if (sql.includes('FROM clients c')) {
      if (sql.includes('WHERE c.rin = ?')) { const c = clients.get(a[0]); return c ? [clientRow(c)] : []; }
      const [q, , , , email] = a;
      const hit = [...clients.values()].filter((c) =>
        (!q || like(c.rin, q) || like(c.company, q) || like(c.user_email, q)) && (!email || c.user_email === email));
      if (sql.startsWith('SELECT COUNT(*)')) return [{ n: hit.length }];
      return hit.map(clientRow).sort((x, y) => String(x.rin).localeCompare(String(y.rin))).slice(a[7], a[7] + a[6]);
    }
    if (sql.includes('FROM devices WHERE user_email')) return owned(a[0], devices).sort((x, y) => String(y.last_seen || '').localeCompare(String(x.last_seen || '')));

    if (sql.includes("FROM jobs WHERE state IN ('planning'")) return [...jobs.values()].filter((j) => ['planning', 'planned', 'running', 'merging'].includes(j.state)).sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at))).slice(0, 50);
    if (sql.includes("FROM jobs WHERE (? = '' OR user_email = ?)")) {
      const [email, , rin] = a;
      return [...jobs.values()].filter((j) => (!email || j.user_email === email) && (!rin || j.rin === rin))
        .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, a[4]);
    }
    if (sql.includes('SELECT * FROM jobs WHERE id')) { const j = jobs.get(a[0]); return (j && j.device_id === a[1]) ? [j] : []; }
    if (sql.includes('SELECT * FROM job_chunks')) return chunks.filter((c) => c.job_id === a[0]).sort((x, y) => x.idx - y.idx);
    // NB order: both statements read FROM job_events, and the MAX(seq) probe must be matched first.
    if (sql.includes('COALESCE(MAX(seq)')) return [{ m: events.filter((e) => e.job_id === a[0]).reduce((m, e) => Math.max(m, e.seq), 0) }];
    if (sql.includes('FROM job_events')) return events.filter((e) => e.job_id === a[0]).sort((x, y) => x.seq - y.seq).slice(0, a[1]);
    if (sql.includes('FROM jobs') && sql.includes('state IN')) {
      return [...jobs.values()]
        .filter((j) => j.device_id === a[0] && ['planned', 'running', 'merging', 'paused', 'incomplete', 'halted'].includes(j.state))
        .sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)))
        .slice(0, a[1]);
    }
    throw new Error('D1 stub: unrecognised query → ' + sql.slice(0, 70));
  };
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    run: async () => exec(sql, args || []),
    first: async () => read(sql, args || [])[0] || null,
    all: async () => ({ results: read(sql, args || []) }),
  });
  return { prepare: (sql) => mk(sql, null), batch: async (stmts) => { for (const s of stmts) await s.run(); return []; }, _jobs: jobs, _chunks: chunks, _events: events, _users: users, _clients: clients, _devices: devices, _plans: plans, _features: features };
}
const JOBS = makeD1();
const env = { LEADS, JOBS, ADMIN_TOKEN: 'testtok' };   // no LOCKS → KV fallbacks
globalThis.fetch = async () => { throw new Error('network disabled'); };   // Disify email check → fail-open

const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256hex = async (s) => hex(await subtle.digest('SHA-256', enc.encode(s)));
async function hmacHex(keyHex, msg) {
  const key = await subtle.importKey('raw', Uint8Array.from(keyHex.match(/.{2}/g).map((h) => parseInt(h, 16))), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await subtle.sign('HMAC', key, enc.encode(msg)));
}
const call = (path, opts) => worker.fetch(new Request('https://x.example' + path, opts), env);
async function signed(path, bodyObj, clientKey, dev, badSig) {
  const body = JSON.stringify(bodyObj);
  const ts = String(Math.floor(Date.now() / 1000)), nonce = Math.random().toString(36).slice(2) + Date.now() + Math.random().toString(36).slice(2);
  const sig = badSig ? 'ab'.repeat(32) : await hmacHex(clientKey, ts + '\n' + nonce + '\nPOST\n' + path + '\n' + await sha256hex(body));
  return call(path, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-device-id': dev, 'x-ts': ts, 'x-nonce': nonce, 'x-signature': sig } });
}
const admin = (path, body) => call(path, body ? { method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer testtok', 'content-type': 'application/json' } } : { headers: { authorization: 'Bearer testtok' } });
let fails = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) fails++; };

try {
  // ── register ──
  const reg = await (await call('/register', { method: 'POST', body: JSON.stringify({ name: 'T', email: 'omtest@example.com', consent: true, registrationNumber: '123456789', deviceId: 'dev-1', version: '0.3.0' }), headers: { 'content-type': 'application/json' } })).json();
  check('register ok', reg.ok && reg.clientKey);

  // ── bug reports: with diag (sanitize/cap), without diag (back-compat) ──
  const bigLog = Array.from({ length: 100 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(200));
  const bug1 = await (await signed('/bug', { message: 'it broke', diag: { version: '0.3.0', last: 'Paused', log: bigLog, plan: { source: 'invoices', year: '2025', chunks: 12, done: 3, failed: 1, rows: 8214, pdf: true } } }, reg.clientKey, 'dev-1')).json();
  const bugRec = JSON.parse(store.get('bug:' + bug1.id));
  check('bug diag stored, log ≤8KB', bug1.ok && bugRec.diag && JSON.stringify(bugRec.diag.log).length <= 8192);
  const bug2 = await (await signed('/bug', { message: 'old client' }, reg.clientKey, 'dev-1')).json();
  check('bug without diag (old client)', bug2.ok && !JSON.parse(store.get('bug:' + bug2.id)).diag);

  // ── /session: stats max-merge into seen: + message delivery ──
  const s1 = await (await signed('/session', { rin: '123456789', version: '0.3.0', stats: { runs: 3, docs: 1200, pdfs: 40, lastExportAt: '2026-07-12T00:00:00Z' } }, reg.clientKey, 'dev-1')).json();
  const seen1 = JSON.parse(store.get('seen:dev-1'));
  check('session stats merged into seen:', s1.ok && seen1.docs === 1200 && seen1.exports === 3 && seen1.pdfs === 40);
  await signed('/session', { rin: '123456789', version: '0.3.0', stats: { runs: 1, docs: 50 } }, reg.clientKey, 'dev-1');   // cleared localStorage → lower counts
  const seen2 = JSON.parse(store.get('seen:dev-1'));
  check('max-merge: lower counts never regress', seen2.docs === 1200 && seen2.exports === 3);
  const ins = await (await admin('/api/insights')).json();
  check('insights value totals', ins.ok && ins.insights.value.totalDocs === 1200 && ins.insights.value.topDocs[0].n === 1200);

  const setMsg = await (await admin('/api/user', { deviceId: 'dev-1', action: 'setMessage', value: { text: 'hello from admin', level: 'warn' } })).json();
  check('setMessage stored', setMsg.ok && JSON.parse(store.get('dev:dev-1')).message.text === 'hello from admin');
  await admin('/api/user', { deviceId: 'dev-1', action: 'lock' });
  const s3 = await (await signed('/session', { rin: '123456789', version: '0.3.0' }, reg.clientKey, 'dev-1')).json();
  check('message delivered even while locked', s3.ok && !s3.allowed && s3.message && s3.message.text === 'hello from admin' && s3.message.id);
  await admin('/api/user', { deviceId: 'dev-1', action: 'unlock' });
  const clr = await (await admin('/api/user', { deviceId: 'dev-1', action: 'clearMessage' })).json();
  check('clearMessage removes it', clr.ok && !JSON.parse(store.get('dev:dev-1')).message);

  // ── rin-request dedupe ──
  const r1 = await (await signed('/rin-request', { requestedRin: '987654321' }, reg.clientKey, 'dev-1')).json();
  const r2 = await (await signed('/rin-request', { requestedRin: '987654321' }, reg.clientKey, 'dev-1')).json();
  check('duplicate rin-request → pending, single record', r1.ok && r2.pending === true && [...store.keys()].filter((k) => k.startsWith('req:')).length === 1);

  // ── sig-fail → err: + /api/errors ──
  const badRes = await signed('/bug', { message: 'x' }, reg.clientKey, 'dev-1', true);
  const errsJ = await (await admin('/api/errors')).json();
  check('sig-fail logged & listed', badRes.status === 401 && errsJ.ok && errsJ.errors.some((e) => e.kind === 'sig_fail'));

  // ── trash: delete → snapshot; restore → re-claim + lostRins; 409 on re-registered ──
  const del = await (await admin('/api/user', { deviceId: 'dev-1', action: 'delete' })).json();
  const tr = JSON.parse(store.get('trash:dev-1') || 'null');
  check('delete snapshots to trash (dev+reqs+bugs)', del.ok && tr && tr.dev.deviceId === 'dev-1' && tr.reqs.length === 1 && tr.bugs.length === 2 && !store.has('dev:dev-1'));
  store.set('rinowner:987654321', 'someone-else');                         // not held by dev-1 — irrelevant
  store.set('rinowner:123456789', 'thief');                                // dev-1's RIN got claimed meanwhile
  const rst = await (await admin('/api/trash', { action: 'restore', deviceId: 'dev-1' })).json();
  const devBack = JSON.parse(store.get('dev:dev-1') || 'null');
  check('restore re-creates account, reports lost RIN', rst.ok && rst.lostRins.includes('123456789') && devBack && devBack.boundRins.length === 0 && store.has('seen:dev-1') && [...store.keys()].filter((k) => k.startsWith('bug:')).length === 2);
  check('trash entry consumed', !store.has('trash:dev-1'));
  store.set('trash:dev-1', JSON.stringify({ dev: { deviceId: 'dev-1' }, at: 'x' }));   // stale trash + live device
  const rst2 = await admin('/api/trash', { action: 'restore', deviceId: 'dev-1' });
  check('restore refuses to clobber a live device (409)', rst2.status === 409);
  store.delete('trash:dev-1');

  // ── scheduled(): daily snapshot + /api/snaps ──
  await worker.scheduled({}, env);
  const day = new Date().toISOString().slice(0, 10);
  const snap = JSON.parse(store.get('snap:' + day) || 'null');
  check('scheduled() writes today snapshot with totals', snap && snap.users === 1 && snap.totalDocs === 1200);
  const snapsJ = await (await admin('/api/snaps')).json();
  check('/api/snaps returns it', snapsJ.ok && snapsJ.snaps.length === 1 && snapsJ.snaps[0].day === day);

  // ── SPEC-016: the planner conversation ──
  // A synthetic portal: anything wider than ~200 days is over the 10,000 invoice cap, anything
  // narrower is comfortably under. One split, two chunks, three steps. 9,500 (not 100) per window
  // so SPEC-024's coalescing — which would merge two windows summing ≤ 9,000 — deliberately leaves
  // the two-chunk structure intact; these checks pin the D1/timeline plumbing, not the merge.
  const probeFor = (f, t) => (Date.parse(t) - Date.parse(f) > 200 * 86400000 ? 20000 : 9500);

  // A device of its own: dev-1 has been deleted and restored by the trash tests above, and the
  // restore deliberately drops a RIN another account re-claimed. Reusing it here would make these
  // assertions depend on damage inflicted by an unrelated test.
  const pReg = await (await call('/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ regId: 'rp', name: 'Planner Dev', email: 'planner@gmail.com', registrationNumber: '900000001', deviceId: 'dev-plan', consent: true, version: '9.9.9' }),
  })).json();
  check('planner device registered with its own RIN', pReg.ok && pReg.boundRins.includes('900000001'));
  const PK = pReg.clientKey, PD = 'dev-plan', PRIN = '900000001';
  // dir 'Sent' explicitly: SPEC-026 gives any non-Sent invoice direction the conservative 2,000
  // cap, and this scenario's 9,500-doc windows are legal only under the full Sales cap.
  const startBody = { source: 'invoices', field: 'Issue', from: '2025-01-01', to: '2025-12-31', dir: 'Sent', rin: PRIN, version: '9.9.9' };

  const unsignedStart = await call('/plan/start', { method: 'POST', body: JSON.stringify({ source: 'invoices' }), headers: { 'content-type': 'application/json' } });
  check('plan/start unsigned → 401', unsignedStart.status === 401);

  // These use the device's OWN rin: entitlement is checked before input validation, so a wrong rin
  // would return 403 and this would be asserting the wrong thing.
  const badRange = await signed('/plan/start', { ...startBody, from: '2025-12-31', to: '2025-01-01' }, PK, PD);
  check('plan/start rejects an inverted date range', badRange.status === 400);

  const badSource = await signed('/plan/start', { ...startBody, source: 'nope' }, PK, PD);
  check('plan/start rejects an unknown source', badSource.status === 400);

  const badField = await signed('/plan/start', { ...startBody, field: 'NotAField' }, PK, PD);
  check('plan/start rejects a date field the source does not have', badField.status === 400);

  const start = await signed('/plan/start', startBody, PK, PD);
  const s0 = await start.json();
  check('plan/start mints a job and the first probe', start.status === 200 && s0.ok && !!s0.jobId && s0.instruction && s0.instruction.kind === 'probe' && !!s0.cursor);

  // Drive the conversation to completion.
  let cursor = s0.cursor, instr = s0.instruction, plan = null, steps = 0;
  while (instr && steps < 50) {
    const obs = instr.kind === 'detectMaxSub' ? { maxSub: null } : { count: probeFor(instr.fromISO || instr.subF, instr.toISO || instr.subT) };
    const r = await (await signed('/plan/step', { jobId: s0.jobId, cursor, observation: obs }, PK, PD)).json();
    steps++;
    if (r.done) { plan = r; break; }
    cursor = r.cursor; instr = r.instruction;
  }
  check('plan/step completes and returns chunks', !!plan && plan.done && plan.chunks.length === 2, plan ? 'chunks=' + plan.chunks.length : 'never finished');
  check('planned chunks are stored in D1, in order', JOBS._chunks.length === 2 && JOBS._chunks[0].idx === 0 && JOBS._chunks[1].idx === 1);
  const jobRow = JOBS._jobs.get(s0.jobId);
  check('job row reaches planned with its totals', jobRow && jobRow.state === 'planned' && jobRow.total_chunks === 2 && jobRow.total_rows === 19000);

  const tampered = await signed('/plan/step', { jobId: s0.jobId, cursor: String(s0.cursor).slice(0, -4) + 'AAAA', observation: { count: 1 } }, PK, PD);
  check('a tampered cursor is refused, not treated as empty state', tampered.status === 400);

  const noJob = await signed('/plan/step', { jobId: 'deadbeefdeadbeef', cursor: s0.cursor, observation: { count: 1 } }, PK, PD);
  check('an unknown job id is refused', noJob.status === 404);

  const cp = await signed('/job/checkpoint', { jobId: s0.jobId, state: 'running', done: 1, failed: 0 }, PK, PD);
  check('checkpoint records progress', cp.status === 200 && jobRow.done_count === 1 && jobRow.state === 'running');

  // ── the chunk timeline (one char per chunk, idx order) ────────────────────────────────────────
  // Without this the admin timeline could only ever show 'pending': the plan wrote the rows and
  // nothing on the server ever touched their state again.
  const chunkStateOf = (j) => JOBS._chunks.filter((c) => c.job_id === j).sort((x, y) => x.idx - y.idx).map((c) => c.state);
  await signed('/job/checkpoint', { jobId: s0.jobId, state: 'running', done: 1, failed: 0, chunkStates: 'dr' }, PK, PD);
  check('a checkpoint paints the chunk timeline', String(chunkStateOf(s0.jobId)) === 'done,running');
  // A snapshot, not a delta: a later checkpoint that demotes a square must be obeyed, because that
  // is what a retried chunk looks like.
  await signed('/job/checkpoint', { jobId: s0.jobId, state: 'running', done: 1, failed: 1, chunkStates: 'df' }, PK, PD);
  check('the timeline is a snapshot — a retried chunk can move back', String(chunkStateOf(s0.jobId)) === 'done,failed');
  // Garbage in the timeline half must not cost the counters, which are the load-bearing half.
  const junk = await signed('/job/checkpoint', { jobId: s0.jobId, state: 'running', done: 2, failed: 0, chunkStates: 'd<script>' }, PK, PD);
  check('a malformed timeline is ignored, counters still land', junk.status === 200 && jobRow.done_count === 2 && String(chunkStateOf(s0.jobId)) === 'done,failed');
  const foreign = await signed('/job/checkpoint', { jobId: s0.jobId, state: 'running', done: 2, failed: 0, chunkStates: 'ff' }, reg.clientKey, 'dev-1');
  check("another device cannot repaint this job's timeline", foreign.ok !== true && String(chunkStateOf(s0.jobId)) === 'done,failed');

  // Retention: an unfinished job KEEPS its chunks — they are what a resume reads.
  await signed('/job/checkpoint', { jobId: s0.jobId, state: 'incomplete', done: 1, failed: 1 }, PK, PD);
  check('an incomplete job keeps its chunks (resume depends on them)', JOBS._chunks.filter((c) => c.job_id === s0.jobId).length === 2);

  // ── the Resume entry under the Download button ──
  const res1 = await (await signed('/job/resumable', {}, PK, PD)).json();
  check('an unfinished job is offered as resumable', res1.ok && res1.jobs.length === 1 && res1.jobs[0].id === s0.jobId && res1.jobs[0].done_count === 1);
  const plan1 = await (await signed('/job/plan', { jobId: s0.jobId }, PK, PD)).json();
  check('resuming returns the stored plan in order', plan1.ok && plan1.chunks.length === 2 && plan1.chunks[0].label && plan1.chunks[0].count === 9500);
  const otherPlan = await (await signed('/job/plan', { jobId: s0.jobId }, reg.clientKey, 'dev-1')).json();
  check("another device cannot read this job's plan", otherPlan.ok !== true);

  // ── T-257 (SPEC-026): direction-aware cap ─────────────────────────────────────────────────────
  // 5,000 docs in one window is a legal single chunk for a Sent plan (cap 10,000) but OVER CAP for
  // a Received plan (cap 2,000) — measured live: received invoices are line-heavy and a 9.5k-doc
  // chunk OOMs the tab. Narrow (≤2-day) windows report 1,600: under the received cap, and two of
  // them (3,200) exceed the coalescing target floor(2000*0.9)=1800, so merges cannot re-breach it.
  const drivePlan = async (body, probeOf) => {
    const st0 = await (await signed('/plan/start', body, PK, PD)).json();
    if (!st0.ok) return { start: st0 };
    let cur = st0.cursor, ins = st0.instruction, fin = null, n = 0;
    while (ins && n < 80) {
      const obs = ins.kind === 'detectMaxSub' ? { maxSub: null } : { count: probeOf(ins) };
      const rr = await (await signed('/plan/step', { jobId: st0.jobId, cursor: cur, observation: obs }, PK, PD)).json();
      n++;
      if (rr.done) { fin = rr; break; }
      cur = rr.cursor; ins = rr.instruction;
    }
    return { start: st0, fin };
  };
  const dirProbe = (ins) => (Date.parse(ins.toISO || ins.subT) - Date.parse(ins.fromISO || ins.subF) > 2 * 86400000 ? 5000 : 1600);
  const dirRange = { source: 'invoices', field: 'Issue', from: '2025-06-01', to: '2025-06-08', rin: PRIN, version: '9.9.9' };
  const sentPlan = await drivePlan({ ...dirRange, dir: 'Sent' }, dirProbe);
  check('T-257 a Sent plan keeps the full 10k cap (5,000-doc window = one chunk)',
    !!sentPlan.fin && sentPlan.fin.chunks.length === 1 && sentPlan.fin.chunks[0].count === 5000);
  const recvPlan = await drivePlan({ ...dirRange, dir: 'Received' }, dirProbe);
  check('T-257 a Received plan splits at the 2,000 cap and every chunk stays under it',
    !!recvPlan.fin && recvPlan.fin.chunks.length > 1 && recvPlan.fin.chunks.every((c) => c.count < 2000 && !c.warn));
  // Drop the two T-257 jobs from the mock store so the job-count/resumable/quota checks below
  // keep seeing exactly the fixture jobs they were written against (same pattern as the uuid
  // scenario's chunk cleanup above).
  for (const jid of [sentPlan.start && sentPlan.start.jobId, recvPlan.start && recvPlan.start.jobId].filter(Boolean)) {
    JOBS._jobs.delete(jid);
    for (let i = JOBS._chunks.length - 1; i >= 0; i--) if (JOBS._chunks[i].job_id === jid) JOBS._chunks.splice(i, 1);
  }

  // ── SPEC-022: /plan/uuids — the gate for list-driven exports ──────────────────────────────────
  // The client sends a COUNT, never the UUIDs: the server decides the batching and mints a real
  // job (dir 'uuids'), so the entitlement gate and the admin timeline work exactly as for ranges,
  // while the backend learns nothing about which documents were asked for.
  const uReg = await (await call('/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ regId: 'ru', name: 'Uuid Dev', email: 'uuiddev@gmail.com', registrationNumber: '900000002', deviceId: 'dev-uuid', consent: true, version: '9.9.9' }),
  })).json();
  check('T-222 uuid-list device registered', uReg.ok && uReg.boundRins.includes('900000002'));
  const UK = uReg.clientKey, UD = 'dev-uuid';
  const uBody = { count: 1234, rin: '900000002', version: '9.9.9' };

  const unsignedU = await call('/plan/uuids', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(uBody) });
  check('T-223 plan/uuids unsigned → 401', unsignedU.status === 401);

  const wrongRin = await signed('/plan/uuids', { ...uBody, rin: '111111111' }, UK, UD);
  check('T-223 plan/uuids with a RIN the device does not hold → 403', wrongRin.status === 403);

  for (const bad of [0, -3, 10001, 'NaN', null]) {
    const r = await signed('/plan/uuids', { ...uBody, count: bad }, UK, UD);
    check('T-223 plan/uuids rejects count=' + bad, r.status === 400, 'got ' + r.status);
  }

  // The happy path — with a decoy uuid list attached, which the server must NOT persist anywhere.
  const MARKER = 'MARKERUUID00000000000ZZZZZ';
  const uRes = await signed('/plan/uuids', { ...uBody, uuids: [MARKER] }, UK, UD);
  const u0 = await uRes.json();
  const uSum = (u0.batches || []).reduce((s, b) => s + b.count, 0);
  check('T-222 plan/uuids mints a job and server-chosen batches summing to the count',
    uRes.status === 200 && u0.ok && !!u0.jobId && Array.isArray(u0.batches) && u0.batches.length > 1
    && u0.batches.length <= 25 && u0.batches.every((b) => b.count >= 1 && b.count <= 500) && uSum === 1234,
    'status=' + uRes.status + ' batches=' + (u0.batches || []).length + ' sum=' + uSum);
  const uJob = JOBS._jobs.get(u0.jobId);
  const uChunks = JOBS._chunks.filter((c) => c.job_id === u0.jobId);
  check('T-222 uuid job row: planned, dir uuids, totals match',
    uJob && uJob.state === 'planned' && uJob.dir === 'uuids' && uJob.total_rows === 1234 && uJob.total_chunks === u0.batches.length);
  check('T-222 uuid chunk rows land in D1 in batch order',
    uChunks.length === u0.batches.length && uChunks.every((c, i) => c.idx === i && c.count === u0.batches[i].count));
  const persisted = JSON.stringify([...store.entries()]) + JSON.stringify([...JOBS._jobs.values()]) + JSON.stringify(JOBS._chunks);
  check('T-222 no document identifier is persisted anywhere (count only)', !persisted.includes(MARKER));

  // Same per-device budget as /plan/start: the two routes share the 'plan' rate bucket.
  let uLimited = null;
  for (let n = 0; n < 70; n++) {
    const r = await signed('/plan/uuids', { ...uBody, count: 1 }, UK, UD);
    if (r.status === 429) { uLimited = { at: n, r }; break; }
  }
  check('T-223 plan/uuids shares the plan rate budget (429 before 70 calls)', !!uLimited);

  // Cleanup: the assertions above minted ~60 throwaway jobs into the fake D1. Later sections
  // assert exact dashboard/job-list counts, so remove every uuid-route job before moving on —
  // the same direct store surgery the trash tests above already perform.
  for (const [jid, row] of [...JOBS._jobs]) if (row.dir === 'uuids') JOBS._jobs.delete(jid);
  for (let i = JOBS._chunks.length - 1; i >= 0; i--) if (String(JOBS._chunks[i].chunk_id || '').startsWith('uuids_')) JOBS._chunks.splice(i, 1);

  // ── SPEC-018 Part B: the run log ships to the portal ──────────────────────────────────────────
  // Status lines only — counts and progress, the strings the drawer already displays. The client
  // (src/core/logship.js) batches and coalesces before it gets here; these assertions are the
  // server's half of that contract: who may write, what is kept, and when it goes away.
  const mkLines = (n, from = 0, kind = null) => Array.from({ length: n }, (_, i) => ({
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, from + i)).toISOString(),
    level: 'run', kind, text: 'chunk ' + (from + i + 1) + '/412 fetching 200/1000',
  }));
  const eventsOf = async (id) => (await (await admin('/api/job?id=' + id)).json()).events;

  const unsignedLog = await call('/job/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: s0.jobId, lines: mkLines(1) }) });
  check('T-171 /job/log is signed — an unsigned batch is refused', unsignedLog.status === 401);

  const logA = await (await signed('/job/log', { jobId: s0.jobId, lines: mkLines(3) }, PK, PD)).json();
  const evA = await eventsOf(s0.jobId);
  check('T-171 a flushed batch is stored in order and surfaces on /api/job',
    logA.ok && logA.stored === 3 && evA.length === 3
    && evA[0].text === 'chunk 1/412 fetching 200/1000' && evA[2].text === 'chunk 3/412 fetching 200/1000'
    && evA[0].level === 'run' && evA[0].at.startsWith('2026-01-01T'));

  const logB = await (await signed('/job/log', { jobId: s0.jobId, lines: mkLines(2, 3) }, PK, PD)).json();
  const evB = await eventsOf(s0.jobId);
  check('T-171 a second flush appends after the first rather than restarting the sequence',
    logB.ok && evB.length === 5 && evB[3].text === 'chunk 4/412 fetching 200/1000' && evB[4].text === 'chunk 5/412 fetching 200/1000');

  // T-172 is the CLIENT's rule (test/logship.test.mjs owns it). What the server must guarantee is
  // that it stores a coalesced batch verbatim — one line per kind — and does not re-expand it.
  const coalesced = [
    { at: '2026-01-01T00:10:00.000Z', level: 'wait', kind: 'rate', text: 'rate limited — waiting 30s' },
    { at: '2026-01-01T00:10:01.000Z', level: 'run', kind: 'page', text: 'chunk 9/412 fetching 900/1000' },
    { at: '2026-01-01T00:10:02.000Z', level: 'warn', kind: null, text: '2 documents dropped in chunk 9' },
  ];
  await signed('/job/log', { jobId: s0.jobId, lines: coalesced }, PK, PD);
  const evC = await eventsOf(s0.jobId);
  check('T-172 a coalesced batch is stored one line per kind, kinds preserved',
    evC.length === 8 && evC[5].kind === 'rate' && evC[6].kind === 'page' && evC[7].kind === null
    && evC.filter((e) => e.kind === 'rate').length === 1);

  const otherLog = await signed('/job/log', { jobId: s0.jobId, lines: mkLines(1, 99) }, reg.clientKey, 'dev-1');
  check('T-174 another device cannot write into this job\'s log, and is told so cleanly (never a 500)',
    otherLog.status === 404 && (await eventsOf(s0.jobId)).length === 8);
  const noJobLog = await signed('/job/log', { jobId: 'deadbeefdeadbeef', lines: mkLines(1) }, PK, PD);
  check('T-174 a batch for an unknown job is a clean 404 the client can drop', noJobLog.status === 404);

  // T-173 — a run emits thousands; the last 200 are what a support conversation needs. Sent as
  // three flushes so the cap is exercised across batches, not only within one oversized one.
  for (let i = 0; i < 3; i++) await signed('/job/log', { jobId: s0.jobId, lines: mkLines(100, 1000 + i * 100) }, PK, PD);
  const evCap = await eventsOf(s0.jobId);
  check('T-173 job_events is capped at 200 per job, keeping the NEWEST',
    evCap.length === 200 && JOBS._events.filter((e) => e.job_id === s0.jobId).length === 200
    && evCap[199].text === 'chunk 1300/412 fetching 200/1000'
    && evCap[0].text === 'chunk 1101/412 fetching 200/1000');
  const overCap = await (await signed('/job/log', { jobId: s0.jobId, lines: mkLines(500, 2000) }, PK, PD)).json();
  check('T-173 a single oversized batch is trimmed to the cap rather than blowing past it',
    overCap.stored === 200 && (await eventsOf(s0.jobId)).length === 200);

  await signed('/job/checkpoint', { jobId: s0.jobId, state: 'done', done: 2, failed: 0 }, PK, PD);
  check('a finished job drops its chunks but keeps its history row',
    JOBS._chunks.filter((c) => c.job_id === s0.jobId).length === 0
    && JOBS._jobs.get(s0.jobId).state === 'done' && JOBS._jobs.get(s0.jobId).total_chunks === 2);
  check('T-175 the shipped log is purged with the chunks when the job reaches done',
    JOBS._events.filter((e) => e.job_id === s0.jobId).length === 0 && (await eventsOf(s0.jobId)).length === 0);

  const res2 = await (await signed('/job/resumable', {}, PK, PD)).json();
  check('a finished job is no longer offered as resumable', res2.ok && res2.jobs.length === 0);
  const gonePlan = await signed('/job/plan', { jobId: s0.jobId }, PK, PD);
  check('resuming a purged plan fails cleanly, not with a half-plan', gonePlan.status === 410);

  // The gate: a locked device must not be able to mint a job at all.
  await admin('/api/user', { deviceId: PD, action: 'lock' });
  const lockedStart = await signed('/plan/start', startBody, PK, PD);
  const lj = await lockedStart.json();
  check('a locked device cannot mint a job', lockedStart.status === 403 && lj.reason === 'locked');
  await admin('/api/user', { deviceId: PD, action: 'unlock' });

  // ── SPEC-021: the export column mapping ───────────────────────────────────────────────────────
  // The extension's BUNDLED copy is imported straight from the extension tree. That coupling is the
  // point: while the two revisions are equal the two tables must be byte-identical, or an offline
  // user and an online user would get different spreadsheets from the same build.
  const clientMap = await import(new URL('../src/export/mapping.js', import.meta.url).href);
  const mapBody = { source: 'invoices', rin: PRIN, version: '9.9.9' };

  const mapUnsigned = await call('/export/mapping', { method: 'POST', body: JSON.stringify(mapBody), headers: { 'content-type': 'application/json' } });
  check('T-195 the mapping is not a public asset — unsigned is refused', mapUnsigned.status === 401);

  const mapBadSource = await signed('/export/mapping', { ...mapBody, source: 'nope' }, PK, PD);
  check('T-196 an unknown source is refused, not answered with a default mapping', mapBadSource.status === 400);

  const mapRes = await signed('/export/mapping', mapBody, PK, PD);
  const mapJ = await mapRes.json();
  const sumKeys = (mapJ.mapping?.summary || []).map(([k]) => k);
  check('T-197 a signed, entitled device gets the whole mapping: sheets, columns, revision and hash',
    mapRes.status === 200 && mapJ.ok && mapJ.source === 'invoices'
    && Number.isInteger(mapJ.revision) && /^[0-9a-f]{32}$/.test(mapJ.hash || '')
    && !!mapJ.mapping.summarySheet && !!mapJ.mapping.lineSheet && mapJ.mapping.summarySheet !== mapJ.mapping.lineSheet
    && sumKeys.includes('index') && sumKeys.includes('details') && sumKeys.includes('uuid')
    && mapJ.mapping.summary.every((c) => Array.isArray(c) && c.length === 3 && typeof c[1] === 'string' && typeof c[2] === 'number')
    && mapJ.mapping.lines.some(([k]) => k === 'uuid'));

  const rcpJ = await (await signed('/export/mapping', { ...mapBody, source: 'receipts' }, PK, PD)).json();
  check('T-198 each source has its own mapping and its own hash',
    rcpJ.ok && rcpJ.mapping.summarySheet !== mapJ.mapping.summarySheet && rcpJ.hash !== mapJ.hash);

  const mapAgain = await (await signed('/export/mapping', mapBody, PK, PD)).json();
  const mapSame = await (await signed('/export/mapping', { ...mapBody, have: mapJ.hash }, PK, PD)).json();
  const mapStale = await (await signed('/export/mapping', { ...mapBody, have: 'ff'.repeat(16) }, PK, PD)).json();
  check('T-199 the hash is stable, and a client holding it is told "unchanged" instead of resent the table — a stale one is not',
    mapAgain.hash === mapJ.hash
    && mapSame.ok && mapSame.unchanged === true && !mapSame.mapping && mapSame.revision === mapJ.revision
    && mapStale.ok && !mapStale.unchanged && !!mapStale.mapping);

  // The invariant that makes the bundled fallback safe.
  const ser = (m) => JSON.stringify([m.key, m.summarySheet, m.lineSheet, m.summary, m.lines]);
  check('T-200 at equal revisions the served mapping and the extension\'s bundled mapping are identical',
    mapJ.revision !== clientMap.BUNDLED_REVISION
      ? true   // revisions have deliberately diverged; the client's validator governs from here
      : ser(mapJ.mapping) === ser(clientMap.BUNDLED.invoices) && ser(rcpJ.mapping) === ser(clientMap.BUNDLED.receipts),
    'served revision ' + mapJ.revision + ' vs bundled ' + clientMap.BUNDLED_REVISION);
  // …and whatever we serve must satisfy the client's own validator, or an authorised user would be
  // silently pushed back onto the bundled mapping by their own extension.
  check('T-201 the served mapping passes the client-side validator for both sources',
    clientMap.validateMapping(mapJ.mapping, clientMap.BUNDLED.invoices).ok
    && clientMap.validateMapping(rcpJ.mapping, clientMap.BUNDLED.receipts).ok);

  await admin('/api/user', { deviceId: PD, action: 'lock' });
  const mapLocked = await signed('/export/mapping', mapBody, PK, PD);
  const mlJ = await mapLocked.json();
  check('T-202 a locked device gets no mapping either — the gate is the same one the planner uses',
    mapLocked.status === 403 && mlJ.reason === 'locked' && !mlJ.mapping);
  await admin('/api/user', { deviceId: PD, action: 'unlock' });

  // ── SPEC-017 slice 1: the admin portal spine ──────────────────────────────────────────────────
  // Historical KV shapes, written straight into the store. That is deliberate: the migration exists
  // for data that predates the users table, and /register can no longer PRODUCE the defect being
  // migrated away from (a second device on one email holding different RINs) — the Locks DO refuses
  // the duplicate claim and the email index is not enforced. Only a seeded namespace has it.
  const mkDev = (o) => JSON.stringify({
    deviceId: o.id, clientKey: 'ff'.repeat(16), boundRins: o.rins, features: o.features || [],
    quota: o.quota, locked: !!o.locked, killed: false, superadmin: false, count: 1, firstAt: o.firstAt,
    name: o.name, email: o.email, phone: '', company: o.company || '', taxpayerName: o.company || '',
    version: '0.4.0', country: 'EG', lastRin: o.rins[0] || '', lastSeen: o.firstAt,
  });
  store.set('dev:mig-a', mkDev({ id: 'mig-a', email: 'SHARED@Example.com', name: 'Nadia Fouad', company: 'Fouad & Co', rins: ['700000001', '700000009'], quota: 3, firstAt: '2026-01-02T00:00:00Z' }));
  store.set('dev:mig-b', mkDev({ id: 'mig-b', email: 'shared@example.com', name: 'Nadia (office PC)', rins: ['700000002'], quota: 5, locked: true, firstAt: '2026-02-02T00:00:00Z' }));
  store.set('dev:mig-c', mkDev({ id: 'mig-c', email: 'other@example.com', name: 'Other Person', company: 'Other LLC', rins: ['700000009'], quota: 1, firstAt: '2026-03-02T00:00:00Z' }));
  store.set('rinowner:700000009', 'mig-a');

  const m1 = await (await admin('/api/migrate', {})).json();
  const uShared = await (await admin('/api/user?email=shared@example.com')).json();
  check('T-152 migration groups two devices sharing an email into ONE user',
    m1.ok && uShared.ok && uShared.devices.length === 2 && uShared.user.email === 'shared@example.com'
    && uShared.user.name === 'Nadia Fouad' && uShared.user.status === 'locked');
  check('T-153 migrated quota is the MAX of the group, never the sum', uShared.user.quota === 5);

  const conflict = m1.conflicts.find((c) => c.rin === '700000009');
  const orphan = await (await admin('/api/clients?q=700000009')).json();
  check('T-154 a RIN under two emails is reported as a conflict and left unassigned',
    !!conflict && conflict.emails.join(',') === 'other@example.com,shared@example.com'
    && conflict.owner === 'mig-a' && orphan.total === 0);

  // The report counts what the migration OWNS after a run, not what it newly inserted — that is the
  // only version of "ran it twice, nothing happened" a caller can actually check. Table sizes are
  // larger (dual-write already recorded the RINs of devices registered earlier in this run) and are
  // asserted separately: they must not move.
  const sizes = () => [JOBS._users.size, JOBS._clients.size, JOBS._devices.size].join('/');
  const sizesBefore = sizes();
  const m2 = await (await admin('/api/migrate', {})).json();
  const afterTwice = await (await admin('/api/users')).json();
  check('T-155 migration is idempotent — same counts, no new rows',
    m2.users === m1.users && m2.clients === m1.clients && m2.devices === m1.devices
    && m2.conflicts.length === m1.conflicts.length && afterTwice.total === m1.users
    && sizes() === sizesBefore);

  // A live run and a run that stopped checkpointing two hours ago.
  const live = await (await signed('/plan/start', startBody, PK, PD)).json();
  await signed('/job/checkpoint', { jobId: live.jobId, state: 'running', done: 0, failed: 0 }, PK, PD);
  const staleJob = JOBS._jobs.get(s0.jobId);
  staleJob.state = 'running'; staleJob.updated_at = new Date(Date.now() - 2 * 3600000).toISOString();
  const dash = await (await admin('/api/dashboard')).json();
  check('T-156 /api/dashboard reports a running job as active and a stale one as an alert',
    dash.ok && dash.stats.users === m1.users && dash.stats.devices === m1.devices
    && dash.active.some((j) => j.jobId === live.jobId && j.state === 'running' && j.user === 'planner@gmail.com')
    && dash.alerts.some((a) => a.ref === s0.jobId && a.level === 'alert')
    && dash.recent.length > 0);

  await admin('/api/user', { email: 'other@example.com', action: 'setPlan', value: 'pro' });
  const uAll = await (await admin('/api/users')).json();
  const uLocked = await (await admin('/api/users?status=locked')).json();
  const uPro = await (await admin('/api/users?plan=pro')).json();
  const uPage2 = await (await admin('/api/users?page=2')).json();
  const uSearch = await (await admin('/api/users?q=fouad')).json();
  check('T-157 /api/users paginates and filters by status and plan',
    uAll.total === 5 && uLocked.total === 1 && uLocked.users[0].email === 'shared@example.com'   // 5th user: dev-uuid (SPEC-022 section above)
    && uPro.total === 1 && uPro.users[0].email === 'other@example.com'
    && uPage2.total === 5 && uPage2.users.length === 0 && uSearch.total === 1);

  const uPlan = await (await admin('/api/user?email=planner@gmail.com')).json();
  check('T-158 /api/user returns clients, devices and jobs for that email only',
    uPlan.ok && uPlan.clients.length === 1 && uPlan.clients[0].rin === PRIN
    && uPlan.devices.length === 1 && uPlan.devices[0].deviceId === PD
    && !('clientKey' in uPlan.devices[0])                                   // the HMAC secret never leaves D1
    && uPlan.jobs.length >= 1 && uPlan.jobs.every((j) => j.user === 'planner@gmail.com'));

  const clientList = await (await admin('/api/clients')).json();
  const c700 = clientList.clients.find((c) => c.rin === '700000001');
  check('T-159 /api/clients shows the managing user for each TRN',
    clientList.ok && clientList.total === JOBS._clients.size && c700
    && c700.userEmail === 'shared@example.com' && c700.userName === 'Nadia Fouad');

  const moved = await (await admin('/api/client', { rin: '700000001', action: 'move', value: 'other@example.com' })).json();
  const c700b = await (await admin('/api/client?rin=700000001')).json();
  const auditAll = () => [...store.keys()].filter((k) => k.startsWith('audit:')).sort().map((k) => JSON.parse(store.get(k)));
  check('T-160 POST /api/client action=move reassigns ownership and writes an audit entry',
    moved.ok && c700b.ok && c700b.client.userEmail === 'other@example.com'
    && c700b.user.email === 'other@example.com'
    && auditAll().some((e) => e.action === 'client:move' && e.target === '700000001' && e.detail.from === 'shared@example.com'));

  await admin('/api/user', { email: 'other@example.com', action: 'setNote', value: 'called, renewing' });
  await admin('/api/client', { rin: '700000002', action: 'void' });
  await admin('/api/migrate', {});
  // Matched by action, NOT by "the newest three": the audit key is millisecond-resolution with a
  // random suffix, so two entries written in the same millisecond sort against each other by chance.
  const entries = auditAll();
  const logged = (a) => entries.filter((e) => e.action === a);
  check('T-161 every mutating endpoint writes an audit entry carrying an actor',
    ['user:setNote', 'client:void', 'client:move', 'migrate'].every((a) => logged(a).length >= 1)
    && entries.every((e) => e.actor === 'token')                            // legacy KV actions too
    && store.has('void:700000002'));                                        // and the KV blacklist stays in step

  // Dual-write: the D1 device row must track the KV dev: record without a migration in between.
  const dwBody = (version) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ regId: 'dw', name: 'Dual Write', email: 'dual.write@example.com', company: 'DW Ltd', taxpayerName: 'DW Ltd', registrationNumber: '800000001', deviceId: 'dev-dw', consent: true, version }) });
  await call('/register', dwBody('0.4.1'));
  const dw1 = await (await admin('/api/user?email=dual.write@example.com')).json();
  const dwReg = await (await call('/register', dwBody('0.5.0'))).json();
  const dw2 = await (await admin('/api/user?email=dual.write@example.com')).json();
  const dwKv = JSON.parse(store.get('dev:dev-dw'));
  check('T-162 dual-write keeps a KV dev: record and its D1 devices row in step',
    dw1.ok && dw1.devices.length === 1 && dw1.devices[0].version === '0.4.1'
    && dw1.clients.some((c) => c.rin === '800000001')
    && dw2.devices[0].version === dwKv.version && dwKv.version === '0.5.0'
    && dw2.user.quota === dwKv.quota);

  // setMessage is KV-only by nature — /session reads it from the dev: record, and it is the only
  // channel that reaches a BLOCKED user to tell them why. Keyed by person, it must fan out to every
  // device they own, or the message depends on which browser they happen to open.
  const msgRes = await (await admin('/api/user', { email: 'dual.write@example.com', action: 'setMessage', value: { text: 'your plan expires next week', level: 'warn' } })).json();
  const msgKv = JSON.parse(store.get('dev:dev-dw'));
  check('setMessage reaches the device through the person-keyed portal',
    msgRes.ok && msgKv.message && msgKv.message.text === 'your plan expires next week' && msgKv.message.level === 'warn');
  const emptyMsg = await admin('/api/user', { email: 'dual.write@example.com', action: 'setMessage', value: { text: '   ' } });
  check('an empty message is refused rather than delivered blank', emptyMsg.status === 400);
  await admin('/api/user', { email: 'dual.write@example.com', action: 'clearMessage' });
  check('clearMessage removes it from the device', !JSON.parse(store.get('dev:dev-dw')).message);

  // The legacy KV dashboard shares /api/user: a { deviceId } body must still reach routes/admin.js.
  const legacy = await (await admin('/api/user', { deviceId: PD, action: 'setNote', value: 'legacy path' })).json();
  check('a legacy { deviceId } /api/user action still falls through to the KV handler',
    legacy.ok && JSON.parse(store.get('dev:' + PD)).note === 'legacy path');

  // ── SPEC-017 slice 2: the Jobs section ────────────────────────────────────────────────────────
  // A third run, driven to a finished plan, so there is a job WITH chunks to inspect and purge.
  // (s0 is stale-running with its chunks already dropped at 'done'; live is running with none yet.)
  const j3 = await (await signed('/plan/start', startBody, PK, PD)).json();
  {
    let c = j3.cursor, i = j3.instruction, n = 0;
    while (i && n++ < 50) {
      const obs = i.kind === 'detectMaxSub' ? { maxSub: null } : { count: probeFor(i.fromISO || i.subF, i.toISO || i.subT) };
      const r = await (await signed('/plan/step', { jobId: j3.jobId, cursor: c, observation: obs }, PK, PD)).json();
      if (r.done) break;
      c = r.cursor; i = r.instruction;
    }
  }

  const jobsAll = await (await admin('/api/jobs')).json();
  check('/api/jobs lists every run in the contract shape',
    jobsAll.ok && jobsAll.total === 3 && jobsAll.jobs.length === 3
    && jobsAll.jobs.every((j) => j.jobId && j.user === 'planner@gmail.com' && j.rin === PRIN
      && 'dir' in j && 'probes' in j && 'version' in j && 'failed' in j));

  // The support question "is anything wedged right now" as one click. s0 stopped checkpointing two
  // hours ago; live checkpointed a moment ago; j3 is 'planned', which is a plan RESTING until the
  // user presses Download and must never be reported as stuck however old it gets.
  const jobsStuck = await (await admin('/api/jobs?stuck=1')).json();
  check('stuck=1 finds only the run that stopped checkpointing 30+ minutes ago',
    jobsStuck.ok && jobsStuck.total === 1 && jobsStuck.jobs[0].jobId === s0.jobId);

  const jobsPlanned = await (await admin('/api/jobs?state=planned')).json();
  const jobsNobody = await (await admin('/api/jobs?user=nobody@example.com')).json();
  const jobsRin = await (await admin('/api/jobs?rin=' + PRIN)).json();
  check('/api/jobs filters by state, user and rin',
    jobsPlanned.total === 1 && jobsPlanned.jobs[0].jobId === j3.jobId
    && jobsNobody.total === 0 && jobsRin.total === 3);

  const one = await (await admin('/api/job?id=' + j3.jobId)).json();
  check('/api/job returns the run and its chunk plan in order',
    one.ok && one.job.jobId === j3.jobId && one.job.total === 2 && one.chunks.length === 2
    && one.chunks[0].idx === 0 && !!one.chunks[0].chunkId && one.chunks[0].count === 9500
    && !!one.chunks[0].label && one.chunks[0].state === 'pending');

  const purged = await (await admin('/api/job', { id: j3.jobId, action: 'purge' })).json();
  check('purge drops the chunk rows and keeps the job row (checkpoint\'s retention rule on demand)',
    purged.ok && JOBS._chunks.filter((c) => c.job_id === j3.jobId).length === 0
    && JOBS._jobs.get(j3.jobId).state === 'planned' && JOBS._jobs.get(j3.jobId).total_chunks === 2);

  const resumeBefore = (await (await signed('/job/resumable', {}, PK, PD)).json()).jobs;
  const aband = await (await admin('/api/job', { id: live.jobId, action: 'abandon' })).json();
  const resumeAfter = (await (await signed('/job/resumable', {}, PK, PD)).json()).jobs;
  check('abandon sets state=abandoned, which also drops the run from /job/resumable',
    aband.ok && aband.job.state === 'abandoned' && JOBS._jobs.get(live.jobId).state === 'abandoned'
    && resumeBefore.some((j) => j.id === live.jobId) && !resumeAfter.some((j) => j.id === live.jobId));

  const noSuchJob = await admin('/api/job', { id: 'deadbeef', action: 'abandon' });
  const badJobAction = await admin('/api/job', { id: s0.jobId, action: 'nuke' });
  check('an unknown job 404s, an unknown job action 400s, and both real ones are audited',
    noSuchJob.status === 404 && badJobAction.status === 400
    && auditAll().some((e) => e.action === 'job:purge' && e.target === j3.jobId)
    && auditAll().some((e) => e.action === 'job:abandon' && e.target === live.jobId));

  // ── SPEC-017 slice 3: plans, features, expiry, and quota on the person ────────────────────────
  const plansJ = await (await admin('/api/plans')).json();
  const byId = (id) => plansJ.plans.find((p) => p.id === id);
  check('the three default plans are seeded with their quotas and features',
    plansJ.ok && byId('free').quota === 1 && byId('free').features.length === 0
    && byId('standard').quota === 5 && byId('standard').features.join() === 'auto-reject'
    && byId('pro').quota === 25 && byId('pro').features.join() === 'auto-reject,po-analytics');

  const up = await (await admin('/api/plan', { id: 'trial', name: 'Trial', quota: 2, features: ['auto-reject'], price: '14 days' })).json();
  check('a plan can be created from the portal', up.ok && up.plan.quota === 2 && up.plan.active === true
    && up.plan.features.join() === 'auto-reject' && up.plan.price === '14 days');

  await admin('/api/user', { email: 'shared@example.com', action: 'setPlan', value: 'trial' });
  const delRef = await admin('/api/plan/delete', { id: 'trial' });
  const delRefJ = await delRef.json();
  check('deleting a plan is REFUSED while a user references it, naming the count',
    delRef.status === 409 && delRefJ.users === 1 && /1 user/.test(delRefJ.error) && JOBS._plans.has('trial'));
  await admin('/api/user', { email: 'shared@example.com', action: 'setPlan', value: 'free' });
  const delOk = await (await admin('/api/plan/delete', { id: 'trial' })).json();
  check('deleting an unreferenced plan works', delOk.ok && !JOBS._plans.has('trial'));

  // Features: the extension has always been SENT `features` and read it nowhere. Slice 3 is the
  // first consumer, so what /session sends has to describe the person's plan, not the browser.
  const dwSession = () => signed('/session', { rin: '800000001', version: '0.5.0' }, dwReg.clientKey, 'dev-dw').then((r) => r.json());
  await admin('/api/user', { email: 'dual.write@example.com', action: 'setPlan', value: 'standard' });
  const sPlan = await dwSession();
  check('/session fills features from the user\'s plan, and the plan raises the reported quota',
    sPlan.ok && sPlan.allowed && sPlan.features.join() === 'auto-reject' && sPlan.quota === 5);

  await admin('/api/user', { email: 'dual.write@example.com', action: 'setFeatures', value: 'po-analytics' });
  const sOver = await dwSession();
  check('a per-user features override beats the plan', sOver.features.join() === 'po-analytics');
  await admin('/api/user', { email: 'dual.write@example.com', action: 'setFeatures', value: '' });
  const sBack = await dwSession();
  check('clearing the override hands the user back to the plan, not to nothing', sBack.features.join() === 'auto-reject');

  // Expiry binds, and it is its OWN reason — the drawer has to be able to say "your plan expired"
  // rather than "you are locked", because those ask completely different things of the user.
  const expStart = () => signed('/plan/start', { ...startBody, rin: '800000001', version: '0.5.0' }, dwReg.clientKey, 'dev-dw');
  await admin('/api/user', { email: 'dual.write@example.com', action: 'setValidUntil', value: '2020-01-01' });
  const sExp = await dwSession();
  const pExp = await expStart(); const pExpJ = await pExp.json();
  check('an expired plan is refused by BOTH /session and /plan/start, with reason=expired',
    sExp.ok && sExp.allowed === false && sExp.reason === 'expired' && sExp.expired === true
    && pExp.status === 403 && pExpJ.reason === 'expired');
  await admin('/api/user', { email: 'dual.write@example.com', action: 'setValidUntil', value: '2099-12-31' });
  const sFuture = await dwSession();
  check('a valid_until still in the future blocks nothing', sFuture.allowed === true && !sFuture.expired);

  // Quota on the PERSON — the hole this spec exists to close: a second browser used to mean a
  // second quota against one licence.
  const qBody = (deviceId, rin) => ({ method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Two Devices', email: 'two.devices@example.com', consent: true, registrationNumber: rin, deviceId, version: '0.5.0' }) });
  const q1 = await (await call('/register', qBody('dev-q1', '810000001'))).json();
  // SPEC-019 arrived after this test and caps devices too: on the free plan the second browser would
  // now be refused at the door and never reach the CLIENT quota rule these assertions are about.
  // Raise the device allowance first so the second device registers and the quota rule is what
  // decides — the device cap gets its own assertions further down (T-181..T-184).
  await admin('/api/user', { email: 'two.devices@example.com', action: 'setDeviceQuota', value: 3 });
  const q2 = await (await call('/register', qBody('dev-q2', '810000002'))).json();
  check('a SECOND browser on the same email does not get a second quota',
    q1.ok && q1.boundRins.includes('810000001')
    && q2.ok && q2.boundRins.length === 0 && q2.allowed === false && !store.has('rinowner:810000002'));

  await admin('/api/user', { email: 'two.devices@example.com', action: 'setQuota', value: 2 });
  const q3 = await (await call('/register', qBody('dev-q2', '810000002'))).json();
  check('raising the PERSON\'s quota lets the second device bind',
    q3.ok && q3.boundRins.includes('810000002') && q3.quota === 2);

  // Grandfather rule: drop the cap BELOW what they already hold. Nothing is confiscated — a RIN
  // removed retroactively would break an export mid-quarter — and nothing new can be added.
  await admin('/api/user', { email: 'two.devices@example.com', action: 'setQuota', value: 1 });
  const q4 = await (await call('/register', qBody('dev-q1', '810000003'))).json();
  check('grandfather: an over-cap user keeps every RIN they hold and simply cannot add another',
    q4.ok && q4.boundRins.length === 1 && q4.boundRins.includes('810000001')
    && JSON.parse(store.get('dev:dev-q2')).boundRins.includes('810000002')
    && !store.has('rinowner:810000003'));                       // never squat a RIN we are over quota to hold

  const rr = await (await signed('/rin-request', { requestedRin: '810000003' }, q1.clientKey, 'dev-q1')).json();
  const appr = await admin('/api/request', { id: rr.id, action: 'approve' });
  const apprJ = await appr.json();
  check('RIN approval counts across the person\'s devices instead of silently raising the quota',
    appr.status === 409 && /across 2 device/.test(apprJ.error)
    && !JSON.parse(store.get('dev:dev-q1')).boundRins.includes('810000003'));
  await admin('/api/user', { email: 'two.devices@example.com', action: 'setQuota', value: 3 });
  const appr2 = await (await admin('/api/request', { id: rr.id, action: 'approve' })).json();
  check('raising the quota first lets the same approval through',
    appr2.ok && JSON.parse(store.get('dev:dev-q1')).boundRins.includes('810000003'));

  // Pre-migration installs must not LOSE features on the day slice 3 ships. Constructed with the
  // portal delete, which removes the D1 person and deliberately leaves the KV device behind.
  await admin('/api/user', { deviceId: 'dev-dw', action: 'setFeatures', value: 'legacy-grant' });   // legacy KV-only path
  await admin('/api/user', { email: 'dual.write@example.com', action: 'delete' });
  const sKvOnly = await dwSession();
  check('a device whose person has no D1 row keeps the features on its KV record',
    sKvOnly.ok && sKvOnly.allowed && sKvOnly.features.join() === 'legacy-grant');

  // ── SPEC-019: the feature catalogue and the device cap ────────────────────────────────────────
  // Two holes, one spec. Features were a vocabulary hard-coded in the portal UI (so a typo produced
  // a grant nobody would ever hold, silently); devices were uncapped (so each browser minted its own
  // allowance — which is how one live account came to hold four).
  const featuresJ = () => admin('/api/features').then((r) => r.json());
  const feat = (fs, id) => fs.features.find((f) => f.id === id);

  const cat1 = await featuresJ();
  await admin('/api/feature', { id: 'auto-reject', name: 'Auto rejection (renamed)', description: 'edited by an admin', active: true });
  const cat2 = await featuresJ();                                  // every portal call re-runs ensureSchema()
  check('T-176 the catalogue seeds idempotently and re-seeding never undoes an admin edit',
    cat1.ok && cat1.features.length === 2 && !!feat(cat1, 'auto-reject') && !!feat(cat1, 'po-analytics')
    && cat2.features.length === 2 && feat(cat2, 'auto-reject').name === 'Auto rejection (renamed)'
    && feat(cat2, 'auto-reject').createdAt === feat(cat1, 'auto-reject').createdAt);   // the id's birthday survives an edit

  // A device of its own for the catalogue assertions: dual.write's D1 person is deleted above.
  const catReg = await (await call('/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Cat Alogue', email: 'cat@example.com', consent: true, registrationNumber: '820000001', deviceId: 'dev-cat', version: '0.5.0' }) })).json();
  const catSession = () => signed('/session', { rin: '820000001', version: '0.5.0' }, catReg.clientKey, 'dev-cat').then((r) => r.json());

  const typo = await admin('/api/user', { email: 'cat@example.com', action: 'setFeatures', value: 'po-analytcs' });
  const typoJ = await typo.json();
  check('T-177 setFeatures refuses an id absent from the catalogue, naming it',
    typo.status === 400 && typoJ.unknown.join() === 'po-analytcs' && /po-analytcs/.test(typoJ.error)
    && !JOBS._users.get('cat@example.com').features.includes('po-analytcs'));   // and nothing was written

  const planTypo = await admin('/api/plan', { id: 'trial2', quota: 2, features: ['auto-reject', 'nope'] });
  check('T-177 a plan cannot grant an id the catalogue does not have either',
    planTypo.status === 400 && !JOBS._plans.has('trial2'));

  // Grant it while active, THEN retire it. Deactivating must stop new grants without touching one.
  await admin('/api/user', { email: 'cat@example.com', action: 'setFeatures', value: 'po-analytics' });
  await admin('/api/feature', { id: 'po-analytics', name: 'PO reconciliation', description: 'retired', active: false });
  const inact = await admin('/api/user', { email: 'other@example.com', action: 'setFeatures', value: 'po-analytics' });
  const inactJ = await inact.json();
  check('T-178 setFeatures refuses an id that exists but is inactive, and says why',
    inact.status === 400 && inactJ.inactive.join() === 'po-analytics' && /inactive/.test(inactJ.error));

  const catSess = await catSession();
  check('T-179 deactivating a feature leaves an existing grant working (grandfathered, never revoked)',
    catSess.ok && catSess.allowed && catSess.features.join() === 'po-analytics'
    && (await featuresJ()).features.find((f) => f.id === 'po-analytics').active === false);
  await admin('/api/feature', { id: 'po-analytics', name: 'PO reconciliation', description: 'The purchase-order matching card', active: true });

  const delFeat = await admin('/api/feature/delete', { id: 'auto-reject' });
  const delFeatJ = await delFeat.json();
  check('T-180 deleting a feature is refused while plans and users still grant it, naming both counts',
    delFeat.status === 409 && delFeatJ.plans === 2 && delFeatJ.users === 0
    && /2 plans/.test(delFeatJ.error) && JOBS._features.has('auto-reject'));
  const delUnused = await (await admin('/api/feature', { id: 'ledger-sync', name: 'Ledger sync' })).json();
  const delUnusedGone = await (await admin('/api/feature/delete', { id: 'ledger-sync' })).json();
  check('a feature nobody grants can be deleted, and is created active by default',
    delUnused.ok && delUnused.created === true && delUnused.feature.active === true
    && delUnusedGone.ok && !JOBS._features.has('ledger-sync'));

  // ── the device cap ──
  const capBody = (deviceId, rin) => ({ method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Cap Test', email: 'devcap@example.com', consent: true, registrationNumber: rin, deviceId, version: '0.5.0' }) });
  const c1 = await (await call('/register', capBody('dev-c1', '830000001'))).json();
  const c2res = await call('/register', capBody('dev-c2', '830000002'));
  const c2 = await c2res.json();
  check('T-181 /register refuses device N+1 with reason=device_limit and the two counts',
    c1.ok && c2res.status === 403 && c2.ok === false && c2.error === 'device limit reached'
    && c2.reason === 'device_limit' && c2.held === 1 && c2.allowed === 1     // free plan: one device
    && !store.has('dev:dev-c2'));                                           // and nothing half-created

  const c1again = await (await call('/register', capBody('dev-c1', '830000001'))).json();
  check('T-182 a returning deviceId is never refused — clearing a cache must not cost a registration',
    c1again.ok && c1again.boundRins.includes('830000001'));

  // Raise the allowance, fill it, then drop it below what they hold.
  await admin('/api/user', { email: 'devcap@example.com', action: 'setDeviceQuota', value: 3 });
  const c2ok = await (await call('/register', capBody('dev-c2', '830000002'))).json();
  const c3ok = await (await call('/register', capBody('dev-c3', '830000003'))).json();
  await admin('/api/user', { email: 'devcap@example.com', action: 'setDeviceQuota', value: 1 });
  const c4res = await call('/register', capBody('dev-c4', '830000004'));
  const c4 = await c4res.json();
  const stillThere = ['dev-c1', 'dev-c2', 'dev-c3'].every((d) => store.has('dev:' + d));
  const allReturn = await Promise.all([
    call('/register', capBody('dev-c1', '830000001')).then((r) => r.json()),
    call('/register', capBody('dev-c2', '830000002')).then((r) => r.json()),
    call('/register', capBody('dev-c3', '830000003')).then((r) => r.json()),
  ]);
  check('T-183 an over-cap user keeps every device and simply cannot add another',
    c2ok.ok && c3ok.ok && c4res.status === 403 && c4.reason === 'device_limit'
    && c4.held === 3 && c4.allowed === 1 && stillThere && allReturn.every((r) => r.ok));

  // MAX(user override, plan) — assigning a bigger plan must never be a downgrade by accident.
  await admin('/api/user', { email: 'devcap@example.com', action: 'setPlan', value: 'pro' });
  const entPro = (await (await admin('/api/user?email=devcap@example.com')).json()).entitlement;
  await admin('/api/user', { email: 'devcap@example.com', action: 'setDeviceQuota', value: 12 });
  const entOver = (await (await admin('/api/user?email=devcap@example.com')).json()).entitlement;
  const c4ok = await (await call('/register', capBody('dev-c4', '830000004'))).json();
  check('T-184 the effective device allowance is MAX(user override, plan), and it says which won',
    entPro.devices === 10 && entPro.source.devices === 'plan'          // override 1 loses to pro's 10
    && entOver.devices === 12 && entOver.source.devices === 'override'
    && entPro.clients === 25 && entPro.source.clients === 'plan'
    && c4ok.ok && c4ok.boundRins.includes('830000004'));

  // ── custom accounts ──
  // A negotiated account detaches from the plans table entirely. The MAX rule must NOT apply, or a
  // cap LOWER than a standard plan — the main reason a custom account is opened — is impossible.
  await admin('/api/user', { email: 'cat@example.com', action: 'setPlan', value: 'custom' });
  await admin('/api/user', { email: 'cat@example.com', action: 'setQuota', value: 2 });
  await admin('/api/user', { email: 'cat@example.com', action: 'setDeviceQuota', value: 2 });
  await admin('/api/user', { email: 'cat@example.com', action: 'setFeatures', value: 'auto-reject' });
  const entCustom = (await (await admin('/api/user?email=cat@example.com')).json()).entitlement;
  const custSess = await catSession();
  check('T-187 a custom account is read VERBATIM, including a cap far LOWER than any named plan',
    entCustom.custom === true && entCustom.clients === 2 && entCustom.devices === 2
    && entCustom.source.clients === 'custom' && entCustom.source.devices === 'custom'
    && entCustom.source.features === 'custom' && entCustom.features.join() === 'auto-reject'
    && custSess.quota === 2 && custSess.features.join() === 'auto-reject');   // not MAX(2, pro's 25)

  await admin('/api/plan', { id: 'pro', name: 'Pro', quota: 500, deviceQuota: 99, features: ['auto-reject', 'po-analytics'], price: '' });
  const entAfterPlanEdit = (await (await admin('/api/user?email=cat@example.com')).json()).entitlement;
  const proAfter = (await (await admin('/api/plans')).json()).plans.find((p) => p.id === 'pro');
  check('T-186 a custom account ignores plan edits entirely',
    proAfter.quota === 500 && proAfter.deviceQuota === 99
    && entAfterPlanEdit.clients === 2 && entAfterPlanEdit.devices === 2);
  // …while an account ON that plan follows it, which is what makes the isolation meaningful.
  const entOnPlan = (await (await admin('/api/user?email=devcap@example.com')).json()).entitlement;
  check('an account on the edited plan does follow it', entOnPlan.devices === 99 && entOnPlan.clients === 500);

  const planOmits = await (await admin('/api/plan', { id: 'pro', name: 'Pro', quota: 500, features: ['auto-reject'] })).json();
  check('a plan upsert that never mentions the device allowance keeps it rather than cutting it to 1',
    planOmits.ok && planOmits.plan.deviceQuota === 99);

  const reserved = await admin('/api/plan', { id: 'custom', name: 'Custom', quota: 9 });
  check('T-188 POST /api/plan refuses the reserved id "custom"',
    reserved.status === 400 && /reserved/.test((await reserved.json()).error) && !JOBS._plans.has('custom'));

  // ── SPEC-017 slice 4: bugs joined to people and runs, and a real audit trail ──────────────────
  // The same admin token, plus the header Cloudflare Access stamps on every request it lets through.
  const adminAs = (who, path, body) => call(path, body
    ? { method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer testtok', 'content-type': 'application/json', 'cf-access-authenticated-user-email': who } }
    : { headers: { authorization: 'Bearer testtok', 'cf-access-authenticated-user-email': who } });

  // A run with a range of its OWN: the three earlier jobs all share startBody's dates, so a report
  // matched against them would be asserting luck rather than the matcher.
  const bugRange = { ...startBody, from: '2024-03-01', to: '2024-03-31' };
  const bJob = await (await signed('/plan/start', bugRange, PK, PD)).json();
  {
    let c = bJob.cursor, i = bJob.instruction, n = 0;
    while (i && n++ < 50) {
      const obs = i.kind === 'detectMaxSub' ? { maxSub: null } : { count: probeFor(i.fromISO || i.subF, i.toISO || i.subT) };
      const r = await (await signed('/plan/step', { jobId: bJob.jobId, cursor: c, observation: obs }, PK, PD)).json();
      if (r.done) break;
      c = r.cursor; i = r.instruction;
    }
  }
  const bChunks = JOBS._jobs.get(bJob.jobId).total_chunks;
  // Log lines timestamped AROUND now, because "the lines around the report" is a time window and a
  // 2026-01-01 fixture would only ever exercise the fallback.
  await signed('/job/log', { jobId: bJob.jobId, lines: [
    { at: new Date(Date.now() - 60000).toISOString(), level: 'run', kind: 'page', text: 'chunk 1/1 fetching 100/100' },
    { at: new Date(Date.now() - 30000).toISOString(), level: 'warn', kind: null, text: '2 documents dropped in chunk 1' },
  ] }, PK, PD);

  const bugRep = await (await signed('/bug', { message: 'export stalled at chunk 1', diag: {
    version: '9.9.9', last: 'Fetching', log: ['chunk 1/1 fetching 100/100'],
    plan: { source: 'invoices', year: '2024', from: '2024-03-01', to: '2024-03-31', chunks: bChunks, done: 0, failed: 0, rows: 100, pdf: false },
  } }, PK, PD)).json();

  const bd = await (await admin('/api/bug?id=' + bugRep.id)).json();
  check('T-189 a bug report joins to its user, its device and the run it came out of',
    bd.ok && bd.user && bd.user.email === 'planner@gmail.com' && bd.device && bd.device.deviceId === PD
    && !('clientKey' in bd.device)                                          // the HMAC secret never leaves D1
    && bd.job && bd.job.jobId === bJob.jobId && bd.jobMatch === 'exact'
    && bd.events.length === 2 && bd.events[1].text === '2 documents dropped in chunk 1');

  const bugNoDiag = await (await signed('/bug', { message: 'no diagnostics from this build' }, PK, PD)).json();
  const bd2 = await (await admin('/api/bug?id=' + bugNoDiag.id)).json();
  check('T-189 a report with no diagnostics falls back to the run that browser last touched, labelled inferred',
    bd2.ok && bd2.jobMatch === 'inferred' && bd2.job && bd2.job.jobId === bJob.jobId);

  const bl = await (await admin('/api/bugs')).json();
  const blRow = bl.bugs.find((g) => g.id === bugRep.id);
  const blOrphan = bl.bugs.find((g) => g.deviceId === 'dev-1');
  check('T-189 /api/bugs joins every row, keeps the legacy fields, and says when no run is determinable',
    bl.ok && blRow && blRow.job.jobId === bJob.jobId && blRow.jobMatch === 'exact'
    && blRow.user.email === 'planner@gmail.com' && blRow.device.deviceId === PD
    && blRow.message === 'export stalled at chunk 1' && !!blRow.diag                 // …and the KV dashboard's shape survives
    && blOrphan && blOrphan.job === null && blOrphan.jobMatch === 'none'             // dev-1 never ran an export
    && bl.total === [...store.keys()].filter((k) => k.startsWith('bug:')).length);

  const bugResolved = await (await admin('/api/bug', { id: bugRep.id, action: 'resolve' })).json();
  const bugNoted = await (await admin('/api/bug', { id: bugRep.id, action: 'note', value: 'called the user, the ETA portal was down' })).json();
  const openOnly = await (await admin('/api/bugs?status=open')).json();
  const emptyNote = await admin('/api/bug', { id: bugRep.id, action: 'note', value: '   ' });
  check('T-190 resolve and an assigned note are stored on the report, audited, and the note body is NOT in the trail',
    bugResolved.ok && bugNoted.ok && bugNoted.bug.note.text.startsWith('called the user')
    && bugNoted.bug.note.by === 'token' && emptyNote.status === 400
    && !openOnly.bugs.some((g) => g.id === bugRep.id) && openOnly.bugs.some((g) => g.id === bugNoDiag.id)
    && auditAll().some((e) => e.action === 'bug:resolve' && e.target === bugRep.id && e.detail.before === 'open' && e.detail.after === 'resolved')
    && auditAll().some((e) => e.action === 'bug:note' && e.detail.chars > 0)
    && !/called the user/.test(JSON.stringify(auditAll())));

  const reopened = await (await adminAs('omar@firm.example', '/api/bug', { id: bugRep.id, action: 'reopen' })).json();
  const junkHeader = await (await adminAs('not-an-email', '/api/bug', { id: bugRep.id, action: 'resolve' })).json();
  const eReopen = auditAll().find((e) => e.action === 'bug:reopen' && e.target === bugRep.id);
  const eResolve = auditAll().find((e) => e.action === 'bug:resolve' && e.target === bugRep.id);
  check('T-191 the actor is the Access identity when the header is present and falls back to "token" when it is not',
    reopened.ok && junkHeader.ok
    && eReopen && eReopen.actor === 'omar@firm.example' && eReopen.via === 'access'
    && eResolve && eResolve.actor === 'token' && eResolve.via === 'token');   // newest resolve: the junk header was refused

  // Entitlement changes carry both sides. `other@example.com` is on pro with the migrated quota of 1.
  await admin('/api/user', { email: 'other@example.com', action: 'setQuota', value: 7 });
  await adminAs('boss@firm.example', '/api/user', { email: 'other@example.com', action: 'setPlan', value: 'standard' });
  await admin('/api/user', { email: 'cat@example.com', action: 'setFeatures', value: 'auto-reject,po-analytics' });
  await admin('/api/user', { email: 'other@example.com', action: 'setNote', value: 'renewal call booked for Tuesday' });
  const eQuota = auditAll().find((e) => e.action === 'user:setQuota' && e.target === 'other@example.com');
  const ePlan = auditAll().find((e) => e.action === 'user:setPlan' && e.target === 'other@example.com');
  const eFeat = auditAll().find((e) => e.action === 'user:setFeatures' && e.target === 'cat@example.com');
  check('T-192 an entitlement change records the value on BOTH sides of it, and a support note records only its shape',
    eQuota && eQuota.detail.field === 'quota' && eQuota.detail.before === 1 && eQuota.detail.after === 7
    && ePlan && ePlan.detail.before === 'pro' && ePlan.detail.after === 'standard' && ePlan.actor === 'boss@firm.example'
    && eFeat && eFeat.detail.before.join() === 'auto-reject' && eFeat.detail.after.join() === 'auto-reject,po-analytics'
    && !/renewal call booked/.test(JSON.stringify(auditAll())));

  // The two endpoints that mutated in silence before this slice.
  await admin('/api/request', { id: rr.id, action: 'delete' });
  await admin('/api/bug', { id: bug2.id, action: 'delete' });
  check('T-190 the two endpoints that used to mutate silently now write an entry',
    auditAll().some((e) => e.action === 'request_delete' && e.detail.after === '(deleted)')
    && auditAll().some((e) => e.action === 'bug:delete' && e.target === bug2.id)
    && !store.has('bug:' + bug2.id) && !store.has('req:' + rr.id));

  const audAll = await (await admin('/api/audit')).json();
  const audActor = await (await admin('/api/audit?actor=boss@firm.example')).json();
  const audTarget = await (await admin('/api/audit?target=other@example.com')).json();
  const audAction = await (await admin('/api/audit?action=bug:')).json();
  const audPage2 = await (await admin('/api/audit?page=2')).json();
  check('T-193 /api/audit pages, and filters by actor, target and action',
    audAll.ok && audAll.total === auditAll().length && audAll.entries.length === Math.min(50, audAll.total)
    && audAll.audit.length === audAll.entries.length                          // the legacy alias the KV dashboard reads
    && audAll.entries[0].at >= audAll.entries[audAll.entries.length - 1].at    // newest first
    && audActor.total >= 1 && audActor.entries.every((e) => e.actor === 'boss@firm.example')
    && audTarget.total >= 1 && audTarget.entries.every((e) => String(e.target).includes('other@example.com'))
    && audAction.total >= 3 && audAction.entries.every((e) => e.action.startsWith('bug:'))
    && audPage2.page === 2 && audPage2.pages === audAll.pages
    && audPage2.entries[0].at <= audAll.entries[49].at);

  const trail = auditAll();
  check('T-194 no endpoint writes an audit entry without an actor, and no secret ever reaches the trail',
    trail.length > 0
    && trail.every((e) => typeof e.actor === 'string' && e.actor.length > 0 && (e.via === 'token' || e.via === 'access'))
    && !JSON.stringify(trail).includes(PK) && !JSON.stringify(trail).includes(reg.clientKey)
    && !JSON.stringify(trail).includes('testtok'));

  // ── top-level catch ──
  const origGet = LEADS.get; LEADS.get = async () => { throw new Error('kv exploded'); };
  const boom = await signed('/session', { rin: '123456789' }, PK, PD);
  LEADS.get = origGet;
  check('unhandled throw → JSON 500', boom.status === 500 && (await boom.json()).error === 'server error');
} finally { /* nothing to clean up — the source under test is imported as-is */ }

console.log(fails ? 'SMOKE FAILED: ' + fails : 'SMOKE OK');
process.exit(fails ? 1 : 0);
