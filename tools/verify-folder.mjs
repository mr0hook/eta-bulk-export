// Independent count of what a folder's chunk files actually contain.
//
// Answers the only question that matters after a merge: is a unique count lower than the plan's
// totalRows because duplicates were removed (correct — the planner cuts on an inclusive shared
// boundary, so a document on a cut is fetched by both neighbours), or because documents are
// genuinely missing (not correct)?
//
//   node --max-old-space-size=8192 tools/verify-folder.mjs "C:\path\to\folder"
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

const root = process.argv[2];
const UUID = 'الرقم الإلكترونى';
const names = (await readdir(root)).filter((n) => /^eInvoices.*\.xlsx$/i.test(n) && !/COMBINED/i.test(n) && !/_det_p\d+/i.test(n)).sort();

let rows = 0;
const seen = new Set();
const dupOwners = new Map();   // uuid → first file that had it (only for the first few, to show examples)
const perFile = [];

for (const [i, n] of names.entries()) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile(path.join(root, n))).buffer);
  const ws = wb.worksheets[0];
  const hdr = ws.getRow(1).values.slice(1).map((h) => String(h ?? ''));
  const col = hdr.indexOf(UUID) + 1;
  let fileRows = 0, fileDup = 0;
  ws.eachRow((r, rn) => {
    if (rn === 1) return;
    fileRows++;
    const u = r.values[col];
    if (u == null || u === '') return;
    if (seen.has(u)) { fileDup++; if (dupOwners.size < 5) dupOwners.set(u, `${dupOwners.get(u) || ''}${n};`); }
    else seen.add(u);
  });
  rows += fileRows;
  perFile.push({ n, fileRows, fileDup });
  process.stdout.write(`\r  ${i + 1}/${names.length} files · ${rows} rows · ${seen.size} unique`);
}

console.log('\n');
console.log('chunk files          :', names.length);
console.log('summary rows total   :', rows);
console.log('unique uuids         :', seen.size);
console.log('duplicates removed   :', rows - seen.size);
const withDup = perFile.filter((f) => f.fileDup > 0);
console.log('files containing dups:', withDup.length);
for (const f of withDup.slice(0, 8)) console.log(`   ${f.n}  rows=${f.fileRows} dup=${f.fileDup}`);
