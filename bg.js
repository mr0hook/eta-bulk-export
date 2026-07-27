// Background service worker — network proxy for the managed backend (the "lead" worker).
//
// Why this exists: the registration / session code runs in the page's MAIN world, where a fetch() to an
// external origin is blocked by the ETA portal's Content-Security-Policy (connect-src allows only ETA
// hosts). A service worker is NOT bound by the page CSP and can call the backend cross-origin. The MAIN
// world talks to us through bridge.js.
//
// SECURITY: the destination is pinned to the EXACT backend origin (baked from LEAD_URL at build time), not
// the whole *.workers.dev space — so this relay can never be abused by an in-page script to exfiltrate the
// portal's data to some other worker past the page CSP. Only same-extension messages reach onMessage.
//
// The LEAD_ORIGIN value below is injected by build.mjs from new URL(LEAD_URL).origin (src/core/registration.js).
const LEAD_ORIGIN = 'https://eta-bulk-leads.omsoliman95.workers.dev';
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'eta-lead-fetch') return false;
  (async () => {
    try {
      const u = new URL(String(msg.url || ''));
      if (u.origin !== LEAD_ORIGIN) {
        console.warn('[ETA Bulk] blocked host: request to ' + u.origin + ' but the backend is pinned to ' + LEAD_ORIGIN + '. Fix: set LEAD_URL in src/core/registration.js to your Worker URL, run `npm run build`, then remove + re-add the extension.');
        sendResponse({ ok: false, status: 0, error: 'backend origin mismatch — rebuild after setting LEAD_URL (pinned to ' + LEAD_ORIGIN + ')' });
        return;
      }
      const init = { method: msg.method || 'GET', headers: msg.headers || {}, redirect: 'manual' };
      if (msg.body != null && init.method !== 'GET') init.body = msg.body;
      // redirect:'manual' + this guard closes an origin-pin bypass: without it a 3xx from the backend would make
      // fetch silently re-issue the signed request (headers + body) to an arbitrary off-origin URL and return
      // THAT response as the authoritative gate verdict. An opaqueredirect or any off-origin final URL is rejected.
      const r = await fetch(u.href, init);
      if (r.type === 'opaqueredirect' || (r.redirected && new URL(r.url).origin !== LEAD_ORIGIN)) {
        sendResponse({ ok: false, status: 0, error: 'backend redirected off-origin — refusing to follow' });
        return;
      }
      let json = null;
      try { json = await r.json(); } catch { /* non-JSON / empty */ }
      sendResponse({ ok: r.ok, status: r.status, json });
    } catch (e) {
      console.warn('[ETA Bulk] backend fetch failed:', String((e && e.message) || e));
      sendResponse({ ok: false, status: 0, error: String((e && e.message) || e) });
    }
  })();
  return true;   // keep the message channel open for the async sendResponse
});
