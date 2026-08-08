// The chunk planner, as a resumable step machine. Pure: no env, no I/O, no clock beyond the dates
// it is given — driven entirely by observations the client reports back.
//
// This is src/core/chunker.js's algorithm with one structural change: the recursion becomes an
// explicit work stack, because a Worker cannot hold a call stack between HTTP requests. Everything
// else — the cap test, the inclusive shared boundary, the DST-safe calendar bisection, the
// sub-second sub-split, the depth caps, the warning strings — is preserved exactly, and
// test/planner.test.mjs drives both implementations from the same probe corpus to prove it.
//
// ORDERING IS LOAD-BEARING. The recursive form returns [...left, ...right]; a LIFO stack therefore
// pushes the RIGHT frame before the LEFT so the left subtree is fully consumed first. Accepted
// chunks append to a flat output array as they are decided, which reproduces that order.
import { dayStartISO, dayEndISO, ymdOf, addDays, daysBetween, chunkLabel } from './cairo.js';

const DEPTH_MAX = 80;      // chunker.js: depth > 80 on the date axis
const SUB_DEPTH_MAX = 64;  // chunker.js: depth > 64 on the submission-time axis

function mkChunk(fromISO, toISO, count, warn, subF, subT) {
  const sub = subF && subT ? ` · sub ${subF.slice(11, 19)}→${subT.slice(11, 19)}` : '';
  return {
    id: `${fromISO}_${toISO}${subF ? '_' + subF + '_' + subT : ''}`,
    fromISO, toISO, subF, subT,
    label: chunkLabel(fromISO, toISO) + sub,
    count, warn,
  };
}

/** Begin a plan. Returns the machine state; call advance() to get the first instruction. */
export function startPlan({ cap, granular, subSplit, field, from, to }) {
  return {
    cap, granular: !!granular, subSplit: !!subSplit, field,
    stack: [{ t: 'split', fromISO: dayStartISO(from), toISO: dayEndISO(to), depth: 0 }],
    out: [],
    pending: null,
    probes: 0,
    step: 0,
  };
}

const instructionFor = (f) =>
  f.t === 'split' ? { kind: 'probe', fromISO: f.fromISO, toISO: f.toISO }
  : f.t === 'sub' ? { kind: 'probeSub', issF: f.issF, issT: f.issT, subF: f.subF, subT: f.subT }
  : { kind: 'detectMaxSub', issF: f.issF, issT: f.issT };

// Apply the observation for the frame that was awaiting one. Mirrors the body of chunker.js's
// split() / ss() / subSplit() between their await points.
function resolve(st, f, obs) {
  const push = (frame) => st.stack.push(frame);
  const emit = (c) => st.out.push(c);

  if (f.t === 'subInit') {
    const maxSub = obs && obs.maxSub;
    if (!maxSub) return;                       // subSplit() bails → the sentinel emits the fallback chunk
    const minMs = Date.parse(f.issF) - 86400000;
    const maxMs = Date.parse(maxSub) + 1000;
    push({ t: 'sub', issF: f.issF, issT: f.issT, subF: new Date(minMs).toISOString(), subT: new Date(maxMs).toISOString(), depth: 0 });
    return;
  }

  if (f.t === 'sub') {
    const cnt = Number(obs && obs.count) || 0;
    st.probes++;
    if (cnt === 0) return;
    if (cnt < st.cap) { emit(mkChunk(f.issF, f.issT, cnt, null, f.subF, f.subT)); return; }
    const fMs = Date.parse(f.subF), tMs = Date.parse(f.subT);
    if (tMs - fMs <= 1000 || f.depth > SUB_DEPTH_MAX) { emit(mkChunk(f.issF, f.issT, cnt, 'over_cap_one_second', f.subF, f.subT)); return; }
    const mid = new Date(fMs + Math.floor((tMs - fMs) / 2)).toISOString();
    push({ t: 'sub', issF: f.issF, issT: f.issT, subF: mid, subT: f.subT, depth: f.depth + 1 });      // right first
    push({ t: 'sub', issF: f.issF, issT: f.issT, subF: f.subF, subT: mid, depth: f.depth + 1 });      // then left
    return;
  }

  // f.t === 'split'
  const cnt = Number(obs && obs.count) || 0;
  st.probes++;
  if (cnt === 0) return;
  if (cnt < st.cap) { emit(mkChunk(f.fromISO, f.toISO, cnt)); return; }

  let leftTo, rightFrom, atFloor;
  if (st.granular) {
    const fMs = Date.parse(f.fromISO), tMs = Date.parse(f.toISO);
    atFloor = (tMs - fMs) <= 1000;
    // Inclusive shared boundary → gap-free at any filter precision. Deliberately NOT mid / mid+1ms:
    // at ETA's sub-ms timestamps that opens a silent gap. A doc exactly on mid can appear twice;
    // merge dedups by UUID. An over-report is recoverable, an under-report is not.
    const mid = new Date(fMs + Math.floor((tMs - fMs) / 2)).toISOString();
    leftTo = mid; rightFrom = mid;
  } else {
    // Calendar arithmetic, DST-safe: a 25-hour Cairo fall-back day must not make next-day land back
    // on the same date. Done on YYYY-MM-DD strings so no wall-clock offset enters the maths.
    const fDay = ymdOf(f.fromISO), tDay = ymdOf(f.toISO);
    const days = daysBetween(f.fromISO, f.toISO);
    atFloor = days <= 0;
    const midDay = addDays(fDay, Math.floor(days / 2));
    leftTo = dayEndISO(midDay);
    rightFrom = dayStartISO(addDays(midDay, 1));
    void tDay;
  }

  if (atFloor || f.depth > DEPTH_MAX) {
    const warn = st.granular ? 'over_cap_one_second' : 'over_cap_single_day';
    if (st.subSplit && st.field === 'Issue' && cnt >= st.cap) {
      // subSplit() returns [] when detectMaxSub yields nothing; the sentinel below detects that the
      // subtree produced no chunks and emits the warned single chunk instead, exactly as
      // `if (s.length) return s;` did.
      push({ t: 'subDone', issF: f.fromISO, issT: f.toISO, cnt, warn, mark: st.out.length });
      push({ t: 'subInit', issF: f.fromISO, issT: f.toISO });
      return;
    }
    emit(mkChunk(f.fromISO, f.toISO, cnt, warn));
    return;
  }

  push({ t: 'split', fromISO: rightFrom, toISO: f.toISO, depth: f.depth + 1 });    // right first
  push({ t: 'split', fromISO: f.fromISO, toISO: leftTo, depth: f.depth + 1 });     // then left
}

/**
 * Feed the observation for the outstanding instruction (or nothing, on the first call) and get the
 * next instruction. Returns {done:true, chunks} when the plan is complete.
 */
export function advance(state, observation) {
  const st = state;
  if (st.pending) { resolve(st, st.pending, observation); st.pending = null; }

  while (st.stack.length) {
    const top = st.stack[st.stack.length - 1];
    if (top.t === 'subDone') {
      st.stack.pop();
      if (st.out.length === top.mark) st.out.push(mkChunk(top.issF, top.issT, top.cnt, top.warn));
      continue;
    }
    st.stack.pop();
    st.pending = top;
    st.step++;
    return { done: false, step: st.step, instruction: instructionFor(top), state: st };
  }
  return { done: true, step: st.step, chunks: st.out, probes: st.probes, state: st };
}

/** Convenience driver — used by the equivalence tests and any local dry run. */
export async function runPlan(config, deps) {
  const st = startPlan(config);
  let r = advance(st);
  while (!r.done) {
    const i = r.instruction;
    const obs = i.kind === 'probe' ? { count: await deps.probe(i.fromISO, i.toISO) }
      : i.kind === 'probeSub' ? { count: await deps.probe(i.issF, i.issT, i.subF, i.subT) }
      : { maxSub: await deps.detectMaxSub(i.issF, i.issT) };
    r = advance(st, obs);
  }
  return r.chunks;
}
