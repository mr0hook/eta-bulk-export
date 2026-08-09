// Clean-room ETA export builder — reimplemented from EXPORT_BEHAVIOR_SPEC.md on ExcelJS.
// Pure + node-testable: renderWorkbook(ExcelJS, records, source, options) -> { workbook, ... }.
// records: [{ detail, search }]  (invoices use detail; receipts use detail + search.posSerialNumber/submitterName)
//
// SPEC-021: the sheet names and base column definitions no longer live in this file — they come
// from mapping.js, which returns the server-served mapping when one has been fetched and validated
// and the BUNDLED one otherwise. This file is unchanged in every other respect: it still decides
// every DYNAMIC column (tax types, FX, discounts, references, customs) from the records in hand,
// and every row it writes is built here, on the device, from data that never leaves it.
import { clean, cleanRow } from './sanitize.js';
import { dateEg } from './dates.js';
import { taxName, taxWidth } from './codes.js';
import { mappingFor, ALWAYS_KEEP } from './mapping.js';

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
// The base [key, header, width] tuples and the two sheet names now come from mapping.js (SPEC-021).
// ALWAYS_KEEP (index/details/uuid) is imported from there too: removableColumns omits those from
// the UI and keep() force-keeps them, so a stray options.columns:{uuid:false} can't break merge.
const toCols = (defs) => defs.map(([key, header, width]) => ({ key, header, width }));
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
  // options.mapping lets a caller pin an exact mapping (tests, and any future "re-render with the
  // mapping this folder was started on"). Otherwise mappingFor() decides: validated server mapping
  // if one is cached and current, bundled otherwise. It never returns a partial mapping.
  const cfg = options.mapping || mappingFor(source);
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
  const cfg = mappingFor(source);   // the Columns UI must offer whatever the export will actually write
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
  const refNumbers = options.refNumbers instanceof Map ? options.refNumbers : null;   // SPEC-008; absent → SPEC-001 behaviour (uuid only)
  if (S.some((o) => o.references?.[0])) {
    insertBefore(sumCols, 'signature', { key: 'referenceUUID', header: 'الرقم المرجعي', width: 32 });   // near the other reference fields, not past the url column
    insertBefore(lineCols, 'uuid', { key: 'referenceUUID', header: 'الرقم المرجعي', width: 32 });        // lr.referenceUUID needs a line col too, else dropped
    if (refNumbers) {   // the human-readable number leads, the hash follows
      insertBefore(sumCols, 'referenceUUID', { key: 'referenceNumber', header: 'رقم الفاتورة الأصلية', width: 22 });
      insertBefore(lineCols, 'referenceUUID', { key: 'referenceNumber', header: 'رقم الفاتورة الأصلية', width: 22 });
    }
  }
  // references → original invoice numbers, joined like the UUID column; unresolved ones are skipped
  // rather than left as empty separators, so 'A-1, , A-3' can never reach a cell.
  const refNums = (o) => {
    if (!refNumbers) return '';
    const n = o.references.filter(Boolean).map((u) => refNumbers.get(u)).filter(Boolean);
    return n.length ? n.join(', ') : '';
  };
  if (S.some((o) => o.customsDeclarationNumber)) sumCols.push({ key: 'customsDeclarationNumber', header: 'رقم الرسالة الجمركية', width: 15 });
  if (S.some((o) => o.customsClearanceDate)) sumCols.push({ key: 'customsClearanceDate', header: 'تاريخ الرسالة الجمركية', width: 15 });
  if (S.some((o) => o.ePaymentNumber)) sumCols.push({ key: 'ePaymentNumber', header: 'رقم المدفوعة', width: 15 });

  const summaryRows = [], lineRows = [];
  let serial = 0;
  for (const o of S) {
    serial++;   // always emit the summary row — a lineless/odd detail must NOT silently vanish (receipts already do this)
    // A credit note reverses value: EVERY figure it carries exports negative, so a plain SUM()
    // over a period nets against the originating invoices instead of double-counting (SPEC-007).
    // Rates are not figures — tax rate %, FX rate and unit price are never signed (a signed unit
    // price would cancel the signed quantity and flip the line total back positive).
    const y = !!(options.negativeCredit && o.documentTypeNamePrimaryLang === 'Credit Note');
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
        row[t.taxType] = sgn(t.amount);   // incl. T4 withholding — see SPEC-007 (the old T4 branch negated it on PLAIN invoices)
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
      if (o.totalItemsDiscountAmount > 0) row.itemsDiscount = sgn(o.totalItemsDiscountAmount);
      if (o.totalDiscount > 0) row.discount = sgn(o.totalDiscount);
      if (o.extraDiscountAmount > 0) row.extraDiscount = sgn(o.extraDiscountAmount);
    }
    if (o.serviceDeliveryDate) row.serviceDeliveryDate = dateEg(o.serviceDeliveryDate);
    if (o.references?.[0]) {
      row.referenceUUID = o.references.filter(Boolean).join(', ');   // a note can reference >1 original
      const rn = refNums(o); if (rn) row.referenceNumber = rn;
    }
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
        lr[t.taxType] = (lr[t.taxType] || 0) + sgn(t.amount);   // accumulate: a line may carry several taxable items of the same taxType
        if (t.taxType !== 'T20' && t.rate !== undefined) { const k = t.taxType + '%'; const c = lr[k]; lr[k] = c == null || c === '' ? t.rate : (String(c).split('&').includes(String(t.rate)) ? c : c + '&' + t.rate); }
      }
      if (options.discountColumns) {
        if (l.valueDifference > 0) lr.valueDifference = sgn(l.valueDifference);
        if (l.discount?.amount > 0) lr.discount = sgn(l.discount.amount);
        if (l.itemsDiscount > 0) lr.itemsDiscount = sgn(l.itemsDiscount);
      }
      if (o.serviceDeliveryDate) lr.serviceDeliveryDate = dateEg(o.serviceDeliveryDate);
      if (o.references?.[0]) {
        lr.referenceUUID = o.references.filter(Boolean).join(', ');   // same join as the summary row
        const rn = refNums(o); if (rn) lr.referenceNumber = rn;
      }
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
