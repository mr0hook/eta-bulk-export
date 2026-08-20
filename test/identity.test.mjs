// SPEC-033 T-271..T-273 — the extension's identity must survive the PORTAL wiping its own
// localStorage. The 2026-08-20 incident: a portal re-login cleared page storage, the extension
// minted a NEW device id, the server answered "not registered", and the automatic re-registration
// was refused with "device limit reached" — the allowance was held by the id that had just been
// erased. These tests pin the mirror that makes that unreachable.
import test from 'node:test';
import assert from 'node:assert/strict';

// A page-localStorage stand-in the "portal" can wipe, plus a bridge stand-in backed by a store the
// page cannot touch (chrome.storage.local in the real thing).
const bag = new Map();
globalThis.localStorage = {
  getItem: (k) => (bag.has(k) ? bag.get(k) : null),
  setItem: (k, v) => bag.set(k, String(v)),
  removeItem: (k) => bag.delete(k),
  get length() { return bag.size; },
  key: (i) => [...bag.keys()][i] ?? null,
};
const extStore = {};           // survives a portal wipe
const sent = [];
globalThis.window = {
  location: { origin: 'https://invoicing.eta.gov.eg' },
  postMessage(msg) {
    if (!msg || msg.__eta !== 'req' || msg.kind !== 'id-store') return;
    sent.push(msg);
    const p = msg.payload || {};
    let result;
    if (p.op === 'set') {
      if (typeof p.deviceId === 'string' && p.deviceId) extStore.deviceId = p.deviceId;
      if (p.creds === null) delete extStore.creds;
      else if (p.creds && p.creds.clientKey) extStore.creds = p.creds;
      result = { ok: true };
    } else {
      result = { ok: true, deviceId: extStore.deviceId || null, creds: extStore.creds || null };
    }
    // the bridge answers asynchronously, exactly like the real postMessage round-trip
    setTimeout(() => globalThis.window.__onres && globalThis.window.__onres({ source: globalThis.window, data: { __eta: 'res', id: msg.id, result } }), 0);
  },
  addEventListener(type, fn) { if (type === 'message') globalThis.window.__onres = fn; },
};
globalThis.addEventListener = globalThis.window.addEventListener;

const { deviceId } = await import('../src/core/registration.js');

const wipePortalStorage = () => bag.clear();   // what a portal re-login does

test('T-271 a device id is minted once and mirrored outside the page', async () => {
  const first = await deviceId();
  assert.ok(first && first.length > 10, 'an id was minted');
  assert.equal(extStore.deviceId, first, 'and mirrored into extension-owned storage');
  assert.equal(await deviceId(), first, 'stable across calls');
});

test('T-272 THE INCIDENT: after the portal wipes localStorage the SAME id comes back', async () => {
  const before = await deviceId();
  wipePortalStorage();
  assert.equal(localStorage.getItem('etaBulk_reg_device_id'), null, 'the portal really did wipe it');
  const after = await deviceId();
  assert.equal(after, before,
    'a wipe must NOT mint a new device id — that is what spent another slot off the allowance and ended in "device limit reached"');
  assert.equal(localStorage.getItem('etaBulk_reg_device_id'), JSON.stringify(before), 'and the fast cache is restored');
});

test('T-273 with no mirror available it still degrades to the old behaviour', async () => {
  wipePortalStorage();
  delete extStore.deviceId;
  const id = await deviceId();
  assert.ok(id && id.length > 10, 'a fresh id is minted when nothing is known anywhere');
  assert.equal(extStore.deviceId, id, 'and is immediately mirrored so this cannot repeat');
});
