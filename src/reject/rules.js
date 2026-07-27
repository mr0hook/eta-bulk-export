// Auto-Reject rule engine. Pure and deterministic (node-testable, no DOM/network): every verdict
// comes from named rules over the /details document, and the list of fired rules IS the explanation
// (design carried over from the Tahaqquq decision-engine spec). Fail-closed law: a document is
// pre-ticked ('reject') only when a hard rule fired on verified data — missing fields, absent tax
// lines or allow-list mode produce un-ticked 'flag' rows, never an automatic rejection.

// ── config ──────────────────────────────────────────────────────────────────
// Stored in localStorage (etaBulk_arCfg) by the drawer; normalizeCfg() makes any stored shape safe.
export const defaultCfg = () => ({
  v: 1,
  issuer: { mode: 'off', list: [] },            // 'off' | 'block' (list → reject) | 'allow' (not on list → flag)
  amount: { on: false, max: null, min: null },  // totalAmount > max → reject; < min → reject (either bound optional)
  vat: { on: false, tolPct: 2 },                // recomputed-vs-stated divergence beyond tolPct% → reject
  dup: { on: true },                            // issuer+internalID+total already seen → reject
  types: { on: false, invoice: true, credit: true, debit: true },   // unchecked type → reject
  windowDays: 14,                               // receiver-rejection legal window; older docs are listed but not tickable
});

const num = (v, d = null) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');   // TINs compare as bare digits

export function normalizeCfg(raw) {
  const d = defaultCfg();
  if (!raw || typeof raw !== 'object') return d;
  const mode = ['off', 'block', 'allow'].includes(raw.issuer?.mode) ? raw.issuer.mode : 'off';
  const list = Array.isArray(raw.issuer?.list) ? [...new Set(raw.issuer.list.map(digits).filter(Boolean))] : [];
  return {
    v: 1,
    issuer: { mode: list.length ? mode : 'off', list },   // an empty list disables either mode (an empty allow-list would flag EVERYTHING)
    amount: { on: !!raw.amount?.on, max: num(raw.amount?.max), min: num(raw.amount?.min) },
    vat: { on: !!raw.vat?.on, tolPct: Math.min(50, Math.max(0.1, num(raw.vat?.tolPct, 2))) },
    dup: { on: raw.dup ? !!raw.dup.on : true },
    types: { on: !!raw.types?.on, invoice: raw.types?.invoice !== false, credit: raw.types?.credit !== false, debit: raw.types?.debit !== false },
    windowDays: Math.min(365, Math.max(1, num(raw.windowDays, 14))),
  };
}

// ── document features ───────────────────────────────────────────────────────
// dateTimeRecevied is the API's REAL spelling (live-verified; see fixtures) — accept both just in case.
const receivedAt = (o) => o?.dateTimeRecevied || o?.dateTimeReceived || null;
const TYPE_KEY = { 'Invoice': 'invoice', 'Credit Note': 'credit', 'Debit Note': 'debit' };

export const dupKeyOf = (o) => {
  const iss = digits(o?.issuer?.id), inv = String(o?.internalID ?? ''), tot = num(o?.totalAmount);
  return iss && inv && tot != null ? `${iss}|${inv}|${tot.toFixed(2)}` : null;   // partial keys would collide → no key, no dup rule
};

// Recompute VAT from line taxable items and reconcile against the header taxTotals (same taxType set).
// Returns divergence in % of the stated total tax, or null when the document carries no verifiable
// tax data (→ VAT-UNVERIFIABLE flag, not a reject: fail-closed).
export function vatDivergencePct(o) {
  const stated = new Map();
  for (const t of o?.taxTotals || []) if (t?.taxType && num(t.amount) != null) stated.set(t.taxType, (stated.get(t.taxType) || 0) + t.amount);
  const lines = o?.invoiceLines;
  if (!stated.size || !Array.isArray(lines) || !lines.length) return null;
  const recomputed = new Map();
  let sawItem = false;
  for (const l of lines) for (const x of l?.lineTaxableItems || []) {
    if (!x?.taxType || num(x.amount) == null) continue;
    sawItem = true; recomputed.set(x.taxType, (recomputed.get(x.taxType) || 0) + x.amount);
  }
  if (!sawItem) return null;
  let statedSum = 0, diff = 0;
  for (const [k, v] of stated) { statedSum += Math.abs(v); diff += Math.abs(v - (recomputed.get(k) || 0)); }
  for (const [k, v] of recomputed) if (!stated.has(k)) diff += Math.abs(v);   // tax present on lines but absent from the header is a divergence too
  if (statedSum === 0) return diff === 0 ? 0 : 100;
  return (diff / statedSum) * 100;
}

// ── rules ───────────────────────────────────────────────────────────────────
// sev 'reject' → hard rule, pre-ticks the row; sev 'flag' → listed un-ticked for human judgment.
// en/ar are fully-resolved rejection reasons (sent to ETA; editable in the review list first).
const resolve = (tpl, p) => tpl.replace(/\{(\w+)\}/g, (m, k) => (p[k] !== undefined ? String(p[k]) : m));

// ctx: { seen:Set(dupKey) persisted across scans, nowMs } — evaluateDoc never mutates ctx.seen;
// the scanner registers keys itself so re-evaluating (e.g. a config tweak) can't self-poison.
export function evaluateDoc(cfg, o, ctx = {}) {
  const firings = [];
  const now = num(ctx.nowMs, Date.now());
  const dupKey = dupKeyOf(o);
  const p = {   // shared template params, resolved once per document
    issuer: `${o?.issuer?.name || ''} (${digits(o?.issuer?.id) || '?'})`.trim(),
    total: num(o?.totalAmount) != null ? o.totalAmount.toLocaleString('en-US') : '?',
    max: cfg.amount.max != null ? cfg.amount.max.toLocaleString('en-US') : '?',
    min: cfg.amount.min != null ? cfg.amount.min.toLocaleString('en-US') : '?',
    type: o?.documentTypeNameSecondaryLang || o?.documentTypeNamePrimaryLang || '?',
  };
  const fire = (id, sev, en, ar, extra) => firings.push({ id, sev, en: resolve(en, { ...p, ...extra }), ar: resolve(ar, { ...p, ...extra }) });

  // eligibility — the legal receiver-rejection window, from the received timestamp
  const rec = Date.parse(receivedAt(o) || '');
  const ageDays = Number.isFinite(rec) ? (now - rec) / 86400000 : null;
  const eligible = ageDays != null && ageDays >= 0 && ageDays <= cfg.windowDays;

  if (!o?.uuid || num(o?.totalAmount) == null || !digits(o?.issuer?.id)) {
    fire('DATA-MISSING', 'flag',
      'Document is missing core fields (uuid/issuer/total) — verify manually.',
      'المستند ينقصه بيانات أساسية (الرقم الإلكتروني/البائع/الإجمالي) — راجعه يدويًا.');
  }

  if (cfg.issuer.mode === 'block' && cfg.issuer.list.includes(digits(o?.issuer?.id))) {
    fire('ISSUER-BLOCKED', 'reject',
      'Issuer {issuer} is on the blocked-suppliers list.',
      'البائع {issuer} مدرج في قائمة الموردين المحظورين.');
  } else if (cfg.issuer.mode === 'allow' && digits(o?.issuer?.id) && !cfg.issuer.list.includes(digits(o?.issuer?.id))) {
    fire('ISSUER-NOT-ALLOWED', 'flag',
      'Issuer {issuer} is not on the trusted-suppliers list.',
      'البائع {issuer} ليس ضمن قائمة الموردين الموثوقين.');
  }

  const total = num(o?.totalAmount);
  if (cfg.amount.on && total != null) {
    if (cfg.amount.max != null && total > cfg.amount.max) fire('AMOUNT-OVER', 'reject',
      'Invoice total {total} exceeds the configured maximum of {max}.',
      'إجمالي الفاتورة {total} يتجاوز الحد الأقصى المحدد {max}.');
    if (cfg.amount.min != null && total < cfg.amount.min) fire('AMOUNT-UNDER', 'reject',
      'Invoice total {total} is below the configured minimum of {min}.',
      'إجمالي الفاتورة {total} أقل من الحد الأدنى المحدد {min}.');
  }

  if (cfg.vat.on) {
    const div = vatDivergencePct(o);
    if (div == null) fire('VAT-UNVERIFIABLE', 'flag',
      'Tax could not be recomputed from the document lines — verify manually.',
      'تعذّر إعادة احتساب الضريبة من بنود المستند — راجعه يدويًا.');
    else if (div > cfg.vat.tolPct) fire('VAT-MISMATCH', 'reject',
      'Stated tax diverges {div}% from the tax recomputed from the document lines.',
      'الضريبة المُعلنة تختلف بنسبة {div}% عن الضريبة المُعاد احتسابها من بنود المستند.',
      { div: div.toFixed(1) });
  }

  if (cfg.dup.on && dupKey && ctx.seen && ctx.seen.has(dupKey)) {
    fire('DUP', 'reject',
      'Duplicate of an already-received invoice (same issuer, internal no. and total).',
      'فاتورة مكررة لمستند سبق استلامه (نفس البائع والرقم الداخلي والإجمالي).');
  }

  if (cfg.types.on) {
    const k = TYPE_KEY[o?.documentTypeNamePrimaryLang];
    if (k && !cfg.types[k]) fire('TYPE-DISALLOWED', 'reject',
      'Document type "{type}" is not accepted per your criteria.',
      'نوع المستند "{type}" غير مقبول وفق المعايير المحددة.');
  }

  const verdict = firings.some((f) => f.sev === 'reject') ? 'reject' : firings.length ? 'flag' : 'pass';
  return { verdict, eligible, ageDays, dupKey, firings };
}
