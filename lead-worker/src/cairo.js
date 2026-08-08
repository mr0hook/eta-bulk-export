// Cairo-fixed calendar arithmetic for the planner.
//
// WHY THIS FILE EXISTS. src/core/time.js does the same job in the browser using LOCAL time, which
// is correct there because the extension runs on an Egyptian taxpayer's machine. A Cloudflare
// Worker runs in UTC. Reusing those helpers server-side would shift every day boundary by Cairo's
// offset (2h/3h) and, worse, would apply DST rules for the wrong zone — silently moving chunk
// boundaries on exactly the days chunker.js:58-63 was written to get right.
//
// So the zone is named explicitly here rather than inherited from the runtime. test/planner.test.mjs
// pins these against src/core/time.js with the suite running TZ=Africa/Cairo: if the two ever
// disagree, the server would cut chunks where the browser would not.
const TZ = 'Africa/Cairo';

const DTF = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

const pad = (n) => String(n).padStart(2, '0');

// Cairo wall-clock components for an instant.
export function parts(instant) {
  const d = instant instanceof Date ? instant : new Date(instant);
  const p = {};
  for (const { type, value } of DTF.formatToParts(d)) if (type !== 'literal') p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, H: +p.hour % 24, M: +p.minute, S: +p.second };
}

// Cairo offset, in ms, at a given instant.
function offsetAt(ts) {
  const p = parts(ts);
  return Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S) - Math.floor(ts / 1000) * 1000;
}

// A Cairo wall-clock time → the UTC instant it names. Iterated twice so a DST transition settles:
// the first pass uses the offset at the wrong instant, the second uses the offset at (nearly) the
// right one. Egypt's transitions are 1h, so two passes converge.
export function zonedMs(y, m, d, H = 0, M = 0, S = 0, ms = 0) {
  const naive = Date.UTC(y, m - 1, d, H, M, S, ms);
  let ts = naive;
  for (let i = 0; i < 2; i++) ts = naive - offsetAt(ts);
  return ts;
}

export const dayStartISO = (ymdStr) => {
  const [y, m, d] = String(ymdStr).split('-').map(Number);
  return new Date(zonedMs(y, m, d, 0, 0, 0, 0)).toISOString();
};
export const dayEndISO = (ymdStr) => {
  const [y, m, d] = String(ymdStr).split('-').map(Number);
  return new Date(zonedMs(y, m, d, 23, 59, 59, 999)).toISOString();
};

// Cairo calendar date of an instant.
export const ymdOf = (instant) => { const p = parts(instant); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };

// Civil (timezone-free) day arithmetic on a YYYY-MM-DD string. Date.UTC handles month/year rollover
// and leap years; no zone is involved because no wall-clock time is.
export const addDays = (ymdStr, n) => {
  const [y, m, d] = String(ymdStr).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

// Whole Cairo days between two instants, by calendar date rather than elapsed ms — a 25-hour
// fall-back day still counts as one day.
export const daysBetween = (fromISO, toISO) => {
  const a = parts(fromISO), b = parts(toISO);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
};

// Byte-identical to src/core/time.js chunkLabel, but reading Cairo components explicitly.
export function chunkLabel(fromISO, toISO) {
  const f = parts(fromISO), t = parts(toISO);
  const ld = (p) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  const lt = (p) => `${pad(p.H)}:${pad(p.M)}`;
  const midnight = (p) => p.H === 0 && p.M === 0 && p.S === 0;
  const endday = (p) => p.H === 23 && p.M === 59;
  if (midnight(f) && endday(t)) return ld(f) === ld(t) ? ld(f) : `${ld(f)}→${ld(t)}`;
  return `${ld(f)} ${lt(f)}→${ld(t)} ${lt(t)}`;
}
