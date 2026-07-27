// Code-table lookups from the bundled official ETA SDK data (public reference data).
import codes from '../../assets/codes/eta_codes.normalized.json' with { type: 'json' };

const byCode = (arr) => { const m = new Map(); for (const x of arr) if (!m.has(x.code)) m.set(x.code, x); return m; };

const TAX = byCode(codes.taxTypes.concat(codes.nonTaxableTaxTypes));
const SUB = byCode(codes.taxSubtypes);
const UNIT = byCode(codes.unitTypes.concat(codes.weightUnitTypes));
const CUR = byCode(codes.currencies);

// Column widths preserved from the base builder's getTaxTypeDescription for layout parity.
const TAX_WIDTH = {
  T1: 18, T2: 18, T3: 18, T4: 22, T5: 22, T13: 22, T6: 30, T14: 30, T7: 14, T15: 14,
  T8: 18, T16: 18, T9: 12, T17: 12, T10: 14, T18: 14, T11: 18, T19: 18, T12: 12, T20: 12,
};

// Official Arabic tax name. For an UNKNOWN code, append the code itself so two different unknown codes
// produce DIFFERENT headers — merge.js unions line/summary columns by header name, so a shared fallback
// header would collapse two distinct taxes into one column and overwrite one value with the other.
export const taxName = (code) => (TAX.get(code)?.ar) || ('ضريبة غير معروفة ' + code);
export const taxWidth = (code) => TAX_WIDTH[code] || 15;
export const subtypeName = (code) => (SUB.get(code)?.ar) || code;
export const unitName = (code) => { const u = UNIT.get(code); return u ? (u.ar || u.en || code) : code; };
export const currencyName = (code) => { const c = CUR.get(code); return c ? (c.en || code) : code; };

export { codes };
