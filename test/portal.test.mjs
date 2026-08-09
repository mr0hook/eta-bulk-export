// Static guards for the admin portal (lead-worker/src/assets/dash.html).
//
// This file exists because a partially-finished portal was committed that PARSED, had balanced
// tags, and had zero external references — every structural check passed — while calling three
// functions that did not exist. It would have thrown a ReferenceError the moment its Activation
// section rendered. Structure is not execution, and the difference is invisible to a tag counter.
//
// The portal is one 240KB HTML file served as a Worker text module; there is no bundler and no
// linter in its path, so these are the only checks it gets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = readFileSync(new URL('../lead-worker/src/assets/dash.html', import.meta.url), 'utf8');
const BLOCKS = [...SRC.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const CODE = BLOCKS.join('\n;\n');

test('every inline script parses', () => {
  assert.ok(BLOCKS.length > 0, 'no inline scripts found — did the file structure change?');
  BLOCKS.forEach((code, i) => {
    const tmp = join(tmpdir(), `dash-block-${i}-${process.pid}.js`);
    writeFileSync(tmp, code);
    try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
    catch (e) { assert.fail(`inline script ${i} does not parse:\n${String(e.stderr || e).slice(0, 600)}`); }
    finally { try { unlinkSync(tmp); } catch {} }
  });
});

// Comments and string literals are full of prose that looks like code — "MAX(account, plan)" in a
// warning, "ensureSchema()" in a comment. Strip them, but KEEP ${…} interpolations: the portal
// renders through template literals, so most of its real calls live inside them.
function codeOnly(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:/])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, (lit) =>
      ' ' + [...lit.matchAll(/\$\{([\s\S]*?)\}/g)].map((m) => m[1]).join(' ; ') + ' ');
}

test('no bare function call references a name the file never declares', () => {
  const CODE = codeOnly(BLOCKS.join('\n;\n'));
  // Bare calls only — `foo(` but not `x.foo(`. A method call is the object's business, not ours.
  const called = new Set([...CODE.matchAll(/(?<![.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
  const declared = new Set([
    ...[...CODE.matchAll(/(?:function\s*\*?\s*|class\s+)([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...CODE.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    // destructured bindings and function params, which can legitimately hold callables
    ...[...CODE.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => s.split(':').pop().trim().split('=')[0].trim())),
    ...[...CODE.matchAll(/function\s*\*?\s*[\w$]*\s*\(([^)]*)\)/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/[=:\s]/)[0])),
    ...[...CODE.matchAll(/\(([^)]{0,200}?)\)\s*=>/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/[=:\s]/)[0])),
    ...[...CODE.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)].map((m) => m[1]),
    ...[...CODE.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  ].filter(Boolean));

  // Language keywords and the browser surface the portal legitimately uses.
  const OK = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await', 'do',
    'else', 'function', 'super', 'this', 'void', 'delete', 'in', 'of', 'yield', 'throw', 'case', 'with',
    'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'atob', 'btoa',
    'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'Promise', 'Error', 'Map',
    'Set', 'WeakMap', 'RegExp', 'Intl', 'URL', 'URLSearchParams', 'Blob', 'FormData', 'AbortController',
    'alert', 'confirm', 'prompt', 'queueMicrotask', 'structuredClone', 'matchMedia', 'getComputedStyle',
    'Symbol', 'BigInt', 'Proxy', 'Reflect', 'escape', 'unescape', 'reportError']);

  const missing = [...called].filter((n) => !declared.has(n) && !OK.has(n));
  assert.deepEqual(missing, [], `these are called but never declared in dash.html — a ReferenceError at runtime:\n  ${missing.join('\n  ')}`);
});

test('the portal is self-contained — a strict CSP blocks anything it does not carry', () => {
  // It is served as a Worker text module behind the same CSP that blocks the extension's webfonts.
  // A CDN link works perfectly on a developer's machine and fails silently in production.
  const refs = [...SRC.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]).filter((u) => /^(https?:)?\/\//.test(u));
  assert.deepEqual(refs, [], 'external references found');
  assert.ok(!/@import/.test(SRC), 'no @import');
  assert.ok(!/fetch\(\s*["'`]https?:/.test(SRC), 'no absolute-URL fetch');
});

test('the document is well-formed enough to serve', () => {
  for (const tag of ['html', 'head', 'body']) {
    const open = (SRC.match(new RegExp('<' + tag + '[\\s>]', 'g')) || []).length;
    const close = (SRC.match(new RegExp('</' + tag + '>', 'g')) || []).length;
    assert.equal(open, 1, `expected exactly one <${tag}>`);
    assert.equal(close, 1, `expected exactly one </${tag}>`);
  }
  assert.match(SRC.trim(), /^<!doctype html>/i);
});
