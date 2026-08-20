// ISOLATED-world bridge (runs at document_start, before the MAIN-world bundle).
//
// The MAIN-world bundle can't touch chrome.* APIs, and its own fetch() to the backend is CSP-blocked.
// So it posts a window message here; we relay to the background service worker (which does the real
// cross-origin fetch) and post the reply back. MAIN and ISOLATED worlds share the same `window`, so
// window.postMessage is the channel between them.
//
// Trust model: this content script only runs on the ETA portal origin, which the whole tool already
// trusts (it reads the portal's own auth token from the page). Messages are correlated by id.
(function () {
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;                 // same-frame only
    var d = e.data;
    if (!d || d.__eta !== 'req' || !d.id) return;
    // SPEC-009: session keep-warm. Only the KIND crosses the bridge — no url, no options. The
    // service worker builds the portal URL from its own pinned constant.
    if (d.kind === 'portal-warm' || d.kind === 'portal-renew') {
      try {
        chrome.runtime.sendMessage(
          { type: d.kind === 'portal-warm' ? 'eta-portal-warm' : 'eta-portal-renew' },
          function (resp) {
            var err0 = chrome.runtime.lastError;
            window.postMessage({ __eta: 'res', id: d.id, result: err0 ? { ok: false, status: 0, error: err0.message } : (resp || { ok: false, status: 0, error: 'no response' }) }, location.origin);
          }
        );
      } catch (ex0) {
        window.postMessage({ __eta: 'res', id: d.id, result: { ok: false, status: 0, error: String((ex0 && ex0.message) || ex0) } }, location.origin);
      }
      return;
    }
    // SPEC-033: the extension-owned identity mirror. Only op/deviceId/creds cross — the service
    // worker pins the storage key itself, so this can never become a general storage primitive.
    if (d.kind === 'id-store') {
      var p = d.payload || {};
      try {
        chrome.runtime.sendMessage(
          { type: 'eta-id-store', op: p.op, deviceId: p.deviceId, creds: p.creds },
          function (resp) {
            var err1 = chrome.runtime.lastError;
            window.postMessage({ __eta: 'res', id: d.id, result: err1 ? { ok: false, error: err1.message } : (resp || { ok: false, error: 'no response' }) }, location.origin);
          }
        );
      } catch (ex1) {
        window.postMessage({ __eta: 'res', id: d.id, result: { ok: false, error: String((ex1 && ex1.message) || ex1) } }, location.origin);
      }
      return;
    }
    if (d.kind === 'lead-fetch') {
      try {
        chrome.runtime.sendMessage(
          { type: 'eta-lead-fetch', url: d.url, method: d.method, headers: d.headers, body: d.body },
          function (resp) {
            var err = chrome.runtime.lastError;
            window.postMessage({ __eta: 'res', id: d.id, result: err ? { ok: false, status: 0, error: err.message } : (resp || { ok: false, status: 0, error: 'no response' }) }, location.origin);
          }
        );
      } catch (ex) {
        window.postMessage({ __eta: 'res', id: d.id, result: { ok: false, status: 0, error: String((ex && ex.message) || ex) } }, location.origin);
      }
    }
  });
})();
