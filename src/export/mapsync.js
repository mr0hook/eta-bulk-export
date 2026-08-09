// SPEC-021 — the network half of the export mapping. Kept OUT of mapping.js on purpose: xlsx.js
// (and therefore every export test) imports the pure module, and nothing that renders a sheet
// should be able to reach the network by accident.
//
// AUTHORITATIVE BEHAVIOUR, restated where it is implemented:
//   · This function is BEST-EFFORT and never throws. If it cannot talk to the worker, the export
//     proceeds on the last validated server mapping (while it is still current) or on the bundled
//     one. Both are complete mappings — the export is correct either way, which is exactly why a
//     failed fetch is allowed to be quiet rather than fatal.
//   · The server's answer is accepted ONLY if it validates against the bundled key set and carries
//     a revision at least as new as this build's. Anything else is discarded and NOT cached: a
//     mapping we half-trust is worse than no mapping at all.
import { exportMapping, taxpayerId, EXT_VERSION } from '../core/registration.js';
import { BUNDLED_REVISION, bundledFor, validateMapping, readEntry, writeEntry, mappingStatus } from './mapping.js';

/**
 * Refresh the cached mapping for one source. Call once per run, before the first render.
 *
 * @param source 'invoices' | 'receipts'
 * @param deps.call   injected transport (tests); defaults to the signed /export/mapping call
 * @param deps.now    injected clock (tests)
 * @returns { origin:'server'|'bundled', reason, revision, ageMs, fetched:boolean, error:string }
 *          `origin` is what the NEXT render will use — the same answer mappingStatus() gives.
 */
export async function refreshMapping(source, deps = {}) {
  const call = deps.call || exportMapping;
  const now = deps.now || (() => Date.now());
  const bundled = bundledFor(source);
  const before = readEntry(source);
  let error = '';

  try {
    const res = await call({
      source: source === 'receipts' ? 'receipts' : 'invoices',
      have: (before && typeof before.hash === 'string') ? before.hash : '',
      rin: taxpayerId(), version: EXT_VERSION,
    });

    if (!res || !res.ok) {
      error = (res && (res.error || (res.network ? 'network' : ''))) || 'unavailable';
    } else if (res.unchanged) {
      // The server confirmed the cached mapping is still the current one. Re-stamp it so a
      // long-lived install doesn't age out a mapping that is demonstrably still right.
      if (before) writeEntry(source, { ...before, at: now() });
    } else {
      const rev = Number(res.revision);
      const v = validateMapping(res.mapping, bundled);
      if (!Number.isInteger(rev) || rev < BUNDLED_REVISION) error = 'served revision ' + res.revision + ' is older than this build (' + BUNDLED_REVISION + ')';
      else if (!v.ok) error = 'rejected: ' + v.why;
      else writeEntry(source, { revision: rev, hash: String(res.hash || ''), at: now(), mapping: res.mapping });
    }
  } catch (e) {
    error = String((e && e.message) || e);
  }

  return { ...mappingStatus(source, now()), fetched: !error, error };
}
