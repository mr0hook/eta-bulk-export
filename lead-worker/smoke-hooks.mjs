// Node module-resolution hooks so the Worker source runs unmodified under plain `node`.
// Registered by smoke-worker.mjs before it imports ./worker.js.
//
// Two things Node cannot load on its own:
//   1. `cloudflare:workers` — the DurableObject base class. Stubbed; the smoke exercises the
//      KV-fallback paths (env.LOCKS is absent), so the stub is never instantiated.
//   2. `*.html` — served in production by wrangler's [[rules]] type = "Text". Mirrored here as a
//      module whose default export is the file's text, which is exactly what that rule produces.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const STUB = 'stub:cloudflare-workers';

export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: STUB, shortCircuit: true };
  if (specifier.endsWith('.html')) {
    const url = new URL(specifier, context.parentURL).href;
    return { url, format: 'module', shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === STUB) {
    return { format: 'module', shortCircuit: true, source: 'export class DurableObject { constructor() {} }' };
  }
  if (url.endsWith('.html')) {
    const text = await readFile(fileURLToPath(url), 'utf8');
    return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(text) + ';' };
  }
  return next(url, context);
}
