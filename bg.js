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

// SPEC-009 — overnight session keep-warm. A run talks only to api-portal.invoicing.eta.gov.eg, so
// the session host below goes hours without a single request and a sliding idle timeout logs the
// user out mid-run. Two jobs, both pinned to this exact origin (already in host_permissions):
//
//   eta-portal-warm  — credentialed GET, slides the idle timeout. Cheap, invisible, every 10 min.
//   eta-portal-renew — boots the portal in a BACKGROUND tab so the SPA's OIDC silent auth mints a
//                      fresh token into localStorage (shared with the run tab), then closes it.
//
// SECURITY: neither handler reads a URL from the message. The page can ask us to warm or renew THE
// PORTAL and nothing else — this cannot be repurposed into a general fetch/tab-open primitive.
const PORTAL_ORIGIN = 'https://invoicing.eta.gov.eg';
const RENEW_DWELL_MS = 12000;   // long enough for the SPA to boot and complete silent auth

async function portalWarm() {
  // Result is deliberately discarded: a 200, a 302 to the login page, or a network error are all
  // equally fine. The point is that the session host saw a live, cookie-bearing browser.
  try { await fetch(PORTAL_ORIGIN + '/', { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'follow' }); return true; }
  catch { return false; }
}

async function portalRenew() {
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: PORTAL_ORIGIN + '/', active: false });   // active:false — never steal the user's focus
    await new Promise((r) => setTimeout(r, RENEW_DWELL_MS));
    return true;
  } catch { return false; }
  finally { if (tab && tab.id != null) { try { await chrome.tabs.remove(tab.id); } catch {} } }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || (msg.type !== 'eta-portal-warm' && msg.type !== 'eta-portal-renew')) return false;
  (async () => {
    const ok = msg.type === 'eta-portal-warm' ? await portalWarm() : await portalRenew();
    sendResponse({ ok, status: ok ? 200 : 0 });
  })();
  return true;   // async sendResponse
});
// SPEC-033 — identity mirror. The extension's device id and creds used to live ONLY in the
// portal's own localStorage; a portal re-login wipes that, and the 2026-08-20 incident showed the
// cost: a fresh device id, a "not registered" verdict, and a re-registration refused with
// "device limit reached" because the allowance was already held by the id that had just been
// erased. chrome.storage.local belongs to the EXTENSION — no page action can clear it.
//
// SECURITY: the storage key is pinned here and only two fields are ever read or written, so this
// cannot be repurposed into general storage access from the page. The values are the same ones the
// page already holds in its own localStorage, so nothing new is exposed to it.
const ID_KEY = 'etaBulkIdentity';
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'eta-id-store') return false;
  (async () => {
    try {
      // Explicit, so a manifest missing "permissions": ["storage"] is a LOUD failure rather than a
      // mirror that silently never stores anything (2026-08-20 review, F-2).
      if (!chrome.storage || !chrome.storage.local) { sendResponse({ ok: false, error: 'no storage permission' }); return; }
      const cur = (await chrome.storage.local.get(ID_KEY))[ID_KEY] || {};
      // SPEC-038 (2026-08-20 review, L-2): sign HERE. The clientKey is every device's authenticator,
      // and handing it back to the MAIN world meant any script on the portal page could read it out
      // of the mirror and impersonate this device to the backend forever. The page now sends the
      // path and body and gets back only the headers — the key never crosses the bridge.
      if (msg.op === 'sign') {
        const key = cur.creds && cur.creds.clientKey;
        if (!key) { sendResponse({ ok: false, error: 'no key' }); return; }
        const enc = new TextEncoder();
        const bodyHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(msg.body || ''))))].map((b) => b.toString(16).padStart(2, '0')).join('');
        const ts = String(Math.floor(Date.now() / 1000));
        const nonce = crypto.randomUUID().replace(/-/g, '');
        const ck = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const sigBuf = await crypto.subtle.sign('HMAC', ck, enc.encode(`${ts}\n${nonce}\nPOST\n${String(msg.path || '')}\n${bodyHash}`));
        const signature = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
        sendResponse({ ok: true, ts, nonce, signature, deviceId: cur.deviceId || null });
        return;
      }
      if (msg.op === 'set') {
        const next = { ...cur };
        if (typeof msg.deviceId === 'string' && msg.deviceId) next.deviceId = msg.deviceId;
        if (msg.creds === null) delete next.creds;
        else if (msg.creds && typeof msg.creds === 'object' && typeof msg.creds.clientKey === 'string') next.creds = msg.creds;
        await chrome.storage.local.set({ [ID_KEY]: next });
        sendResponse({ ok: true });
        return;
      }
      // `creds` is deliberately NOT returned (SPEC-038 / L-2). The page gets the device id and
      // whether a key exists; to USE the key it must ask this worker to sign (op:'sign'), so the
      // credential itself never reaches a world that page scripts can read.
      sendResponse({ ok: true, deviceId: cur.deviceId || null, hasCreds: !!(cur.creds && cur.creds.clientKey) });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;   // async sendResponse
});
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
