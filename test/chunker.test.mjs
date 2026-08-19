import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChunks, coalesce } from '../src/core/chunker.js';

// synthetic "server": count docs whose timestamp is within [from,to] (inclusive, full precision)
function makeProbe(docs) {
  return async (fromISO, toISO) => {
    const lo = Date.parse(fromISO), hi = Date.parse(toISO);
    return docs.reduce((n, t) => n + (t >= lo && t <= hi ? 1 : 0), 0);
  };
}
function coverage(docs, chunks) {
  const ranges = chunks.map((c) => [Date.parse(c.fromISO), Date.parse(c.toISO)]);
  let covered = 0, missed = 0;
  for (const t of docs) (ranges.some(([lo, hi]) => t >= lo && t <= hi) ? covered++ : missed++);
  return { covered, missed };
}

test('granular: gap-free coverage + every chunk under cap (dense cluster forces time-bisection)', async () => {
  const SRC = { cap: 100, granular: ['DateTimeReceived'], subSplit: false };
  const YEAR = Date.parse('2025-01-01T00:00:00Z');
  const docs = [];
  for (let i = 0; i < 500; i++) docs.push(YEAR + Math.floor(i * (365 * 86400000 / 500)));           // spread across the year
  const cluster = Date.parse('2025-06-15T10:00:00Z');
  for (let i = 0; i < 500; i++) docs.push(cluster + i * 7200);                                       // 500 packed into one hour

  const chunks = await buildChunks(SRC, '2025-01-01', '2025-12-31', 'DateTimeReceived', { probe: makeProbe(docs) });

  const { covered, missed } = coverage(docs, chunks);
  assert.equal(missed, 0, 'no document falls in a gap between chunks');
  assert.equal(covered, docs.length, 'every document covered');
  for (const c of chunks) assert.ok(c.count < SRC.cap, `chunk ${c.label} has ${c.count} ≥ cap`);
  assert.ok(!chunks.some((c) => c.warn), 'no over-cap warnings for this distribution');
  assert.ok(chunks.length > 6, 'the dense hour was split into multiple sub-chunks');
});

test('date-only: BLOCKER regression — Cairo DST fall-back day (25h) is not double-counted (#1)', async () => {
  const SRC = { cap: 100, granular: ['Submission'], subSplit: true };
  const docs = [];
  // dense docs spanning the DST fall-back window; Cairo falls back on 2024-10-31 (a 25-hour day)
  for (let d = 27; d <= 31; d++) for (let i = 0; i < 60; i++) docs.push(Date.parse(`2024-10-${d}T12:00:00Z`) + i * 1000);
  for (let i = 0; i < 60; i++) docs.push(Date.parse('2024-11-01T12:00:00Z') + i * 1000);
  const chunks = await buildChunks(SRC, '2024-10-27', '2024-11-04', 'Issue', { probe: makeProbe(docs) });
  for (const t of docs) {
    const hits = chunks.filter((c) => t >= Date.parse(c.fromISO) && t <= Date.parse(c.toISO)).length;
    assert.equal(hits, 1, `doc ${new Date(t).toISOString()} must be in exactly ONE chunk (was fetched ~80× before the DST fix)`);
  }
  assert.ok(!chunks.some((c) => c.warn), 'no degenerate over_cap chunks from a non-terminating re-split');
});

test('granular: MEDIUM regression — a doc in the final sub-second of the last day is covered (#2)', async () => {
  const SRC = { cap: 100, granular: ['DateTimeReceived'], subSplit: false };
  const docs = [Date.parse('2025-03-15T23:59:59.500')]; // Cairo-local under the TZ pin
  const chunks = await buildChunks(SRC, '2025-03-15', '2025-03-15', 'DateTimeReceived', { probe: makeProbe(docs) });
  assert.equal(coverage(docs, chunks).missed, 0, 'the 23:59:59.5 doc is inside the range (dayEndISO now .999, was .000)');
});

test('sub-split: an issuance day over cap splits by submission time into under-cap, gap-free sub-chunks', async () => {
  const SRC = { cap: 100, granular: ['Submission'], subSplit: true };
  // two-axis docs: issued across 3 days; the middle day has 450 docs (over cap) submitted in a 3-hour burst
  const docs = [];
  const mk = (iss, sub) => docs.push({ iss, sub });
  for (let i = 0; i < 50; i++) mk(Date.parse('2025-05-01T09:00:00Z') + i * 60000, Date.parse('2025-05-01T10:00:00Z') + i * 60000);
  for (let i = 0; i < 450; i++) mk(Date.parse('2025-05-02T06:00:00Z') + (i % 600) * 1000, Date.parse('2025-05-02T08:00:00Z') + i * 24000);
  for (let i = 0; i < 50; i++) mk(Date.parse('2025-05-03T09:00:00Z') + i * 60000, Date.parse('2025-05-03T11:00:00Z') + i * 60000);

  const probe = async (fromISO, toISO, subF, subT) => {
    const lo = Date.parse(fromISO), hi = Date.parse(toISO);
    const sl = subF ? Date.parse(subF) : -Infinity, sh = subT ? Date.parse(subT) : Infinity;
    return docs.reduce((n, d) => n + (d.iss >= lo && d.iss <= hi && d.sub >= sl && d.sub <= sh ? 1 : 0), 0);
  };
  const detectMaxSub = async (fromISO, toISO) => {
    const lo = Date.parse(fromISO), hi = Date.parse(toISO);
    const subs = docs.filter((d) => d.iss >= lo && d.iss <= hi).map((d) => d.sub);
    return subs.length ? new Date(Math.max(...subs)).toISOString() : null;
  };

  const chunks = await buildChunks(SRC, '2025-05-01', '2025-05-03', 'Issue', { probe, detectMaxSub });

  for (const c of chunks) assert.ok(c.count < SRC.cap, `chunk ${c.label} has ${c.count} ≥ cap`);
  assert.ok(chunks.some((c) => c.subF && c.subT), 'the over-cap day was sub-split by submission time');
  assert.ok(!chunks.some((c) => c.warn), 'no over-cap warnings — the sub-split resolved the dense day');
  // coverage on BOTH axes: every doc lands in ≥1 chunk (a boundary doc may land in 2 — merge dedups by UUID)
  let missed = 0;
  for (const d of docs) {
    const hit = chunks.some((c) => d.iss >= Date.parse(c.fromISO) && d.iss <= Date.parse(c.toISO)
      && (!c.subF || (d.sub >= Date.parse(c.subF) && d.sub <= Date.parse(c.subT))));
    if (!hit) missed++;
  }
  assert.equal(missed, 0, 'no document falls into a sub-split gap');
});

test('sub-split: detectMaxSub returning null degrades to a warned single-day chunk (not a crash/loop)', async () => {
  const SRC = { cap: 100, granular: ['Submission'], subSplit: true };
  const docs = [];
  for (let i = 0; i < 300; i++) docs.push(Date.parse('2025-05-02T06:00:00Z') + i * 1000);
  const probe = async (fromISO, toISO) => {
    const lo = Date.parse(fromISO), hi = Date.parse(toISO);
    return docs.reduce((n, t) => n + (t >= lo && t <= hi ? 1 : 0), 0);
  };
  const chunks = await buildChunks(SRC, '2025-05-02', '2025-05-02', 'Issue', { probe, detectMaxSub: async () => null });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].warn, 'over_cap_single_day', 'falls back to the warned over-cap chunk when the sub axis is unavailable');
});

// ── SPEC-024: the coalescing fold, unit-level ───────────────────────────────────────────────────
test('T-253 coalesce: merges runs of small plain chunks up to 90% of cap, greedily and only there', () => {
  const P = (from, to, count, warn) => ({
    id: `${from}_${to}`, fromISO: `${from}T00:00:00.000Z`, toISO: `${to}T21:59:59.999Z`,
    subF: undefined, subT: undefined, label: from, count, warn: warn || null,
  });
  // [10, 20, 30] all fit inside target 90 → ONE chunk spanning the outer range, counts summed.
  const merged = coalesce([P('2025-01-01', '2025-01-02', 10), P('2025-01-03', '2025-01-04', 20), P('2025-01-05', '2025-01-06', 30)], 100);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].count, 60);
  assert.equal(merged[0].fromISO, '2025-01-01T00:00:00.000Z');
  assert.equal(merged[0].toISO, '2025-01-06T21:59:59.999Z');
  assert.ok(!merged[0].warn);

  // Greedy boundary: 50+45 = 95 > 90 stays split; the 45 then takes the 10 (55 ≤ 90).
  const greedy = coalesce([P('2025-02-01', '2025-02-01', 50), P('2025-02-02', '2025-02-02', 45), P('2025-02-03', '2025-02-03', 10)], 100);
  assert.deepEqual(greedy.map((c) => c.count), [50, 55]);

  // A single chunk already above the target passes through untouched (bisection always allowed
  // a lone leaf anywhere under cap; the target only governs merges).
  const lone = coalesce([P('2025-03-01', '2025-03-01', 97)], 100);
  assert.equal(lone.length, 1);
  assert.equal(lone[0].count, 97);

  // A warned chunk is a wall: nothing merges into it, nothing merges through it.
  const walled = coalesce([P('2025-04-01', '2025-04-01', 40), P('2025-04-02', '2025-04-02', 500, 'over_cap_single_day'), P('2025-04-03', '2025-04-03', 40)], 100);
  assert.deepEqual(walled.map((c) => c.count), [40, 500, 40]);
  assert.equal(walled[1].warn, 'over_cap_single_day');

  // Sub chunks: merge inside one issuance window, never across windows, never with a plain chunk.
  const S = (day, sf, st, count) => ({
    id: `${day}_${day}_${sf}_${st}`, fromISO: `${day}T00:00:00.000Z`, toISO: `${day}T21:59:59.999Z`,
    subF: `${day}T${sf}:00.000Z`, subT: `${day}T${st}:00.000Z`, label: day, count, warn: null,
  });
  const subs = coalesce([
    P('2025-05-01', '2025-05-01', 30),
    S('2025-05-02', '08:00', '10:00', 30), S('2025-05-02', '10:00', '12:00', 40),   // same window → merge (70)
    S('2025-05-03', '08:00', '10:00', 30),                                          // next day's window → wall
  ], 100);
  assert.deepEqual(subs.map((c) => c.count), [30, 70, 30]);
  assert.equal(subs[1].subF, '2025-05-02T08:00:00.000Z');
  assert.equal(subs[1].subT, '2025-05-02T12:00:00.000Z');
  assert.equal(subs[1].fromISO, '2025-05-02T00:00:00.000Z', 'a merged sub chunk keeps its issuance window');
});

test('date-only: whole-day split, coverage, no day double-counted', async () => {
  const SRC = { cap: 100, granular: ['Submission'], subSplit: true };
  const docs = [];
  // 300 docs, ~1/day at UTC midnight across the year (date-only axis)
  for (let i = 0; i < 300; i++) docs.push(Date.parse('2025-01-01T00:00:00Z') + i * 86400000);
  const probe = makeProbe(docs);
  const chunks = await buildChunks(SRC, '2025-01-01', '2025-12-31', 'Issue', { probe });

  const { missed } = coverage(docs, chunks);
  assert.equal(missed, 0, 'no gaps on the date-only axis');
  // each midnight doc lands in exactly one chunk (no overlap) since Cairo-day ranges don't split a UTC-midnight value
  for (const t of docs) {
    const hits = chunks.filter((c) => t >= Date.parse(c.fromISO) && t <= Date.parse(c.toISO)).length;
    assert.equal(hits, 1, 'each date-only doc in exactly one chunk');
  }
});
