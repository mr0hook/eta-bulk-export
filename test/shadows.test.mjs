// Guard against import shadowing inside drawer.js's mountUI. A local `const t = …` once shadowed the
// imported i18n t() across the whole function scope → "Cannot access 't' before initialization" at
// mount (TDZ), which no node test can catch because mountUI needs a DOM. This static scan can.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

test('drawer.js: no local declaration shadows an imported identifier inside mountUI', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/ui/drawer.js', import.meta.url)), 'utf8');
  const imports = [...src.matchAll(/^import\s*\{([^}]+)\}\s*from/gm)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  assert.ok(imports.includes('t'), 'sanity: the i18n t import is present');
  const body = src.slice(src.indexOf('export function mountUI'));
  const offenders = [];
  for (const name of imports) {
    const re = new RegExp('(?:const|let|var|function)\\s+' + name + '\\b|\\(\\s*' + name + '\\s*\\)\\s*=>', 'g');
    let m; while ((m = re.exec(body))) offenders.push(name + ' @ …' + body.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, ' '));
  }
  assert.deepEqual(offenders, [], 'imported identifiers re-declared inside mountUI (TDZ / wrong-binding hazard)');
});
