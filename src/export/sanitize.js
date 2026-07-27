// Strip characters that are illegal in XML 1.0 (control chars + noncharacters).
// ETA/ERP data occasionally contains these (e.g. a stray U+FFFE glued into a name);
// ExcelJS writes them raw, which corrupts the shared-string table. We clean at the
// data layer so the vendored ExcelJS can stay pristine. Keeps tab/LF/CR (legal).
const ILLEGAL = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;
const LONE_HI = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;   // high surrogate not followed by a low  \u2192 invalid XML
const LONE_LO = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;   // low surrogate not preceded by a high  \u2192 invalid XML
// Strip control/noncharacters AND unpaired surrogates (a lone surrogate makes the whole workbook unopenable);
// valid emoji/supplementary chars are surrogate PAIRS and are preserved.
const scrub = (s) => s.replace(ILLEGAL, '').replace(LONE_HI, '').replace(LONE_LO, '');

export function clean(v) {
  return typeof v === 'string' ? scrub(v) : v;
}

// Deep-clean a plain row object's string values (and {text,hyperlink} cells).
export function cleanRow(row) {
  for (const k in row) {
    const v = row[k];
    if (typeof v === 'string') row[k] = scrub(v);
    else if (v && typeof v === 'object') { if (typeof v.text === 'string') v.text = scrub(v.text); if (typeof v.hyperlink === 'string') v.hyperlink = scrub(v.hyperlink); }   // scrub the link TARGET too — it lands in .xml.rels which repair.js can't reach
  }
  return row;
}
