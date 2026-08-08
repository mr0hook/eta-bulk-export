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
const env = { LEADS, ADMIN_TOKEN: 'testtok' };   // no LOCKS → KV fallbacks
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

  // ── top-level catch ──
  const origGet = LEADS.get; LEADS.get = async () => { throw new Error('kv exploded'); };
  const boom = await signed('/session', { rin: '123456789' }, reg.clientKey, 'dev-1');
  LEADS.get = origGet;
  check('unhandled throw → JSON 500', boom.status === 500 && (await boom.json()).error === 'server error');
} finally { /* nothing to clean up — the source under test is imported as-is */ }

console.log(fails ? 'SMOKE FAILED: ' + fails : 'SMOKE OK');
process.exit(fails ? 1 : 0);
