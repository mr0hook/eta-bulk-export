// PO reconciliation engine — pure functions only (no DOM, no network, no ExcelJS import: the
// caller hands over an already-loaded workbook). Matching and utilization are deterministic and
// order-stable so an auditor can reproduce every number from the input sheet + the invoice list.
// Out-of-period and over-consumption are WARNINGS for the user — they never feed the reject flow.

// ── cell coercion ───────────────────────────────────────────────────────────
// ExcelJS materializes cells as: string | number | Date (UTC) | {richText} | {text} |
// {formula,result} | null. Real user sheets add comma-grouped numbers, DD/MM/YYYY strings and
// raw Excel serials. Everything funnels through these three.
const pad = (n) => String(n).padStart(2, '0');
const EXCEL_EPOCH_OFFSET = 25569;            // serial 25569 = 1970-01-01
const SERIAL_MIN = 20000, SERIAL_MAX = 60000; // ~1954..2064 — outside this a bare number is not a date

export function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return cellYmd(v) || '';
  if (Array.isArray(v.richText)) return v.richText.map((r) => r?.text ?? '').join('').trim();
  if (v.text != null) return String(v.text).trim();
  if (v.result !== undefined) return cellText(v.result);
  return String(v).trim();
}

export function cellNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v != null && typeof v === 'object' && v.result !== undefined) return cellNumber(v.result);
  const s = cellText(v).replace(/[,\s ]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function cellYmd(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) return null;
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;   // UTC getters — ExcelJS date cells are UTC
  }
  if (typeof v === 'number') {
    if (!(v >= SERIAL_MIN && v <= SERIAL_MAX)) return null;
    return cellYmd(new Date(Math.round((v - EXCEL_EPOCH_OFFSET) * 86400000)));
  }
  if (typeof v === 'object' && v.result !== undefined) return cellYmd(v.result);
  const s = cellText(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);   // DD/MM/YYYY (Egyptian convention)
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
}

// ── header mapping ──────────────────────────────────────────────────────────
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
// NFC + strip tatweel + fold hamza-alef variants + alef-maqsura + collapse whitespace + lowercase
const normHdr = (s) => String(s == null ? '' : s).normalize('NFC')
  .replace(/ـ/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي')
  .replace(/\s+/g, ' ').trim().toLowerCase();

const ALIASES = {
  company: ['company name', 'company', 'supplier name', 'اسم الشركة', 'الشركة', 'اسم المورد', 'المورد'],
  tin: ['registration number', 'tax registration number', 'supplier tin', 'tin', 'الرقم الضريبي', 'رقم التسجيل', 'رقم التسجيل الضريبي', 'الرقم الضريبي للمورد', 'الرقم الضريبي للبائع'],
  poNumber: ['po number', 'po no', 'po', 'purchase order', 'purchase order number', 'رقم امر الشراء', 'رقم طلب الشراء', 'مرجع طلب الشراء', 'امر الشراء'],
  totalAmount: ['po total amount', 'po amount', 'total amount', 'po total', 'قيمة امر الشراء', 'اجمالي امر الشراء', 'قيمة طلب الشراء'],
  validFrom: ['po valid from', 'valid from', 'from', 'ساري من', 'بداية السريان', 'من'],
  validTo: ['po valid to', 'valid to', 'to', 'ساري الي', 'نهاية السريان', 'الي'],
};
const NORM_ALIASES = Object.fromEntries(Object.entries(ALIASES).map(([k, v]) => [k, new Set(v.map(normHdr))]));
const coded = (code) => Object.assign(new Error(code), { code });

// headerCells: ExcelJS row.values (index 0 unused). Returns { company, tin, ... } → column index.
export function headerMapOf(headerCells) {
  const map = {};
  for (let i = 1; i < (headerCells?.length || 0); i++) {
    const h = normHdr(cellText(headerCells[i]));
    if (!h) continue;
    for (const [field, set] of Object.entries(NORM_ALIASES)) if (map[field] === undefined && set.has(h)) map[field] = i;
  }
  const missing = ['tin', 'poNumber'].filter((f) => map[f] === undefined);
  if (missing.length) throw Object.assign(coded('PO_HEADERS'), { missing });
  return map;
}

// ── PO parsing ──────────────────────────────────────────────────────────────
// Normalized PO-number key: NFC, drop every separator (space/dash/dot/slash — "PO 100",
// "PO-100" and "po.100" are the same order), uppercase; purely-numeric values collapse to
// their digits so 100 (number cell) equals '100' (text cell).
export function poKeyOf(v) {
  const s = cellText(v).normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '').toUpperCase();
  if (!s) return null;
  return /^\d+$/.test(s) ? String(Number(s)) : s;
}

// wb: an already-loaded ExcelJS workbook (first worksheet, row 1 = headers).
export function parsePoWorkbook(wb) {
  const ws = wb?.worksheets?.[0];
  if (!ws) throw coded('PO_HEADERS');
  const map = headerMapOf(ws.getRow(1).values);
  const pos = [], rowWarnings = [];
  const seen = new Set();
  ws.eachRow((row, rn) => {
    if (rn === 1) return;
    const cell = (f) => (map[f] === undefined ? null : row.values[map[f]]);
    const tin = digits(cellText(cell('tin')));
    const poNumber = cellText(cell('poNumber'));
    const poKey = poKeyOf(poNumber);
    if (!tin && !poKey) return;   // blank/decorative row
    if (!tin || !poKey) { rowWarnings.push({ row: rn, id: 'PO-ROW-INCOMPLETE' }); return; }   // half-filled row can't be matched safely
    const warnings = [];
    const dupKey = `${tin}|${poKey}`;
    if (seen.has(dupKey)) { rowWarnings.push({ row: rn, id: 'PO-DUP' }); return; }   // first wins
    seen.add(dupKey);
    const totalAmount = cellNumber(cell('totalAmount'));
    const validFrom = cellYmd(cell('validFrom'));
    const validTo = cellYmd(cell('validTo'));
    if (totalAmount == null) warnings.push('PO-NO-AMOUNT');
    if (!validFrom || !validTo) warnings.push('PO-NO-DATES');
    pos.push({ row: rn, company: cellText(cell('company')), tin, poNumber, poKey, totalAmount, validFrom, validTo, warnings });
  });
  return { pos, rowWarnings };
}

// ── invoice projection & matching ───────────────────────────────────────────
export function projectInvoice(o) {
  return {
    uuid: o?.uuid, internalID: o?.internalID, issuerId: digits(o?.issuer?.id), issuerName: o?.issuer?.name,
    totalAmount: typeof o?.totalAmount === 'number' ? o.totalAmount : null,
    typeEn: o?.documentTypeNamePrimaryLang, typeAr: o?.documentTypeNameSecondaryLang,
    dateIssuedYmd: String(o?.dateTimeIssued || '').slice(0, 10) || null,
    receivedIso: o?.dateTimeRecevied || o?.dateTimeReceived || null,   // API's real misspelling first
    purchaseOrderReference: o?.purchaseOrderReference || null, status: o?.status,
  };
}

const inPeriod = (po, ymd) => !!(po.validFrom && po.validTo && ymd && po.validFrom <= ymd && ymd <= po.validTo);

// Deterministic: (1) poKey equality (TIN-matching candidate preferred, else first in sheet
// order) → 'po-ref'; unknown ref falls through with PO-REF-UNKNOWN. (2) TIN + issue date inside
// validity → 'tin-period' (several → lowest validFrom, PO-AMBIGUOUS). (3) 'none' + NO-PO-MATCH.
export function matchInvoice(pos, inv) {
  const warnings = [];
  const refKey = poKeyOf(inv.purchaseOrderReference);
  if (refKey) {
    const cands = pos.filter((p) => p.poKey === refKey);
    if (cands.length) {
      const po = cands.find((p) => p.tin === inv.issuerId) || cands[0];
      if (po.validFrom && po.validTo && !inPeriod(po, inv.dateIssuedYmd)) warnings.push('OUT-OF-PO-PERIOD');
      return { matchType: 'po-ref', po, warnings };
    }
    warnings.push('PO-REF-UNKNOWN');
  }
  const cands = pos.filter((p) => p.tin && p.tin === inv.issuerId && inPeriod(p, inv.dateIssuedYmd));
  if (cands.length) {
    const po = [...cands].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0))[0];
    if (cands.length > 1) warnings.push('PO-AMBIGUOUS');
    return { matchType: 'tin-period', po, warnings };
  }
  warnings.push('NO-PO-MATCH');
  return { matchType: 'none', po: null, warnings };
}

// ── analytics ───────────────────────────────────────────────────────────────
const EPS = 0.005;   // money epsilon: display-grade analytics, never accounting postings

export function analyzePo(pos, invoices, { resolveWindow, windowDays = 14, nowMs = Date.now(), fetchFailed = 0 } = {}) {
  // utilization accumulates in issue-date order so "which invoice crossed the PO" is well-defined
  const ordered = [...invoices].sort((a, b) =>
    (a.dateIssuedYmd || '') < (b.dateIssuedYmd || '') ? -1 : (a.dateIssuedYmd || '') > (b.dateIssuedYmd || '') ? 1 : String(a.uuid).localeCompare(String(b.uuid)));

  const acc = new Map();   // po → { utilized, invCount, exceeded }
  for (const p of pos) acc.set(p, { utilized: 0, invCount: 0, exceeded: false });

  const perInvoice = [];
  for (const inv of ordered) {
    const m = matchInvoice(pos, inv);
    const warnings = [...m.warnings];
    if (m.po) {
      const a = acc.get(m.po);
      a.invCount++;
      const sign = inv.typeEn === 'Credit Note' ? -1 : 1;   // mirrors the export's negativeCredit treatment
      a.utilized += sign * (inv.totalAmount || 0);
      if (m.po.totalAmount != null && a.utilized > m.po.totalAmount + EPS) a.exceeded = true;
      if (a.exceeded) warnings.push('PO-EXCEEDED');   // the crossing doc and everything after it
    }
    // rejection-window status — resolver speaks the details vocabulary
    const wd = (resolveWindow && Number.isFinite(resolveWindow({ documentTypeNamePrimaryLang: inv.typeEn }))) ? resolveWindow({ documentTypeNamePrimaryLang: inv.typeEn }) : windowDays;
    const rec = Date.parse(inv.receivedIso || '');
    const ageDays = Number.isFinite(rec) ? (nowMs - rec) / 86400000 : null;
    const window = ageDays == null || ageDays < 0
      ? { days: wd, ageDays: null, daysLeft: null, status: 'unknown' }
      : ageDays <= wd
        ? { days: wd, ageDays, daysLeft: wd - ageDays, status: 'can-reject' }
        : { days: wd, ageDays, daysLeft: 0, status: 'window-passed' };
    perInvoice.push({ ...inv, matchType: m.matchType, poKey: m.po?.poKey ?? null, poNumber: m.po?.poNumber ?? null, warnings, window });
  }

  const perPo = pos.map((p) => {
    const a = acc.get(p);
    return {
      ...p, invCount: a.invCount, utilized: a.utilized,
      remaining: p.totalAmount != null ? p.totalAmount - a.utilized : null,
      utilizationPct: p.totalAmount ? (a.utilized / p.totalAmount) * 100 : null,
      exceeded: a.exceeded,
    };
  });

  const bySup = new Map();
  for (const i of perInvoice) {
    const k = i.issuerId || '?';
    const s = bySup.get(k) || { tin: k, name: i.issuerName || '', invCount: 0, totalAmount: 0, matchedCount: 0, unmatchedCount: 0, warnCount: 0 };
    s.invCount++;
    s.totalAmount += (i.typeEn === 'Credit Note' ? -1 : 1) * (i.totalAmount || 0);
    if (i.matchType === 'none') s.unmatchedCount++; else s.matchedCount++;
    s.warnCount += i.warnings.length;
    if (!s.name && i.issuerName) s.name = i.issuerName;
    bySup.set(k, s);
  }

  const totals = {
    invoices: perInvoice.length,
    matched: perInvoice.filter((i) => i.matchType !== 'none').length,
    unmatched: perInvoice.filter((i) => i.matchType === 'none').length,
    warnings: perInvoice.reduce((s, i) => s + i.warnings.length, 0),
    exceededPos: perPo.filter((p) => p.exceeded).length,
    fetchFailed,
  };
  return { perInvoice, perPo, perSupplier: [...bySup.values()], totals };
}
