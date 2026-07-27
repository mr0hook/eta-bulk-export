// SPEC-004 (F-04) — PO reconciliation engine. Pure module; parse tests build real ExcelJS
// workbooks (devDependency) because production cells arrive as Dates/richText/formulas.
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const { cellText, cellNumber, cellYmd, headerMapOf, parsePoWorkbook, poKeyOf, matchInvoice, analyzePo } = await import('../src/reject/po.js');

const NOW = Date.parse('2026-07-27T12:00:00Z');
const PO = (over = {}) => ({
  company: 'ACME', tin: '100200300', poNumber: 'PO-100', poKey: poKeyOf('PO-100'),
  totalAmount: 1000, validFrom: '2026-07-01', validTo: '2026-07-31', warnings: [], ...over,
});
const INV = (over = {}) => ({
  uuid: 'U1', internalID: 'A-1', issuerId: '100200300', issuerName: 'ACME Trading',
  totalAmount: 100, typeEn: 'Invoice', dateIssuedYmd: '2026-07-10',
  receivedIso: '2026-07-25T12:00:00Z', purchaseOrderReference: null, status: 'Valid', ...over,
});

test('T-021 headerMapOf: bilingual tolerant matching; PO_HEADERS on missing required fields', () => {
  const en = headerMapOf([undefined, 'Company Name', ' Registration Number ', 'PO Number', 'PO Total Amount', 'PO Valid From', 'PO Valid To']);
  assert.deepEqual([en.company, en.tin, en.poNumber, en.totalAmount, en.validFrom, en.validTo], [1, 2, 3, 4, 5, 6]);
  // Arabic with tatweel, hamza variants, alef-maqsura, doubled spaces
  const ar = headerMapOf([undefined, 'اسـم  الشركة', 'الرقم الضريبى', 'رقم أمر الشراء', 'قيمة امر الشراء', 'سارى من', 'ساري إلى']);
  assert.deepEqual([ar.company, ar.tin, ar.poNumber, ar.totalAmount, ar.validFrom, ar.validTo], [1, 2, 3, 4, 5, 6]);
  try { headerMapOf([undefined, 'Company Name', 'PO Total Amount']); assert.fail('should throw'); }
  catch (e) { assert.equal(e.code, 'PO_HEADERS'); assert.ok(e.missing.includes('tin') && e.missing.includes('poNumber'), JSON.stringify(e.missing)); }
});

test('T-022 cell coercions', () => {
  assert.equal(cellYmd(new Date(Date.UTC(2026, 6, 15))), '2026-07-15');
  assert.equal(cellYmd('2026-07-15'), '2026-07-15');
  assert.equal(cellYmd('15/07/2026'), '2026-07-15');
  assert.equal(cellYmd(46218), '2026-07-15');           // Excel serial for 2026-07-15
  assert.equal(cellYmd('garbage'), null);
  assert.equal(cellYmd(null), null);
  assert.equal(cellNumber(1234.5), 1234.5);
  assert.equal(cellNumber('1,234.50'), 1234.5);
  assert.equal(cellNumber({ formula: 'A1*2', result: 42 }), 42);
  assert.equal(cellNumber('x'), null);
  assert.equal(cellText({ richText: [{ text: 'PO-' }, { text: '9' }] }), 'PO-9');
  assert.equal(cellText({ text: 'PO-7' }), 'PO-7');
  assert.equal(cellText(100200300), '100200300');
  assert.equal(cellText('  s  '), 's');
});

test('T-023 parsePoWorkbook: normalization, first-wins dup, row warnings', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('POs');
  ws.addRow(['Company Name', 'Registration Number', 'PO Number', 'PO Total Amount', 'PO Valid From', 'PO Valid To']);
  ws.addRow(['ACME', '100-200-300', 'PO-100', 1000, new Date(Date.UTC(2026, 6, 1)), new Date(Date.UTC(2026, 6, 31))]);
  ws.addRow(['ACME', '100200300', 'po 100', 2000, '2026-07-01', '2026-07-31']);   // dup of row 1 (poKey + tin)
  ws.addRow(['Beta', '999888777', 'PO-200', null, '2026-07-01', '2026-07-31']);   // missing amount
  ws.addRow(['Gamma', '555444333', 'PO-300', 500, null, null]);                    // missing dates
  ws.addRow([null, null, null, null, null, null]);                                  // blank row skipped
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(await wb.xlsx.writeBuffer());

  const { pos, rowWarnings } = parsePoWorkbook(loaded);
  assert.equal(pos.length, 3, 'dup collapsed, blank skipped');
  assert.equal(pos[0].tin, '100200300', 'TIN digits-only');
  assert.equal(pos[0].totalAmount, 1000, 'first wins');
  assert.equal(pos[0].validFrom, '2026-07-01');
  assert.equal(pos[0].validTo, '2026-07-31');
  assert.ok(rowWarnings.some((w) => w.id === 'PO-DUP'));
  assert.ok(pos.find((p) => p.poNumber === 'PO-200').warnings.includes('PO-NO-AMOUNT'));
  assert.ok(pos.find((p) => p.poNumber === 'PO-300').warnings.includes('PO-NO-DATES'));
});

test('T-024 poKeyOf normalization and numeric equality', () => {
  assert.equal(poKeyOf(' po-100 '), poKeyOf('PO-100'));
  assert.equal(poKeyOf('po 100'), poKeyOf('PO-100'));
  assert.equal(poKeyOf(100), poKeyOf('100'));
  assert.notEqual(poKeyOf('PO-100'), poKeyOf('PO-101'));
  assert.equal(poKeyOf(''), null);
  assert.equal(poKeyOf(null), null);
});

test('T-025 po-ref match beats tin-period; TIN tiebreak among same poKey', () => {
  const pos = [PO({ tin: '999888777', company: 'Other' }), PO()];
  const m = matchInvoice(pos, INV({ purchaseOrderReference: 'po 100', dateIssuedYmd: '2026-07-10' }));
  assert.equal(m.matchType, 'po-ref');
  assert.equal(m.po.tin, '100200300', 'TIN-matching candidate preferred');
});

test('T-026 tin-period fallback: unique, ambiguous, none, unknown-ref', () => {
  const unique = matchInvoice([PO()], INV());
  assert.equal(unique.matchType, 'tin-period');
  const amb = matchInvoice([PO({ poNumber: 'PO-B', poKey: poKeyOf('PO-B'), validFrom: '2026-06-01', validTo: '2026-08-31' }), PO()], INV());
  assert.equal(amb.matchType, 'tin-period');
  assert.equal(amb.po.poNumber, 'PO-B', 'lowest validFrom wins');
  assert.ok(amb.warnings.includes('PO-AMBIGUOUS'));
  const none = matchInvoice([PO({ tin: '111' })], INV());
  assert.equal(none.matchType, 'none');
  assert.ok(none.warnings.includes('NO-PO-MATCH'));
  const unk = matchInvoice([PO()], INV({ purchaseOrderReference: 'PO-DOES-NOT-EXIST' }));
  assert.equal(unk.matchType, 'tin-period', 'unknown ref falls back');
  assert.ok(unk.warnings.includes('PO-REF-UNKNOWN'));
});

test('T-027 out-of-validity on a po-ref match is a warning, never a rejection signal', () => {
  const m = matchInvoice([PO()], INV({ purchaseOrderReference: 'PO-100', dateIssuedYmd: '2026-12-05' }));
  assert.equal(m.matchType, 'po-ref');
  assert.ok(m.warnings.includes('OUT-OF-PO-PERIOD'));
  assert.ok(!m.warnings.includes('NO-PO-MATCH'));
});

test('T-028 utilization: issue-date order, credit subtracts, exceeded flags crossing + later docs', () => {
  const pos = [PO({ totalAmount: 1000 })];
  const invoices = [
    INV({ uuid: 'U-C', typeEn: 'Credit Note', totalAmount: 300, dateIssuedYmd: '2026-07-20', purchaseOrderReference: 'PO-100' }),
    INV({ uuid: 'U-A', totalAmount: 600, dateIssuedYmd: '2026-07-05', purchaseOrderReference: 'PO-100' }),
    INV({ uuid: 'U-B', totalAmount: 500, dateIssuedYmd: '2026-07-10', purchaseOrderReference: 'PO-100' }),
  ];
  const a = analyzePo(pos, invoices, { windowDays: 14, nowMs: NOW });
  const p = a.perPo[0];
  assert.equal(p.utilized, 800, '600+500-300');
  assert.equal(p.remaining, 200);
  assert.equal(p.exceeded, true, 'crossed 1000 at U-B even though the credit later pulled it back');
  const byU = Object.fromEntries(a.perInvoice.map((i) => [i.uuid, i]));
  assert.ok(!byU['U-A'].warnings.includes('PO-EXCEEDED'));
  assert.ok(byU['U-B'].warnings.includes('PO-EXCEEDED'), 'the crossing invoice is flagged');
  assert.ok(byU['U-C'].warnings.includes('PO-EXCEEDED'), 'docs after the crossing stay flagged');
});

test('T-029 per-supplier aggregates and totals include fail-closed fetch failures', () => {
  const pos = [PO()];
  const invoices = [
    INV(), INV({ uuid: 'U2', totalAmount: 200 }),
    INV({ uuid: 'U3', issuerId: '999', issuerName: 'Stranger', totalAmount: 50 }),
  ];
  const a = analyzePo(pos, invoices, { windowDays: 14, nowMs: NOW, fetchFailed: 2 });
  const acme = a.perSupplier.find((s) => s.tin === '100200300');
  assert.equal(acme.invCount, 2);
  assert.equal(acme.totalAmount, 300);
  assert.equal(acme.matchedCount, 2);
  const other = a.perSupplier.find((s) => s.tin === '999');
  assert.equal(other.unmatchedCount, 1);
  assert.equal(a.totals.invoices, 3);
  assert.equal(a.totals.matched, 2);
  assert.equal(a.totals.unmatched, 1);
  assert.equal(a.totals.fetchFailed, 2);
  assert.ok(a.totals.warnings >= 1);
});

test('T-030 rejection-window status per invoice via resolver', () => {
  const pos = [PO()];
  const seen = [];
  const resolver = (o) => { seen.push(o.documentTypeNamePrimaryLang); return o.documentTypeNamePrimaryLang === 'Credit Note' ? 30 : 3; };
  const invoices = [
    INV({ uuid: 'W1', receivedIso: '2026-07-25T12:00:00Z' }),                       // 2d old, 3d window → can-reject
    INV({ uuid: 'W2', receivedIso: '2026-07-07T12:00:00Z' }),                       // 20d old → window-passed
    INV({ uuid: 'W3', receivedIso: null }),                                          // unknown
    INV({ uuid: 'W4', typeEn: 'Credit Note', receivedIso: '2026-07-07T12:00:00Z' }), // 20d old but 30d window
  ];
  const a = analyzePo(pos, invoices, { resolveWindow: resolver, windowDays: 14, nowMs: NOW });
  const byU = Object.fromEntries(a.perInvoice.map((i) => [i.uuid, i]));
  assert.equal(byU.W1.window.status, 'can-reject');
  assert.equal(Math.floor(byU.W1.window.daysLeft), 1);
  assert.equal(byU.W2.window.status, 'window-passed');
  assert.equal(byU.W3.window.status, 'unknown');
  assert.equal(byU.W4.window.status, 'can-reject', 'per-type window honored');
  assert.ok(seen.includes('Credit Note'));
});
