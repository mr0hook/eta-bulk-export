// SPEC-016 T-137..T-142 — the server-conducted planner must decide EXACTLY what the in-browser
// planner decides.
//
// lead-worker/src/planner.js rewrites chunker.js's recursion as a resumable stack machine, because a
// Worker cannot hold a call stack across HTTP requests. That rewrite is the whole risk of S2: if the
// two implementations ever diverge on a real corpus, the server cuts chunk boundaries where the
// browser would not, and the failure mode is a SILENT GAP — invoices missing from a compliance
// export, with no error anywhere.
//
// So these tests do not check the machine against expectations. They drive both implementations from
// the identical probe corpus and demand identical output: same ids, order, ranges, counts, labels
// and warnings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChunks } from '../src/core/chunker.js';
import { runPlan, startPlan, advance } from '../lead-worker/src/planner.js';
import * as cairo from '../lead-worker/src/cairo.js';
import { dayStartISO, dayEndISO, chunkLabel } from '../src/core/time.js';

// The same synthetic "server" the chunker suite uses.
function makeProbe(docs) {
  return async (fromISO, toISO, subF, subT) => {
    const lo = Date.parse(subF || fromISO), hi = Date.parse(subT || toISO);
    return docs.reduce((n, t) => n + (t >= lo && t <= hi ? 1 : 0), 0);
  };
}
const cfg = (SRC, field, from, to) => ({
  cap: SRC.cap, granular: SRC.granular.includes(field), subSplit: !!SRC.subSplit, field, from, to,
});

// ── the zone the server does its arithmetic in ──────────────────────────────────────────────────
test('T-137a cairo.js matches the browser helpers (suite runs TZ=Africa/Cairo)', () => {
  // src/core/time.js uses LOCAL time — correct in the browser, wrong in a UTC Worker. cairo.js names
  // the zone explicitly. With the suite pinned to Africa/Cairo the two must agree exactly; if they
  // ever don't, every server-side day boundary is off by Cairo's offset.
  const days = ['2025-01-01', '2025-06-15', '2025-12-31', '2024-10-25', '2024-10-26', '2024-10-27',
                '2024-04-25', '2024-04-26', '2024-04-27', '2026-02-28', '2024-02-29'];
  for (const d of days) {
    assert.equal(cairo.dayStartISO(d), dayStartISO(d), 'dayStart ' + d);
    assert.equal(cairo.dayEndISO(d), dayEndISO(d), 'dayEnd ' + d);
  }
  for (const d of days) {
    const a = dayStartISO(d), b = dayEndISO(d);
    assert.equal(cairo.chunkLabel(a, b), chunkLabel(a, b), 'label ' + d);
    assert.equal(cairo.ymdOf(a), d, 'ymdOf ' + d);
  }
  // A DST transition must still be one calendar day wide.
  assert.equal(cairo.daysBetween(dayStartISO('2024-10-25'), dayEndISO('2024-10-27')), 2);
  assert.equal(cairo.addDays('2024-02-28', 1), '2024-02-29', 'leap year');
  assert.equal(cairo.addDays('2025-12-31', 1), '2026-01-01', 'year rollover');
});

async function assertIdentical(label, SRC, field, from, to, docs, deps = {}) {
  const probe = makeProbe(docs);
  const mine = await buildChunks(SRC, from, to, field, { probe, ...deps });
  const theirs = await runPlan(cfg(SRC, field, from, to), { probe, detectMaxSub: deps.detectMaxSub || (async () => null) });
  assert.equal(theirs.length, mine.length, `${label}: chunk COUNT differs (${mine.length} browser vs ${theirs.length} server)`);
  for (let i = 0; i < mine.length; i++) {
    assert.deepEqual(theirs[i], mine[i], `${label}: chunk ${i} differs\n  browser ${JSON.stringify(mine[i])}\n  server  ${JSON.stringify(theirs[i])}`);
  }
  return mine;
}

test('T-138 equivalence: granular time-bisection over a dense cluster', async () => {
  const SRC = { cap: 100, granular: ['DateTimeReceived'], subSplit: false };
  const YEAR = Date.parse('2025-01-01T00:00:00Z');
  const docs = [];
  for (let i = 0; i < 500; i++) docs.push(YEAR + Math.floor(i * (365 * 86400000 / 500)));
  const cluster = Date.parse('2025-06-15T10:00:00Z');
  for (let i = 0; i < 500; i++) docs.push(cluster + i * 7200);
  const chunks = await assertIdentical('granular', SRC, 'DateTimeReceived', '2025-01-01', '2025-12-31', docs);
  assert.ok(chunks.length > 6, 'the corpus should actually force bisection, or this proves nothing');
});

test('T-139 equivalence: Cairo DST fall-back day (the 25-hour day)', async () => {
  const SRC = { cap: 100, granular: ['Submission'], subSplit: true };
  const docs = [];
  for (let i = 0; i < 400; i++) docs.push(Date.parse('2024-10-27T00:00:00Z') + i * 60000);
  await assertIdentical('dst', SRC, 'Issue', '2024-10-27', '2024-11-04', docs);
});

test('T-140 equivalence: sub-split by submission time when an issuance day is over cap', async () => {
  const SRC = { cap: 100, granular: ['Submission'], subSplit: true };
  const docs = [];
  for (let i = 0; i < 300; i++) docs.push(Date.parse('2025-05-02T08:00:00Z') + i * 1000);
  const detectMaxSub = async () => '2025-05-02T12:00:00.000Z';
  await assertIdentical('subsplit', SRC, 'Issue', '2025-05-01', '2025-05-03', docs, { detectMaxSub });
});

test('T-141 equivalence: detectMaxSub returning null degrades to a warned single-day chunk', async () => {
  const SRC = { cap: 100, granular: ['Submission'], subSplit: true };
  const docs = [];
  for (let i = 0; i < 300; i++) docs.push(Date.parse('2025-05-02T08:00:00Z') + i * 1000);
  const chunks = await assertIdentical('nullsub', SRC, 'Issue', '2025-05-02', '2025-05-02', docs, { detectMaxSub: async () => null });
  assert.ok(chunks.some((c) => c.warn), 'the fallback path should warn — otherwise this asserts nothing');
});

test('T-142 equivalence: a doc in the final sub-second of the last day', async () => {
  const SRC = { cap: 100, granular: ['DateTimeReceived'], subSplit: false };
  const docs = [Date.parse('2025-03-15T21:59:59.900Z')];
  await assertIdentical('lastms', SRC, 'DateTimeReceived', '2025-03-15', '2025-03-15', docs);
});

test('T-137 equivalence: whole-day split across a full year', async () => {
  const SRC = { cap: 100, granular: ['Submission'], subSplit: true };
  const docs = [];
  for (let i = 0; i < 900; i++) docs.push(Date.parse('2025-01-01T06:00:00Z') + Math.floor(i * (364 * 86400000 / 900)));
  await assertIdentical('year', SRC, 'Issue', '2025-01-01', '2025-12-31', docs);
});

// ── machine mechanics ───────────────────────────────────────────────────────────────────────────
test('T-145 a replayed step returns the identical instruction', () => {
  // The client hard-fails and retries on a network error rather than falling back, so the same step
  // is re-sent routinely. Re-reading state without an observation must not advance the machine.
  const st = startPlan({ cap: 100, granular: false, subSplit: false, field: 'Issue', from: '2025-01-01', to: '2025-12-31' });
  const a = advance(st);
  const before = st.step;
  assert.equal(a.done, false);
  assert.equal(a.instruction.kind, 'probe');
  assert.equal(st.pending.t, 'split', 'the frame stays pending until an observation arrives');
  assert.equal(st.step, before, 'reading the outstanding instruction must not consume a step');
});

test('T-151 the machine terminates on a pathological corpus rather than looping', async () => {
  // Every probe reports over cap forever, so only the floor conditions can end it. Exercised on the
  // DATE axis: it bottoms out at whole days, which proves termination in a handful of chunks. The
  // granular axis bottoms out at ONE SECOND, so the same test over 3 days builds ~130k leaves and
  // took 10.6s — real coverage of the same branch, at 400x the runtime. The granular floor is
  // covered below on a range narrow enough to stay cheap.
  const SRC = { cap: 10, granular: ['Submission'], subSplit: false };
  const alwaysOverCap = async () => 999999;
  const mine = await buildChunks(SRC, '2025-01-01', '2025-01-05', 'Issue', { probe: alwaysOverCap });
  const theirs = await runPlan(cfg(SRC, 'Issue', '2025-01-01', '2025-01-05'), { probe: alwaysOverCap });
  assert.deepEqual(theirs, mine, 'both implementations bottom out identically');
  assert.equal(mine.length, 5, 'one warned chunk per calendar day');
  assert.ok(mine.every((c) => c.warn === 'over_cap_single_day'), 'every leaf is a warned over-cap day');
});

test('T-151b the granular floor is one second, and both agree on it', async () => {
  const SRC = { cap: 10, granular: ['DateTimeReceived'], subSplit: false };
  const alwaysOverCap = async () => 999999;
  // A 4-second window: enough to bisect down to the 1s floor, cheap enough to stay instant.
  const from = '2025-03-15', to = '2025-03-15';
  const narrow = { ...cfg(SRC, 'DateTimeReceived', from, to) };
  const mine = await buildChunks(SRC, from, to, 'DateTimeReceived', {
    probe: async (f, t) => (Date.parse(t) - Date.parse(f) > 4000 ? 0 : 999999),
  });
  const theirs = await runPlan(narrow, { probe: async (f, t) => (Date.parse(t) - Date.parse(f) > 4000 ? 0 : 999999) });
  assert.deepEqual(theirs, mine, 'granular floor behaviour is identical');
});
