// SPEC-021 — the export column mapping, served.
//
// Sheet names and [key, header, width] tuples for each source. This is the copy that can change
// WITHOUT shipping an extension build: edit it here, bump MAPPING_REVISION, deploy, and every
// authorised installation picks the new headers up on its next run.
//
// What this is NOT: it is not the only copy, and it cannot be. The extension carries a bundled
// mapping (src/export/mapping.js) that renders a correct export when this worker is unreachable —
// a failed fetch must never yield a spreadsheet with missing or renamed columns. See that file's
// header for which side is authoritative for what.
//
// The rule the client enforces on whatever we serve: we may RENAME, RE-WIDTH, RE-ORDER and ADD
// columns; we may never REMOVE one, because a removed column silently discards data the user has
// already paid to fetch. A mapping that drops a bundled key is rejected client-side and the
// bundled one is used instead — so removing a column really does require a build.
//
// Invoice ROWS never appear here or anywhere near this route. This is column metadata only.
import { sha256hex } from './lib/util.js';

// Bump on every change below, and bump BUNDLED_REVISION in src/export/mapping.js in the same
// commit. While the two numbers are equal, a smoke test pins the two tables byte-identical.
export const MAPPING_REVISION = 1;

export const MAPPINGS = {
  invoices: {
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
  },
  receipts: {
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
      ['uuid', 'الرقم الإلكترونى', 32],
    ],
  },
};

// Stable serialisation for hashing: field order fixed here rather than trusting object key order,
// so the hash only moves when the mapping actually moves.
export const canonical = (m) => JSON.stringify([m.key, m.summarySheet, m.lineSheet, m.summary, m.lines]);

// Content hash — the client sends back the one it holds, and an unchanged mapping costs one small
// JSON reply instead of the whole table. It is also how a stale cache is DETECTED: revision says
// which generation, hash says which exact bytes.
export const mappingHash = async (m) => (await sha256hex(canonical(m))).slice(0, 32);

export const mappingFor = (source) => MAPPINGS[source] || null;
