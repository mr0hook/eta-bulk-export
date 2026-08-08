// Seed the STAGING worker with synthetic accounts through the real extension endpoints.
// Also the first post-A0 exercise of the Locks Durable Object: the duplicate-RIN case at the end
// can only pass if atomic first-writer-wins ownership still works on the deployed split worker.
// Writes only to staging's own KV namespace. No real taxpayer data.
import { webcrypto } from 'crypto';
const { subtle } = webcrypto;

// Target. Override with `node seed-staging.mjs <url>` for a differently-named staging worker.
const BASE = (process.argv[2] || 'https://eta-bulk-leads-staging.omsoliman95.workers.dev').replace(/\/$/, '');

// Hard refusal: this script writes permanent KV records (dev:, req:, bug:) with no TTL, and RIN
// claims that a Durable Object will then defend. Run against production and you have salted the
// live namespace with fake taxpayers that only manual deletion removes.
if (!/staging/i.test(BASE)) {
  console.error('REFUSING: "' + BASE + '" does not look like a staging target.\n' +
    'This script creates permanent records. Point it at a staging worker.');
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

async function post(path, body, signAs) {
  const text = JSON.stringify(body);
  const headers = { 'content-type': 'application/json' };
  if (signAs) {
    const ts = String(Math.floor(Date.now() / 1000)), nonce = uuid().replace(/-/g, '');
    headers['x-device-id'] = signAs.deviceId;
    headers['x-ts'] = ts;
    headers['x-nonce'] = nonce;
    headers['x-signature'] = await hmacHex(signAs.clientKey, `${ts}\n${nonce}\nPOST\n${path}\n${await sha256hex(text)}`);
  }
  const r = await fetch(BASE + path, { method: 'POST', headers, body: text });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}

// Synthetic accounts. Emails use domains with real MX records — /register runs a Disify
// deliverability check and rejects a domain with no mail server outright.
const PEOPLE = [
  { name: 'Seed Alpha Trading',  email: 'eta.seed.alpha@gmail.com',  company: 'Alpha Trading LLC',  rin: '100000001', version: '0.4.1', runs: 12, docs: 48210, pdfs: 310 },
  { name: 'Seed Beta Foods',     email: 'eta.seed.beta@gmail.com',   company: 'Beta Foods SAE',     rin: '100000002', version: '0.4.1', runs: 3,  docs: 5120,  pdfs: 0 },
  { name: 'Seed Gamma Textiles', email: 'eta.seed.gamma@yahoo.com',  company: 'Gamma Textiles',     rin: '100000003', version: '0.4.0', runs: 1,  docs: 640,   pdfs: 12 },
];

const made = [];
let fails = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   ' + extra : '')); if (!cond) fails++; };

console.log('seeding ' + BASE + '\n');

for (const p of PEOPLE) {
  const deviceId = uuid();
  const { status, j } = await post('/register', {
    regId: uuid(), name: p.name, email: p.email, phone: '+20100000000', company: p.company,
    registrationNumber: p.rin, taxpayerName: p.company, deviceId, version: p.version, consent: true,
  });
  ok('register ' + p.company, status === 200 && j.ok && j.clientKey, j.error || ('rins=' + JSON.stringify(j.boundRins)));
  if (!j.clientKey) continue;
  const dev = { deviceId, clientKey: j.clientKey, ...p };
  made.push(dev);

  const s = await post('/session', { rin: p.rin, version: p.version, stats: { runs: p.runs, docs: p.docs, pdfs: p.pdfs, lastExportAt: new Date().toISOString() } }, dev);
  ok('  session check-in', s.status === 200 && s.j.ok && s.j.allowed === true, 'allowed=' + s.j.allowed + ' reason=' + (s.j.reason || '-'));
}

if (made.length) {
  const a = made[0];
  const rq = await post('/rin-request', { requestedRin: '100000009', note: 'second company, seeded' }, a);
  ok('rin-request queued', rq.status === 200 && rq.j.ok, rq.j.error || ('id=' + (rq.j.id || rq.j.pending)));

  const bg = await post('/bug', {
    message: 'Seeded report: merge stalled on a large folder.',
    diag: { version: a.version, last: 'merge: writing part 3', log: ['plan: 412 chunks', 'chunk 3/412 fetching…', 'merge: part 2 written'], plan: { source: 'invoices', year: '2026', from: '2026-01-01', to: '2026-06-30', chunks: 412, done: 190, failed: 2, rows: 48210, pdf: true } },
  }, a);
  ok('bug filed with diagnostics', bg.status === 200 && bg.j.ok, bg.j.error || ('id=' + bg.j.id));
}

// ── the Durable Object test ─────────────────────────────────────────────────────────────────────
// A second device claiming an already-owned RIN must LOSE. This is the only path that proves the
// Locks DO still arbitrates ownership after the split — the local parity harness ran without the
// binding and therefore only ever exercised the KV fallback.
if (made.length) {
  const taken = made[0].rin;
  const { status, j } = await post('/register', {
    regId: uuid(), name: 'Seed Delta Impostor', email: 'eta.seed.delta@gmail.com', company: 'Delta Co',
    registrationNumber: taken, taxpayerName: 'Delta Co', deviceId: uuid(), version: '0.4.1', consent: true,
  });
  ok('duplicate RIN claim is REFUSED (Locks DO)', status === 409, 'status=' + status + ' err=' + String(j.error || '').slice(0, 60));
}

console.log('\n' + (fails ? fails + ' FAILED' : 'seed complete — all checks passed'));
console.log('devices created: ' + made.length);
process.exit(fails ? 1 : 0);
