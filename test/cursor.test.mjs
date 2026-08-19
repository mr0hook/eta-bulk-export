// SPEC-016 T-143, T-144, T-146, T-147 — the sealed planner cursor.
//
// The cursor is what lets the Worker stay stateless through a 400-probe plan. It is also the only
// thing standing between a patched client and simply declaring its own plan, so every failure mode
// here must land on "reject", never on "treat as empty".
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { seal, unseal } from '../lead-worker/src/cursor.js';
import { startPlan, advance } from '../lead-worker/src/planner.js';

// cursor.js reaches for the global crypto/btoa/atob, Workers style. Node 24 provides all three, and
// globalThis.crypto is a getter-only property there — assigning to it throws, so don't.
const makeKey = () => webcrypto.subtle.importKey('raw', webcrypto.getRandomValues(new Uint8Array(32)), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

test('T-143 a cursor round-trips, and tampered bytes are rejected rather than accepted', async () => {
  const key = await makeKey();
  const state = { stack: [{ t: 'split', fromISO: 'a', toISO: 'b', depth: 3 }], out: [], probes: 7, step: 12 };

  const token = await seal(key, 'job-1', state);
  assert.deepEqual(await unseal(key, 'job-1', token), state, 'round-trip must be lossless');

  // Flip a byte in the ciphertext body (past the 12-byte IV, in base64url space).
  const bad = token.slice(0, -4) + (token.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assert.equal(await unseal(key, 'job-1', bad), null, 'tampered cursor must be null, not partial state');

  assert.equal(await unseal(key, 'job-1', 'not-a-cursor'), null, 'garbage must be null');
  assert.equal(await unseal(key, 'job-1', ''), null, 'empty must be null');
  assert.equal(await unseal(key, 'job-1', 'AAAA'), null, 'too-short must be null');
});

test('T-144 a cursor sealed for one job is refused for another', async () => {
  // jobId is the AES-GCM additional authenticated data. Without this, a client could take the
  // cursor from a job it is entitled to and drive a job it is not.
  const key = await makeKey();
  const token = await seal(key, 'job-A', { step: 1, stack: [], out: [] });
  assert.ok(await unseal(key, 'job-A', token), 'own job opens it');
  assert.equal(await unseal(key, 'job-B', token), null, 'another job must not');
});

test('T-143b a cursor sealed under one key is refused under another', async () => {
  const a = await makeKey(), b = await makeKey();
  const token = await seal(a, 'job-1', { step: 1, stack: [], out: [] });
  assert.equal(await unseal(b, 'job-1', token), null);
});

test('T-146 the step number survives sealing, so a stale step is detectable', async () => {
  const key = await makeKey();
  const st = startPlan({ cap: 100, granular: false, subSplit: false, field: 'Issue', from: '2025-01-01', to: '2025-12-31' });
  advance(st);                       // issues step 1
  const t1 = await seal(key, 'j', st);
  advance(st, { count: 5 });         // resolves it; plan completes (under cap)
  const t2 = await seal(key, 'j', st);

  const s1 = await unseal(key, 'j', t1);
  const s2 = await unseal(key, 'j', t2);
  assert.equal(s1.step, 1);
  assert.ok(s2.step >= s1.step, 'step is monotonic across seals');
  assert.notEqual(t1, t2, 'a fresh IV each time — identical states must not seal identically');
});

test('T-148 sealing survives the state a big live plan actually reaches (regression: 2026-08-18 stress test)', async () => {
  // The shipped /plan/step route seals the FULL machine state — accepted chunks ride in st.out
  // (unlike the stripped copy T-147 seals). A ~2M-invoice range crossed ~1,000 probes, st.out held
  // hundreds of chunks, and b64url's `String.fromCharCode(...bytes)` spread every ciphertext byte
  // onto the call stack → RangeError('Maximum call stack size exceeded') → an opaque 'server error'
  // at the client. Sealing must be O(1) stack whatever the state size.
  const key = await makeKey();
  const chunk = (i) => ({
    id: `2025-01-01T00:00:00.000Z_2025-01-01T23:59:59.999Z_${i}`,
    fromISO: '2025-01-01T00:00:00.000Z', toISO: '2025-01-01T23:59:59.999Z',
    subF: null, subT: null, label: `1 Jan 2025 · part ${i}`, count: 4000 + i, warn: null,
  });
  const st = {
    cap: 10000, granular: true, subSplit: true, field: 'Issue',
    stack: Array.from({ length: 40 }, (_, d) => ({ t: 'split', fromISO: 'x', toISO: 'y', depth: d })),
    out: Array.from({ length: 4096 }, (_, i) => chunk(i)),   // CHUNK_STATES_MAX — the biggest plan the backend accepts
    pending: null, probes: 9000, step: 9000,
  };
  const token = await seal(key, 'job-big', st);
  assert.ok(token.length > 100000, `a state this size must produce a big token, got ${token.length}`);
  assert.deepEqual(await unseal(key, 'job-big', token), st, 'round-trip must be lossless at any size');
});

test('T-147 the cursor stays small on a plan that accepts hundreds of chunks', async () => {
  // The stack holds at most one pending frame per level (depth capped at 80) and accepted chunks do
  // NOT ride along — they are written to D1 as they are decided. So cursor size must be a function
  // of DEPTH, not of plan size. If this regresses, every probe starts carrying the whole plan.
  const key = await makeKey();
  // One day bisected to ~5-minute leaves: ~500 accepted chunks, which is a realistic big plan and
  // finishes in ~1000 steps. (A year to 1-minute leaves is half a million chunks — the earlier
  // version of this test never terminated inside its own step budget.)
  const st = startPlan({ cap: 50, granular: true, subSplit: false, field: 'DateTimeReceived', from: '2025-03-15', to: '2025-03-15' });

  let r = advance(st), worst = 0, steps = 0;
  while (!r.done && steps < 4000) {
    // Force deep bisection: always report over cap until the range is narrow.
    const i = r.instruction;
    const span = Date.parse(i.toISO || i.subT) - Date.parse(i.fromISO || i.subF);
    const out = { ...st, out: [] };                       // mirror the real route: chunks go to D1
    worst = Math.max(worst, (await seal(key, 'j', out)).length);
    // 40 per leaf, NOT 10: with SPEC-024 coalescing, 10-count neighbours merge four-to-one and the
    // plan shrinks below the size this test needs. 40+40 exceeds the merge target (45), so every
    // leaf stays its own chunk and the "hundreds of chunks" claim keeps meaning.
    r = advance(st, { count: span > 300000 ? 999999 : 40 });
    steps++;
  }
  assert.ok(r.done, 'the plan finished');
  assert.ok(st.out.length > 200, `expected a big plan to make the size claim meaningful, got ${st.out.length}`);
  assert.ok(worst < 8192, `sealed cursor peaked at ${worst} bytes, expected under 8KB`);
});
