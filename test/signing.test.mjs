// SPEC-038 T-283/T-284 (2026-08-20 review, L-2) — the HMAC client key must never reach the page.
//
// Before this, the identity mirror handed `creds` back into the MAIN world, so any script on the
// portal page could read the device's authenticator out of it and impersonate the device to the
// backend indefinitely. Signing now happens in the service worker; the page sends a path and a
// body and receives only headers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const bg = await readFile(new URL('../src/bg.js', import.meta.url), 'utf8');
const reg = await readFile(new URL('../src/core/registration.js', import.meta.url), 'utf8');
const bridge = await readFile(new URL('../bridge.js', import.meta.url), 'utf8');

test('T-283 the service worker never hands the key back, and can sign on request', () => {
  const getReply = bg.slice(bg.indexOf("sendResponse({ ok: true, deviceId"), bg.indexOf("sendResponse({ ok: true, deviceId") + 200);
  assert.ok(!/creds:/.test(getReply), 'the get reply must not carry creds — that was the leak');
  assert.match(getReply, /hasCreds/, 'the page is told whether a key exists, not what it is');
  assert.match(bg, /op === 'sign'/, 'the worker exposes signing');
  const signBlock = bg.slice(bg.indexOf("op === 'sign'"), bg.indexOf("if (msg.op === 'set')"));
  assert.match(signBlock, /crypto\.subtle\.sign\('HMAC'/, 'it signs with the stored key');
  assert.ok(!/sendResponse\([^)]*clientKey/.test(signBlock), 'and returns headers only, never the key');
});

test('T-284 the page prefers worker signing and keeps a local fallback', () => {
  const fn = reg.slice(reg.indexOf('async function signedPost'), reg.indexOf('async function signedPost') + 1200);
  assert.match(fn, /op: 'sign'/, 'the worker is asked first');
  assert.ok(fn.indexOf("op: 'sign'") < fn.indexOf('hmacHex'), 'the local HMAC is only the fallback');
  assert.match(fn, /hmacHex/, 'a fallback still exists for installs whose mirror predates this version');
  // and the mirror reader must not pull creds back into the page
  const idGet = reg.slice(reg.indexOf('async get()'), reg.indexOf('async get()') + 400);
  assert.ok(!/r\.creds/.test(idGet), 'the page must not read creds out of the mirror');
  assert.match(bridge, /path: p\.path, body: p\.body/, 'the bridge relays what signing needs');
});
