// Delete the chunk files that came back short and heal the progress file so a Resume refetches
// exactly those windows. Backs the progress file up first; touches nothing else.
//
//   node tools/drop-short-chunks.mjs "<folder>" <1-based chunk idx> [...]
import { readdir, readFile, writeFile, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { chunkFile } from '../src/core/store.js';

const root = process.argv[2];
const idxs = process.argv.slice(3).map(Number).filter((n) => n > 0);
if (!root || !idxs.length) { console.error('usage: node tools/drop-short-chunks.mjs "<folder>" <idx> [idx...]'); process.exit(1); }

const files = await readdir(root);
const progName = files.find((n) => /^eta_progress.*\.json$/i.test(n));
const progPath = path.join(root, progName);
const prog = JSON.parse(await readFile(progPath, 'utf8'));
const plan = { ...prog, dateField: prog.dateField || prog.field, mode: prog.mode || 'range' };

// Refuse on a filtered run: there, a chunk legitimately holds fewer rows than planned and file-truth
// healing does not apply, so dropping files would be guesswork.
const filtered = (Array.isArray(prog.statuses) && prog.statuses.length > 0 && prog.statuses.length < 4) || (prog.rinFilter && prog.rinFilter.length);
if (filtered) { console.error('this run is FILTERED — planned vs actual is not comparable. Aborting.'); process.exit(2); }

await copyFile(progPath, progPath + '.bak');
console.log(`backed up ${progName} → ${progName}.bak\n`);

const done = new Set(prog.doneIds || []);
for (const i of idxs) {
  const c = plan.chunks[i - 1];
  if (!c) { console.log(`#${i}: no such chunk`); continue; }
  const name = chunkFile(plan, c);
  let actual = 'missing';
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await readFile(path.join(root, name))).buffer);
    let n = 0; wb.worksheets[0].eachRow((r, rn) => { if (rn > 1) n++; });
    actual = n;
  } catch {}
  console.log(`#${i} ${c.label}`);
  console.log(`    planned ${c.count} · file has ${actual} · ${c.fromISO} → ${c.toISO}`);
  try { await unlink(path.join(root, name)); console.log(`    deleted ${name}`); } catch (e) { console.log(`    could not delete (${e.code})`); }
  // any detail parts belonging to it
  const stem = name.replace(/\.xlsx$/i, '');
  for (const f of files) {
    if (f.startsWith(stem) && /_det_p\d+\.xlsx$/i.test(f)) { try { await unlink(path.join(root, f)); console.log(`    deleted part ${f}`); } catch {} }
  }
  done.delete(c.id);
}

prog.doneIds = [...done];
prog.status = 'incomplete';
prog.updatedAt = new Date().toISOString();
await writeFile(progPath, JSON.stringify(prog, null, 1));
console.log(`\nprogress healed: doneIds ${(prog.doneIds || []).length}/${plan.chunks.length}, status=incomplete`);
console.log('Resume from folder will now refetch exactly the deleted windows.');
