// OIDC bearer from the portal's own localStorage. Never sent anywhere but the ETA API.
import { t as tr } from './i18n.js';

export function getToken() {
  try { return JSON.parse(localStorage.getItem('USER_DATA') || '{}').access_token || null; } catch { return null; }
}

export function tokenStatus() {
  const t = getToken();
  if (!t) return { ok: false, label: tr('tok.notFound') };
  try {
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (p.exp == null) return { ok: true, left: 0, label: tr('tok.present') };   // valid token, unknown TTL — don't treat as expired
    const left = p.exp * 1000 - Date.now();
    if (left <= 0) return { ok: false, left: 0, label: tr('tok.expired') };
    return { ok: true, left, label: tr('tok.left', { m: Math.floor(left / 60000) }) };
  } catch { return { ok: !!t, left: 0, label: tr('tok.present') }; }
}
