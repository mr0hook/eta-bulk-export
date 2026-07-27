// runlog: coalescing, ring bounds, persistence round-trip, rendering. Pure module — injected clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunLog } from '../src/core/runlog.js';

// fixed fake clock: 2025-06-01 10:20:30 local, advancing 1s per call when told to
const T0 = new Date(2025, 5, 1, 10, 20, 30).getTime();
const clock = () => { let t = T0; return { now: () => t, tick: (ms = 1000) => { t += ms; } }; };

test('push + text: timestamped HH:MM:SS lines in order', () => {
  const c = clock();
  const log = createRunLog({ now: c.now });
  log.push('first'); c.tick(); log.push('second', { level: 'run' });
  assert.deepEqual(log.lines(), ['10:20:30 first', '10:20:31 second']);
  assert.equal(log.text(), '10:20:30 first\n10:20:31 second');
  assert.equal(log.entries()[1].level, 'run');
});

test('coalescing: consecutive same-kind lines replace in place; identical msg counts ×N', () => {
  const c = clock();
  const log = createRunLog({ now: c.now });
  log.push('⏳ Rate-limited — waiting 5s…', { level: 'wait', kind: 'rate' });
  c.tick(); log.push('⏳ Rate-limited — waiting 5s…', { level: 'wait', kind: 'rate' });   // identical → ×2
  c.tick(); log.push('⏳ Rate-limited — waiting 10s…', { level: 'wait', kind: 'rate' });  // same kind, new msg → replace, n resets
  assert.equal(log.entries().length, 1, 'one live line for the whole 429 burst');
  assert.equal(log.entries()[0].msg, '⏳ Rate-limited — waiting 10s…');
  assert.equal(log.entries()[0].n, 1);
  log.push('▶ details…');                                                                // no kind → appends
  log.push('⏳ Rate-limited — waiting 5s…', { level: 'wait', kind: 'rate' });             // kind interrupted → new entry
  assert.equal(log.entries().length, 3, 'a non-kind line breaks the coalescing run');
});

test('×N rendering for repeated identical coalesced lines', () => {
  const c = clock();
  const log = createRunLog({ now: c.now });
  for (let i = 0; i < 4; i++) log.push('same', { kind: 'page' });
  assert.match(log.lines()[0], / same ×4$/);
});

test('ring: entry-count cap drops oldest', () => {
  const log = createRunLog({ max: 3, now: () => T0 });
  for (let i = 1; i <= 5; i++) log.push('m' + i);
  assert.deepEqual(log.entries().map((e) => e.msg), ['m3', 'm4', 'm5']);
});

test('ring: byte cap drops oldest but never the last entry', () => {
  const log = createRunLog({ max: 100, maxBytes: 300, now: () => T0 });
  for (let i = 0; i < 10; i++) log.push('x'.repeat(80) + i);
  assert.ok(log.entries().length >= 1 && log.entries().length < 10, 'byte cap trimmed the head');
  assert.ok(log.entries().at(-1).msg.endsWith('9'), 'newest entry survives');
});

test('toJSON → restore round-trip preserves entries; garbage restores to empty', () => {
  const c = clock();
  const log = createRunLog({ now: c.now });
  log.push('a'); c.tick(); log.push('b', { level: 'err', kind: 'k' });
  const saved = JSON.stringify(log.toJSON());
  const back = createRunLog({ now: c.now });
  back.restore(saved);
  assert.deepEqual(back.lines(), log.lines());
  assert.equal(back.entries()[1].level, 'err');
  const junk = createRunLog({});
  junk.restore('{not json'); assert.equal(junk.entries().length, 0);
  junk.restore(JSON.stringify({ nope: 1 })); assert.equal(junk.entries().length, 0);
  junk.restore(JSON.stringify([{ msg: 'ok' }, { bad: true }, null])); assert.equal(junk.entries().length, 1, 'non-entries filtered, valid one kept');
});

test('clear empties the log', () => {
  const log = createRunLog({ now: () => T0 });
  log.push('x'); log.clear();
  assert.equal(log.text(), '');
});
