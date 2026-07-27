// In-memory run log: timestamped, level-tagged, coalescing, ring-bounded. Pure (injectable clock) so
// tests can drive it; the drawer owns persistence (localStorage) and rendering. Coalescing: consecutive
// entries with the same meta.kind ('rate', 'page', 'probe', …) REPLACE the previous line instead of
// appending — a 3-hour run's 429 waits and per-page progress collapse to one live line each (×N).
export function createRunLog({ max = 200, maxBytes = 32768, now = Date.now } = {}) {
  let entries = [];   // { t, level, msg, n, kind? }
  const trim = () => {
    while (entries.length > max) entries.shift();
    while (entries.length > 1 && JSON.stringify(entries).length > maxBytes) entries.shift();
  };
  const api = {
    push(msg, meta) {
      const m = String(msg ?? ''), level = (meta && meta.level) || 'info', kind = (meta && meta.kind) || null;
      const last = entries[entries.length - 1];
      if (kind && last && last.kind === kind) { last.n = last.msg === m ? (last.n || 1) + 1 : 1; last.msg = m; last.t = now(); last.level = level; }
      else entries.push({ t: now(), level, msg: m, n: 1, ...(kind ? { kind } : {}) });
      trim();
    },
    entries: () => entries.slice(),
    lines: () => entries.map((e) => fmtT(e.t) + ' ' + e.msg + (e.n > 1 ? ' ×' + e.n : '')),
    text: () => api.lines().join('\n'),
    toJSON: () => entries.slice(),
    restore(v) {   // tolerates garbage / old shapes — a corrupt persisted log must never break mount
      try {
        const a = typeof v === 'string' ? JSON.parse(v) : v;
        entries = Array.isArray(a)
          ? a.filter((e) => e && typeof e.msg === 'string')
            .map((e) => ({ t: +e.t || 0, level: String(e.level || 'info'), msg: e.msg, n: +e.n || 1, ...(e.kind ? { kind: String(e.kind) } : {}) }))
          : [];
      } catch { entries = []; }
      trim();
    },
    clear() { entries = []; },
  };
  return api;
}
const fmtT = (t) => { const d = new Date(t || 0); const p = (n) => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };
