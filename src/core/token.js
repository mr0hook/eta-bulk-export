// OIDC bearer from the portal's own localStorage. Never sent anywhere but the ETA API.
import { t as tr } from './i18n.js';

export function getToken() {
  try { return JSON.parse(localStorage.getItem('USER_DATA') || '{}').access_token || null; } catch { return null; }
}

// The ACTIVE taxpayer identity: RIN + profile id together. One login can hold several ENTITIES
// (each with its own TaxRin) and the portal's document visibility follows the active one.
// 2026-08-19 incident: a cold portal load re-authenticated and flipped the active entity mid-run —
// every search went empty and /details returned 403 — and the per-chunk RIN guard saw nothing
// wrong, because it asks "is this RIN one the device is ENTITLED to?" and the switched-to entity
// was also registered on the account. The run therefore snapshots this stamp at start and pauses
// the moment it changes: a run belongs to the exact identity it started under, entitled or not.
export function profileStamp() {
  try {
    const p = JSON.parse(localStorage.getItem('USER_DATA') || '{}').profile || {};
    return `${p.TaxRin || ''}:${p.ProfId || ''}`;
  } catch { return ':'; }
}

// SPEC-023: everything a run needs to PIN its entity — the stamp to detect a switch, and the
// numeric TaxId the portal's own switchtaxpayer endpoint takes to switch back.
export function profileInfo() {
  try {
    const p = JSON.parse(localStorage.getItem('USER_DATA') || '{}').profile || {};
    return { stamp: `${p.TaxRin || ''}:${p.ProfId || ''}`, taxId: p.TaxId || '' };
  } catch { return { stamp: ':', taxId: '' }; }
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
