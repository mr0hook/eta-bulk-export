// Regression tests for the offline "grace" verdict rule. A network blip must NEVER upgrade a server
// denial (version kill / void / lock / kill) to allowed — that was a real kill-switch bypass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graceVerdict } from '../src/core/registration.js';

test('grace: no cached verdict → null (caller fails closed)', () => {
  assert.equal(graceVerdict(null, 'R1'), null);
  assert.equal(graceVerdict(undefined, 'R1'), null);
});

test('grace: a legit allowed verdict is honoured offline for the same RIN', () => {
  const cached = { registered: true, allowed: true, killed: false, locked: false, reason: '', boundRins: ['R1'], rin: 'R1' };
  const g = graceVerdict(cached, 'R1');
  assert.equal(g.allowed, true);
  assert.equal(g.stale, true);
});

test('grace: an allowed verdict is NOT reused for a different logged-in RIN', () => {
  const cached = { registered: true, allowed: true, boundRins: ['R1'], rin: 'R1' };
  assert.equal(graceVerdict(cached, 'R2').allowed, false);
});

test('grace: version kill (update_required) stays blocked offline', () => {
  const cached = { registered: true, allowed: false, killed: false, locked: false, reason: 'update_required', boundRins: ['R1'], rin: 'R1' };
  assert.equal(graceVerdict(cached, 'R1').allowed, false);
});

test('grace: voided RIN stays blocked offline even though it is still in boundRins', () => {
  const cached = { registered: true, allowed: false, killed: false, locked: false, reason: 'rin_voided', boundRins: ['R1'], rin: 'R1' };
  const g = graceVerdict(cached, 'R1');
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'rin_voided');   // reason carried through for the right message
});

test('grace: kill and lock denials stay blocked offline', () => {
  assert.equal(graceVerdict({ allowed: false, killed: true, boundRins: ['R1'], rin: 'R1' }, 'R1').allowed, false);
  assert.equal(graceVerdict({ allowed: false, locked: true, boundRins: ['R1'], rin: 'R1' }, 'R1').allowed, false);
});
