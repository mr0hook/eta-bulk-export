// T-302 — the service worker's signature must actually verify against the server.
//
// 2026-09-20 incident: "Plan failed: unauthorized". SPEC-038 moved signing into the service worker,
// and the worker keyed its HMAC on the UTF-8 bytes of the hex clientKey while the backend (and the
// page's own fallback) key on the DECODED hex bytes. Every signed call the worker signed was a
// well-formed signature that could never verify, so /session fell back to the cached grace verdict
// (drawer looks licensed) and /plan/start answered 401 'unauthorized'.
//
// signing.test.mjs pins the SHAPE of the worker's signing path by reading the source. It cannot
// catch a wrong key derivation — so this one runs the real handler and verifies the real signature.
import test from 'node:test';
import assert from 'node:assert/strict';

const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

// The backend's verifier, verbatim from lead-worker/src/lib/util.js — the authority both clients
// have to match.
async function serverHmac(keyHex, msg) {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(keyHex.match(/.{2}/g).map((h) => parseInt(h, 16))), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
const sha256hex = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

const CLIENT_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff00';   // 32 bytes, as randHex(32) mints
const MIRROR = { deviceId: 'dev-1', creds: { clientKey: CLIENT_KEY } };

// Minimal chrome stand-in: enough for bg.js to register its listeners and read the identity mirror.
const handlers = [];
globalThis.chrome = {
  runtime: { onMessage: { addListener: (fn) => handlers.push(fn) } },
  storage: { local: { get: async () => ({ etaBulkIdentity: MIRROR }), set: async () => {} } },
  tabs: { create: async () => ({ id: 1 }), remove: async () => {} },
};
await import('../src/bg.js');

// Drive the real handler the bridge drives.
function ask(msg) {
  return new Promise((resolve, reject) => {
    for (const fn of handlers) if (fn(msg, null, resolve) === true) return;
    reject(new Error('no handler claimed the message'));
  });
}

test('T-302 the service worker signs with the key the server verifies with', async () => {
  const path = '/plan/start';
  const body = JSON.stringify({ rin: '123456789', source: 'invoices' });
  const r = await ask({ type: 'eta-id-store', op: 'sign', path, body });
  assert.equal(r.ok, true, 'the worker signed');
  const expect = await serverHmac(CLIENT_KEY, `${r.ts}\n${r.nonce}\nPOST\n${path}\n${await sha256hex(body)}`);
  assert.equal(r.signature, expect,
    'the worker keyed its HMAC differently from the backend — every signed call would 401 "unauthorized"');
});

test('T-302b keying on the hex STRING is what the incident was, and no longer matches', async () => {
  const wrongKey = await crypto.subtle.importKey('raw', enc.encode(CLIENT_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const wrong = hex(await crypto.subtle.sign('HMAC', wrongKey, enc.encode('x')));
  assert.notEqual(wrong, await serverHmac(CLIENT_KEY, 'x'), 'the two derivations really are different keys');
});
