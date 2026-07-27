import test from 'node:test';
import assert from 'node:assert/strict';

// Stub localStorage BEFORE importing the module (token.js reads it at call time, but the
// import must not blow up either).
const bag = new Map();
globalThis.localStorage = {
  getItem: (k) => (bag.has(k) ? bag.get(k) : null),
  setItem: (k, v) => bag.set(k, String(v)),
  removeItem: (k) => bag.delete(k),
};

const { getToken, tokenStatus } = await import('../src/core/token.js');

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (payload) => `h.${b64url(payload)}.s`;
const setUser = (o) => bag.set('USER_DATA', JSON.stringify(o));
const nowSec = () => Math.floor(Date.now() / 1000);

test('getToken: missing / non-JSON / present', () => {
  bag.clear();
  assert.equal(getToken(), null, 'no USER_DATA → null');
  bag.set('USER_DATA', 'not json');
  assert.equal(getToken(), null, 'non-JSON USER_DATA → null (caught)');
  setUser({ access_token: 'abc' });
  assert.equal(getToken(), 'abc');
});

test('tokenStatus: not found → ok:false, guidance label', () => {
  bag.clear();
  const s = tokenStatus();
  assert.equal(s.ok, false);
  assert.match(s.label, /not found/i);
});

test('tokenStatus: expired token → ok:false, left 0', () => {
  setUser({ access_token: jwt({ exp: nowSec() - 60 }) });
  const s = tokenStatus();
  assert.equal(s.ok, false);
  assert.equal(s.left, 0);
  assert.match(s.label, /expired/i);
});

test('tokenStatus: valid future token exposes left + minutes label (drives proactive pause)', () => {
  setUser({ access_token: jwt({ exp: nowSec() + 30 * 60 }) });
  const s = tokenStatus();
  assert.equal(s.ok, true);
  assert.ok(s.left > 25 * 60000 && s.left <= 30 * 60000, `left ~30m, got ${s.left}`);
  assert.match(s.label, /^Token: (2[5-9]|30)m$/);
});

test('tokenStatus: present but unparseable exp → ok:true, left 0 (must NOT trigger a false proactive pause)', () => {
  setUser({ access_token: 'not-a-jwt' });
  const s = tokenStatus();
  assert.equal(s.ok, true);
  assert.equal(s.left, 0, 'left must be 0 so the orchestrator guard (left>0) skips it');
});

test('tokenStatus: valid JWT with no exp claim → ok:true, left 0 (present, unknown TTL — not "expired")', () => {
  setUser({ access_token: jwt({ sub: 'user-1' }) }); // parseable payload, no exp
  const s = tokenStatus();
  assert.equal(s.ok, true, 'a token without exp is present, not expired');
  assert.equal(s.left, 0);
});
