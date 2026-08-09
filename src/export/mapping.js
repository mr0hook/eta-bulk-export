// SPEC-021 — the export column MAPPING: sheet names + [key, header, width] column definitions.
//
// WHICH BEHAVIOUR IS AUTHORITATIVE — read this before changing anything here.
//
//   · The BUNDLED mapping below is authoritative for CORRECTNESS. It is a complete, working
//     mapping. With no network, no account and no cache, `mappingFor()` returns it and the export
//     is exactly what it has always been. A failed fetch can therefore never produce a spreadsheet
//     with missing or renamed columns — the fallback is not a degraded subset, it IS the shipped
//     layout.
//   · The SERVER mapping (lead-worker /export/mapping) is authoritative for CURRENCY. When the
//     worker is reachable, authorises the device, and returns a mapping at a revision >= the one
//     bundled here, its headers/widths/order win — that is what lets headers change without
//     shipping a build.
//
// The rule when they disagree is deliberately one-directional: the server may RENAME, RE-WIDTH,
// RE-ORDER and ADD columns; it may never REMOVE one. `validateMapping()` enforces that against the
// bundled key set, all-or-nothing. Dropping a column server-side would silently discard data the
// user has already paid (in time and portal quota) to fetch, and would do it invisibly — a build
// is the right place for that decision, not a KV edit.
//
// Nothing about invoice ROWS lives here or crosses the wire. This file is column metadata only;
// rendering and merging stay entirely on the device.
//
// This module is PURE and dependency-light on purpose (only ls.js): xlsx.js imports it, so every
// export test loads it. The network half lives in mapsync.js.
import { lsGet, lsSet } from '../core/ls.js';

// Bump BOTH this and lead-worker/src/mapping.js MAPPING_REVISION when the mapping changes.
// A cached mapping older than the build's own is ignored — see chooseMapping('older-revision').
// A smoke test pins the two trees byte-identical while the revisions are equal.
export const BUNDLED_REVISION = 1;

// A cached server mapping is only trusted for this long. Past it we cannot tell a correct mapping
// from one superseded months ago, so the build's own is used instead — that is what makes a stale
// cache DETECTABLE rather than silently authoritative forever.
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const CACHE_KEY = (source) => 'export_mapping_' + (source === 'receipts' ? 'receipts' : 'invoices');

// ---------------- the bundled mapping (moved verbatim from xlsx.js) ----------------
const INV = {
  key: 'invoices', summarySheet: 'جميع الفواتير', lineSheet: 'بيانات الفواتير',
  summary: [
    ['index', 'مسلسل', 10], ['details', 'تفاصيل', 10], ['type', 'نوع المستند', 12], ['version', 'نسخة المستند', 13],
    ['status', 'الحالة', 10], ['dateIssued', 'تاريخ الإصدار', 13], ['dateReceived', 'تاريخ التقديم', 13],
    ['currency', 'عملة الفاتورة', 13], ['totalSales', 'إجمالى المبيعات', 12], ['netAmount', 'قيمة الفاتورة', 12],
    ['totalAmount', 'إجمالى الفاتورة', 14], ['invoiceNumber', 'الرقم الداخلى', 23], ['uuid', 'الرقم الإلكترونى', 32],
    ['issuerId', 'الرقم الضريبى للبائع', 17], ['issuerName', 'إسم البائع', 32], ['issuerAddress', 'عنوان البائع', 32],
    ['receiverId', 'الرقم الضريبى للمشترى', 17], ['receiverName', 'إسم المشترى', 32], ['receiverAddress', 'عنوان المشترى', 32],
    ['purchaseOrderReference', 'مرجع طلب الشراء', 32], ['purchaseOrderDescription', 'وصف طلب الشراء', 32],
    ['salesOrderReference', 'مرجع طلب المبيعات', 32], ['salesOrderDescription', 'وصف طلب المبيعات', 32],
    ['signature', 'التوقيع الإلكترونى', 32], ['url', 'الرابط الخارجى', 120],
  ],
  lines: [
    ['type', 'نوع المستند', 12], ['version', 'نسخة المستند', 13], ['status', 'الحالة', 10], ['invoiceNumber', 'رقم الفاتورة', 23],
    ['dateIssued', 'تاريخ الإصدار', 13], ['dateReceived', 'تاريخ التقديم', 13], ['itemCode', 'كود الصنف', 14], ['internalCode', 'الكود الداخلى', 14],
    ['itemSecondaryName', 'إسم الكود', 14], ['description', 'الوصف', 25], ['unitType', 'كود الوحدة', 12], ['unitTypeName', 'إسم الوحدة', 20],
    ['unitValue', 'السعر', 10], ['quantity', 'الكمية', 10], ['salesTotal', 'المبيعات', 10], ['netTotal', 'القيمة', 10], ['total', 'الإجمالى', 10],
    ['issuerId', 'الرقم الضريبى للبائع', 17], ['issuerName', 'إسم البائع', 32], ['issuerAddress', 'عنوان البائع', 32],
    ['receiverId', 'الرقم الضريبى للمشترى', 17], ['receiverName', 'إسم المشترى', 32], ['receiverAddress', 'عنوان المشترى', 32],
    ['purchaseOrderReference', 'مرجع طلب الشراء', 32], ['purchaseOrderDescription', 'وصف طلب الشراء', 32],
    ['salesOrderReference', 'مرجع طلب المبيعات', 32], ['salesOrderDescription', 'وصف طلب المبيعات', 32],
    ['uuid', 'الرقم الإلكترونى', 32], ['signature', 'التوقيع الإلكترونى', 32],
  ],
};
const RCP = {
  key: 'receipts', summarySheet: 'جميع الإيصالات', lineSheet: 'بيانات الإيصالات',
  summary: [
    ['index', 'مسلسل', 10], ['details', 'تفاصيل', 10], ['type', 'نوع الإيصال', 12], ['status', 'الحالة', 10],
    ['dateTimeIssued', 'تاريخ الإصدار', 13], ['dateTimeReceived', 'تاريخ الإستلام', 13], ['currency', 'عملة الإيصال', 13],
    ['netAmount', 'قيمة الإيصال', 12], ['totalAmount', 'إجمالى الإيصال', 14], ['receiptNumber', 'رقم الإيصال', 23],
    ['uuid', 'الرقم الإلكترونى', 32], ['deviceSerialNumber', 'سيريال نقطة البيع', 17], ['submitterName', 'إسم نقطة البيع', 17],
    ['issuerId', 'الرقم الضريبى للبائع', 17], ['issuerName', 'إسم البائع', 32], ['issuerAddress', 'عنوان البائع', 32],
    ['receiverId', 'الرقم الضريبى للمشترى', 17], ['receiverName', 'إسم المشترى', 32], ['receiverMobileNumber', 'رقم المشترى', 32],
  ],
  lines: [
    ['type', 'نوع الإيصال', 12], ['receiptNumber', 'رقم الإيصال', 23], ['dateTimeIssued', 'تاريخ الإصدار', 13], ['dateTimeReceived', 'تاريخ الإستلام', 13],
    ['itemCode', 'كود الصنف', 14], ['itemCodeNameAr', 'إسم الكود', 14], ['description', 'الوصف', 25], ['unitPrice', 'السعر', 10],
    ['quantity', 'الكمية', 10], ['netSale', 'المبيعات', 10], ['netAmount', 'القيمة', 10], ['total', 'الإجمالى', 10],
    ['deviceSerialNumber', 'سيريال نقطة البيع', 17], ['submitterName', 'إسم نقطة البيع', 17],
    ['issuerId', 'الرقم الضريبى للبائع', 17], ['issuerName', 'إسم البائع', 32], ['issuerAddress', 'عنوان البائع', 32],
    ['receiverId', 'الرقم الضريبى للمشترى', 17], ['receiverName', 'إسم المشترى', 32], ['receiverMobileNumber', 'رقم المشترى', 32],
    ['uuid', 'الرقم الإلكترونى', 32], // added (base receipt line sheet lacks uuid) so merge can join
  ],
};

export const BUNDLED = { invoices: INV, receipts: RCP };
export const bundledFor = (source) => (source === 'receipts' ? RCP : INV);

// Columns never dropped: index/details are structural; uuid is the merge/repair dedup key. Lives
// here rather than in xlsx.js because it is part of the mapping CONTRACT — a served mapping that
// omits one of these is rejected outright, whatever else is right about it.
export const ALWAYS_KEEP = new Set(['index', 'details', 'uuid']);

// ---------------- validation ----------------
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function badCols(defs, mustHave) {
  if (!Array.isArray(defs) || !defs.length) return 'not a column list';
  const seen = new Set();
  for (const d of defs) {
    if (!Array.isArray(d) || d.length !== 3) return 'column is not a [key, header, width] triple';
    const [key, header, width] = d;
    if (typeof key !== 'string' || !KEY_RE.test(key)) return 'bad column key';
    if (typeof header !== 'string' || !header.trim()) return 'empty header for ' + key;
    if (typeof width !== 'number' || !Number.isFinite(width) || width < 1 || width > 255) return 'bad width for ' + key;
    if (seen.has(key)) return 'duplicate column key ' + key;
    seen.add(key);
  }
  // The one-directional rule: rename/reorder/re-width/add freely, never remove.
  for (const k of mustHave) if (!seen.has(k)) return 'served mapping drops column ' + k;
  return '';
}

/**
 * Validate a mapping payload against the bundled mapping for the same source.
 * All-or-nothing by design: a partially-applied mapping is exactly the silent-corruption failure
 * this whole mechanism exists to avoid, so there is no "use the good half".
 * @returns {{ ok: boolean, why: string }}
 */
export function validateMapping(m, bundled) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, why: 'not an object' };
  if (typeof m.summarySheet !== 'string' || !m.summarySheet.trim()) return { ok: false, why: 'no summary sheet name' };
  if (typeof m.lineSheet !== 'string' || !m.lineSheet.trim()) return { ok: false, why: 'no line sheet name' };
  if (m.summarySheet === m.lineSheet) return { ok: false, why: 'both sheets have the same name' };
  const s = badCols(m.summary, bundled.summary.map(([k]) => k));
  if (s) return { ok: false, why: 'summary: ' + s };
  const l = badCols(m.lines, bundled.lines.map(([k]) => k));
  if (l) return { ok: false, why: 'lines: ' + l };
  return { ok: true, why: '' };
}

// ---------------- choosing which mapping is in force ----------------
/**
 * Pure decision: given the bundled mapping and whatever is cached, which one renders this export?
 * Every rejection reason is named so the run log can say WHY the built-in layout is in use — a
 * stale cache that is silently ignored is as bad as one silently trusted.
 *
 * @param entry cached { revision, hash, at, mapping } (or null)
 * @returns { mapping, origin: 'server'|'bundled', reason, revision, ageMs }
 */
export function chooseMapping(bundled, entry, now = Date.now()) {
  const fallback = (reason) => ({ mapping: bundled, origin: 'bundled', reason, revision: BUNDLED_REVISION, ageMs: 0 });
  if (!entry || typeof entry !== 'object') return fallback('no-cache');
  const rev = Number(entry.revision);
  if (!Number.isInteger(rev) || rev < BUNDLED_REVISION) return fallback('older-revision');
  const at = Number(entry.at);
  if (!Number.isFinite(at) || at <= 0) return fallback('no-timestamp');
  const ageMs = now - at;
  // A clock that moved backwards (or a hand-written entry dated in the future) is not evidence of
  // freshness. Treat it as unusable rather than as infinitely fresh.
  if (ageMs < -60000) return fallback('future-timestamp');
  if (ageMs > MAX_AGE_MS) return fallback('expired');
  const v = validateMapping(entry.mapping, bundled);
  if (!v.ok) return fallback('invalid: ' + v.why);
  return { mapping: entry.mapping, origin: 'server', reason: '', revision: rev, ageMs: Math.max(0, ageMs) };
}

// ---------------- storage ----------------
export function readEntry(source) {
  const e = lsGet(CACHE_KEY(source));
  return (e && typeof e === 'object') ? e : null;
}
export function writeEntry(source, entry) { return lsSet(CACHE_KEY(source), entry); }

// ---------------- the accessors xlsx.js uses ----------------
// Deliberately SYNCHRONOUS and un-memoised: renderWorkbook is pure and synchronous, drawer.js calls
// removableColumns() straight from a render, and a module-level cache would need invalidating from
// two places. One small localStorage read per chunk is not worth that class of bug.
export function mappingStatus(source, now = Date.now()) {
  return chooseMapping(bundledFor(source), readEntry(source), now);
}
export function mappingFor(source) { return mappingStatus(source).mapping; }
