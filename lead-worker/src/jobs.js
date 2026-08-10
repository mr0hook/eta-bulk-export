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
      WHERE device_id = ? AND state IN ('planned','running','merging','paused','incomplete','halted')
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

// One character per chunk, in idx order: d=done, f=failed, r=running, anything else pending.
// Deliberately a SNAPSHOT of the whole run rather than a delta: checkpoints are best-effort and the
// client drops any it cannot deliver, so a delta scheme would leave a square permanently wrong
// after one dropped call. Restating everything makes the next checkpoint self-healing.
export const CHUNK_STATES = /^[dfrp]*$/;
export const CHUNK_STATES_MAX = 4096;   // a 4096-chunk plan is ~40M documents; far past anything real

/**
 * Progress checkpoint from a running export: the counters, and optionally where each chunk stands.
 *
 * `chunkStates` is applied with substr() against each row's own idx rather than an IN-list of ids,
 * because D1 caps bound parameters per statement (~100) and a real plan runs to hundreds of chunks.
 * One statement, two parameters, any plan size — and it rides in the same batch as the counters so
 * the timeline and the totals can never disagree.
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
  const state = ['running', 'merging', 'done', 'incomplete', 'halted', 'paused', 'abandoned'].includes(p.state) ? p.state : 'running';
  const stmts = [env.JOBS.prepare(
    `UPDATE jobs SET state=?, done_count=?, failed_count=?, updated_at=? WHERE id=? AND device_id=?`,
  ).bind(state, p.done | 0, p.failed | 0, now, id, deviceId)];
  // An unparseable map is ignored rather than rejected: the counters are the load-bearing half and
  // must land even from a client whose timeline half is malformed or from an older build.
  const map = (typeof p.chunkStates === 'string' && p.chunkStates.length <= CHUNK_STATES_MAX && CHUNK_STATES.test(p.chunkStates)) ? p.chunkStates : '';
  if (map) {
    stmts.push(env.JOBS.prepare(
      `UPDATE job_chunks
          SET state = CASE substr(?, idx + 1, 1)
                        WHEN 'd' THEN 'done' WHEN 'f' THEN 'failed' WHEN 'r' THEN 'running'
                        ELSE 'pending' END
        WHERE job_id = ? AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND device_id = ?)`,
    ).bind(map, id, id, deviceId));
  }
  await env.JOBS.batch(stmts);
  // SPEC-018: the shipped run log follows the chunks exactly — same trigger, same retention rule.
  // Both are working detail about one taxpayer's activity; neither is the history of what ran.
  if (state === 'done') { await purgeChunks(env, id, deviceId); await purgeEvents(env, id, deviceId); }
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

// ── SPEC-018 Part B · the shipped run log ─────────────────────────────────────────────────────────
// Status lines only: counts and progress, the same strings the drawer shows and /bug already
// carries. Nothing here stores document content, and nothing here is authoritative — the log the
// user's own folder holds (SPEC-011) is, which is why every path below degrades quietly instead of
// failing a request.

export const EVENTS_CAP = 200;   // per job, newest kept. A run emits thousands; support needs the tail.

// Created lazily as well as in schema.sql: this shipped after the D1 was provisioned, and a Worker
// deployed before the file was re-applied must start logging on its next flush rather than 500.
// Cached per isolate — the CREATE is idempotent but it is still a round-trip per call otherwise.
let eventsReady = false;
async function ensureEvents(env) {
  if (eventsReady) return;
  await env.JOBS.prepare(
    `CREATE TABLE IF NOT EXISTS job_events (
       job_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT, level TEXT, kind TEXT, text TEXT,
       PRIMARY KEY (job_id, seq))`,
  ).run();
  eventsReady = true;
}

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

/**
 * Append a flush from the extension and trim the job back to the newest `cap` lines.
 *
 * seq is assigned server-side from the current MAX rather than taken from the client: it is what
 * makes "the newest 200" well defined when two flushes land in the same second, and a client-chosen
 * sequence could overwrite earlier lines by reusing a number.
 *
 * The inserts and the trim go out as ONE batch (a single D1 transaction) so a job can never be seen
 * holding more than the cap, and a failed append leaves the previous tail intact rather than a
 * half-written one.
 */
export async function appendEvents(env, id, lines, cap = EVENTS_CAP) {
  if (!hasJobs(env) || !Array.isArray(lines) || !lines.length) return 0;
  await ensureEvents(env);
  const row = await env.JOBS.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM job_events WHERE job_id = ?').bind(id).first();
  let seq = (row && row.m) | 0;
  // A batch larger than the cap would be trimmed to its own tail anyway — do it before the writes.
  const use = lines.slice(-cap);
  const ins = env.JOBS.prepare('INSERT OR REPLACE INTO job_events (job_id, seq, at, level, kind, text) VALUES (?,?,?,?,?,?)');
  const stmts = use.map((e) => ins.bind(
    id, ++seq, clip(e && e.at, 32), clip(e && e.level, 8),
    (e && e.kind) ? clip(e.kind, 16) : null, clip(e && e.text, 300),
  ));
  stmts.push(env.JOBS.prepare('DELETE FROM job_events WHERE job_id = ? AND seq <= ?').bind(id, seq - cap));
  await env.JOBS.batch(stmts);
  return use.length;
}

/** The tail of a job's shipped log, oldest first — read by the portal's job detail. */
export async function getEvents(env, id, limit = EVENTS_CAP) {
  if (!hasJobs(env)) return [];
  // Swallowed on purpose: an environment whose D1 predates job_events must still render the job
  // page. An empty tail is a missing convenience; a 500 is a missing page.
  try {
    const r = await env.JOBS.prepare(
      'SELECT at, level, kind, text FROM job_events WHERE job_id = ? ORDER BY seq ASC LIMIT ?',
    ).bind(id, limit).all();
    return (r && r.results) || [];
  } catch { return []; }
}

/** Drop a job's shipped log. Device-scoped via the jobs row, exactly as purgeChunks is. */
export async function purgeEvents(env, id, deviceId) {
  if (!hasJobs(env)) return false;
  try {
    await env.JOBS.prepare(
      `/* purge events */ DELETE FROM job_events WHERE job_id = ? AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND device_id = ?)`,
    ).bind(id, id, deviceId).run();
  } catch { return false; }
  return true;
}
