// Sealed planner cursor.
//
// The planner's traversal state has to survive between HTTP requests without the Worker storing
// anything per step: a 400-probe plan would otherwise mean 400 writes, and KV's free tier allows
// 1,000 a day across the whole service. So the state travels with the client — encrypted, so the
// client can neither read the algorithm's shape out of it nor forge a state that makes the server
// mint chunks it did not decide.
//
// AES-GCM with the jobId as additional authenticated data: a cursor sealed for one job cannot be
// replayed against another, even by someone holding both.
import { randHex } from './lib/util.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};
const hexBytes = (hex) => Uint8Array.from(String(hex).match(/.{2}/g).map((h) => parseInt(h, 16)));

// The key lives in KV rather than as a secret, so standing up a new environment needs no extra
// manual step. It protects cursors from the CLIENT, not from the operator — anyone with KV access
// already has every device's clientKey. Rotating it (delete the record) invalidates plans that are
// mid-flight; the client simply starts planning again.
let _cached = null;
export async function cursorKey(env) {
  if (_cached) return _cached;
  let hex = await env.LEADS.get('cursorkey');
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) { hex = randHex(32); await env.LEADS.put('cursorkey', hex); }
  _cached = await crypto.subtle.importKey('raw', hexBytes(hex), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return _cached;
}

/** Seal planner state for a job. Returns a compact base64url token. */
export async function seal(key, jobId, state) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(String(jobId)) },
    key, enc.encode(JSON.stringify(state)),
  );
  const body = new Uint8Array(ct);
  const out = new Uint8Array(iv.length + body.length);
  out.set(iv, 0); out.set(body, iv.length);
  return b64url(out);
}

/**
 * Open a cursor. Returns null on ANY failure — wrong job, tampered bytes, wrong key, malformed
 * token. Callers treat null as "start over", never as "empty state": a forged cursor accepted as
 * empty would let a client skip planning entirely and declare a plan of its own choosing.
 */
export async function unseal(key, jobId, token) {
  try {
    const raw = unb64url(token);
    if (raw.length < 13) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(String(jobId)) },
      key, raw.slice(12),
    );
    const obj = JSON.parse(dec.decode(pt));
    return (obj && typeof obj === 'object') ? obj : null;
  } catch { return null; }
}
