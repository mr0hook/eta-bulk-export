// T-305 — the default deploy target and [env.production] publish to the SAME worker name, so they
// must carry the SAME bindings.
//
// 2026-09-20 incident: D1 was added under [env.staging] and [env.production] only. wrangler does not
// inherit bindings into environments — and, the direction that bit here, the top-level config is its
// own target. A bare `wrangler deploy` therefore replaced the live worker with a build that had no
// JOBS binding: /api/dashboard answered "portal unavailable — no D1 binding", /plan/* answered 503
// "planner unavailable", and nothing in the deploy output said a binding had been dropped.
//
// Parsed with a small regex reader rather than a TOML dependency — the file uses exactly two shapes
// (an inline-table array for KV, [[table]] blocks for the rest) and this only needs binding names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const toml = readFileSync(new URL('../lead-worker/wrangler.toml', import.meta.url), 'utf8');

// Everything from `header` until the next environment section. The header must be matched at the
// START of a line: the comments in this file quote section names, and matching one of those reads
// the wrong block (which is how the first draft of this test "passed" the wrong thing).
function section(name) {
  let start = 0;
  if (name) {
    const m = new RegExp(`^\\[${name.replace(/\./g, '\\.')}\\]\\s*$`, 'm').exec(toml);
    assert.ok(m, `wrangler.toml has no [${name}] section`);
    start = m.index + m[0].length;
  }
  const rest = toml.slice(start);
  const end = rest.search(/^\[env\./m);
  return end < 0 ? rest : rest.slice(0, end);
}

// binding = "NAME" (the [[table]] blocks) plus binding = "NAME" inside inline tables (kv_namespaces).
const bindings = (text) => [...text.matchAll(/binding\s*=\s*"([^"]+)"/g)].map((m) => m[1]).sort();
const dbIds = (text) => [...text.matchAll(/database_id\s*=\s*"([^"]+)"/g)].map((m) => m[1]);

test('T-305 a bare deploy carries the same bindings as --env production', () => {
  const top = bindings(section(''));
  const prod = bindings(section('env.production'));
  assert.deepEqual(top, prod,
    'the default target and [env.production] publish to the same worker name — a binding in one and not the other means a bare `wrangler deploy` silently strips it');
  assert.ok(top.includes('JOBS'), 'JOBS (D1) is the one that was lost; it must be in both');
  assert.deepEqual(dbIds(section('')), dbIds(section('env.production')),
    'and they must point at the SAME database — production data, not staging');
});

test('T-305b staging stays a separate worker with its own resources', () => {
  const stg = section('env.staging');
  assert.match(stg, /name\s*=\s*"eta-bulk-leads-staging"/, 'staging has its own worker name');
  assert.notDeepEqual(dbIds(stg), dbIds(section('env.production')), 'and its own database');
});
