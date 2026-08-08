// Contrast record for the drawer's theme tokens (both themes).
//
// The palette is the omarsoliman.dev design system, used UNMODIFIED — brand fidelity was chosen
// over contrast adjustment by explicit decision. Eleven pairs land below WCAG AA as a result.
//
// This test does NOT quietly accept them. Each one is listed in ACCEPTED with the ratio it actually
// measures, so:
//   * a token edit that changes any of those ratios fails the test rather than drifting silently;
//   * every pair NOT listed must still clear its floor;
//   * a pair that gets fixed must be removed from the list — the test rejects entries that now pass,
//     so ACCEPTED can never become stale cover for a value nobody re-checked.
//
// Floors: 4.5 for anything rendering text (drawer labels run 9-13px, so the large-text exemption
// never applies), 3.0 for non-text UI that conveys state.
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

const THEMES = { dark: tokens(':host{ all:initial;'), light: tokens(':host([data-theme=light]){') };

// The CSS template literal with /* comments */ stripped. Scans for hardcoded font families and for
// url()-based @font-face must look at rules only — the comments in that block legitimately discuss
// both, and matching them made three earlier versions of these tests fail on their own prose.
const CSS_CODE = (() => {
  const a = SRC.indexOf('const CSS = `');
  const css = SRC.slice(a, SRC.indexOf('`;', a));
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
})();

// [foreground, background, floor, what it is]
const PAIRS = [
  ['--text', '--bg', 4.5, 'body text on the drawer'],
  ['--text', '--bg2', 4.5, 'text inside inputs and chips'],
  ['--text', '--bg-hd', 4.5, 'wordmark on the header'],
  ['--muted', '--bg', 4.5, 'secondary text'],
  ['--dim', '--bg', 4.5, 'micro-labels — field labels, stat keys, hints'],
  ['--gold', '--bg', 4.5, 'accent text (caps, step numerals)'],
  ['--gold', '--bg-hd', 4.5, 'the omarsoliman.dev byline in the header'],
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
  // .btn:hover border-color. A button stays identifiable by its fill and resting border without it.
];

// Below-AA pairs accepted by explicit decision, with the ratio each actually measures.
// The light theme carries most of them: a paper palette built for an editorial website puts
// mid-tone terracotta under cream text, which is a marketing-page move, not a dense-UI one.
const ACCEPTED = {
  'dark --dim on --bg': 3.70,        // ink-4 on paper-0
  'light --dim on --bg': 3.05,
  'light --gold on --bg': 3.87,      // clay-5 as accent text
  'light --gold on --bg-hd': 4.10,   // the byline. In DARK it measures 5.97 and needs no exemption —
                                     // moving it off --dim improved it from 3.43.
  'light --gold on --gold-chip': 3.32,
  'light --on-gold on --gold': 4.10, // cream on clay-5 — the site's own primary button
  'light --on-gold on --gold2': 2.60,// cream on clay-4, the gradient's top. The worst pair here.
  'light --ok on --ok-bg': 4.18,     // green-6 on green-2
  'light --err on --err-bg': 4.43,   // red-6 on red-2
  'light --warn-tx on --warn-bg': 3.96, // amber-6 on amber-2
};

for (const [theme, T] of Object.entries(THEMES)) {
  test(`${theme} theme — unlisted pairs clear their floor`, () => {
    const failures = [];
    for (const [fg, bg, floor, what] of PAIRS) {
      assert.ok(T[fg], `${theme}: missing ${fg}`);
      assert.ok(T[bg], `${theme}: missing ${bg}`);
      if (`${theme} ${fg} on ${bg}` in ACCEPTED) continue;
      const r = ratio(T[fg], T[bg]);
      if (r < floor) failures.push(`  ${fg} (${T[fg]}) on ${bg} (${T[bg]}) = ${r.toFixed(2)}, need ${floor} — ${what}`);
    }
    assert.equal(failures.length, 0, `${theme} contrast failures:\n${failures.join('\n')}`);
  });
}

test('accepted below-AA pairs still measure exactly what was signed off', () => {
  const drift = [];
  for (const [key, expected] of Object.entries(ACCEPTED)) {
    const [theme, fg, , bg] = key.split(' ');
    const T = THEMES[theme];
    const actual = ratio(T[fg], T[bg]);
    if (Math.abs(actual - expected) > 0.02) {
      drift.push(`  ${key}: recorded ${expected}, now ${actual.toFixed(2)} — update the record or revert the token`);
    }
  }
  assert.equal(drift.length, 0, `accepted-pair drift:\n${drift.join('\n')}`);
});

test('the accepted list contains nothing that now passes', () => {
  // Stops ACCEPTED from outliving the problem it documents.
  const stale = [];
  for (const key of Object.keys(ACCEPTED)) {
    const [theme, fg, , bg] = key.split(' ');
    const floor = (PAIRS.find(([f, b]) => f === fg && b === bg) || [, , 4.5])[2];
    if (ratio(THEMES[theme][fg], THEMES[theme][bg]) >= floor) stale.push('  ' + key + ' now clears its floor — remove it');
  }
  assert.equal(stale.length, 0, `stale exemptions:\n${stale.join('\n')}`);
});

test('the palette is the design system, unmodified', () => {
  const D = THEMES.dark, L = THEMES.light;
  assert.equal(D['--bg'], '#1a1712', 'dark surface = paper-0 dark');
  assert.equal(D['--text'], '#f0eadb', 'dark text = ink-1 dark');
  assert.equal(D['--dim'], '#7a715c', 'dark faint = ink-4 dark, unadjusted');
  assert.equal(D['--gold'], '#e08358', 'dark accent = clay dark');
  assert.equal(L['--bg'], '#faf6ee', 'light surface = paper-0');
  assert.equal(L['--dim'], '#968d78', 'light faint = ink-4, unadjusted');
  assert.equal(L['--gold'], '#c2603b', 'light accent = clay-5, unadjusted');
  assert.equal(L['--ok'], '#2e7b4f', 'green-6, unadjusted');
  assert.equal(L['--err'], '#b23f2e', 'red-6, unadjusted');
  assert.equal(L['--warn-tx'], '#95680f', 'amber-6, unadjusted');
  assert.ok(!SRC.includes('#151a21'), 'the old cool-slate surface should be gone');
  assert.ok(!SRC.includes('#e3a552'), 'the old amber accent should be gone');
});

test('font tokens resolve — no self-reference, every stack ends in a system fallback', () => {
  // A bulk rewrite of font declarations once replaced the family names INSIDE these very
  // definitions, producing --font-ui:var(--font-ui). CSS treats that cycle as invalid at
  // computed-value time, so every one of the ~54 call sites silently lost its font-family.
  // Nothing else in the suite parses custom-property cycles, so this is the only guard.
  const decls = [...CSS_CODE.matchAll(/(--font-[\w-]+)\s*:\s*([^;}]+)[;}]/g)].map(([, k, v]) => [k, v.trim()]);
  assert.ok(decls.length >= 3, 'expected the ui / mono / ar font tokens');
  for (const [k, v] of decls) {
    assert.ok(!v.includes(`var(${k})`), `${k} refers to itself: ${v}`);
    // A token may alias another token (the RTL block points --font-ui at --font-ar); anything else
    // is a real stack and must bottom out in a generic family so a failed load still renders.
    if (/^var\(--font-[\w-]+\)$/.test(v)) continue;
    assert.match(v, /(sans-serif|monospace|serif)\s*$/, `${k} must end in a generic family: ${v}`);
  }
  const names = decls.map(([k]) => k);
  for (const need of ['--font-ui', '--font-mono', '--font-ar']) assert.ok(names.includes(need), 'missing ' + need);
});

test('every font declaration goes through a token — none hardcode a family', () => {
  const body = CSS_CODE.replace(/--font-[\w-]+\s*:[^;}]+[;}]/g, '');   // token definitions are the exception
  for (const bad of ['system-ui', 'ui-monospace', 'Bricolage', 'IBM Plex']) {
    assert.ok(!body.includes(bad), `"${bad}" is hardcoded in a rule — it belongs in a --font-* token`);
  }
});

test('the bundled faces are registered from bytes, never fetched', () => {
  // A url()-based @font-face would be subject to the ETA portal's CSP; FontFace(name, ArrayBuffer)
  // performs no fetch. If this ever regresses to a URL the fonts stop loading on the live portal
  // while still working in any local test page — a failure that only shows up in production.
  assert.match(SRC, /new FontFace\([^)]*bytes\.buffer/, 'faces must be constructed from an ArrayBuffer');
  assert.ok(!CSS_CODE.includes('@font-face'), 'no url()-based @font-face — the portal CSP would block it');
  assert.match(SRC, /installFonts\(\);/, 'installFonts must be called at mount');
});

test('the light theme stays opt-in — the drawer defaults to dark', () => {
  // The drawer is injected into the ETA portal's white SPA and has to read as a separate
  // instrument. :host carries the dark set; light only applies under [data-theme=light].
  const darkAt = SRC.indexOf(':host{ all:initial;');
  const lightAt = SRC.indexOf(':host([data-theme=light]){');
  assert.ok(darkAt > -1 && lightAt > darkAt, 'the unqualified :host block must come first');
  // --scheme:dark must close the FIRST block, i.e. fall between the two selectors. (Asserting a
  // character distance instead made this fail the moment the block grew by the font tokens.)
  const schemeDarkAt = SRC.indexOf('--scheme:dark');
  assert.ok(schemeDarkAt > darkAt && schemeDarkAt < lightAt, 'dark is the default set, not the override');
});

test('the byline is RTL-safe and not translated', () => {
  assert.ok(SRC.includes('<div class="tag">by omarsoliman.dev</div>'), 'byline markup missing');
  assert.ok(!SRC.includes('data-i18n="ui.tag"'), 'the byline must not be swapped by the translator');
  const i = SRC.indexOf('.tag{');
  const rule = SRC.slice(i, SRC.indexOf('}', i));
  // A Latin domain inside an Arabic RTL header must be bidi-isolated or it reorders on screen.
  assert.match(rule, /direction:ltr/, '.tag must pin LTR');
  assert.match(rule, /unicode-bidi:isolate/, '.tag must isolate from surrounding RTL');
  assert.doesNotMatch(rule, /text-transform:uppercase/, 'a domain is a name, not a label');
  assert.match(rule, /color:var\(--gold\)/, 'the byline carries the brand accent, not --dim');
  assert.doesNotMatch(rule, /ui-monospace/, 'the byline is a signature, not a mono field label');
});
