// No-remote-code bundle: esbuild inlines all src/ modules + the SDK code tables
// into a single classic IIFE loaded as a MAIN-world content script.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const dev = process.argv.includes('--dev');
const staging = process.argv.includes('--staging');

// Three things must agree or the extension silently cannot reach its backend: the LEAD_URL compiled
// into the bundle, the single origin bg.js is allowed to fetch, and the manifest's host_permissions.
// Switching targets by hand meant editing two files and remembering to undo both, so the target is a
// build flag and this file keeps all three in step.
const PROD_URL = 'https://eta-bulk-leads.omsoliman95.workers.dev';
const STAGING_URL = 'https://eta-bulk-leads-staging.omsoliman95.workers.dev';
const leadUrl = staging ? STAGING_URL : PROD_URL;

const manifestUrl = new URL('./manifest.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl));
const version = manifest.version;
await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  outfile: 'dist/etaBulk.js',
  target: ['chrome111'],   // MAIN-world content scripts require Chrome 111 (matches manifest minimum_chrome_version)
  loader: { '.json': 'json' },
  charset: 'ascii',        // escape all non-ASCII → guaranteed UTF-8-safe content script
  legalComments: 'none',
  define: {
    '__EXT_VERSION__': JSON.stringify(version),   // sent to the backend for the version kill switch
    '__LEAD_URL__': JSON.stringify(leadUrl),
  },
  minify: !dev,
  sourcemap: dev,
  logLevel: 'info',
});
console.log('✓ built dist/etaBulk.js' + (dev ? ' (dev)' : ''));

// Generate bg.js (background service worker) with the backend origin pinned. Single source of truth is
// LEAD_URL in src/core/registration.js — the SW only ever fetches that exact origin, so the relay can't
// be abused to exfiltrate to another *.workers.dev host.
const regSrc = readFileSync(new URL('./src/core/registration.js', import.meta.url), 'utf8');
// For a staging build the compiled LEAD_URL comes from the define, not the literal — read the same
// value the bundle got, or bg.js would pin production's origin and refuse every staging call.
const leadMatch = staging ? [null, leadUrl] : regSrc.match(/:\s*['"](https?:[^'"]+)['"]/);
// Derive the backend origin. If LEAD_URL is the intentional REPLACE-ME placeholder the gate is OFF
// (gateEnabled() is false), so bg.js never fetches and its origin is a harmless stub. But a LEAD_URL that
// is set-yet-malformed means the gate is ON against an origin we can't parse — fail LOUDLY rather than ship
// a build whose service worker silently rejects every backend call (the old fallback did exactly that).
let leadOrigin;
if (!leadMatch) throw new Error('LEAD_URL not found in src/core/registration.js — cannot generate bg.js.');
if (/REPLACE-ME/.test(leadMatch[1])) { leadOrigin = 'https://replace-me.invalid'; console.log('  ⚠ LEAD_URL is the placeholder — gate is OFF; bg.js origin is a harmless stub.'); }
else { try { leadOrigin = new URL(leadMatch[1]).origin; } catch { throw new Error(`LEAD_URL="${leadMatch[1]}" is not a valid URL — set your Worker URL in src/core/registration.js, then rebuild.`); } }
const bgOut = readFileSync(new URL('./src/bg.js', import.meta.url), 'utf8').split('__LEAD_ORIGIN__').join(leadOrigin);   // replace ALL occurrences
writeFileSync(new URL('./bg.js', import.meta.url), bgOut);
console.log('✓ generated bg.js (backend origin ' + leadOrigin + ')');

// host_permissions must contain whichever backend we just pinned, and must NOT contain the other:
// an unlisted extra host is a review question you don't want to answer, and a missing one means
// every backend call fails with an opaque network error.
const OTHER = staging ? PROD_URL : STAGING_URL;
const want = leadOrigin + '/*', drop = new URL(OTHER).origin + '/*';
const hosts = manifest.host_permissions.filter((h) => h !== drop);
if (!hosts.includes(want)) hosts.push(want);
if (JSON.stringify(hosts) !== JSON.stringify(manifest.host_permissions)) {
  manifest.host_permissions = hosts;
  writeFileSync(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');
  console.log('✓ manifest host_permissions → ' + want);
}
if (staging) {
  console.log('\n  ⚠ STAGING BUILD. manifest.json now points at staging — `git status` will show it.');
  console.log('    Run `npm run build` to go back to production. `npm run package` refuses a staging manifest.\n');
}
