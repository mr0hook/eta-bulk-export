// Rejection-window service. ETA configures the receiver-rejection window per DOCUMENT TYPE in
// documenttypes → workflowParameters. The public integration API that documents this lives on a
// different origin the extension cannot reach (origin guard, host_permissions, portal CSP,
// OAuth2), so we try the PORTAL-origin equivalent through the existing hardened client. That
// path is LIVE-UNVERIFIED: the parser never throws, failures are cached for a day so scans don't
// hammer a 404, and the fallback (source:'config') is byte-identical to the pre-F-03 behavior —
// the user's configured windowDays. The UI badge always shows which source is in effect.
import { API_ORIGIN } from '../api/sources.js';
import { apiGet } from '../api/client.js';
import { lsGet, lsSet } from '../core/ls.js';

export const WIN_KEY = 'rejWin';          // → localStorage etaBulk_rejWin
export const TTL_OK = 7 * 864e5;          // a good answer is stable — refetch weekly
export const TTL_FAIL = 864e5;            // a failed probe is retried daily, not per scan
const DT_BASE = API_ORIGIN + '/api/v1';   // same /api/v1 shape as documents/{uuid}/details

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : null));
// Map whatever the portal calls the type onto the documentTypeNamePrimaryLang vocabulary the
// details objects use. Credit/debit checked first — their names would never match /invoice/i,
// but the reverse guard costs nothing.
const typeOf = (name) => {
  const s = String(name || '');
  if (/credit/i.test(s) || /دائن/.test(s)) return 'Credit Note';
  if (/debit/i.test(s) || /مدين/.test(s)) return 'Debit Note';
  if (/invoice/i.test(s) || /فاتورة/.test(s)) return 'Invoice';
  return null;
};

// PURE + defensive: any surprise in the (unverified) shape → null, never a throw.
export function parseWorkflowWindows(listJson, detailJsons, nowMs = Date.now()) {
  try {
    if (!Array.isArray(detailJsons)) return null;
    const byType = {};
    const stamp = {};   // latest activeFrom wins when a type carries several active windows
    for (const d of detailJsons) {
      const t = typeOf(d?.name || d?.documentTypeNamePrimaryLang || d?.description);
      if (!t) continue;
      const params = Array.isArray(d?.workflowParameters) ? d.workflowParameters : [];
      for (const p of params) {
        const pname = String(p?.parameter ?? p?.name ?? '');
        if (!/reject/i.test(pname)) continue;
        const from = p?.activeFrom ? Date.parse(p.activeFrom) : null;
        const to = p?.activeTo ? Date.parse(p.activeTo) : null;
        if (from != null && (!Number.isFinite(from) || from > nowMs)) continue;
        if (to != null && (!Number.isFinite(to) || to <= nowMs)) continue;
        let days = num(p?.value);
        if (days == null) continue;
        if (/hour/i.test(pname)) days = days / 24;
        if (!(days >= 1 && days <= 365)) continue;   // implausible after unit conversion → not trusted
        if (stamp[t] == null || (from ?? 0) >= stamp[t]) { byType[t] = days; stamp[t] = from ?? 0; }
      }
    }
    return Object.keys(byType).length ? { byType } : null;
  } catch { return null; }
}

// Cache + fetch. Never throws except STOPPED (abort must propagate to the caller's flow).
export async function loadWindows({ signal, force = false } = {}, deps = { apiGet }) {
  const env = lsGet(WIN_KEY);
  const now = Date.now();
  if (!force && env && typeof env.at === 'number') {
    const age = now - env.at;
    if (env.ok && env.byType && age < TTL_OK) return { source: 'api', byType: env.byType, at: env.at };
    if (!env.ok && age >= 0 && age < TTL_FAIL) return { source: 'config', byType: null };
  }
  try {
    const listJson = await deps.apiGet(`${DT_BASE}/documenttypes`, { signal, attempts: 2 });
    const arr = listJson?.result || listJson?.documentTypes || (Array.isArray(listJson) ? listJson : []);
    const ids = (Array.isArray(arr) ? arr : []).map((x) => x?.id).filter((x) => x != null).slice(0, 12);
    const details = [];
    for (const id of ids) {
      try { details.push(await deps.apiGet(`${DT_BASE}/documenttypes/${encodeURIComponent(id)}`, { signal, attempts: 2 })); }
      catch (e) { if (e.code === 'STOPPED') throw e; }   // one broken type must not sink the rest
    }
    const parsed = parseWorkflowWindows(listJson, details, now);
    if (parsed) { lsSet(WIN_KEY, { at: now, ok: true, byType: parsed.byType }); return { source: 'api', byType: parsed.byType, at: now }; }
  } catch (e) {
    if (e.code === 'STOPPED') throw e;
  }
  lsSet(WIN_KEY, { at: now, ok: false, byType: null });
  return { source: 'config', byType: null };
}

// PURE: per-document window in days; cfg.windowDays when the service has nothing for the type.
export const makeResolver = (loaded, cfg) => (o) => {
  const v = loaded?.byType?.[o?.documentTypeNamePrimaryLang];
  return typeof v === 'number' && Number.isFinite(v) ? v : cfg.windowDays;
};
