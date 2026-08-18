// OIDC bearer from the portal's own localStorage. Never sent anywhere but the ETA API.
import { t as tr } from './i18n.js';

export function getToken() {
  try { return JSON.parse(localStorage.getItem('USER_DATA') || '{}').access_token || null; } catch { return null; }
}

// The ACTIVE taxpayer identity, not just the RIN. One login can hold several profiles that share
// a TaxRin and differ only in ProfId — and the portal's document visibility follows the profile.
// 2026-08-19 incident: a profile switch mid-run (another portal tab is enough) made every search
// return empty and /details return 403 while the RIN-based guard saw nothing wrong. The run
// snapshots this at start and pauses the moment it changes.
export function profileStamp() {
  try {
    const p = JSON.parse(localStorage.getItem('USER_DATA') || '{}').profile || {};
    return `${p.TaxRin || ''}:${p.ProfId || ''}`;
  } catch { return ':'; }
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
