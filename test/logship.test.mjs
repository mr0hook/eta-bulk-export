// SPEC-018 Part B / T-171, T-172, T-174 — the run log shipped to the portal.
//
// The shipper is pure apart from an injected clock and an injected `send`, so batching by interval
// is deterministic and the failure policy can be provoked rather than hoped for. Everything here is
// about the three promises the contract makes: batch (never one request per progress tick),
// coalesce (a 3-hour 429 storm is one line), and never break the run (a dead backend costs nothing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogShip, SHIP_FLUSH_MS, SHIP_MAX_LINES } from '../src/core/logship.js';

function clock(start = 1_800_000_000_000) { let t = start; return { now: () => t, tick: (ms) => { t += ms; } }; }

// Records every batch handed to it; `fail` makes the next send behave badly.
function recorder(mode = 'ok') {
  const calls = [];
  const send = async (body) => {
    calls.push(body);
    if (mode === 'throw') throw new Error('bridge exploded');
    if (mode === 'reject') return Promise.reject(new Error('network'));
    if (mode === 'notok') return { ok: false, error: 'http 500' };
    return { ok: true };
  };
  return { send, calls, batches: () => calls.map((c) => c.lines) };
}

const ship = (r, c, over = {}) => createLogShip({ send: r.send, now: c.now, ...over });

// ── T-171 · batching ──────────────────────────────────────────────────────────────────────────────

test('T-171 nothing ships before a jobId exists — the early lines are held, not lost', async () => {
  const r = recorder(), c = clock();
  const s = ship(r, c);
  for (let i = 0; i < 80; i++) s.push('probing ' + i, { level: 'run' });
  await s.idle();
  assert.equal(r.calls.length, 0, 'no jobId → no request');
  assert.ok(s.stats().pending > 0, 'the lines are still buffered');

  s.setJob('job-1');
  await s.idle();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].jobId, 'job-1');
  assert.equal(r.calls[0].lines.at(-1).text, 'probing 79');
});

test('T-171 batches by COUNT: 50 lines go out as one request, not fifty', async () => {
  const r = recorder(), c = clock();
  const s = ship(r, c); s.setJob('job-1');

  for (let i = 0; i < SHIP_MAX_LINES - 1; i++) s.push('line ' + i, { level: 'run' });
  await s.idle();
  assert.equal(r.calls.length, 0, '49 lines is still under the threshold');

  s.push('line 49', { level: 'run' });
  await s.idle();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].lines.length, SHIP_MAX_LINES);
  assert.equal(s.stats().pending, 0);
});

test('T-171 batches by INTERVAL: a slow trickle still flushes every 15 s', async () => {
  const r = recorder(), c = clock();
  const s = ship(r, c); s.setJob('job-1');

  s.push('first', { level: 'run' });
  c.tick(SHIP_FLUSH_MS - 1);
  s.push('second', { level: 'run' });
  await s.idle();
  assert.equal(r.calls.length, 0, 'under the interval, still buffered');

  c.tick(2);
  s.push('third', { level: 'run' });
  await s.idle();
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].lines.map((l) => l.text), ['first', 'second', 'third']);

  // And the clock restarts from the flush, so the next line does not immediately flush again.
  s.push('fourth', { level: 'run' });
  await s.idle();
  assert.equal(r.calls.length, 1);
});

test('T-171 a terminal line flushes immediately, whatever the count or the clock', async () => {
  const r = recorder(), c = clock();
  const s = ship(r, c); s.setJob('job-1');

  s.push('chunk 1/412 fetching', { level: 'run' });
  s.push('paused at chunk 2/412', { level: 'wait', terminal: true });
  await s.idle();

  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].lines.map((l) => l.text), ['chunk 1/412 fetching', 'paused at chunk 2/412']);
  assert.equal(r.calls[0].lines[1].level, 'wait');
});

test('T-171 the shipped shape is { at, level, kind, text } and nothing else', async () => {
  const r = recorder(), c = clock();
  const s = ship(r, c); s.setJob('job-1');
  s.push('done — 412/412 chunks', { level: 'ok', terminal: true, kind: 'done' });
  await s.idle();

  const line = r.calls[0].lines[0];
  assert.deepEqual(Object.keys(line).sort(), ['at', 'kind', 'level', 'text']);
  assert.equal(line.text, 'done — 412/412 chunks');
  assert.equal(line.kind, 'done');
  assert.equal(line.at, new Date(c.now()).toISOString());
});

test('T-171 an over-long line is clipped — a status line is a sentence, never a payload', async () => {
  const r = recorder(), c = clock();
  const s = ship(r, c); s.setJob('job-1');
  s.push('x'.repeat(5000), { level: 'err', terminal: true });
  await s.idle();
  assert.equal(r.calls[0].lines[0].text.length, 300);
});

// ── T-172 · coalescing ────────────────────────────────────────────────────────────────────────────

test('T-172 high-frequency kinds coalesce to the newest of each per flush', async () => {
  const r = recorder(), c = clock();
  const s = ship(r, c); s.setJob('job-1');

  // A realistic interleave: page ticks with rate waits cutting across them, plus a probe.
  for (let i = 1; i <= 20; i++) {
    s.push(`chunk 3/412 fetching ${i * 50}/1000`, { level: 'run', kind: 'page' });
    if (i % 4 === 0) s.push(`rate limited — waiting ${i}s`, { level: 'wait', kind: 'rate' });
  }
  s.push('probing invoices 1/3', { level: 'run', kind: 'probe' });
  s.push('probing invoices 3/3', { level: 'run', kind: 'probe' });
  s.flush();
  await s.idle();

  const lines = r.calls[0].lines;
  assert.equal(lines.length, 3, '25 pushes → one line per kind');
  // The order is the order of each kind's NEWEST line: the last page tick (i=20) precedes the rate
  // wait that follows it, and the probes come last.
  assert.deepEqual(lines.map((l) => l.kind), ['page', 'rate', 'probe']);
  assert.equal(lines.find((l) => l.kind === 'page').text, 'chunk 3/412 fetching 1000/1000');
  assert.equal(lines.find((l) => l.kind === 'rate').text, 'rate limited — waiting 20s');
  assert.equal(lines.find((l) => l.kind === 'probe').text, 'probing invoices 3/3');
});

test('T-172 coalescing is PER FLUSH — a later batch carries its own newest line', async () => {
  const r = recorder(), c = clock();
  const s = ship(r, c); s.setJob('job-1');

  s.push('chunk 1/412 fetching 100/1000', { level: 'run', kind: 'page' });
  s.flush(); await s.idle();
  s.push('chunk 2/412 fetching 500/1000', { level: 'run', kind: 'page' });
  s.flush(); await s.idle();

  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].lines[0].text, 'chunk 1/412 fetching 100/1000');
  assert.equal(r.calls[1].lines[0].text, 'chunk 2/412 fetching 500/1000');
});

test('T-172 lines WITHOUT a kind never coalesce, and keep their order around the ones that do', async () => {
  const r = recorder(), c = clock();
  const s = ship(r, c); s.setJob('job-1');

  s.push('chunk 1/412 · 412 documents', { level: 'run' });
  s.push('chunk 1/412 fetching 100/1000', { level: 'run', kind: 'page' });
  s.push('2 documents dropped in chunk 1', { level: 'warn' });
  s.push('chunk 1/412 fetching 900/1000', { level: 'run', kind: 'page' });
  s.push('writing chunk 1/412', { level: 'run' });
  s.flush(); await s.idle();

  assert.deepEqual(r.calls[0].lines.map((l) => l.text), [
    'chunk 1/412 · 412 documents',
    '2 documents dropped in chunk 1',
    'chunk 1/412 fetching 900/1000',   // the survivor keeps the NEWEST occurrence's slot
    'writing chunk 1/412',
  ]);
});

test('T-172 a burst of one kind never grows the buffer — coalescing happens on the way in too', async () => {
  const r = recorder(), c = clock();
  const s = ship(r, c); s.setJob('job-1');
  for (let i = 0; i < 5000; i++) s.push('rate limited — waiting 30s', { level: 'wait', kind: 'rate' });
  await s.idle();
  assert.equal(r.calls.length, 0, '5000 identical waits never reach the 50-line threshold');
  assert.equal(s.stats().pending, 1);
});

// ── T-174 · the failure policy ────────────────────────────────────────────────────────────────────

test('T-174 a send that THROWS drops that batch and the shipper carries on', async () => {
  const r = recorder('throw'), c = clock();
  const s = ship(r, c); s.setJob('job-1');

  s.push('boom', { level: 'run', terminal: true });
  await s.idle();
  assert.equal(r.calls.length, 1);
  assert.equal(s.stats().dropped, 1);
  assert.equal(s.stats().pending, 0, 'a failed batch is DROPPED, never re-queued');

  s.push('still running', { level: 'run', terminal: true });
  await s.idle();
  assert.equal(r.calls.length, 2, 'the next batch is still attempted');
  assert.equal(r.calls[1].lines[0].text, 'still running');
});

test('T-174 a rejected promise and an { ok:false } answer are both just dropped', async () => {
  for (const mode of ['reject', 'notok']) {
    const r = recorder(mode), c = clock();
    const s = ship(r, c); s.setJob('job-1');
    s.push('line', { level: 'run', terminal: true });
    await s.idle();
    assert.equal(s.stats().dropped, 1, mode);
    assert.equal(s.stats().sent, 0, mode);
  }
});

test('T-174 push() never throws, whatever it is handed or whatever send does', async () => {
  const c = clock();
  const s = createLogShip({ send: () => { throw new Error('sync throw'); }, now: c.now });
  s.setJob('job-1');
  // Garbage in: no meta, a null message, a frozen meta, an object that stringifies badly.
  assert.doesNotThrow(() => s.push('plain'));
  assert.doesNotThrow(() => s.push(null, { level: 'err' }));
  assert.doesNotThrow(() => s.push(undefined));
  assert.doesNotThrow(() => s.push({ toString() { throw new Error('evil'); } }, { terminal: true }));
  assert.doesNotThrow(() => s.push('x', Object.freeze({ level: 'run', kind: 'page', terminal: true })));
  assert.doesNotThrow(() => s.flush());
  await s.idle();

  // A shipper with no send at all is also inert rather than fatal.
  const bare = createLogShip({ now: c.now });
  bare.setJob('job-2');
  assert.doesNotThrow(() => bare.push('line', { terminal: true }));
  await bare.idle();
});

test('T-174 push() does not BLOCK — the run keeps emitting while a send hangs', async () => {
  let release; const gate = new Promise((res) => { release = res; });
  const seen = [];
  const s = createLogShip({ send: async (b) => { seen.push(b); await gate; return { ok: true }; } });
  s.setJob('job-1');

  s.push('first', { level: 'run', terminal: true });
  await Promise.resolve();                       // let the flush reach the send
  assert.equal(seen.length, 1, 'the send is in flight and will not resolve until we say so');

  const t0 = Date.now();
  for (let i = 0; i < 200; i++) s.push('line ' + i, { level: 'run' });
  assert.ok(Date.now() - t0 < 200, 'pushing during a hung send costs the run nothing');
  assert.equal(seen.length, 1, 'flushes serialise behind the in-flight one, never fire in parallel');

  release();
  await s.idle();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].lines.at(-1).text, 'line 199');
});

test('T-174 an unreachable backend cannot grow the buffer without bound', async () => {
  const r = recorder('notok'), c = clock();
  const s = ship(r, c);   // no jobId at all → nothing can ever flush
  for (let i = 0; i < 5000; i++) s.push('line ' + i, { level: 'run' });
  await s.idle();
  assert.equal(s.stats().pending, 200, 'bounded to the server-side cap, oldest dropped');

  s.setJob('job-1');
  await s.idle();
  assert.equal(r.calls[0].lines.length, 200);
  assert.equal(r.calls[0].lines.at(-1).text, 'line 4999', 'the NEWEST lines are the ones kept');
});

test('reset() stops a run without a jobId from shipping into the previous job\'s log', async () => {
  const r = recorder(), c = clock();
  const s = ship(r, c); s.setJob('job-1');
  s.push('old run', { level: 'run', terminal: true });
  await s.idle();
  assert.equal(r.calls.length, 1);

  s.reset();
  s.push('a run whose plan has no jobId', { level: 'run', terminal: true });
  await s.idle();
  assert.equal(r.calls.length, 1, 'nothing shipped');
  assert.equal(s.stats().jobId, null);
});
