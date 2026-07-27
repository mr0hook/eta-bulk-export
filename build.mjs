// No-remote-code bundle: esbuild inlines all src/ modules + the SDK code tables
// into a single classic IIFE loaded as a MAIN-world content script.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const dev = process.argv.includes('--dev');
const version = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url))).version;
await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  outfile: 'dist/etaBulk.js',
  target: ['chrome111'],   // MAIN-world content scripts require Chrome 111 (matches manifest minimum_chrome_version)
  loader: { '.json': 'json' },
  charset: 'ascii',        // escape all non-ASCII → guaranteed UTF-8-safe content script
  legalComments: 'none',
  define: { '__EXT_VERSION__': JSON.stringify(version) },   // sent to the backend for the version kill switch
  minify: !dev,
  sourcemap: dev,
  logLevel: 'info',
});
console.log('✓ built dist/etaBulk.js' + (dev ? ' (dev)' : ''));

// Generate bg.js (background service worker) with the backend origin pinned. Single source of truth is
// LEAD_URL in src/core/registration.js — the SW only ever fetches that exact origin, so the relay can't
// be abused to exfiltrate to another *.workers.dev host.
const regSrc = readFileSync(new URL('./src/core/registration.js', import.meta.url), 'utf8');
const leadMatch = regSrc.match(/LEAD_URL\s*=\s*['"]([^'"]+)['"]/);
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
