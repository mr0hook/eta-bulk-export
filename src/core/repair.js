// Repair/scan xlsx files whose XML holds illegal characters (legacy exports from other tools;
// this tool never produces them — it sanitizes on write). Unzips, strips illegal chars from
// sharedStrings/worksheets, rezips, keeping <name>.corrupt.bak. Uses JSZip (MIT).
import JSZip from 'jszip';
import { listFiles, readArrayBuffer, writeBlob } from './fs.js';
import { t } from './i18n.js';

const CTRL_G = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;
const LONE_HI = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
const LONE_LO = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// stateless detector (non-global .test avoids the /g lastIndex bug that breaks scanOnly); strips controls + noncharacters + lone surrogates
const hasIllegal = (t) => /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/.test(t) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t) || /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t);
const strip = (t) => t.replace(CTRL_G, '').replace(LONE_HI, '').replace(LONE_LO, '');
const PART = /\.xml$/i;   // scan EVERY xml part (sharedStrings, worksheets, docProps, comments, styles\u2026), not just two

export async function repairFolder(dir, { onStatus = () => {}, scanOnly = false } = {}) {
  const files = (await listFiles(dir, /\.xlsx$/i)).filter((n) => !/COMBINED/i.test(n));
  if (!files.length) { onStatus(t('repair.noFiles')); return; }
  let hit = 0, fixed = 0, errors = 0;
  for (const name of files) {
    try {
      const buf = await readArrayBuffer(dir, name);
      const zip = await JSZip.loadAsync(buf);
      let bad = false;
      for (const path of Object.keys(zip.files)) {
        if (!PART.test(path)) continue;
        const txt = await zip.file(path).async('string');
        if (hasIllegal(txt)) { bad = true; if (!scanOnly) zip.file(path, strip(txt)); }
      }
      if (!bad) continue;
      hit++;
      if (scanOnly) { onStatus(t('repair.corrupt', { name })); continue; }
      await writeBlob(dir, name + '.corrupt.bak', new Blob([buf]));          // backup original
      const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
      await writeBlob(dir, name, new Blob([out], { type: 'application/zip' })); fixed++;
      onStatus(t('repair.repaired', { name }));
    } catch (e) { errors++; onStatus(t('repair.error', { name, msg: e?.message || e })); }
  }
  onStatus(scanOnly
    ? t('repair.scanSummary', { hit, n: files.length })
    : t('repair.repairSummary', { fixed, errors, hit, n: files.length }));
}
