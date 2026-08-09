// SPEC-016 — the planner conversation.
//
//   POST /plan/start   signed → mints a job (entitlement checked FIRST) and returns the first probe
//   POST /plan/step    signed → consumes one observation, returns the next probe or the finished plan
//   POST /job/checkpoint signed → progress counters for a running export
//
// This is where the gate actually bites. /session only TELLS the extension whether it may act;
// /plan/start refuses to mint a job at all. A patched client that forges its local verdict gets a
// drawer that looks unlocked and no plan to run — and without a plan there is nothing to export.
import { json, randHex, cleanRin } from '../lib/util.js';
import { getDev, getCfg, deviceRate } from '../lib/kv.js';
import { verifySigned } from '../lib/auth.js';
import { computeVerdict } from '../lib/verdict.js';
import { errlog } from '../lib/audit.js';
import { cursorKey, seal, unseal } from '../cursor.js';
import { startPlan, advance } from '../planner.js';
import { createJob, getJob, getChunks, finishPlan, checkpoint, listResumable, hasJobs } from '../jobs.js';

// Mirrors SOURCES in the extension (src/api/sources.js). Held server-side so a client cannot raise
// its own cap and have the planner accept oversized chunks.
const SOURCES = {
  invoices: { cap: 10000, granular: ['Submission'], subSplit: true, fields: ['Issue', 'Submission'] },
  receipts: { cap: 3000, granular: ['DateTimeReceived'], subSplit: false, fields: ['DateTimeReceived', 'DateTimeIssued'] },
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_STEPS = 20000;   // backstop: the depth caps bound a plan long before this

export async function planRoutes(request, env, url, path) {
  if (!path.startsWith('/plan/') && !path.startsWith('/job/')) return null;
  if (request.method !== 'POST') return json({ ok: false, error: 'not found' }, 404);

  const body = await request.text();
  const dev = await verifySigned(env, request, body);
  if (!dev) {
    const known = await getDev(env, request.headers.get('x-device-id') || '');
    await errlog(env, request, 'sig_fail', { tag: 'plan', known: !!known });
    return json({ ok: false, error: known ? 'unauthorized' : 'not registered' }, 401);
  }
  let b = {}; try { b = JSON.parse(body || '{}'); } catch {}

  if (!hasJobs(env)) {
    // Deployed without the D1 binding. Say so plainly rather than 500 — the client's retry loop
    // should not hammer a route that cannot succeed until the environment is fixed.
    await errlog(env, request, 'no_jobs_binding', { path });
    return json({ ok: false, error: 'planner unavailable' }, 503);
  }

  // ── start ─────────────────────────────────────────────────────────────────────────────────────
  if (path === '/plan/start') {
    if (!(await deviceRate(env, 'plan', dev.deviceId, 60, 3600000))) {
      await errlog(env, request, 'rate_limit', { tag: 'plan' });
      return json({ ok: false, error: 'Too many plans from this device — please try again later.' }, 429);
    }
    const rin = cleanRin(b.rin);
    const version = String(b.version || '').slice(0, 24);
    const cfg = await getCfg(env);
    const v = await computeVerdict(env, dev, { rin, version, cfg });
    if (!v.allowed) return json({ ok: false, error: 'not allowed', reason: v.reason, ...v }, 403);

    const src = SOURCES[String(b.source || '')];
    if (!src) return json({ ok: false, error: 'unknown source' }, 400);
    const field = String(b.field || '');
    if (!src.fields.includes(field)) return json({ ok: false, error: 'unknown date field' }, 400);
    const from = String(b.from || ''), to = String(b.to || '');
    if (!YMD.test(from) || !YMD.test(to) || from > to) return json({ ok: false, error: 'bad date range' }, 400);

    const id = randHex(12);
    await createJob(env, {
      id, deviceId: dev.deviceId, rin, source: b.source, dateField: field,
      dir: String(b.dir || '').slice(0, 24), fromIso: from, toIso: to,
      statuses: Array.isArray(b.statuses) ? b.statuses.map(String).slice(0, 12) : [], version,
    });

    const st = startPlan({ cap: src.cap, granular: src.granular.includes(field), subSplit: src.subSplit, field, from, to });
    const r = advance(st);
    const key = await cursorKey(env);
    return json({ ok: true, jobId: id, cursor: await seal(key, id, st), ...trim(r) });
  }

  // ── step ──────────────────────────────────────────────────────────────────────────────────────
  if (path === '/plan/step') {
    const id = String(b.jobId || '');
    const job = await getJob(env, id, dev.deviceId);
    if (!job) return json({ ok: false, error: 'no such job' }, 404);

    const key = await cursorKey(env);
    const st = await unseal(key, id, String(b.cursor || ''));
    // null covers tampering, a cursor from another job, and garbage. Never treat it as empty state:
    // that would let a client skip planning and declare a plan of its own choosing.
    if (!st) return json({ ok: false, error: 'bad cursor' }, 400);
    if (st.step > MAX_STEPS) return json({ ok: false, error: 'plan too large' }, 400);

    const obs = (b.observation && typeof b.observation === 'object') ? b.observation : {};
    const r = advance(st, obs);

    if (r.done) {
      await finishPlan(env, id, r.chunks, r.probes);
      return json({ ok: true, done: true, jobId: id, chunks: r.chunks, probes: r.probes });
    }
    return json({ ok: true, jobId: id, cursor: await seal(key, id, st), ...trim(r) });
  }

  // ── resumable jobs ────────────────────────────────────────────────────────────────────────────
  // Backs the Resume entry under the Download button. Deliberately does NOT require an allowed
  // verdict: a user whose licence lapsed mid-export should still be able to see that work is
  // outstanding and why they cannot continue it, rather than have it silently disappear.
  if (path === '/job/resumable') {
    const jobs = await listResumable(env, dev.deviceId);
    return json({ ok: true, jobs });
  }

  // Hand back the plan for a job the client is resuming. The chunks are still in D1 because they
  // are only purged when a job reaches 'done' — see jobs.js checkpoint().
  if (path === '/job/plan') {
    const id = String(b.jobId || '');
    const job = await getJob(env, id, dev.deviceId);
    if (!job) return json({ ok: false, error: 'no such job' }, 404);
    const chunks = await getChunks(env, id);
    if (!chunks.length) return json({ ok: false, error: 'plan no longer available', state: job.state }, 410);
    return json({
      ok: true, job,
      chunks: chunks.map((c) => ({ id: c.chunk_id, fromISO: c.from_iso, toISO: c.to_iso, subF: c.sub_f, subT: c.sub_t, label: c.label, count: c.count, warn: c.warn })),
    });
  }

  // ── checkpoint ────────────────────────────────────────────────────────────────────────────────
  if (path === '/job/checkpoint') {
    const id = String(b.jobId || '');
    const job = await getJob(env, id, dev.deviceId);
    if (!job) return json({ ok: false, error: 'no such job' }, 404);
    await checkpoint(env, id, dev.deviceId, { state: String(b.state || 'running'), done: b.done, failed: b.failed });
    return json({ ok: true });
  }

  return json({ ok: false, error: 'not found' }, 404);
}

// The client gets the instruction and a step number, never the machine's internals — the shape of
// the traversal is the thing worth not handing over.
const trim = (r) => ({ done: false, step: r.step, instruction: r.instruction });
