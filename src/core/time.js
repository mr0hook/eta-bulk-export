// Cairo-local date helpers (browser runs in Cairo; run node tests with TZ=Africa/Cairo).
export const pad = (n) => String(n).padStart(2, '0');
export const dayStartISO = (d) => new Date(`${d}T00:00:00`).toISOString();
export const dayEndISO = (d) => new Date(`${d}T23:59:59.999`).toISOString();   // include the whole final second (granular DateTimeReceived/Submission)
export const ymd = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;

export function chunkLabel(fromISO, toISO) {
  const f = new Date(fromISO), t = new Date(toISO);
  const ld = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const lt = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const midnight = (d) => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
  const endday = (d) => d.getHours() === 23 && d.getMinutes() === 59;
  if (midnight(f) && endday(t)) return ld(f) === ld(t) ? ld(f) : `${ld(f)}→${ld(t)}`;
  return `${ld(f)} ${lt(f)}→${ld(t)} ${lt(t)}`;
}

export const safeName = (s) => String(s).replace(/[^0-9A-Za-z_\-]+/g, '_');

// Calendar day arithmetic on ymd strings via Date components — DST-safe (Egypt observes DST; adding
// 86400e3 ms across a spring-forward day would skip/duplicate a calendar day).
export const addDaysYmd = (d, n) => { const [y, m, dd] = String(d).split('-').map(Number); return ymd(new Date(y, m - 1, dd + n)); };
export const todayYmd = () => ymd(new Date());   // Cairo-local (tests run TZ=Africa/Cairo)
