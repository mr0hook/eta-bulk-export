// Entry (MAIN world). Mounts the unified drawer UI, which owns the orchestrator.
import { mountUI } from './ui/drawer.js';

(function () {
  if (window.__etaBulkMounted) return;
  window.__etaBulkMounted = true;
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason; if (r && (r.code || /eta|chunk|token|invoic|receipt/i.test(String(r.stack || r.message || '')))) console.warn('[ETA Bulk] unhandled', r); });
  try {
    // Do NOT publish the orchestrator on window: this runs in world:MAIN (shared global with the page),
    // and the orchestrator exposes dir() → the readwrite FileSystemDirectoryHandle. Keeping it only in the
    // drawer's module closure prevents a page-XSS / compromised portal asset from reaching the export folder.
    mountUI();
    console.log('[ETA Bulk] drawer mounted.');
  } catch (e) {
    console.error('[ETA Bulk] mount failed', e);
  }
})();
