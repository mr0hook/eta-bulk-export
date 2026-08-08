// SPEC-011 / F-12 — run log persisted to the export folder.
// The case it exists for: the tab is killed mid-run. eta_progress_*.json survives; the narrative of
// what actually happened did not. Batching is deliberate — an FSA writable is only durable after
// close(), so this writes open/append/close per batch rather than holding a stream open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDir } from './fakefs.mjs';
import { createFolderLog, LOG_MAX_BYTES } from '../src/core/folderlog.js';

const KEY = '2026_Sent_Issue_2026-01-01_2026-12-31';
const NAME = `eta_runlog_${KEY}.log`;
const textOf = (dir, name = NAME) => (dir.files.has(name) ? new TextDecoder().decode(dir.files.get(name)) : null);
const linesOf = (dir, name = NAME) => (textOf(dir, name) || '').split('\n').filter(Boolean);

// injectable clock so time-based flushing is deterministic
function clock(start = 1_800_000_000_000) { let t = start; return { now: () => t, tick: (ms) => { t += ms; } }; }

test('T-091 flush writes the pending lines, in order, ISO-timestamped with level', async () => {
  const dir = fakeDir(); const c = clock();
  const log = createFolderLog(dir, KEY, { now: c.now });

  log.push('first', { level: 'info' });
  log.push('second', { level: 'wait' });
  log.push('third', { level: 'err' });
  await log.flush();

  const lines = linesOf(dir);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+info\s+first$/, lines[0]);
  assert.match(lines[1], /\bwait\b\s+second$/);
  assert.match(lines[2], /\berr\b\s+third$/);
});

test('T-092 pushing alone writes NOTHING — batching is real, not per-line', async () => {
  const dir = fakeDir(); const c = clock();
  const log = createFolderLog(dir, KEY, { now: c.now });

  for (let i = 0; i < 10; i++) log.push('line ' + i, { level: 'info' });

  assert.equal(textOf(dir), null, 'no file until a flush trigger — per-line writes would be O(n²)');
});

test('T-093 the buffer auto-flushes once it fills, without an explicit flush', async () => {
  const dir = fakeDir(); const c = clock();
  const log = createFolderLog(dir, KEY, { now: c.now, maxPending: 64 });

  for (let i = 0; i < 64; i++) log.push('line ' + i, { level: 'info' });
  await log.idle();

  assert.equal(linesOf(dir).length, 64, 'size trigger fired');
});

test('T-094 a quiet run still lands: the time trigger flushes on the next push', async () => {
  const dir = fakeDir(); const c = clock();
  const log = createFolderLog(dir, KEY, { now: c.now, flushMs: 2000 });

  log.push('early', { level: 'info' });
  assert.equal(textOf(dir), null, 'not yet');
  c.tick(2500);
  log.push('later', { level: 'info' });
  await log.idle();

  assert.equal(linesOf(dir).length, 2, 'both lines landed once the interval elapsed');
});

test('T-095 a coalescing storm costs ONE line carrying its count, not N lines', async () => {
  const dir = fakeDir(); const c = clock();
  const log = createFolderLog(dir, KEY, { now: c.now });

  for (let i = 0; i < 200; i++) log.push('Rate limited — waiting 30s', { level: 'wait', kind: 'rate' });
  await log.flush();

  const lines = linesOf(dir);
  assert.equal(lines.length, 1, `200 same-kind pushes -> 1 line, got ${lines.length}`);
  assert.match(lines[0], /×200$/, lines[0]);
});

test('T-096 a second flush APPENDS — it must never truncate what is already on disk', async () => {
  const dir = fakeDir(); const c = clock();
  const log = createFolderLog(dir, KEY, { now: c.now });

  log.push('one', { level: 'info' }); await log.flush();
  log.push('two', { level: 'info' }); await log.flush();

  assert.deepEqual(linesOf(dir).map((l) => l.split(/\s+/).pop()), ['one', 'two']);
});

test('T-097 a failed write never escapes, and its lines are re-sent on the next flush', async () => {
  const dir = fakeDir(); const c = clock();
  let fail = true;
  const realGet = dir.getFileHandle.bind(dir);
  dir.getFileHandle = async (n, o) => { if (fail && n === NAME) throw new Error('disk gone'); return realGet(n, o); };
  const log = createFolderLog(dir, KEY, { now: c.now });

  log.push('before the failure', { level: 'info' });
  await log.flush();                       // must not throw
  assert.equal(textOf(dir), null, 'nothing landed');

  fail = false;
  log.push('after recovery', { level: 'info' });
  await log.flush();

  const lines = linesOf(dir).map((l) => l.split(/\s{2,}/).pop());
  assert.deepEqual(lines, ['before the failure', 'after recovery'], 'the lost line was retained and re-sent');
});

test('T-098 the size cap stops the file growing and says so, without throwing', async () => {
  const dir = fakeDir(); const c = clock();
  const log = createFolderLog(dir, KEY, { now: c.now, maxBytes: 2000 });

  for (let i = 0; i < 400; i++) { log.push('a fairly long line of run output number ' + i, { level: 'info' }); }
  await log.flush();
  const atCap = textOf(dir).length;
  log.push('this must not be written', { level: 'info' });
  await log.flush();

  assert.ok(atCap <= 2000 + 200, `stays near the cap, got ${atCap}`);
  assert.match(textOf(dir), /truncated/i, 'says why it stopped');
  assert.equal(textOf(dir).includes('this must not be written'), false, 'nothing appended past the cap');
});

test('T-099 a new run rotates the previous log to .prev.log and starts clean', async () => {
  const dir = fakeDir(); const c = clock();
  const first = createFolderLog(dir, KEY, { now: c.now });
  first.push('run one', { level: 'info' }); await first.flush();

  const second = createFolderLog(dir, KEY, { now: c.now });
  await second.rotate();
  second.push('run two', { level: 'info' }); await second.flush();

  assert.match(textOf(dir, `eta_runlog_${KEY}.prev.log`), /run one/, 'previous run preserved one generation back');
  const now = textOf(dir);
  assert.match(now, /run two/);
  assert.equal(now.includes('run one'), false, 'the new run starts clean');
});

test('T-100 LOG_MAX_BYTES is small enough that appendText\'s whole-file copy stays cheap', () => {
  assert.ok(LOG_MAX_BYTES <= 8 * 1024 * 1024, 'a folder log must never approach the merge-scratch scale');
});

// ---------------------------------------------------------------- integration: a real run

test('T-101 a completed run leaves its narrative in the folder, with no explicit flush by the caller', async () => {
  const { runOnce } = await import('./runfixture.mjs');
  const { dir } = await runOnce();

  const log = [...dir.files.keys()].find((n) => /^eta_runlog_.*\.log$/.test(n));
  assert.ok(log, `a run log was written, saw ${JSON.stringify([...dir.files.keys()])}`);
  const text = new TextDecoder().decode(dir.files.get(log));
  assert.match(text, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+\w+\s+\S/m, 'ISO-timestamped, level-tagged lines');
  assert.ok(text.split('\n').filter(Boolean).length >= 2, 'more than a single line of narrative');
});

test('T-102 the TERMINAL line reaches disk — the case a crashed run is read for', async () => {
  const { runOnce } = await import('./runfixture.mjs');
  const { dir, status } = await runOnce();

  const terminal = status.filter((s) => s.meta?.terminal).pop();
  assert.ok(terminal, 'the run ended with a terminal line');
  const log = [...dir.files.keys()].find((n) => /^eta_runlog_.*\.log$/.test(n));
  const text = new TextDecoder().decode(dir.files.get(log));
  assert.ok(text.includes(terminal.m), `the terminal line "${terminal.m}" is on disk, not just in memory`);
});
