// Cairo local time with Egypt DST. Faithful replica of the base builder's formatter:
// DST window = last Friday of April → last Thursday of October → +3, else +2.
// Returns a Date shifted so its instant reads as Cairo wall-clock when ExcelJS serializes it.
// (Boundary dates are computed with local Date construction — run node tests with TZ=Africa/Cairo.)
export function dateEg(iso) {
  if (!iso) return null;
  const t = new Date(iso);
  const y = t.getUTCFullYear();
  const apr = new Date(y, 3, 30);
  const dstStart = new Date(apr);
  dstStart.setDate(30 - (apr.getDay() + 2) % 7);
  const oct = new Date(y, 9, 31);
  const dstEnd = new Date(oct);
  dstEnd.setDate(31 - (oct.getDay() + 3) % 7);
  const off = (t >= dstStart && dstEnd > t) ? 3 : 2;
  return new Date(t.getTime() + 3600000 * off);
}
