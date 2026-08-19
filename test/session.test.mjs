// SPEC-009 (F-09) — overnight session keep-warm. Every dependency is injected (timer, clock,
// token status, the two bridge calls), so the whole scheduler is exercised with no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSessionKeeper, WARM_EVERY_MS, RENEW_BELOW_MS, RENEW_MIN_GAP_MS } from '../src/core/session.js';

// A hand-cranked timer + clock: tick() advances both, so rate-limit windows are exact.
function harness({ status, warm, renew } = {}) {
  let now = 1_000_000, fn = null, iv = 0;
  const calls = { warm: 0, renew: 0 };
  const keeper = createSessionKeeper({
    status: status || (() => ({ ok: true, left: 60 * 60 * 1000 })),
    warm: warm || (async () => { calls.warm++; }),
    renew: renew || (async () => { calls.renew++; }),
    now: () => now,
    setTimer: (f, ms) => { fn = f; iv = ms; return 1; },
    clearTimer: () => { fn = null; },
  });
  return {
    keeper, calls,
    interval: () => iv,
    running: () => fn !== null,
    advance: (ms) => { now += ms; },
    async tick(ms = WARM_EVERY_MS) { now += ms; if (fn) await fn(); },
  };
}
const healthy = () => ({ ok: true, left: 60 * 60 * 1000 });

test('T-060 the keeper warms the session on every tick and stops dead on stop()', async () => {
  const h = harness();
  h.keeper.start();
  assert.equal(h.interval(), WARM_EVERY_MS, 'warms on the documented interval');
  await h.tick(); await h.tick(); await h.tick();
  assert.equal(h.calls.warm, 3, 'one warm per tick');
  h.keeper.stop();
  assert.equal(h.running(), false, 'timer cleared');
  assert.equal(h.calls.warm, 3, 'no work after stop');
});

test('T-061 a healthy token warms but does NOT open a renewal tab', async () => {
  const h = harness({ status: healthy });
  h.keeper.start(); await h.tick();
  assert.equal(h.calls.warm, 1, 'warmed');
  assert.equal(h.calls.renew, 0, 'no tab churn while the token is fine');
});

test('T-062 a token under the threshold triggers a renewal', async () => {
  const h = harness({ status: () => ({ ok: true, left: RENEW_BELOW_MS - 1000 }) });
  h.keeper.start(); await h.tick();
  assert.equal(h.calls.renew, 1, 'renewed before it lapses');
});

test('T-063 a missing token triggers a renewal', async () => {
  const h = harness({ status: () => ({ ok: false, left: 0 }) });
  h.keeper.start(); await h.tick();
  assert.equal(h.calls.renew, 1, 'renewed');
});

test('T-064 left:0 with ok:true is a valid token of unknown TTL — never treated as expiring', async () => {
  const h = harness({ status: () => ({ ok: true, left: 0 }) });
  h.keeper.start(); await h.tick();
  assert.equal(h.calls.renew, 0, 'unknown TTL must not cause a renewal storm');
  assert.equal(h.calls.warm, 1, 'still warmed');
});

test('T-065 renewals are rate limited to one per gap', async () => {
  const h = harness({ status: () => ({ ok: false, left: 0 }) });
  h.keeper.start();
  await h.tick(1000);            // renew #1
  await h.tick(1000);            // inside the gap → suppressed
  await h.tick(1000);            // still inside → suppressed
  assert.equal(h.calls.renew, 1, 'one renewal inside the gap');
  await h.tick(RENEW_MIN_GAP_MS + 1000);
  assert.equal(h.calls.renew, 2, 'a renewal is allowed once the gap has passed');
});

test('T-066 a failing warm or renew never escapes into the run', async () => {
  const h = harness({
    status: () => ({ ok: false, left: 0 }),
    warm: async () => { throw new Error('offline'); },
    renew: async () => { throw new Error('no tabs'); },
  });
  h.keeper.start();
  await assert.doesNotReject(() => h.tick(), 'the keeper is best-effort by contract');
});

test('T-067 renewNow() is callable directly (the AUTH recovery path) and shares the rate limit', async () => {
  const h = harness({ status: () => ({ ok: false, left: 0 }) });
  h.keeper.start();
  await h.keeper.renewNow();
  assert.equal(h.calls.renew, 1, 'AUTH path can force a renewal without waiting for a tick');
  await h.keeper.renewNow();
  assert.equal(h.calls.renew, 1, 'still rate limited');
  h.advance(RENEW_MIN_GAP_MS + 1);
  await h.keeper.renewNow();
  assert.equal(h.calls.renew, 2, 'allowed again after the gap');
});

test('T-068 start() twice does not stack timers', async () => {
  const h = harness();
  h.keeper.start(); h.keeper.start();
  await h.tick();
  assert.equal(h.calls.warm, 1, 'one tick = one warm, not two');
});

// SPEC-031 replaces the old T-071 (which pinned a 30-minute scheduled tab boot). That boot is the
// entity-flip vector, and it was only ever needed because the SERVICE-WORKER warm could not be
// trusted to carry a SameSite cookie. The warm is now first-party from the page, and a token that
// keeps advancing is positive proof the session is alive — so a healthy run opens no tabs at all.
test('T-071 a self-renewing token never opens a tab, however long the run lasts', async () => {
  // The portal mints a fresh 15-minute token on its own every tick, exactly as it does with a
  // portal tab open. Six hours of ticks must produce zero renewals — and every tick still warms.
  let left = 15 * 60 * 1000;
  const h = harness({ status: () => ({ ok: true, left }) });
  h.keeper.start();
  for (let i = 0; i < 36; i++) { left = 15 * 60 * 1000; await h.tick(); }   // 36 × 10 min = 6 h
  assert.equal(h.calls.renew, 0, 'a live, self-renewing session needs no tab boot — ever');
  assert.equal(h.calls.warm, 36, 'the cheap first-party warm still runs every tick');
});

test('T-267 self-renewal is REPORTED, and a token that stops advancing gets rescued', async () => {
  // Absolute expiry is what is watched: while it advances the portal is renewing for us; when it
  // stops advancing the token decays tick by tick until it crosses the threshold and we step in.
  let left = 15 * 60 * 1000, selfRenews = 0;
  const h = harness({ status: () => ({ ok: true, left }) });
  const keeper = createSessionKeeper({
    status: () => ({ ok: true, left }),
    warm: async () => {}, renew: async () => { h.calls.renew++; },
    onSelfRenew: () => selfRenews++,
    now: () => 1_000_000 + tickN * WARM_EVERY_MS,
    setTimer: () => 1, clearTimer: () => {},
  });
  let tickN = 0;
  const tick = async () => { tickN++; await keeper.tick(); };

  await tick();                       // first observation — nothing to compare against yet
  assert.equal(selfRenews, 0);
  left = 15 * 60 * 1000; await tick();   // portal renewed: expiry advanced by a full tick
  assert.equal(selfRenews, 1, 'the portal renewing on its own is observed and reported');
  assert.equal(h.calls.renew, 0, 'and costs no tab');

  // Now the portal stops renewing: the token decays 10 minutes per tick.
  left = 8 * 60 * 1000; await tick();
  assert.ok(h.calls.renew >= 1, 'once it is genuinely running down, the rescue renewal fires');
});

test('T-268 afterRenew always runs — even when the renewal itself throws (the fetch hold must release)', async () => {
  let after = 0;
  const keeper = createSessionKeeper({
    status: () => ({ ok: false, left: 0 }),
    warm: async () => {},
    renew: async () => { throw new Error('no tabs'); },
    afterRenew: async () => { after++; },
    now: () => 1_000_000, setTimer: () => 1, clearTimer: () => {},
  });
  const ok = await keeper.renewNow();
  assert.equal(ok, false, 'the failure is reported');
  assert.equal(after, 1, 'a half-finished boot can still have flipped the entity — and the hold must be freed');
});

test('T-269 the warm goes out first-party from the page, with the worker only as a fallback', async () => {
  // The SameSite argument in one assertion: if the page-context fetch is ever dropped, the warm
  // silently stops sliding the session and the tab boot (the flip vector) comes back by the door.
  const src = await readFile(new URL('../src/core/orchestrator.js', import.meta.url), 'utf8');
  const warmBlock = src.slice(src.indexOf('warm: async'), src.indexOf('onSelfRenew:'));
  assert.match(warmBlock, /fetch\(PORTAL_ORIGIN/, 'the page issues the warm itself');
  assert.ok(warmBlock.indexOf('fetch(PORTAL_ORIGIN') < warmBlock.indexOf('portal-warm'),
    'the first-party fetch is tried BEFORE the cross-site service-worker fallback');
  assert.match(src, /const PORTAL_ORIGIN = 'https:\/\/invoicing\.eta\.gov\.eg'/, 'origin is pinned, never read from location');
});

test('T-069 the run waits all night for a token, not 15 minutes', async () => {
  const src = await readFile(new URL('../src/core/orchestrator.js', import.meta.url), 'utf8');
  const polls = Number(src.match(/TOKEN_WAIT_MAX_POLLS\s*=\s*([\d_]+)/)?.[1].replace(/_/g, ''));
  const every = eval(src.match(/TOKEN_WAIT_POLL_MS\s*=\s*([^;]+);/)[1]);   // e.g. "15 * 1000"
  assert.ok(Number.isFinite(polls) && polls > 0, 'poll cap still declared');
  assert.ok(polls * every >= 8 * 60 * 60 * 1000,
    `a session that dies at 01:00 must still be recoverable at 08:00 (got ${(polls * every) / 3600000}h)`);
});

test('T-070 the service worker pins the portal origin for warm + renew', async () => {
  const src = await readFile(new URL('../src/bg.js', import.meta.url), 'utf8');
  assert.match(src, /PORTAL_ORIGIN\s*=\s*'https:\/\/invoicing\.eta\.gov\.eg'/, 'portal origin pinned as a constant');
  assert.match(src, /eta-portal-warm/, 'warm handler present');
  assert.match(src, /eta-portal-renew/, 'renew handler present');
  // the handlers must build their URL from the pinned constant, never from the message
  assert.ok(!/msg\.(url|href)/.test(src.split('eta-portal-warm')[1] || ''),
    'the portal handlers must never take a URL from the page');
});
