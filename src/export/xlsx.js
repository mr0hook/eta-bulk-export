// Clean-room ETA export builder — reimplemented from EXPORT_BEHAVIOR_SPEC.md on ExcelJS.
// Pure + node-testable: renderWorkbook(ExcelJS, records, source, options) -> { workbook, ... }.
// records: [{ detail, search }]  (invoices use detail; receipts use detail + search.posSerialNumber/submitterName)
import { clean, cleanRow } from './sanitize.js';
import { dateEg } from './dates.js';
import { taxName, taxWidth } from './codes.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const RTL = { rightToLeft: true, rtl: true, activeCell: 'A1', state: 'frozen', ySplit: 1 };
const THIN = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
const FILL = {
  valid: solid('FFC6EFCE'), credit: solid('FFD9E1F2'), debit: solid('FFFFE699'), bad: solid('FFFFC7CE'),
};
function solid(argb) { return { type: 'pattern', pattern: 'solid', fgColor: { argb } }; }
function addr(a) { a = a || {}; return `${a.buildingNumber ?? ''} ${a.street ?? ''} ${a.regionCity ?? ''} ${a.governate ?? ''}`.replace(/\s+/g, ' ').trim(); }
const idx = (cols, key) => cols.findIndex((c) => c.key === key);
function insertBefore(cols, beforeKey, col) { const i = idx(cols, beforeKey); cols.splice(i < 0 ? cols.length : i, 0, col); }
function insertAfter(cols, afterKey, col) { const i = idx(cols, afterKey); cols.splice(i < 0 ? cols.length : i + 1, 0, col); }
const BAD_STATUS = ['Invalid', 'Rejected', 'Cancelled', 'Cancellation Requested', 'Rejection Requested'];

// ---------------- column definitions ----------------
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

const toCols = (defs) => defs.map(([key, header, width]) => ({ key, header, width }));
// Columns never dropped: index/details are structural; uuid is the merge/repair dedup key. removableColumns
// omits these from the UI and keep() force-keeps them, so a stray options.columns:{uuid:false} can't break merge.
const ALWAYS_KEEP = new Set(['index', 'details', 'uuid']);
const keep = (defs, options) => toCols(defs).filter((c) => ALWAYS_KEEP.has(c.key) || options?.columns?.[c.key] !== false);
const sortTax = (set) => [...set].sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));

function deriveInvStatus(o) {
  let s = o.status;
  if (o.status === 'Valid' && o.cancelRequestDate != null && o.declineCancelRequestDate == null) s = 'Cancellation Requested';
  if (o.status === 'Valid' && o.rejectRequestDate != null && o.declineRejectRequestDate == null) s = 'Rejection Requested';
  return s;
}
function fillFor(statusEn, typeEn) {
  if (statusEn === 'Valid') return typeEn === 'Credit Note' ? FILL.credit : typeEn === 'Debit Note' ? FILL.debit : FILL.valid;
  return BAD_STATUS.includes(statusEn) ? FILL.bad : null;
}

// ---------------- main ----------------
export function renderWorkbook(ExcelJS, records, source, options = {}) {
  const cfg = source === 'receipts' ? RCP : INV;
  const wb = new ExcelJS.Workbook();
  const built = source === 'receipts'
    ? buildReceipts(records, options, cfg)
    : buildInvoices(records, options, cfg);

  // summary sheet
  const s0 = wb.addWorksheet(cfg.summarySheet); s0.views = [RTL]; s0.columns = built.summaryCols;
  for (const r of built.summaryRows) {
    const row = s0.addRow(cleanRow(r));
    row.eachCell({ includeEmpty: true }, (c) => (c.border = THIN));
    const f = fillFor(r.status, r.typeEn); if (f) row.fill = f;
  }
  s0.autoFilter = { from: 'A1', to: { row: built.summaryRows.length + 1, column: built.summaryCols.length } };

  // line-items sheet (combineAll)
  const s1 = wb.addWorksheet(cfg.lineSheet); s1.views = [RTL]; s1.columns = built.lineCols;
  for (const r of built.lineRows) {
    const row = s1.addRow(cleanRow(r));
    row.eachCell({ includeEmpty: true }, (c) => (c.border = THIN));
    const f = fillFor(r.status, r.typeEn); if (f) row.fill = f;
  }
  s1.autoFilter = { from: 'A1', to: { row: built.lineRows.length + 1, column: built.lineCols.length } };

  return { workbook: wb, summaryCols: built.summaryCols, lineCols: built.lineCols, summaryRows: built.summaryRows, lineRows: built.lineRows };
}

// ---------------- invoices ----------------
// Base summary columns a user may remove (for the Columns UI). ALWAYS_KEEP (index/details/uuid) is excluded.
export function removableColumns(source) {
  const cfg = source === 'receipts' ? RCP : INV;
  return cfg.summary.filter(([k]) => !ALWAYS_KEEP.has(k)).map(([key, header]) => ({ key, header }));
}

function buildInvoices(records, options, cfg) {
  const details = records.map((r) => r.detail).filter(Boolean);
  const S = options.validOnly ? details.filter((o) => deriveInvStatus(o) === 'Valid') : details;

  const sumCols = keep(cfg.summary, options);
  const lineCols = keep(cfg.lines, options);

  // dynamic column unions (stable pre-pass)
  const anyNonEgp = S.some((o) => (o.currenciesSold && o.currenciesSold !== 'EGP') || o.invoiceLines?.[0]?.unitValue?.currencySold && o.invoiceLines[0].unitValue.currencySold !== 'EGP');
  if (anyNonEgp) {
    insertBefore(sumCols, 'totalSales', { key: 'currencyExchangeRate', header: 'سعر العملة', width: 13 });
    insertBefore(sumCols, 'totalSales', { key: 'currencyTotal', header: 'مبلغ العملة', width: 13 });
    for (const c of [['currencySold', 'العملة', 10], ['currencyExchangeRate', 'سعر العملة', 12], ['amountSold', 'القيمة', 10], ['totalForeign', 'الإجمالى', 10]])
      insertBefore(lineCols, 'issuerId', { key: c[0], header: c[1], width: c[2] });
  }
  if (options.taxColumns) {
    const st = new Set(); S.forEach((o) => o.taxTotals?.forEach((t) => t.taxType && st.add(t.taxType)));
    for (const tt of sortTax(st)) {
      if (idx(sumCols, tt) < 0) insertAfter(sumCols, 'netAmount', { key: tt, header: taxName(tt), width: taxWidth(tt) });
      if (tt !== 'T20' && idx(sumCols, tt + '%') < 0) insertAfter(sumCols, tt, { key: tt + '%', header: tt + '%', width: 7 });
    }
    const lt = new Set(); S.forEach((o) => o.invoiceLines?.forEach((l) => l.lineTaxableItems?.forEach((t) => t.taxType && lt.add(t.taxType))));
    for (const tt of sortTax(lt)) {
      if (idx(lineCols, tt) < 0) insertBefore(lineCols, 'total', { key: tt, header: taxName(tt), width: taxWidth(tt) });
      if (tt !== 'T20' && idx(lineCols, tt + '%') < 0) insertAfter(lineCols, tt, { key: tt + '%', header: tt + '%', width: 7 });
    }
  }
  if (options.discountColumns) {
    if (S.some((o) => o.totalItemsDiscountAmount > 0)) insertBefore(sumCols, 'totalAmount', { key: 'itemsDiscount', header: 'خصم الأصناف', width: 13 });
    if (S.some((o) => o.totalDiscount > 0)) insertBefore(sumCols, 'totalAmount', { key: 'discount', header: 'خصم الفاتورة', width: 13 });
    if (S.some((o) => o.extraDiscountAmount > 0)) insertBefore(sumCols, 'totalAmount', { key: 'extraDiscount', header: 'خصم إضافى', width: 13 });
    // Line-item discount columns — the row builder writes lr.itemsDiscount / lr.discount / lr.valueDifference
    // (below), but without these column defs ExcelJS maps by key and silently DROPS them from the detail sheet.
    // Mirror the receipts line path so per-line discount figures actually appear.
    if (S.some((o) => o.invoiceLines?.some((l) => l.itemsDiscount > 0))) insertBefore(lineCols, 'total', { key: 'itemsDiscount', header: 'خصم الأصناف', width: 13 });
    if (S.some((o) => o.invoiceLines?.some((l) => l.discount?.amount > 0))) insertBefore(lineCols, 'total', { key: 'discount', header: 'خصم', width: 13 });
    if (S.some((o) => o.invoiceLines?.some((l) => l.valueDifference > 0))) insertBefore(lineCols, 'total', { key: 'valueDifference', header: 'فرق قيمة لأغراض الضريبة', width: 20 });
  }
  if (S.some((o) => o.serviceDeliveryDate)) sumCols.push({ key: 'serviceDeliveryDate', header: 'خدمة التوصيل', width: 13 });
  if (S.some((o) => o.serviceDeliveryDate)) lineCols.push({ key: 'serviceDeliveryDate', header: 'خدمة التوصيل', width: 13 });   // lr.serviceDeliveryDate is set per line — needs a line column too, else dropped
  // v62 additions — sparse ETA fields; add the column only when some invoice carries it
  if (S.some((o) => o.references?.[0])) sumCols.push({ key: 'referenceUUID', header: 'الرقم المرجعي', width: 32 });
  if (S.some((o) => o.customsDeclarationNumber)) sumCols.push({ key: 'customsDeclarationNumber', header: 'رقم الرسالة الجمركية', width: 15 });
  if (S.some((o) => o.customsClearanceDate)) sumCols.push({ key: 'customsClearanceDate', header: 'تاريخ الرسالة الجمركية', width: 15 });
  if (S.some((o) => o.ePaymentNumber)) sumCols.push({ key: 'ePaymentNumber', header: 'رقم المدفوعة', width: 15 });

  const summaryRows = [], lineRows = [];
  let serial = 0;
  for (const o of S) {
    serial++;   // always emit the summary row — a lineless/odd detail must NOT silently vanish (receipts already do this)
    const y = !!(options.negativeCredit && o.documentTypeNamePrimaryLang === 'Credit Note');
    const w = o.documentTypeNamePrimaryLang === 'Credit Note';
    const sgn = (v) => (y ? -1 * v : v);
    let cur = o.currenciesSold; if (cur !== 'EGP') cur = (o.invoiceLines || []).find((l) => l.unitValue?.currencySold)?.unitValue.currencySold || cur;
    const statusEn = deriveInvStatus(o);
    const row = {
      index: serial, typeEn: o.documentTypeNamePrimaryLang, type: o.documentTypeNameSecondaryLang, version: o.documentTypeVersion,
      status: statusEn, dateIssued: dateEg(o.dateTimeIssued), dateReceived: dateEg(o.dateTimeRecevied), currency: cur,
      totalSales: sgn(o.totalSales), netAmount: sgn(o.netAmount), totalAmount: sgn(o.totalAmount),
      invoiceNumber: o.internalID, uuid: o.uuid, issuerId: o.issuer?.id, issuerName: o.issuer?.name, issuerAddress: addr(o.issuer?.address),
      receiverId: o.receiver?.id, receiverName: o.receiver?.name, receiverAddress: addr(o.receiver?.address),
      purchaseOrderReference: o.purchaseOrderReference, purchaseOrderDescription: o.purchaseOrderDescription,
      salesOrderReference: o.salesOrderReference, salesOrderDescription: o.salesOrderDescription,
      signature: o.signatures?.[0]?.signedBy || '', url: o.publicUrl ? { text: o.publicUrl, hyperlink: o.publicUrl } : '',
      details: { text: 'عرض', hyperlink: `#'${cfg.lineSheet}'!A1` },
    };
    if (options.taxColumns) {
      for (const t of o.taxTotals || []) {
        row[t.taxType] = t.taxType === 'T4' ? (w ? t.amount : (options.negativeCredit ? -1 * t.amount : t.amount)) : sgn(t.amount);
        if (t.taxType !== 'T20') {
          const rates = new Set(); (o.invoiceLines || []).forEach((l) => l.lineTaxableItems?.forEach((x) => x.taxType === t.taxType && rates.add(x.rate)));
          row[t.taxType + '%'] = [...rates].sort((a, b) => a - b).join('&');
        }
      }
    }
    if (anyNonEgp && cur !== 'EGP' && o.currencySegments?.[0]) {
      row.currencyExchangeRate = o.currencySegments[0].currencyExchangeRate;
      row.currencyTotal = sgn(o.currencySegments[0].totalAmount);
    }
    if (options.discountColumns) {
      if (o.totalItemsDiscountAmount > 0) row.itemsDiscount = w ? o.totalItemsDiscountAmount : sgn(o.totalItemsDiscountAmount);
      if (o.totalDiscount > 0) row.discount = w ? o.totalDiscount : sgn(o.totalDiscount);
      if (o.extraDiscountAmount > 0) row.extraDiscount = w ? o.extraDiscountAmount : sgn(o.extraDiscountAmount);
    }
    if (o.serviceDeliveryDate) row.serviceDeliveryDate = dateEg(o.serviceDeliveryDate);
    if (o.references?.[0]) row.referenceUUID = o.references.filter(Boolean).join(', ');   // a note can reference >1 original
    if (o.customsDeclarationNumber) row.customsDeclarationNumber = o.customsDeclarationNumber;
    if (o.customsClearanceDate) row.customsClearanceDate = dateEg(o.customsClearanceDate);
    if (o.ePaymentNumber) row.ePaymentNumber = o.ePaymentNumber;
    summaryRows.push(row);

    for (const l of o.invoiceLines || []) {
      const lr = {
        typeEn: o.documentTypeNamePrimaryLang, type: o.documentTypeNameSecondaryLang, version: o.documentTypeVersion, status: statusEn,
        invoiceNumber: o.internalID, dateIssued: dateEg(o.dateTimeIssued), dateReceived: dateEg(o.dateTimeRecevied),
        itemCode: l.itemCode, internalCode: l.internalCode, itemSecondaryName: l.itemSecondaryName, description: l.description,
        quantity: sgn(l.quantity), unitType: l.unitType, unitTypeName: l.unitTypePrimaryName, unitValue: l.unitValue?.amountEGP || 0,
        salesTotal: sgn(l.salesTotal), netTotal: sgn(l.netTotal), total: sgn(l.total),
        issuerId: o.issuer?.id, issuerName: o.issuer?.name, issuerAddress: addr(o.issuer?.address),
        receiverId: o.receiver?.id, receiverName: o.receiver?.name, receiverAddress: addr(o.receiver?.address),
        purchaseOrderReference: o.purchaseOrderReference, purchaseOrderDescription: o.purchaseOrderDescription,
        salesOrderReference: o.salesOrderReference, salesOrderDescription: o.salesOrderDescription, uuid: o.uuid, signature: o.signatures?.[0]?.signedBy || '',
      };
      if (options.taxColumns) for (const t of l.lineTaxableItems || []) {
        const amt = (y && t.taxType !== 'T4') ? -1 * t.amount : (t.taxType === 'T4' ? (w ? t.amount : (options.negativeCredit ? -1 * t.amount : t.amount)) : t.amount);
        lr[t.taxType] = (lr[t.taxType] || 0) + amt;   // accumulate: a line may carry several taxable items of the same taxType
        if (t.taxType !== 'T20' && t.rate !== undefined) { const k = t.taxType + '%'; const c = lr[k]; lr[k] = c == null || c === '' ? t.rate : (String(c).split('&').includes(String(t.rate)) ? c : c + '&' + t.rate); }
      }
      if (options.discountColumns) {
        if (l.valueDifference > 0) lr.valueDifference = w ? l.valueDifference : sgn(l.valueDifference);
        if (l.discount?.amount > 0) lr.discount = w ? l.discount.amount : sgn(l.discount.amount);
        if (l.itemsDiscount > 0) lr.itemsDiscount = w ? l.itemsDiscount : sgn(l.itemsDiscount);
      }
      if (o.serviceDeliveryDate) lr.serviceDeliveryDate = dateEg(o.serviceDeliveryDate);
      if (anyNonEgp && cur !== 'EGP') {
        lr.currencySold = l.unitValue?.currencySold || 'EGP'; lr.currencyExchangeRate = l.unitValue?.currencyExchangeRate || 1;
        lr.amountSold = sgn(l.unitValue?.amountSold || 0); lr.totalForeign = sgn(l.totalForeign || 0);
      }
      lineRows.push(lr);
    }
  }
  return { summaryCols: sumCols, lineCols, summaryRows, lineRows };
}

// ---------------- receipts ----------------
function buildReceipts(records, options, cfg) {
  const recs = records.filter((r) => r.detail);
  const sumCols = keep(cfg.summary, options);
  const lineCols = keep(cfg.lines, options);

  if (options.taxColumns) {
    const st = new Set(); recs.forEach((r) => r.detail.taxTotals?.forEach((t) => t.taxType && st.add(t.taxType)));
    for (const tt of sortTax(st)) if (idx(sumCols, tt) < 0) insertAfter(sumCols, 'netAmount', { key: tt, header: taxName(tt), width: taxWidth(tt) });
    const lt = new Set(); recs.forEach((r) => r.detail.itemData?.forEach((it) => it.taxableItems?.forEach((t) => t.taxType && lt.add(t.taxType))));
    for (const tt of sortTax(lt)) if (idx(lineCols, tt) < 0) insertBefore(lineCols, 'total', { key: tt, header: taxName(tt), width: taxWidth(tt) });
  }
  if (options.discountColumns) {
    if (recs.some((r) => r.detail.totalItemsDiscount > 0)) insertBefore(sumCols, 'totalAmount', { key: 'itemsDiscount', header: 'خصم الأصناف', width: 13 });
    if (recs.some((r) => r.detail.totalCommercialDiscount > 0)) insertBefore(sumCols, 'totalAmount', { key: 'commercialDiscount', header: 'خصم', width: 13 });
    if (recs.some((r) => r.detail.itemData?.some((it) => it.valueDifference > 0))) insertBefore(lineCols, 'total', { key: 'valueDifference', header: 'فرق قيمة لأغراض الضريبة', width: 20 });
  }

  const summaryRows = [], lineRows = [];
  let serial = 0;
  for (const r of recs) {
    const g = r.detail; serial++;
    const row = {
      index: serial, type: g.documentType?.receiptTypeNameAr, status: g.status,
      dateTimeIssued: dateEg(g.dateTimeIssued), dateTimeReceived: dateEg(g.dateTimeReceived), currency: g.currency,
      netAmount: g.totalSales, totalAmount: g.totalAmount, receiptNumber: g.receiptNumber, uuid: g.uuid,
      deviceSerialNumber: r.search?.posSerialNumber, submitterName: r.search?.submitterName,
      issuerId: g.seller?.sellerId, issuerName: g.seller?.sellerName, issuerAddress: addr(g.seller?.branchAddress),
      receiverId: g.buyer?.buyerId, receiverName: g.buyer?.buyerName, receiverMobileNumber: g.buyer?.mobileNumber,
      details: { text: 'عرض', hyperlink: `#'${cfg.lineSheet}'!A1` },
    };
    if (options.taxColumns) for (const t of g.taxTotals || []) row[t.taxType] = t.amount;
    if (options.discountColumns) {
      if (g.totalItemsDiscount > 0) row.itemsDiscount = g.totalItemsDiscount;
      if (g.totalCommercialDiscount > 0) row.commercialDiscount = g.totalCommercialDiscount;
    }
    summaryRows.push(row);

    for (const it of g.itemData || []) {
      const lr = {
        type: g.documentType?.receiptTypeNameAr, receiptNumber: g.receiptNumber, dateTimeIssued: dateEg(g.dateTimeIssued), dateTimeReceived: dateEg(g.dateTimeReceived),
        itemCode: it.itemCode, itemCodeNameAr: it.itemCodeNameAr, description: it.description, unitPrice: it.unitPrice,
        quantity: it.quantity, netSale: it.netSale, netAmount: it.netAmount, total: it.total,
        deviceSerialNumber: r.search?.posSerialNumber, submitterName: r.search?.submitterName,
        issuerId: g.seller?.sellerId, issuerName: g.seller?.sellerName, issuerAddress: addr(g.seller?.branchAddress),
        receiverId: g.buyer?.buyerId, receiverName: g.buyer?.buyerName, receiverMobileNumber: g.buyer?.mobileNumber,
        status: g.status, uuid: g.uuid,
      };
      if (options.taxColumns) for (const t of it.taxableItems || []) lr[t.taxType] = t.amount;
      if (options.discountColumns && it.valueDifference > 0) lr.valueDifference = it.valueDifference;
      lineRows.push(lr);
    }
  }
  return { summaryCols: sumCols, lineCols, summaryRows, lineRows };
}
