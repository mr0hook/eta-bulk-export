// Synthetic fixtures faithful to the live-verified /details structure (EXPORT_BEHAVIOR_SPEC §9),
// crafted to exercise paths a VAT-only real sample can't: multi-tax, T4 withholding, credit-note
// signs, foreign currency, discounts, and an illegal XML char.
const ILL = '￾'; // noncharacter that must be stripped

const addr = { buildingNumber: '1', street: 'Nile St', regionCity: 'Cairo', governate: 'Cairo' };

export const invoices = [
  // 1) plain valid VAT-only, EGP
  { search: {}, detail: {
    uuid: 'INV-1', internalID: 'A-0001', status: 'Valid',
    documentTypeNamePrimaryLang: 'Invoice', documentTypeNameSecondaryLang: 'فاتورة', documentTypeVersion: '1.0',
    dateTimeIssued: '2025-03-10T00:00:00Z', dateTimeRecevied: '2025-03-10T09:30:00Z', currenciesSold: 'EGP',
    totalSales: 1000, netAmount: 1000, totalAmount: 1140,
    issuer: { id: '100', name: 'Seller A', address: addr },
    receiver: { id: '200', name: 'Buyer B', address: addr },
    taxTotals: [{ taxType: 'T1', amount: 140 }],
    invoiceLines: [{ itemCode: 'EG-1', internalCode: 'x1', itemSecondaryName: 'Widget', description: 'Widget X',
      quantity: 10, unitType: 'EA', unitTypePrimaryName: 'each', unitValue: { amountEGP: 100 },
      salesTotal: 1000, netTotal: 1000, total: 1140, lineTaxableItems: [{ taxType: 'T1', rate: 14, amount: 140 }] }],
    currencySegments: [{ currencyExchangeRate: 1, totalAmount: 1140 }], publicUrl: 'https://p/1',
    signatures: [{ signedBy: 'CERT-A' }], purchaseOrderReference: 'PO1', salesOrderReference: 'SO1',
  } },
  // 2) credit note, T1 + T4 withholding (tests negativeCredit sign + T4 special case)
  { search: {}, detail: {
    uuid: 'INV-2', internalID: 'A-0002', status: 'Valid',
    documentTypeNamePrimaryLang: 'Credit Note', documentTypeNameSecondaryLang: 'إشعار دائن', documentTypeVersion: '1.0',
    dateTimeIssued: '2025-08-01T00:00:00Z', dateTimeRecevied: '2025-08-01T12:00:00Z', currenciesSold: 'EGP',
    totalSales: 500, netAmount: 500, totalAmount: 560,
    issuer: { id: '100', name: 'Seller A', address: addr }, receiver: { id: '200', name: 'Buyer B', address: addr },
    taxTotals: [{ taxType: 'T1', amount: 70 }, { taxType: 'T4', amount: 10 }],
    invoiceLines: [{ itemCode: 'EG-2', description: 'Returned', quantity: 5, unitType: 'EA', unitTypePrimaryName: 'each',
      unitValue: { amountEGP: 100 }, salesTotal: 500, netTotal: 500, total: 560,
      lineTaxableItems: [{ taxType: 'T1', rate: 14, amount: 70 }, { taxType: 'T4', rate: 2, amount: 10 }] }],
    references: ['ORIG-UUID-99'], customsDeclarationNumber: 'CD-123', customsClearanceDate: '2025-07-30T00:00:00Z', ePaymentNumber: 'EP-777',
    signatures: [{ signedBy: 'CERT-A' }],
  } },
  // 3) foreign currency (USD) + discounts + an illegal char in a name
  { search: {}, detail: {
    uuid: 'INV-3', internalID: 'A-0003', status: 'Valid',
    documentTypeNamePrimaryLang: 'Invoice', documentTypeNameSecondaryLang: 'فاتورة', documentTypeVersion: '1.0',
    dateTimeIssued: '2025-06-15T00:00:00Z', dateTimeRecevied: '2025-06-15T08:00:00Z', currenciesSold: 'USD',
    totalSales: 2000, netAmount: 1900, totalAmount: 2166,
    issuer: { id: '100', name: 'Seller' + ILL + ' A', address: addr }, receiver: { id: '200', name: 'Buyer B', address: addr },
    taxTotals: [{ taxType: 'T1', amount: 266 }],
    totalItemsDiscountAmount: 60, totalDiscount: 40, extraDiscountAmount: 0,
    invoiceLines: [{ itemCode: 'EG-3', description: 'Import', quantity: 20, unitType: 'EA', unitTypePrimaryName: 'each',
      unitValue: { amountEGP: 100, currencySold: 'USD', currencyExchangeRate: 49.5, amountSold: 2.02 },
      salesTotal: 2000, netTotal: 1900, total: 2166, totalForeign: 43.76,
      lineTaxableItems: [{ taxType: 'T1', rate: 14, amount: 266 }] }],
    currencySegments: [{ currencyExchangeRate: 49.5, totalAmount: 43.76 }], signatures: [{ signedBy: 'CERT-A' }],
  } },
];

export const receipts = [
  { search: { posSerialNumber: 'POS-1', submitterName: 'RE ERP' }, detail: {
    uuid: 'RCP-1', receiptNumber: 'R-0001', status: 'Valid',
    documentType: { receiptTypeNameAr: 'إيصال' }, dateTimeIssued: '2025-12-31T00:00:00Z', dateTimeReceived: '2025-12-31T19:49:32.1736728Z',
    currency: 'EGP', totalSales: 200, totalAmount: 228, totalCommercialDiscount: 5,
    seller: { sellerId: '100', sellerName: 'Shop', branchAddress: addr },
    buyer: { buyerId: '200', buyerName: 'Cust' + ILL, mobileNumber: '0100000000' },
    taxTotals: [{ taxType: 'T1', amount: 28 }],
    itemData: [
      { itemCode: 'EG-1', itemCodeNameAr: 'صنف', description: 'Item 1', quantity: 1, unitPrice: 100, netSale: 100, netAmount: 100, total: 114, taxableItems: [{ taxType: 'T1', amount: 14 }], valueDifference: 3 },
      { itemCode: 'EG-2', description: 'Item 2', quantity: 1, unitPrice: 100, netSale: 100, netAmount: 100, total: 114, taxableItems: [{ taxType: 'T1', amount: 14 }] },
    ],
  } },
];

export const OPTS = { columns: {}, combineAll: true, taxColumns: true, discountColumns: true, negativeCredit: true, validOnly: false };
