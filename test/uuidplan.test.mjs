// SPEC-022 T-221, T-228 — the client half of a UUID-list plan: batches → chunks, refusal → no run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planUuidList, PlanDenied, PlanStopped } from '../src/core/planclient.js';

const UU = (n) => Array.from({ length: n }, (_, i) => ('U' + String(i).padStart(25, '0')).slice(0, 26));
const REQ = { rin: '123456789', version: '9.9.9' };
const noWait = { wait: async () => {} };

test('T-221 batches from the server become chunks carrying exact slices of the list', async () => {
  const uuids = UU(1234);
  let sent = null;
  const call = async (body) => {
    sent = body;
    return { ok: true, jobId: 'job-u1', batches: [
      { id: 'uuids_0', idx: 0, label: 'UUIDs 1-412', count: 412 },
      { id: 'uuids_1', idx: 1, label: 'UUIDs 413-824', count: 412 },
      { id: 'uuids_2', idx: 2, label: 'UUIDs 825-1234', count: 410 },
    ] };
  };
  const { jobId, chunks } = await planUuidList(uuids, REQ, { call, ...noWait });
  assert.equal(jobId, 'job-u1');
  assert.deepEqual(sent, { count: 1234, rin: REQ.rin, version: REQ.version }, 'the request carries the COUNT, never the list');
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.uuids.length), [412, 412, 410]);
  assert.equal(chunks[0].uuids[0], uuids[0]);
  assert.equal(chunks[2].uuids[409], uuids[1233], 'the last uuid lands in the last batch — nothing dropped');
  assert.deepEqual([...new Set(chunks.flatMap((c) => c.uuids))].length, 1234, 'slices cover the list exactly once');
  assert.equal(chunks[1].count, 412);
});

test('T-228 a server refusal is final: PlanDenied, no chunks, no local fallback', async () => {
  const call = async () => ({ ok: false, error: 'not allowed', reason: 'rin_not_allowed' });
  await assert.rejects(() => planUuidList(UU(5), REQ, { call, ...noWait }), (e) => e instanceof PlanDenied && e.reason === 'rin_not_allowed');
});

test('T-228 a network failure retries the same call instead of giving up or falling back', async () => {
  let calls = 0;
  const call = async () => (++calls < 3 ? { ok: false, error: 'network', network: true } : { ok: true, jobId: 'j', batches: [{ id: 'uuids_0', label: 'x', count: 5 }] });
  const { chunks } = await planUuidList(UU(5), REQ, { call, ...noWait });
  assert.equal(calls, 3);
  assert.equal(chunks[0].uuids.length, 5);
});

test('T-228 a batching that does not cover the list exactly is refused (silent drops forbidden)', async () => {
  const short = async () => ({ ok: true, jobId: 'j', batches: [{ id: 'uuids_0', label: 'x', count: 4 }] });
  await assert.rejects(() => planUuidList(UU(5), REQ, { call: short, ...noWait }), PlanDenied);
  const zero = async () => ({ ok: true, jobId: 'j', batches: [{ id: 'a', label: 'x', count: 5 }, { id: 'b', label: 'y', count: 0 }] });
  await assert.rejects(() => planUuidList(UU(5), REQ, { call: zero, ...noWait }), PlanDenied);
});

test('T-228 pause during the network wait surfaces as PlanStopped', async () => {
  let stopped = false;
  const call = async () => ({ ok: false, network: true });
  const p = planUuidList(UU(3), REQ, { call, stopped: () => stopped, wait: async () => { stopped = true; } });
  await assert.rejects(() => p, PlanStopped);
});
