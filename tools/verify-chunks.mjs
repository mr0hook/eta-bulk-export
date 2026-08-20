// Per-chunk reconciliation: what the PLAN said each chunk holds vs what its file actually contains.
//
// A folder-level shortfall (2024 Q1: 240,351 planned, 230,545 present, 0 duplicates, 0 failures)
// says documents were never fetched. This says WHICH chunks are short, by how much, and what those
// chunks have in common — which is what identifies the mechanism.
//
//   node --max-old-space-size=8192 tools/verify-chunks.mjs "C:\path\to\folder"
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { chunkFile } from '../src/core/store.js';

const root = process.argv[2];
const files = await readdir(root);
const progName = files.find((n) => /^eta_progress.*\.json$/i.test(n));
if (!progName) { console.error('no eta_progress*.json in that folder'); process.exit(1); }
const prog = JSON.parse(await readFile(path.join(root, progName), 'utf8'));
// The progress file stores the date field as `field`; chunkFile()'s signature hashes `dateField`
// (orchestrator.resume() does the same remap). Without this every filename misses.
const plan = { ...prog, dateField: prog.dateField || prog.field, mode: prog.mode || 'range' };
console.log(`plan: ${plan.chunks.length} chunks · totalRows ${plan.totalRows} · done ${plan.doneIds?.length} · failed ${plan.failedIds?.length}\n`);

const present = new Set(files);
const rowsOf = async (name) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile(path.join(root, name))).buffer);
  const ws = wb.worksheets[0];
  let n = 0; ws.eachRow((r, rn) => { if (rn > 1) n++; });
  return n;
};

const out = [];
let plannedSum = 0, actualSum = 0;
for (const [i, c] of plan.chunks.entries()) {
  const fname = chunkFile(plan, c);
  plannedSum += c.count | 0;
  if (!present.has(fname)) { out.push({ i: i + 1, label: c.label, planned: c.count, actual: null, miss: c.count, note: 'NO FILE' }); continue; }
  const actual = await rowsOf(fname);
  actualSum += actual;
  out.push({ i: i + 1, label: c.label, from: c.fromISO, to: c.toISO, planned: c.count | 0, actual, miss: (c.count | 0) - actual, warn: c.warn || '', sub: c.subF ? 'sub' : '' });
  process.stdout.write(`\r  checked ${i + 1}/${plan.chunks.length}`);
}
console.log('\n');

const short = out.filter((r) => r.miss > 0).sort((a, b) => b.miss - a.miss);
const over = out.filter((r) => r.miss < 0);
console.log(`planned total ${plannedSum} · actual total ${actualSum} · missing ${plannedSum - actualSum}`);
console.log(`chunks short: ${short.length}/${out.length} · chunks over: ${over.length}\n`);
console.log('idx  planned   actual   missing  window');
for (const r of short) {
  console.log(`${String(r.i).padStart(3)}  ${String(r.planned).padStart(7)}  ${String(r.actual ?? '-').padStart(7)}  ${String(r.miss).padStart(7)}  ${r.from || ''} → ${r.to || ''} ${r.warn} ${r.sub}`);
}
// Patterns worth seeing at a glance
const caps = short.filter((r) => r.planned >= 9000).length;
const exact100 = short.filter((r) => r.miss % 100 === 0).length;
console.log(`\nshort chunks with planned >= 9000: ${caps}`);
console.log(`shortfalls that are an exact multiple of the 100-row page size: ${exact100}/${short.length}`);
console.log(`largest single shortfall: ${short[0] ? short[0].miss : 0}`);
