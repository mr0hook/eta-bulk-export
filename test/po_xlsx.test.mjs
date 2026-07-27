// SPEC-005 (F-05) — PO analytics report + template renderers.
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const { renderPoAnalytics, renderPoTemplate, poAnalyticsName, WARN_AR, WINDOW_AR } = await import('../src/reject/po_xlsx.js');
const { parsePoWorkbook } = await import('../src/reject/po.js');

// parity-style structural mock
class Row { constructor(d) { this.data = d; this.fill = null; } eachCell(_o, _cb) {} }
class Sheet { constructor(n) { this.name = n; this.rows = []; this.columns = []; this.views = null; this.autoFilter = null; } addRow(o) { const r = new Row(o); this.rows.push(r); return r; } }
const MockExcel = { Workbook: class { constructor() { this.sheets = []; } addWorksheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; } } };

const META = { from: '2026-06-27', to: '2026-07-27', generatedAt: '2026-07-27T18:00:00Z', version: '0.4.0', windowSource: 'config', windowDays: 14 };
const WIN = (status) => ({ days: 14, ageDays: 2, daysLeft: 12, status });
const ANALYSIS = {
  perInvoice: [
    { uuid: 'U-OK', internalID: 'A-1', issuerId: '100', issuerName: 'ACME', totalAmount: 100, typeEn: 'Invoice', typeAr: 'فاتورة', dateIssuedYmd: '2026-07-10', receivedIso: '2026-07-25T00:00:00Z', purchaseOrderReference: 'PO-100', matchType: 'po-ref', poNumber: 'PO-100', warnings: [], window: WIN('can-reject') },
    { uuid: 'U-WARN', internalID: 'A-2', issuerId: '100', issuerName: 'ACME', totalAmount: 200, typeEn: 'Invoice', typeAr: 'فاتورة', dateIssuedYmd: '2026-12-05', receivedIso: '2026-07-25T00:00:00Z', purchaseOrderReference: 'PO-100', matchType: 'po-ref', poNumber: 'PO-100', warnings: ['OUT-OF-PO-PERIOD'], window: WIN('window-passed') },
    { uuid: 'U-EXC', internalID: 'A-3', issuerId: '100', issuerName: 'ACME', totalAmount: 900, typeEn: 'Invoice', typeAr: 'فاتورة', dateIssuedYmd: '2026-07-12', receivedIso: null, purchaseOrderReference: 'PO-100', matchType: 'po-ref', poNumber: 'PO-100', warnings: ['PO-EXCEEDED'], window: WIN('unknown') },
  ],
  perPo: [
    { row: 2, company: 'ACME', tin: '100', poNumber: 'PO-100', poKey: 'PO100', totalAmount: 1000, validFrom: '2026-07-01', validTo: '2026-07-31', warnings: [], invCount: 3, utilized: 1200, remaining: -200, utilizationPct: 120, exceeded: true },
    { row: 3, company: 'Beta', tin: '200', poNumber: 'PO-200', poKey: 'PO200', totalAmount: 500, validFrom: '2026-07-01', validTo: '2026-07-31', warnings: [], invCount: 0, utilized: 0, remaining: 500, utilizationPct: 0, exceeded: false },
  ],
  perSupplier: [{ tin: '100', name: 'ACME', invCount: 3, totalAmount: 1200, matchedCount: 3, unmatchedCount: 0, warnCount: 2 }],
  totals: { invoices: 3, matched: 3, unmatched: 0, warnings: 2, exceededPos: 1, fetchFailed: 1 },
};

test('T-031 four RTL sheets with autofilters and a meta-bearing summary', () => {
  const { workbook } = renderPoAnalytics(MockExcel, ANALYSIS, META);
  const names = workbook.sheets.map((s) => s.name);
  assert.deepEqual(names, ['الملخص', 'أوامر الشراء', 'الموردون', 'الفواتير']);
  for (const s of workbook.sheets) assert.ok(s.views?.[0]?.rightToLeft, `${s.name} RTL`);
  for (const s of workbook.sheets.slice(1)) assert.ok(s.autoFilter, `${s.name} autoFilter`);
  const flat = workbook.sheets[0].rows.map((r) => (Array.isArray(r.data) ? r.data.join('|') : String(r.data)));
  assert.ok(flat.some((x) => x.includes('2026-06-27') && x.includes('2026-07-27')), 'period row');
  assert.ok(flat.some((x) => x.includes('0.4.0')), 'version row');
  assert.ok(flat.some((x) => /14/.test(x) && workbook.sheets[0].rows.length > 5), 'window fallback row');
  assert.ok(flat.some((x) => x.includes('1')), 'fetchFailed surfaced');
});

test('T-032 fills and window labels', () => {
  const { workbook } = renderPoAnalytics(MockExcel, ANALYSIS, META);
  const poSheet = workbook.sheets[1];
  const exceededRow = poSheet.rows.find((r) => r.data.poNumber === 'PO-100');
  const cleanPoRow = poSheet.rows.find((r) => r.data.poNumber === 'PO-200');
  assert.ok(exceededRow.fill, 'exceeded PO highlighted');
  assert.equal(cleanPoRow.fill, null);
  const invSheet = workbook.sheets[3];
  const byU = Object.fromEntries(invSheet.rows.map((r) => [r.data.uuid, r]));
  assert.equal(byU['U-OK'].fill?.fgColor?.argb, 'FFC6EFCE', 'clean matched = valid green');
  assert.equal(byU['U-WARN'].fill?.fgColor?.argb, 'FFFFE699', 'warned = yellow');
  assert.equal(byU['U-EXC'].fill?.fgColor?.argb, 'FFFFC7CE', 'exceeded = red');
  assert.equal(byU['U-OK'].data.window, WINDOW_AR['can-reject']);
  assert.equal(byU['U-WARN'].data.window, WINDOW_AR['window-passed']);
  assert.equal(byU['U-EXC'].data.window, WINDOW_AR['unknown']);
  assert.equal(byU['U-WARN'].data.warnings, WARN_AR['OUT-OF-PO-PERIOD']);
});

test('T-033 template round-trips through our own parser', async () => {
  const { workbook } = renderPoTemplate(ExcelJS);
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
  const { pos, rowWarnings } = parsePoWorkbook(loaded);
  assert.equal(pos.length, 1, 'one example row');
  assert.match(pos[0].tin, /^\d+$/);
  assert.match(pos[0].validFrom, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(pos[0].validTo, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(pos[0].warnings.length, 0);
  assert.equal(rowWarnings.length, 0);
});

test('T-034 report filename dodges Merge, COMBINED and Windows-illegal characters', () => {
  const name = poAnalyticsName(new Date(Date.UTC(2026, 6, 27, 18, 5, 9)));
  assert.ok(name.startsWith('PO_Analytics_'), name);
  assert.ok(name.endsWith('.xlsx'));
  assert.ok(!/[:*?"<>|]/.test(name), 'no Windows-illegal chars');
  assert.ok(!/^e(Invoices|Receipts)_/i.test(name), 'not swallowed by Merge');
  assert.ok(!/COMBINED/i.test(name));
});

test('T-035 serialization survives illegal chars via cleanRow', async () => {
  const dirty = JSON.parse(JSON.stringify(ANALYSIS));
  dirty.perSupplier[0].name = 'ACME￾ Trading';
  dirty.perInvoice[0].issuerName = 'ACME￾Trading';
  const { workbook } = renderPoAnalytics(ExcelJS, dirty, META);
  const buf = await workbook.xlsx.writeBuffer();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(buf);
  let illegal = 0;
  wb2.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => { if (typeof c.value === 'string' && /[￾￿]/.test(c.value)) illegal++; })));
  assert.equal(illegal, 0, 'cleanRow stripped noncharacters on every sheet');
});
