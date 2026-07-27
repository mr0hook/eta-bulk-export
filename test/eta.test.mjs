// Work-based live ETA: paging = zero work, details/pdf = real work, resume-aware baseline, warmup gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { workTotal, doneChunkWork, chunkPhaseWork, createEtaTracker } from '../src/core/eta.js';

const plan = (over = {}) => ({
  totalRows: 1000, cap: 10000, downloadPdf: false,
  chunks: [{ id: 'a', count: 400 }, { id: 'b', count: 600 }], doneIds: [], ...over,
});

test('workTotal: rows once, doubled with PDFs', () => {
  assert.equal(workTotal(plan()), 1000);
  assert.equal(workTotal(plan({ downloadPdf: true })), 2000);
});

test('doneChunkWork: only completed chunks count, capped at plan.cap, pdf doubles', () => {
  assert.equal(doneChunkWork(plan()), 0);
  assert.equal(doneChunkWork(plan({ doneIds: ['a'] })), 400);
  assert.equal(doneChunkWork(plan({ doneIds: ['a', 'b'], downloadPdf: true })), 2000);
  assert.equal(doneChunkWork(plan({ doneIds: ['a'], cap: 100 })), 100, 'over-cap chunk counts at most cap rows');
});

test('chunkPhaseWork: search contributes ZERO work; details per-row; pdf offsets by the chunk row count', () => {
  assert.equal(chunkPhaseWork({ phase: 'search', cur: 380, max: 400 }, false), 0, 'paging must not move the timer');
  assert.equal(chunkPhaseWork({ phase: 'details', cur: 150, max: 400 }, false), 150);
  assert.equal(chunkPhaseWork({ phase: 'pdf', cur: 50, max: 400 }, true), 450, 'details done (400) + 50 pdfs');
  assert.equal(chunkPhaseWork({ phase: 'write', cur: 1, max: 400 }, true), 800, 'whole chunk banked at write');
  assert.equal(chunkPhaseWork(null, false), 0);
});

test('tracker: search-phase updates keep the estimate null (no fake progress)', () => {
  let t = 0; const eta = createEtaTracker({ now: () => t });
  const p = plan();
  assert.equal(eta.update(p, { phase: 'search', cur: 100, max: 400 }), null, 'baseline call');
  t += 120000;   // 2 minutes of paging
  assert.equal(eta.update(p, { phase: 'search', cur: 4000, max: 400 }), null, 'still zero work gained → no estimate');
});

test('tracker: details progress produces a sane estimate', () => {
  let t = 0; const eta = createEtaTracker({ now: () => t });
  const p = plan();
  eta.update(p, null);                                        // baseline: 0 work at t=0
  t += 60000;                                                 // 1 min later, 100 invoices processed
  const mins = eta.update(p, { phase: 'details', cur: 100, max: 400 });
  assert.equal(mins, 9, '900 left at 100/min → 9 minutes');
});

test('tracker: resume baseline excludes prior-session chunks', () => {
  let t = 0; const eta = createEtaTracker({ now: () => t });
  const p = plan({ doneIds: ['a'] });                         // 400 rows done in a PREVIOUS session
  assert.equal(eta.update(p, null), null, 'baseline = 400, not treated as gained work');
  t += 60000;
  const mins = eta.update(p, { phase: 'details', cur: 100, max: 600 });
  assert.equal(mins, 5, 'rate from the NEW 100 rows only: 500 left at 100/min');
});

test('tracker: warmup gates — too early or too little work → null', () => {
  let t = 0; const eta = createEtaTracker({ now: () => t });
  const p = plan();
  eta.update(p, null);
  t += 10000;                                                 // < 30s
  assert.equal(eta.update(p, { phase: 'details', cur: 100, max: 400 }), null);
  t += 25000;                                                 // ≥ 30s but…
  assert.equal(eta.update(p, { phase: 'details', cur: 10, max: 400 }), null, '< 20 work units');
});

test('tracker: reset re-baselines for a new run', () => {
  let t = 0; const eta = createEtaTracker({ now: () => t });
  const p = plan();
  eta.update(p, { phase: 'details', cur: 100, max: 400 });
  eta.reset();
  t += 60000;
  assert.equal(eta.update(p, { phase: 'details', cur: 200, max: 400 }), null, 'first post-reset call is the new baseline');
});
