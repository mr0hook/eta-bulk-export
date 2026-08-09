// SPEC-016 stage 5 — the client half of the server-conducted planner.
//
// This file replaces chunker.js in the shipped bundle. It contains no planning logic at all: it
// probes the ETA portal with the user's own token, reports counts, and does what the server says.
// That is the point — the algorithm that makes a >10,000-row range exportable no longer travels
// with the extension, and a patched build has no plan to run.
//
// chunker.js stays in the repo as the reference implementation the equivalence tests drive against
// the server's step machine; it is simply no longer imported by anything that ships.
import { planStart, planStep } from './registration.js';
import { t } from './i18n.js';

/** The server answered, and its answer was no. Retrying will not help; the drawer explains instead. */
export class PlanDenied extends Error {
  constructor(res) {
    super(res.reason || res.error || 'denied');
    this.name = 'PlanDenied';
    this.reason = res.reason || '';
    this.serverError = res.error || '';
  }
}
/** The user paused or halted mid-plan. */
export class PlanStopped extends Error {
  constructor() { super('stopped'); this.name = 'PlanStopped'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Drive one call with the agreed offline policy: a plan HARD-REQUIRES the server, so a network
 * failure waits and retries the same step rather than falling back to anything local. Every step is
 * idempotent server-side (the sealed cursor carries a step number), so a retry is safe — a reply
 * lost on the wire costs a repeat, never a corrupted plan.
 *
 * A refusal is different from a failure: if the server answered at all, it decided, and hammering it
 * will not change its mind.
 */
async function insist(fn, { onStatus, stopped, wait = sleep }) {
  let delay = 2000;
  for (;;) {
    if (stopped()) throw new PlanStopped();
    const res = await fn();
    if (res && res.ok) return res;
    if (!res || !res.network) throw new PlanDenied(res || {});
    onStatus(t('plan.retry', { s: Math.round(delay / 1000) }), { level: 'wait', kind: 'plan' });
    await wait(delay);
    if (stopped()) throw new PlanStopped();
    delay = Math.min(delay * 2, 30000);
  }
}

/**
 * Build a plan by conversation. Returns { jobId, chunks } — the chunk objects are shaped exactly as
 * chunker.js produced them, so every downstream consumer (store.chunkFile, the run loop, merge) is
 * unchanged.
 *
 * deps.probe / deps.detectMaxSub are the same injected portal calls the old planner took.
 */
export async function planViaServer(req, deps) {
  const { probe, detectMaxSub, onStatus = () => {}, stopped = () => false, wait = sleep } = deps;
  const io = { onStatus, stopped, wait };

  onStatus(t('plan.contacting'), { level: 'run', kind: 'plan' });
  const start = await insist(() => planStart(req), io);

  let { jobId, cursor, instruction } = start;
  let probes = 0;

  while (instruction) {
    if (stopped()) throw new PlanStopped();

    // The only thing the client decides: which portal call answers this instruction.
    let observation;
    if (instruction.kind === 'detectMaxSub') {
      observation = { maxSub: await detectMaxSub(instruction.issF, instruction.issT) };
    } else if (instruction.kind === 'probeSub') {
      observation = { count: await probe(instruction.issF, instruction.issT, instruction.subF, instruction.subT) };
      probes++;
    } else {
      observation = { count: await probe(instruction.fromISO, instruction.toISO) };
      probes++;
    }
    onStatus(t('orch.probe', { n: probes, m: instruction.note || '' }), { level: 'run', kind: 'probe' });

    const res = await insist(() => planStep({ jobId, cursor, observation }), io);
    if (res.done) {
      onStatus(t('plan.ready', { n: res.chunks.length }), { level: 'ok', kind: 'plan' });
      return { jobId, chunks: res.chunks };
    }
    cursor = res.cursor;
    instruction = res.instruction;
  }

  // The server ended the conversation without a plan. Treated as a refusal rather than an empty
  // plan: an empty chunk list downstream would look like "nothing to export" and quietly succeed.
  throw new PlanDenied({ error: 'no plan returned' });
}
