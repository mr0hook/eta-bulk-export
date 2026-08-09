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
// Minimal D1 stub for the planner routes. Deliberately NOT a SQL engine — it recognises the six
// statements jobs.js issues and nothing else, so an unrecognised query throws loudly rather than
// silently returning empty and making a broken route look like it passed.
function makeD1() {
  const jobs = new Map(), chunks = [];
  const exec = (sql, a) => {
    if (sql.includes('INSERT INTO jobs')) { jobs.set(a[0], { id: a[0], device_id: a[1], rin: a[2], source: a[3], date_field: a[4], dir: a[5], from_iso: a[6], to_iso: a[7], statuses: a[8], state: 'planning', version: a[9], created_at: a[10], updated_at: a[11], total_chunks: 0, total_rows: 0, done_count: 0, failed_count: 0, probes: 0 }); return { success: true }; }
    if (sql.includes('INSERT OR REPLACE INTO job_chunks')) { chunks.push({ job_id: a[0], idx: a[1], chunk_id: a[2], from_iso: a[3], to_iso: a[4], sub_f: a[5], sub_t: a[6], label: a[7], count: a[8], warn: a[9], state: 'pending' }); return { success: true }; }
    if (sql.includes("SET state='planned'")) { const j = jobs.get(a[4]); if (j) Object.assign(j, { state: 'planned', total_chunks: a[0], total_rows: a[1], probes: a[2], updated_at: a[3] }); return { success: true }; }
    if (sql.includes('SET state=?, done_count=?')) { const j = jobs.get(a[4]); if (j && j.device_id === a[5]) Object.assign(j, { state: a[0], done_count: a[1], failed_count: a[2], updated_at: a[3] }); return { success: true }; }
    throw new Error('D1 stub: unrecognised statement → ' + sql.slice(0, 70));
  };
  const read = (sql, a) => {
    if (sql.includes('SELECT * FROM jobs WHERE id')) { const j = jobs.get(a[0]); return (j && j.device_id === a[1]) ? [j] : []; }
    if (sql.includes('SELECT * FROM job_chunks')) return chunks.filter((c) => c.job_id === a[0]).sort((x, y) => x.idx - y.idx);
    throw new Error('D1 stub: unrecognised query → ' + sql.slice(0, 70));
  };
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    run: async () => exec(sql, args || []),
    first: async () => read(sql, args || [])[0] || null,
    all: async () => ({ results: read(sql, args || []) }),
  });
  return { prepare: (sql) => mk(sql, null), batch: async (stmts) => { for (const s of stmts) await s.run(); return []; }, _jobs: jobs, _chunks: chunks };
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
  // narrower is comfortably under. One split, two chunks, three steps.
  const probeFor = (f, t) => (Date.parse(t) - Date.parse(f) > 200 * 86400000 ? 20000 : 100);

  // A device of its own: dev-1 has been deleted and restored by the trash tests above, and the
  // restore deliberately drops a RIN another account re-claimed. Reusing it here would make these
  // assertions depend on damage inflicted by an unrelated test.
  const pReg = await (await call('/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ regId: 'rp', name: 'Planner Dev', email: 'planner@gmail.com', registrationNumber: '900000001', deviceId: 'dev-plan', consent: true, version: '9.9.9' }),
  })).json();
  check('planner device registered with its own RIN', pReg.ok && pReg.boundRins.includes('900000001'));
  const PK = pReg.clientKey, PD = 'dev-plan', PRIN = '900000001';
  const startBody = { source: 'invoices', field: 'Issue', from: '2025-01-01', to: '2025-12-31', rin: PRIN, version: '9.9.9' };

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
  check('job row reaches planned with its totals', jobRow && jobRow.state === 'planned' && jobRow.total_chunks === 2 && jobRow.total_rows === 200);

  const tampered = await signed('/plan/step', { jobId: s0.jobId, cursor: String(s0.cursor).slice(0, -4) + 'AAAA', observation: { count: 1 } }, PK, PD);
  check('a tampered cursor is refused, not treated as empty state', tampered.status === 400);

  const noJob = await signed('/plan/step', { jobId: 'deadbeefdeadbeef', cursor: s0.cursor, observation: { count: 1 } }, PK, PD);
  check('an unknown job id is refused', noJob.status === 404);

  const cp = await signed('/job/checkpoint', { jobId: s0.jobId, state: 'running', done: 1, failed: 0 }, PK, PD);
  check('checkpoint records progress', cp.status === 200 && jobRow.done_count === 1 && jobRow.state === 'running');

  // The gate: a locked device must not be able to mint a job at all.
  await admin('/api/user', { deviceId: PD, action: 'lock' });
  const lockedStart = await signed('/plan/start', startBody, PK, PD);
  const lj = await lockedStart.json();
  check('a locked device cannot mint a job', lockedStart.status === 403 && lj.reason === 'locked');
  await admin('/api/user', { deviceId: PD, action: 'unlock' });

  // ── top-level catch ──
  const origGet = LEADS.get; LEADS.get = async () => { throw new Error('kv exploded'); };
  const boom = await signed('/session', { rin: '123456789' }, PK, PD);
  LEADS.get = origGet;
  check('unhandled throw → JSON 500', boom.status === 500 && (await boom.json()).error === 'server error');
} finally { /* nothing to clean up — the source under test is imported as-is */ }

console.log(fails ? 'SMOKE FAILED: ' + fails : 'SMOKE OK');
process.exit(fails ? 1 : 0);
