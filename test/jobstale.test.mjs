// T-303 — a job nobody has checkpointed in 24 hours stops being live.
//
// Before this, `listResumable` offered a 'planned' job for ever (the drawer's Resume row) and
// `listActiveJobs` / the activeJobs counter kept every 'planning' row in the dashboard's "Running
// now" panel, so a tab closed last month still read as pending. The rule is one bound in SQL.
//
// These run the real queries against a fake D1 that records SQL + params, and also assert that every
// statement binds exactly as many values as it has placeholders — the bind-order mistake is the easy
// one to make when adding a ? to the front of a multi-parameter query.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listResumable } from '../lead-worker/src/jobs.js';
import { listActiveJobs, dashboardStats } from '../lead-worker/src/users.js';
import { JOB_STALE_MS } from '../lead-worker/src/lib/util.js';

function fakeDb() {
  const seen = [];
  const env = {
    JOBS: {
      prepare(sql) {
        const st = {
          sql,
          bind(...params) { seen.push({ sql, params }); return st; },
          async all() { return { results: [] }; },
          async first() { return {}; },
        };
        return st;
      },
    },
  };
  return { env, seen };
}

const placeholders = (sql) => (sql.match(/\?/g) || []).length;

test('T-303 the resume offer is bounded to the last 24h', async () => {
  const { env, seen } = fakeDb();
  const before = Date.now();
  await listResumable(env, 'dev-1');
  const q = seen.at(-1);
  assert.match(q.sql, /updated_at >= \?/, 'the query carries an age bound');
  assert.equal(q.params.length, placeholders(q.sql), 'one bound value per placeholder');
  const cutoff = Date.parse(q.params[1]);
  assert.ok(Math.abs((before - JOB_STALE_MS) - cutoff) < 5000, `cutoff is 24h back, got ${q.params[1]}`);
});

test('T-303b "Running now" and its counter use the same bound', async () => {
  const { env, seen } = fakeDb();
  await listActiveJobs(env);
  const a = seen.at(-1);
  assert.match(a.sql, /state IN \('planning','planned','running','merging'\) AND updated_at >= \?/);
  assert.equal(a.params.length, placeholders(a.sql), 'one bound value per placeholder');

  await dashboardStats(env, { since: '2026-09-20T00:00:00.000Z', horizon: '2026-10-04' });
  const d = seen.at(-1);
  assert.match(d.sql, /AS active_jobs/);
  assert.equal(d.params.length, placeholders(d.sql), 'one bound value per placeholder — the stale bound is FIRST');
  assert.ok(Date.parse(d.params[0]) < Date.now() - JOB_STALE_MS + 5000, 'and the first bound value is the 24h cutoff, not `since`');
  assert.equal(d.params[1], '2026-09-20T00:00:00.000Z', 'so `since` still lands on jobs_today');
});
