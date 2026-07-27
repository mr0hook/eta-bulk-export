import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { repairFolder } from '../src/core/repair.js';
import { fakeDir } from './fakefs.mjs';

const ILLEGAL = new RegExp('[' + String.fromCharCode(0xFFFE, 0xFFFF) + ']');

// build a valid xlsx then inject an illegal char into sharedStrings (simulates a legacy-corrupt file)
async function makeCorruptXlsx() {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('s'); ws.addRow(['name']); ws.addRow(['okstring']);
  const zip = await JSZip.loadAsync(await wb.xlsx.writeBuffer());
  const ss = await zip.file('xl/sharedStrings.xml').async('string');
  zip.file('xl/sharedStrings.xml', ss.replace('okstring', 'ok' + String.fromCharCode(0xFFFE) + 'string'));
  return zip.generateAsync({ type: 'uint8array' });
}

test('repair: scan detects, repair strips illegal char + keeps .corrupt.bak', async () => {
  const dir = fakeDir();
  const bad = await makeCorruptXlsx();
  const fh = await dir.getFileHandle('eInvoices_2025_Sent_x.xlsx', { create: true }); const w = await fh.createWritable(); await w.write(bad); await w.close();

  const scan = []; await repairFolder(dir, { onStatus: (m) => scan.push(m), scanOnly: true });
  assert.ok(scan.some((m) => /^CORRUPT/.test(m)), 'scan flags the corrupt file');
  assert.ok(!dir.files.has('eInvoices_2025_Sent_x.xlsx.corrupt.bak'), 'scan-only writes nothing');

  const rep = []; await repairFolder(dir, { onStatus: (m) => rep.push(m) });
  assert.ok(rep.some((m) => /^REPAIRED/.test(m)), 'repair reports fixed');
  assert.ok(dir.files.has('eInvoices_2025_Sent_x.xlsx.corrupt.bak'), 'original backed up');

  const zip = await JSZip.loadAsync((await (await dir.getFileHandle('eInvoices_2025_Sent_x.xlsx')).getFile()).arrayBuffer());
  const ss = await zip.file('xl/sharedStrings.xml').async('string');
  assert.ok(!ILLEGAL.test(ss), 'illegal char stripped from repaired file');
  assert.ok(ss.includes('okstring'), 'surrounding text preserved (okstring)');

  const clean = []; await repairFolder(dir, { onStatus: (m) => clean.push(m), scanOnly: true });
  assert.ok(clean.some((m) => /0 corrupt/.test(m)), 're-scan finds it clean');
});
