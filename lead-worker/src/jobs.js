// Job records in D1 (schema.sql). Nothing here stores invoice content — a job records WHICH ranges
// were asked for and HOW MANY documents they held, the same shape store.js already writes to
// eta_progress.json in the user's own folder.
//
// Every function tolerates a missing env.JOBS by returning null/false rather than throwing, so an
// environment deployed without the binding degrades to "planner unavailable" instead of 500s.

export const hasJobs = (env) => !!(env && env.JOBS);

export async function createJob(env, j) {
  if (!hasJobs(env)) return false;
  const now = new Date().toISOString();
  await env.JOBS.prepare(
    `INSERT INTO jobs (id, device_id, rin, source, date_field, dir, from_iso, to_iso, statuses,
                       state, version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,'planning',?,?,?)`,
  ).bind(j.id, j.deviceId, j.rin || '', j.source || '', j.dateField || '', j.dir || '',
    j.fromIso || '', j.toIso || '', JSON.stringify(j.statuses || []), j.version || '', now, now).run();
  return true;
}

export async function getJob(env, id, deviceId) {
  if (!hasJobs(env)) return null;
  // Scoped by device: a job id is a bearer-ish handle, and one device must never drive another's job.
  const r = await env.JOBS.prepare('SELECT * FROM jobs WHERE id = ? AND device_id = ?').bind(id, deviceId).first();
  return r || null;
}

/**
 * Record the finished plan: chunks in order, then the job flips to 'planned'.
 * idx is the plan's ORDER and is load-bearing — the client fetches in it, so a reordering would
 * change which documents land in which output file.
 */
export async function finishPlan(env, id, chunks, probes) {
  if (!hasJobs(env)) return false;
  const now = new Date().toISOString();
  const stmts = [];
  const ins = env.JOBS.prepare(
    `INSERT OR REPLACE INTO job_chunks (job_id, idx, chunk_id, from_iso, to_iso, sub_f, sub_t, label, count, warn, state)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'pending')`,
  );
  chunks.forEach((c, i) => stmts.push(ins.bind(id, i, c.id, c.fromISO, c.toISO, c.subF || null, c.subT || null, c.label, c.count | 0, c.warn || null)));
  const rows = chunks.reduce((n, c) => n + (c.count | 0), 0);
  stmts.push(env.JOBS.prepare(
    `UPDATE jobs SET state='planned', total_chunks=?, total_rows=?, probes=?, updated_at=? WHERE id=?`,
  ).bind(chunks.length, rows, probes | 0, now, id));
  // D1 batch is a single transaction: either the whole plan lands or none of it does. A half-written
  // plan would look complete to the client and silently skip whatever never got inserted.
  await env.JOBS.batch(stmts);
  return true;
}

/**
 * Jobs this device could still pick up: planned but never started, or started and not finished.
 * Drives the "Resume" entry under the Download button — the user should not have to remember that
 * an export was interrupted, and should never be able to start a second run over the same range by
 * accident because the first one was invisible.
 *
 * 'done' is excluded (nothing to resume) and so is 'abandoned'. Newest first, capped: a device with
 * a long history should not push a wall of stale jobs into the drawer.
 */
export async function listResumable(env, deviceId, limit = 5) {
  if (!hasJobs(env)) return [];
  const r = await env.JOBS.prepare(
    `SELECT id, source, date_field, dir, from_iso, to_iso, state, total_chunks, total_rows,
            done_count, failed_count, updated_at
       FROM jobs
      WHERE device_id = ? AND state IN ('planned','running','paused','incomplete','halted')
      ORDER BY updated_at DESC
      LIMIT ?`,
  ).bind(deviceId, limit).all();
  return (r && r.results) || [];
}

export async function getChunks(env, id) {
  if (!hasJobs(env)) return [];
  const r = await env.JOBS.prepare('SELECT * FROM job_chunks WHERE job_id = ? ORDER BY idx ASC').bind(id).all();
  return (r && r.results) || [];
}

/**
 * Progress checkpoint from a running export. Counts only.
 *
 * On successful completion the per-chunk rows are dropped and the jobs row is kept: the history of
 * WHAT was exported survives, the range-by-range working detail does not. That is a deliberate
 * retention rule — it keeps the admin timeline useful while shrinking what the backend holds about
 * a taxpayer's activity, and it keeps /privacy honest about a smaller surface.
 *
 * Chunks are dropped ONLY on 'done'. They are exactly what a resume reads, so clearing them on an
 * incomplete, halted or paused job would strand the user with no way to continue — the failure
 * would look like the tool losing their work.
 */
export async function checkpoint(env, id, deviceId, p) {
  if (!hasJobs(env)) return false;
  const now = new Date().toISOString();
  const state = ['running', 'done', 'incomplete', 'halted', 'paused', 'abandoned'].includes(p.state) ? p.state : 'running';
  await env.JOBS.prepare(
    `UPDATE jobs SET state=?, done_count=?, failed_count=?, updated_at=? WHERE id=? AND device_id=?`,
  ).bind(state, p.done | 0, p.failed | 0, now, id, deviceId).run();
  if (state === 'done') await purgeChunks(env, id, deviceId);
  return true;
}

/** Drop the working rows for a finished job, leaving its history row intact. */
export async function purgeChunks(env, id, deviceId) {
  if (!hasJobs(env)) return false;
  // Device-scoped via the jobs row so a job id alone cannot be used to wipe someone else's chunks.
  await env.JOBS.prepare(
    `DELETE FROM job_chunks WHERE job_id = ? AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND device_id = ?)`,
  ).bind(id, id, deviceId).run();
  return true;
}
