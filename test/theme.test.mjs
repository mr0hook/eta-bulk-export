// Contrast guard for the drawer's theme tokens (both themes).
//
// The palette comes from the omarsoliman.dev design system, but a design system built for an
// editorial website is not automatically legible in a dense operational drawer: the site's own
// ink-4 and clay-5 both fail WCAG AA at the sizes this UI uses them. This test pins the ratios so
// a future palette edit cannot quietly regress legibility — which is exactly what had happened to
// --dim before the retheme (3.55 dark / 2.98 light, shipped).
//
// Thresholds: 4.5 for anything rendering text (the drawer's labels run 9-13px, so the large-text
// exemption never applies), 3.0 for purely decorative/­structural pairs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/ui/drawer.js', import.meta.url), 'utf8');

function tokens(selector) {
  const i = SRC.indexOf(selector);
  assert.ok(i > -1, 'token block not found: ' + selector);
  const block = SRC.slice(i, SRC.indexOf('--scheme:', i));
  const out = {};
  for (const [, k, v] of block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) out[k] = v;
  return out;
}

const srgb = (h) => {
  let x = h.replace('#', '');
  if (x.length === 3) x = [...x].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255);
};
const lum = (hex) => {
  const [r, g, b] = srgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

const DARK = tokens(':host{ all:initial;');
const LIGHT = tokens(':host([data-theme=light]){');

// [foreground, background, min, what it is]
const PAIRS = [
  ['--text', '--bg', 4.5, 'body text on the drawer'],
  ['--text', '--bg2', 4.5, 'text inside inputs and chips'],
  ['--text', '--bg-hd', 4.5, 'wordmark on the header'],
  ['--muted', '--bg', 4.5, 'secondary text'],
  ['--dim', '--bg', 4.5, 'micro-labels — the token that was failing before the retheme'],
  ['--dim', '--bg-hd', 4.5, 'the .tag line under the wordmark'],
  ['--gold', '--bg', 4.5, 'accent text (caps, step numerals)'],
  ['--gold', '--gold-chip', 4.5, 'step numeral on its chip'],
  ['--on-gold', '--gold', 4.5, 'primary button label, gradient bottom'],
  ['--on-gold', '--gold2', 4.5, 'primary button label, gradient top'],
  ['--gate-sub', '--bg', 4.5, 'gate screen subtitle'],
  ['--ok', '--ok-bg', 4.5, 'success chip'],
  ['--err', '--err-bg', 4.5, 'error chip'],
  ['--info-tx', '--info-bg', 4.5, 'info banner'],
  ['--warn-tx', '--warn-bg', 4.5, 'warning banner'],
  ['--ok', '--bg', 4.5, 'success text on the drawer'],
  ['--err', '--bg', 4.5, 'error text on the drawer'],
  ['--teal', '--bg', 3.0, 'progress fill — conveys run state, so 1.4.11 applies'],
  // Deliberately NOT asserted: --line / --line2 / --line3. Hairline borders are decorative in this
  // palette (and in the source design system), and --line3 is used in exactly one place —
  // .btn:hover border-color (drawer.js:106). A button stays identifiable by its own fill and
  // resting border without it, so 1.4.11's 3:1 does not attach to the hover accent. Asserting it
  // would have forced a heavier border than either design intends.
];

for (const [themeName, T] of [['dark', DARK], ['light', LIGHT]]) {
  test(`${themeName} theme — every token pair meets its contrast floor`, () => {
    const failures = [];
    for (const [fg, bg, min, what] of PAIRS) {
      assert.ok(T[fg], `${themeName}: missing ${fg}`);
      assert.ok(T[bg], `${themeName}: missing ${bg}`);
      const r = ratio(T[fg], T[bg]);
      if (r < min) failures.push(`  ${fg} (${T[fg]}) on ${bg} (${T[bg]}) = ${r.toFixed(2)}, need ${min} — ${what}`);
    }
    assert.equal(failures.length, 0, `${themeName} contrast failures:\n${failures.join('\n')}`);
  });
}

test('the retheme actually landed — palette is the warm clay-and-paper set', () => {
  assert.equal(DARK['--bg'], '#1a1712', 'dark surface should be paper-0 dark');
  assert.equal(DARK['--text'], '#f0eadb', 'dark text should be ink-1 dark');
  assert.equal(DARK['--gold'], '#e08358', 'dark accent should be clay');
  assert.equal(LIGHT['--bg'], '#faf6ee', 'light surface should be paper-0');
  assert.ok(!SRC.includes('#151a21'), 'the old cool-slate surface should be gone');
  assert.ok(!SRC.includes('#e3a552'), 'the old amber accent should be gone');
});

test('the light theme stays opt-in — the drawer defaults to dark', () => {
  // The drawer is injected into the ETA portal's white SPA and has to read as a separate
  // instrument. :host carries the dark set; light only applies under [data-theme=light].
  assert.ok(SRC.indexOf(':host{ all:initial;') < SRC.indexOf(':host([data-theme=light]){'));
  assert.match(SRC.slice(SRC.indexOf(':host{ all:initial;')), /^:host\{ all:initial;[\s\S]{0,2000}?--scheme:dark/);
});

test('the byline is RTL-safe', () => {
  const i = SRC.indexOf('.by{');
  assert.ok(i > -1, '.by rule missing');
  const rule = SRC.slice(i, SRC.indexOf('}', i));
  // A Latin domain inside an Arabic RTL header must be bidi-isolated or it reorders on screen.
  assert.match(rule, /direction:ltr/, '.by must pin LTR');
  assert.match(rule, /unicode-bidi:isolate/, '.by must isolate from surrounding RTL');
  assert.match(rule, /margin-inline-start/, '.by must use a logical margin so it flips with dir');
  assert.doesNotMatch(rule, /text-transform:uppercase/, 'uppercase + tracking breaks Arabic joining');
});
