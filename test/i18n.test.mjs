// Catalog integrity: EN↔AR key + placeholder parity, interpolation, default-en, and a string-freeze
// guard for the EN values the rest of the test suite asserts against.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EN, AR, t, getLang, setLang } from '../src/core/i18n.js';

const params = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('key parity: every EN key has an AR translation and vice versa', () => {
  assert.deepEqual(Object.keys(AR).sort(), Object.keys(EN).sort());
});

test('placeholder parity: each key uses the same {params} in both languages', () => {
  for (const k of Object.keys(EN)) assert.deepEqual(params(AR[k]), params(EN[k]), `placeholders differ for ${k}`);
});

test('no empty values in either catalog', () => {
  for (const k of Object.keys(EN)) { assert.ok(String(EN[k]).length, 'EN ' + k); assert.ok(String(AR[k]).length, 'AR ' + k); }
});

test('t(): default lang is en; interpolation; missing params pass through; unknown key echoes', () => {
  assert.equal(getLang(), 'en', 'node tests have no stored lang → en');
  assert.equal(t('orch.pausedAt', { i: 3, n: 12 }), '⏸ Paused at 3/12.');
  assert.equal(t('orch.probe', { n: 1 }), 'Probe 1: {m}', 'missing param left visible, not undefined');
  assert.equal(t('nope.missing'), 'nope.missing');
});

test('setLang switches to Arabic and back; persists via localStorage when available', () => {
  const bag = new Map();
  globalThis.localStorage = { getItem: (k) => (bag.has(k) ? bag.get(k) : null), setItem: (k, v) => bag.set(k, String(v)), removeItem: (k) => bag.delete(k) };
  setLang('ar');
  assert.equal(getLang(), 'ar');
  assert.equal(t('ui.pause'), AR['ui.pause']);
  assert.equal(bag.get('etaBulk_lang'), '"ar"');
  setLang('en');
  assert.equal(t('ui.pause'), 'Pause');
  delete globalThis.localStorage;
});

// STRING-FREEZE GUARD: these EN values are asserted (as substrings) by orchestrator/merge tests and by
// the drawer's legacy sniffing. Changing them here without updating those tests will break the suite —
// this test makes that coupling explicit instead of a mystery failure.
test('string-freeze: test-coupled EN values are verbatim', () => {
  assert.equal(t('orch.allDetailsFailed', { count: 5, i: 1 }), 'all 5 detail fetches failed in chunk 1');
  assert.equal(t('orch.tokenLapsed').includes('waiting for the portal to renew'), true);
  assert.equal(t('orch.pausedNoToken', { i: 1, n: 1 }).includes('no fresh token appeared'), true);
  assert.equal(t('orch.tokenRenewed').startsWith('🔑 Token renewed'), true);
  assert.equal(t('orch.rateWait', { s: 5 }), '⏳ Rate-limited (429) — waiting 5s…');
  assert.equal(t('orch.doneSummary', { word: t('orch.doneOk'), done: 1, n: 1, failed: 0, drops: '', pdfs: '' }), '✅ Done: 1/1 chunks, 0 failed.');
  assert.equal(t('orch.dropLogFailed', { count: 2, msg: 'x' }).startsWith('could not record'), true);
  assert.equal(t('merge.skipped', { name: 'f.xlsx' }), '⚠️ SKIPPED (unreadable): f.xlsx');
  assert.equal(t('orch.rinMismatch').includes('no longer matches your registration'), true);
});

test('T-299 no duplicate literal keys — the parsed object cannot show them', async () => {
  // v0.16.0 shipped merge.reconcileHealed TWICE in AR: an earlier insert I believed had failed,
  // plus the corrected one. JS keeps the LAST literal so the right text won at runtime, but the
  // stale copy said "nothing was deleted" about a merge that now deletes — one reorder away from
  // the Arabic UI stating the opposite of what the code does. Object.keys() dedupes, so the parity
  // test above is blind to it; only the source text can tell.
  const src = await (await import('node:fs/promises')).readFile(new URL('../src/core/i18n.js', import.meta.url), 'utf8');
  const dupes = [];
  const tables = [['EN', src.slice(src.indexOf('export const EN'), src.indexOf('export const AR'))],
                  ['AR', src.slice(src.indexOf('export const AR'))]];
  for (const [name, body] of tables) {
    const seen = new Set();
    for (const m of body.matchAll(/^  '([^']+)':/gm)) {
      if (seen.has(m[1])) dupes.push(`${name} ${m[1]}`);
      seen.add(m[1]);
    }
  }
  assert.deepEqual(dupes, [], `duplicate i18n keys: ${dupes.join(', ')}`);
});
