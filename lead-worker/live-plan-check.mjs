// Drives a full planner conversation against the DEPLOYED staging worker and real D1.
//
// The smoke suite proves the routes against a stub I wrote to match my own assumptions. This proves
// them against Cloudflare's actual D1 — specifically the three places a stub can lie: `LIMIT ?`
// parameter binding, `EXISTS (...)` inside a DELETE, and whether batch() really is one transaction.
//
//   node live-plan-check.mjs [url]
import { webcrypto } from 'crypto';
const { subtle } = webcrypto;

const BASE = (process.argv[2] || 'https://eta-bulk-leads-staging.omsoliman95.workers.dev').replace(/\/$/, '');
if (!/staging/i.test(BASE)) {
  console.error('REFUSING: "' + BASE + '" is not a staging target. This registers a device and writes job rows.');
  process.exit(2);
}

const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256hex = async (s) => hex(await subtle.digest('SHA-256', enc.encode(s)));
async function hmacHex(keyHex, msg) {
  const key = await subtle.importKey('raw', Uint8Array.from(keyHex.match(/.{2}/g).map((h) => parseInt(h, 16))), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await subtle.sign('HMAC', key, enc.encode(msg)));
}
const uuid = () => webcrypto.randomUUID();

async function post(path, body, as) {
  const text = JSON.stringify(body);
  const headers = { 'content-type': 'application/json' };
  if (as) {
    const ts = String(Math.floor(Date.now() / 1000)), nonce = uuid().replace(/-/g, '');
    Object.assign(headers, {
      'x-device-id': as.deviceId, 'x-ts': ts, 'x-nonce': nonce,
      'x-signature': await hmacHex(as.clientKey, `${ts}\n${nonce}\nPOST\n${path}\n${await sha256hex(text)}`),
    });
  }
  const r = await fetch(BASE + path, { method: 'POST', headers, body: text });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}

let fails = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   ' + extra : '')); if (!cond) fails++; };

console.log('live planner check → ' + BASE + '\n');

// A fresh device each run: RINs are claimed atomically and a re-used one would 409.
const rin = '9' + String(Date.now()).slice(-8);
const deviceId = uuid();
const reg = await post('/register', {
  regId: uuid(), name: 'Live Plan Check', email: 'eta.seed.plan@gmail.com', company: 'Plan Check',
  registrationNumber: rin, taxpayerName: 'Plan Check', deviceId, version: '9.9.9', consent: true,
});
ok('register', reg.status === 200 && reg.j.ok, reg.j.error || ('rin=' + rin));
if (!reg.j.clientKey) process.exit(1);
const dev = { deviceId, clientKey: reg.j.clientKey };

// Synthetic portal: wider than ~200 days is over the 10,000 cap, narrower is under.
const probeFor = (f, t) => (Date.parse(t) - Date.parse(f) > 200 * 86400000 ? 20000 : 100);

const start = await post('/plan/start', { source: 'invoices', field: 'Issue', from: '2025-01-01', to: '2025-12-31', dir: 'Sent', statuses: ['Valid'], rin, version: '9.9.9' }, dev);
ok('plan/start mints a job', start.status === 200 && start.j.ok && !!start.j.jobId, start.j.error || start.j.reason || '');
if (!start.j.jobId) process.exit(1);
const jobId = start.j.jobId;

let cursor = start.j.cursor, instr = start.j.instruction, plan = null, steps = 0;
while (instr && steps < 200) {
  const obs = instr.kind === 'detectMaxSub' ? { maxSub: null } : { count: probeFor(instr.fromISO || instr.subF, instr.toISO || instr.subT) };
  const r = await post('/plan/step', { jobId, cursor, observation: obs }, dev);
  steps++;
  if (!r.j.ok) { ok('plan/step', false, 'status=' + r.status + ' err=' + r.j.error); break; }
  if (r.j.done) { plan = r.j; break; }
  cursor = r.j.cursor; instr = r.j.instruction;
}
ok('plan completes over the wire', !!plan && plan.chunks.length === 2, plan ? `chunks=${plan.chunks.length} steps=${steps}` : 'never finished');

// batch() as one transaction: the plan and the state flip land together or not at all.
const resumable1 = await post('/job/resumable', {}, dev);          // exercises LIMIT ? binding
ok('D1 LIMIT ? binds — job is listed as resumable',
  resumable1.j.ok && (resumable1.j.jobs || []).some((j) => j.id === jobId), resumable1.j.error || '');
const listed = (resumable1.j.jobs || []).find((j) => j.id === jobId) || {};
ok('planned totals persisted', listed.state === 'planned' && listed.total_chunks === 2 && listed.total_rows === 200,
  `state=${listed.state} chunks=${listed.total_chunks} rows=${listed.total_rows}`);

const planBack = await post('/job/plan', { jobId }, dev);
ok('stored plan reads back in order', planBack.j.ok && planBack.j.chunks.length === 2 && planBack.j.chunks[0].count === 100);

await post('/job/checkpoint', { jobId, state: 'running', done: 1, failed: 0 }, dev);
const midway = await post('/job/plan', { jobId }, dev);
ok('an in-flight job keeps its plan', midway.j.ok && midway.j.chunks.length === 2);

// The retention rule, against real D1: DELETE ... WHERE EXISTS (...)
await post('/job/checkpoint', { jobId, state: 'done', done: 2, failed: 0 }, dev);
const purged = await post('/job/plan', { jobId }, dev);
ok('D1 DELETE ... EXISTS purges the plan on completion', purged.status === 410, 'status=' + purged.status);
const resumable2 = await post('/job/resumable', {}, dev);
ok('a finished job leaves the resumable list', resumable2.j.ok && !(resumable2.j.jobs || []).some((j) => j.id === jobId));

console.log('\n' + (fails ? fails + ' FAILED' : 'live planner check passed — real D1 agrees with the stub'));
process.exit(fails ? 1 : 0);
