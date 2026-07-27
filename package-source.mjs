// Reviewer source bundle — the human-readable source a Chrome Web Store reviewer needs to reproduce
// dist/etaBulk.js via `npm ci && npm run build`. Excludes node_modules, built output, packaged zips,
// and screenshots. Ship this alongside the store upload if the reviewer asks about the minified bundle.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('./', import.meta.url));
const pkg = JSON.parse(readFileSync(root + 'package.json'));

// top-level files + directories to include (directories walked recursively)
const FILES = [
  'manifest.json', 'package.json', 'package-lock.json', 'csp-shim.js', 'bg.js', 'bridge.js',
  'build.mjs', 'package-ext.mjs', 'package-source.mjs',
  'README.md', 'STORE.md', 'PUBLISHING.md', 'PRIVACY.md', 'privacy.html',
  'LICENSE', 'NOTICE', '.github/workflows/test.yml',
];
const DIRS = ['src', 'assets', 'icons', 'test', 'vendor'];

const zip = new JSZip();
const add = (rel) => { try { zip.file(rel, readFileSync(root + rel)); } catch { /* optional file absent */ } };
for (const f of FILES) add(f);
function walk(dir) {
  for (const name of readdirSync(root + dir)) {
    const rel = dir + '/' + name;
    if (statSync(root + rel).isDirectory()) walk(rel); else add(rel);
  }
}
for (const d of DIRS) { try { walk(d); } catch { /* optional dir absent */ } }

const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
mkdirSync(root + 'dist-package/', { recursive: true });
const name = `eta-bulk-export-source-v${pkg.version}.zip`;
writeFileSync(root + 'dist-package/' + name, out);
const count = Object.values(zip.files).filter((f) => !f.dir).length;
console.log(`✓ dist-package/${name}  (${Math.round(out.length / 1024)} KB, ${count} files) — reproduce dist with: npm ci && npm run build`);
