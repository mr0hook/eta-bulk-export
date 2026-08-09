// Package the extension for Chrome Web Store upload — only the runtime files, no dev/source.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import JSZip from 'jszip';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url)));
if (manifest.version !== pkg.version) {
  throw new Error(`version mismatch: manifest.json is ${manifest.version} but package.json is ${pkg.version} — bump both to the same value before packaging (CWS rejects a re-upload without a higher manifest version).`);
}
// A staging build is indistinguishable from a production one once it is a zip — same version, same
// files, and the only difference is a backend the public cannot reach. Shipping one would look like
// a total outage to every user who updated. Refuse loudly instead.
const stagingHost = manifest.host_permissions.find((h) => /-staging\./.test(h));
if (stagingHost) {
  throw new Error(`refusing to package a STAGING build: manifest.json still permits ${stagingHost}. Run \`npm run build\` to retarget production, then package again.`);
}
if (readFileSync(new URL('./bg.js', import.meta.url), 'utf8').includes('-staging.')) {
  throw new Error('refusing to package: bg.js is pinned to the staging origin. Run `npm run build` first.');
}

const FILES = [
  'manifest.json',
  'bg.js',
  'bridge.js',
  'csp-shim.js',
  'dist/etaBulk.js',
  'vendor/exceljs.min.js',
  'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png',
  'LICENSE', 'NOTICE',
];

const zip = new JSZip();
for (const f of FILES) {
  const u = new URL('./' + f, import.meta.url);
  if (!existsSync(u)) throw new Error('missing shipping file: ' + f + ' (run `npm run build` first)');
  zip.file(f, readFileSync(u));
}
const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
mkdirSync(new URL('./dist-package/', import.meta.url), { recursive: true });
const name = `eta-bulk-export-v${pkg.version}.zip`;
writeFileSync(new URL('./dist-package/' + name, import.meta.url), out);
console.log(`✓ dist-package/${name}  (${Math.round(out.length / 1024)} KB, ${FILES.length} files)`);
