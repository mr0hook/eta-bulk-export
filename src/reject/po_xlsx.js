// PO analytics report + input-template renderers — same house style as export/xlsx.js (RTL,
// frozen header, thin borders, status fills, cleanRow on EVERY row so a later "Repair files"
// pass never flags or rewrites the report). Pure: caller supplies the ExcelJS constructor.
// Sheet/column headers are Arabic constants (xlsx.js precedent), not i18n catalog entries.
import { cleanRow } from '../export/sanitize.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const RTL = { rightToLeft: true, rtl: true, activeCell: 'A1', state: 'frozen', ySplit: 1 };
const THIN = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const FILL = { valid: solid('FFC6EFCE'), warn: solid('FFFFE699'), bad: solid('FFFFC7CE') };

// Arabic labels for engine warning ids / window statuses — exported so the drawer's on-screen
// rows (F-06) say exactly what the report says.
export const WARN_AR = {
  'OUT-OF-PO-PERIOD': 'خارج فترة سريان أمر الشراء',
  'NO-PO-MATCH': 'بدون أمر شراء مطابق',
  'PO-AMBIGUOUS': 'تطابق مع أكثر من أمر شراء',
  'PO-REF-UNKNOWN': 'مرجع أمر شراء غير معروف',
  'PO-EXCEEDED': 'تجاوز قيمة أمر الشراء',
  'PO-NO-AMOUNT': 'أمر شراء بدون قيمة',
  'PO-NO-DATES': 'أمر شراء بدون فترة سريان',
  'PO-DUP': 'أمر شراء مكرر — اعتُمد الأول',
  'PO-ROW-INCOMPLETE': 'صف ناقص البيانات — تم تجاهله',
};
export const WINDOW_AR = {
  'can-reject': 'متاح الرفض',
  'window-passed': 'انتهت النافذة — اطلب إشعار دائن من البائع',
  'unknown': 'غير مؤكد',
};
const warnText = (ids) => ids.map((id) => WARN_AR[id] || id).join('، ');
const num2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : v ?? '');

function addTable(wb, name, cols, rows, fillOf) {
  const ws = wb.addWorksheet(name);
  ws.views = [RTL];
  ws.columns = cols;
  for (const r of rows) {
    const row = ws.addRow(cleanRow(r));
    row.eachCell({ includeEmpty: true }, (c) => (c.border = THIN));
    const f = fillOf ? fillOf(r) : null; if (f) row.fill = f;
  }
  ws.autoFilter = { from: 'A1', to: { row: rows.length + 1, column: cols.length } };
  return ws;
}

// meta: { from, to, generatedAt, version, windowSource: 'api'|'config', windowDays }
export function renderPoAnalytics(ExcelJS, analysis, meta = {}) {
  const wb = new ExcelJS.Workbook();
  const t = analysis.totals || {};

  // 1 — summary (key/value pairs; array rows)
  const s0 = wb.addWorksheet('الملخص');
  s0.views = [RTL];
  s0.columns = [{ key: 'k', header: 'البند', width: 34 }, { key: 'v', header: 'القيمة', width: 44 }];
  const kv = [
    ['فترة البحث (تاريخ التقديم)', `${meta.from ?? ''} ← ${meta.to ?? ''}`],
    ['تاريخ الإنشاء', meta.generatedAt ?? ''],
    ['إصدار الأداة', meta.version ?? ''],
    ['مصدر مهلة الرفض', meta.windowSource === 'api' ? 'مصلحة الضرائب (حسب نوع المستند)' : `افتراضي ${meta.windowDays ?? ''} يوم`],
    ['عدد الفواتير المفحوصة', t.invoices ?? 0],
    ['مطابقة لأمر شراء', t.matched ?? 0],
    ['غير مطابقة', t.unmatched ?? 0],
    ['إجمالي التحذيرات', t.warnings ?? 0],
    ['أوامر شراء متجاوزة القيمة', t.exceededPos ?? 0],
    ['مستندات تعذّر التحقق منها', t.fetchFailed ?? 0],   // fail-closed: unverifiable docs are surfaced, never hidden
    ['عدد الموردين', (analysis.perSupplier || []).length],
    ['أوامر الشراء المحمّلة', (analysis.perPo || []).length],
  ];
  for (const pair of kv) {
    const row = s0.addRow(cleanRow([...pair]));
    row.eachCell({ includeEmpty: true }, (c) => (c.border = THIN));
  }

  // 2 — POs
  addTable(wb, 'أوامر الشراء', [
    { key: 'company', header: 'الشركة', width: 28 }, { key: 'tin', header: 'الرقم الضريبى للمورد', width: 17 },
    { key: 'poNumber', header: 'رقم أمر الشراء', width: 18 }, { key: 'totalAmount', header: 'قيمة أمر الشراء', width: 15 },
    { key: 'validFrom', header: 'ساري من', width: 12 }, { key: 'validTo', header: 'ساري إلى', width: 12 },
    { key: 'invCount', header: 'عدد الفواتير', width: 11 }, { key: 'utilized', header: 'إجمالى الفواتير المطابقة', width: 18 },
    { key: 'remaining', header: 'المتبقى', width: 13 }, { key: 'utilizationPct', header: 'نسبة الاستخدام %', width: 14 },
    { key: 'exceeded', header: 'تجاوز؟', width: 9 }, { key: 'notes', header: 'ملاحظات', width: 30 },
  ], (analysis.perPo || []).map((p) => ({
    company: p.company, tin: p.tin, poNumber: p.poNumber, totalAmount: num2(p.totalAmount),
    validFrom: p.validFrom ?? '', validTo: p.validTo ?? '', invCount: p.invCount, utilized: num2(p.utilized),
    remaining: num2(p.remaining), utilizationPct: num2(p.utilizationPct),
    exceeded: p.exceeded ? 'نعم' : 'لا', notes: warnText(p.warnings || []),
  })), (r) => (r.exceeded === 'نعم' ? FILL.bad : r.notes ? FILL.warn : null));

  // 3 — suppliers
  addTable(wb, 'الموردون', [
    { key: 'tin', header: 'الرقم الضريبى', width: 17 }, { key: 'name', header: 'إسم البائع', width: 32 },
    { key: 'invCount', header: 'عدد الفواتير', width: 11 }, { key: 'totalAmount', header: 'إجمالى الفواتير', width: 15 },
    { key: 'matched', header: 'مطابقة', width: 10 }, { key: 'unmatched', header: 'غير مطابقة', width: 11 },
    { key: 'warns', header: 'تحذيرات', width: 10 },
  ], (analysis.perSupplier || []).map((s) => ({
    tin: s.tin, name: s.name, invCount: s.invCount, totalAmount: num2(s.totalAmount),
    matched: s.matchedCount, unmatched: s.unmatchedCount, warns: s.warnCount,
  })), (r) => (r.unmatched > 0 || r.warns > 0 ? FILL.warn : null));

  // 4 — invoices
  addTable(wb, 'الفواتير', [
    { key: 'index', header: 'مسلسل', width: 8 }, { key: 'uuid', header: 'الرقم الإلكترونى', width: 32 },
    { key: 'internalID', header: 'الرقم الداخلى', width: 20 }, { key: 'type', header: 'نوع المستند', width: 12 },
    { key: 'dateIssued', header: 'تاريخ الإصدار', width: 13 }, { key: 'issuerId', header: 'الرقم الضريبى للبائع', width: 17 },
    { key: 'issuerName', header: 'إسم البائع', width: 30 }, { key: 'totalAmount', header: 'إجمالى الفاتورة', width: 14 },
    { key: 'poRef', header: 'مرجع طلب الشراء', width: 18 }, { key: 'matchedPo', header: 'أمر الشراء المطابق', width: 18 },
    { key: 'matchType', header: 'طريقة المطابقة', width: 13 }, { key: 'warnings', header: 'تحذيرات', width: 34 },
    { key: 'window', header: 'نافذة الرفض', width: 34 }, { key: 'daysLeft', header: 'الأيام المتبقية', width: 12 },
  ], (analysis.perInvoice || []).map((i, n) => ({
    index: n + 1, uuid: i.uuid, internalID: i.internalID ?? '', type: i.typeAr || i.typeEn || '',
    dateIssued: i.dateIssuedYmd ?? '', issuerId: i.issuerId ?? '', issuerName: i.issuerName ?? '',
    totalAmount: num2(i.totalAmount), poRef: i.purchaseOrderReference ?? '', matchedPo: i.poNumber ?? '',
    matchType: i.matchType === 'none' ? 'بدون' : i.matchType, warnings: warnText(i.warnings || []),
    window: WINDOW_AR[i.window?.status] || '', daysLeft: i.window?.daysLeft != null ? Math.floor(i.window.daysLeft) : '',
  })), (r) => (r.warnings.includes(WARN_AR['PO-EXCEEDED']) ? FILL.bad : r.warnings ? FILL.warn : r.matchType !== 'بدون' ? FILL.valid : null));

  return { workbook: wb };
}

// Input template — headers are the Arabic canonical aliases so the sheet round-trips through
// parsePoWorkbook verbatim (T-033 guards the two against drifting apart).
export function renderPoTemplate(ExcelJS) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('أوامر الشراء');
  ws.views = [RTL];
  ws.columns = [
    { key: 'company', header: 'اسم الشركة', width: 28 }, { key: 'tin', header: 'الرقم الضريبي', width: 18 },
    { key: 'poNumber', header: 'رقم أمر الشراء', width: 18 }, { key: 'totalAmount', header: 'قيمة أمر الشراء', width: 16 },
    { key: 'validFrom', header: 'ساري من', width: 13 }, { key: 'validTo', header: 'ساري إلى', width: 13 },
  ];
  const ex = ws.addRow(cleanRow({ company: 'شركة المثال للتجارة', tin: '123456789', poNumber: 'PO-100', totalAmount: 100000, validFrom: '2026-01-01', validTo: '2026-12-31' }));
  ex.eachCell({ includeEmpty: true }, (c) => (c.border = THIN));
  return { workbook: wb };
}

const pad = (n) => String(n).padStart(2, '0');
// No ':' (Windows), never matches merge's /^e(Invoices|Receipts)_/i glob nor /COMBINED/i.
export const poAnalyticsName = (now) =>
  `PO_Analytics_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.xlsx`;
