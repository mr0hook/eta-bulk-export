// SPEC-014 — streaming single-sheet xlsx writer. Constant memory, any row count.
//
// Why this exists: the vendored browser build of ExcelJS has no streaming writer, so a whole
// workbook lives in its object model until writeBuffer() zips it — ~9.5KB of heap per row, which
// OOMs a browser tab at ~90k rows. That forced merge to split every 60k rows. An xlsx is just a ZIP
// of XML, so generating the XML row-by-row and deflating it straight into the zip costs flat memory
// regardless of size. Measured: 1,000,000 rows at 22MB heap, and ExcelJS reads the result back with
// sheet names, Arabic headers, real Date cells and the RTL frozen pane intact.
//
// Only the MERGE OUTPUT uses this. Reading, and the per-chunk export, still use ExcelJS.
import JSZip from 'jszip';

const enc = new TextEncoder();

// Excel's own format limit. Not a tuning knob — a sheet cannot hold more.
export const SHEET_MAX_ROWS = 1048576;

const CRC = (() => { const t = new Int32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c; } return t; })();
const crc32 = (buf, c = 0) => { c = ~c; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return ~c >>> 0; };

// XML 1.0 forbids the C0 control characters outright (tab/LF/CR excepted) — one of them in a
// description field would make the whole file unopenable, so they are dropped, not escaped.
const stripCtl = (s) => {
  let o = '';
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c > 31 || c === 9 || c === 10 || c === 13) o += s[i]; }
  return o;
};
const esc = (s) => stripCtl(String(s)).replace(/[&<>]/g, (m) => (m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;'));
export function colRef(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; }

const SERIAL_EPOCH = Date.UTC(1899, 11, 30);
const toSerial = (d) => (d.getTime() - SERIAL_EPOCH) / 86400000;

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const WBRELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
// s="1" is the date format; everything else uses the default style.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;
const wbXml = (sheet) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheet).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

// Column widths are guessed from the header text: the merge unions columns by NAME across chunk
// files, so the base mapping's per-column widths aren't available here. With no <cols> at all Excel
// falls back to its 8.43-char default and every date cell shows as ########.
const DATE_HDR = /تاريخ|date/i;
const colWidth = (h) => (DATE_HDR.test(String(h ?? '')) ? 21 : Math.min(40, Math.max(11, String(h ?? '').length + 3)));
const colsXml = (cols) => (cols.length
  ? '<cols>' + cols.map((h, i) => `<col min="${i + 1}" max="${i + 1}" width="${colWidth(h)}" customWidth="1"/>`).join('') + '</cols>'
  : '');

const SHEET_HEAD = (rtl, cols) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView${rtl ? ' rightToLeft="1"' : ''} tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>${colsXml(cols)}<sheetData>`;
export const SHEET_TAIL = '</sheetData></worksheet>';

const FLUSH_CHARS = 1 << 18;   // ~256KB of XML per compressor write

// ---- ZIP container, written strictly forward (no seeking: the FSA writable is append-only here) ----
class Zip {
  constructor(sink) { this.sink = sink; this.offset = 0; this.entries = []; }
  async raw(u8) { this.offset += u8.length; await this.sink(u8); }
  #header(nameB, method, flag) {
    const b = new Uint8Array(30 + nameB.length), dv = new DataView(b.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, flag, true);
    dv.setUint16(8, method, true); dv.setUint16(12, 0x2821, true); dv.setUint16(26, nameB.length, true);
    b.set(nameB, 30); return b;
  }
  // Small parts: size and CRC are known up front, so they get ordinary headers.
  async small(name, text) {
    const nameB = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const h = this.#header(nameB, 0, 0), dv = new DataView(h.buffer);
    dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
    const start = this.offset;
    await this.raw(h); await this.raw(data);
    this.entries.push({ name: nameB, crc, comp: data.length, raw: data.length, start, method: 0, flag: 0 });
  }
  // The sheet: size is unknowable until the last row, so it uses a streaming data descriptor
  // (general-purpose bit 3) — the standard shape for a zip written in one forward pass.
  async stream(name) {
    const nameB = enc.encode(name);
    const deflate = typeof CompressionStream === 'function';
    const method = deflate ? 8 : 0, flag = 0x08;
    const start = this.offset;
    await this.raw(this.#header(nameB, method, flag));
    let crc = 0, raw = 0, comp = 0;
    let writer = null, pump = null;
    if (deflate) {
      const cs = new CompressionStream('deflate-raw');
      writer = cs.writable.getWriter();
      const reader = cs.readable.getReader();
      pump = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; comp += value.length; await this.raw(value); } })();
    }
    return {
      write: async (text) => {
        const u8 = enc.encode(text); crc = crc32(u8, crc); raw += u8.length;
        if (deflate) await writer.write(u8); else { comp += u8.length; await this.raw(u8); }
      },
      end: async () => {
        if (deflate) { await writer.close(); await pump; }
        const dd = new Uint8Array(16), dv = new DataView(dd.buffer);
        dv.setUint32(0, 0x08074b50, true); dv.setUint32(4, crc, true); dv.setUint32(8, comp, true); dv.setUint32(12, raw, true);
        await this.raw(dd);
        this.entries.push({ name: nameB, crc, comp, raw, start, method, flag });
      },
    };
  }
  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const b = new Uint8Array(46 + e.name.length), dv = new DataView(b.buffer);
      dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
      dv.setUint16(8, e.flag, true); dv.setUint16(10, e.method, true); dv.setUint16(14, 0x2821, true);
      dv.setUint32(16, e.crc, true); dv.setUint32(20, e.comp, true); dv.setUint32(24, e.raw, true);
      dv.setUint16(28, e.name.length, true); dv.setUint32(42, e.start, true); b.set(e.name, 46);
      await this.raw(b);
    }
    const eo = new Uint8Array(22), dv = new DataView(eo.buffer);
    dv.setUint32(0, 0x06054b50, true); dv.setUint16(8, this.entries.length, true);
    dv.setUint16(10, this.entries.length, true); dv.setUint32(12, this.offset - cdStart, true);
    dv.setUint32(16, cdStart, true);
    await this.raw(eo);
  }
}

function cellXml(v, ref) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return isNaN(v) ? '' : `<c r="${ref}" s="1"><v>${toSerial(v)}</v></c>`;
  if (typeof v === 'number') return isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : '';
  if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  // ExcelJS hands back rich text and formula/hyperlink objects for some cells; take their text.
  if (typeof v === 'object') {
    const s = Array.isArray(v.richText) ? v.richText.map((r) => r.text).join('') : (v.text ?? v.result ?? v.hyperlink ?? '');
    return s === '' ? '' : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(s)}</t></is></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

// Writes one sheet into one file. addRow() takes an array of values positional to `header`.
export async function createXlsxWriter(dir, name, { sheetName = 'Sheet1', header = [], cols = header, rtl = true } = {}) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  const zip = new Zip((u8) => w.write(u8));
  await zip.small('[Content_Types].xml', CT);
  await zip.small('_rels/.rels', RELS);
  await zip.small('xl/workbook.xml', wbXml(sheetName));
  await zip.small('xl/_rels/workbook.xml.rels', WBRELS);
  await zip.small('xl/styles.xml', STYLES);
  const sheet = await zip.stream('xl/worksheets/sheet1.xml');

  let buf = SHEET_HEAD(rtl, cols), rows = 0;
  const flush = async () => { if (buf) { await sheet.write(buf); buf = ''; } };
  if (header.length) { rows = 1; buf += `<row r="1">` + header.map((h, i) => cellXml(String(h ?? ''), colRef(i + 1) + '1')).join('') + '</row>'; }

  return {
    get rows() { return rows; },
    async addRow(vals) {
      rows++;
      let cells = '';
      for (let i = 0; i < vals.length; i++) cells += cellXml(vals[i], colRef(i + 1) + rows);
      buf += `<row r="${rows}">${cells}</row>`;
      if (buf.length >= FLUSH_CHARS) await flush();
    },
    // Copy an existing sheet's <row> elements verbatim, renumbering nothing — used to top up a part
    // without ever holding it in memory. `text` arrives in chunks from a streaming unzip.
    async copyChunk(text) { buf += text; if (buf.length >= FLUSH_CHARS) await flush(); },
    setRows(n) { rows = n; },
    async close() {
      buf += SHEET_TAIL;
      await flush();
      await sheet.end();
      await zip.finish();
      await w.close();
      return rows;
    },
  };
}

// Streams the <row> elements out of a sheet we previously wrote, so an existing part can be topped
// up without ever materialising it. The zip itself is small (a 1M-row part is ~25MB compressed); it
// is the DECOMPRESSED xml — and ExcelJS's object model — that would blow the heap, and both are
// avoided here. Decoding is incremental so a multi-byte Arabic character split across two chunks
// isn't mangled.
export async function copySheetBody(bytes, onChunk) {
  const zip = await JSZip.loadAsync(bytes);
  const f = zip.file('xl/worksheets/sheet1.xml');
  if (!f) throw new Error('no sheet1.xml — not a stream-written part');
  const dec = new TextDecoder('utf-8');
  let started = false, held = '';
  const CLOSE = '</sheetData>';
  // Hold back the WHOLE trailer, not just </sheetData>: the stream ends
  // "</sheetData></worksheet>", so a 12-char holdback leaves </worksheet> in the buffer and it gets
  // copied into the new sheet as a stray closing tag.
  const HOLD = SHEET_TAIL.length;

  const handle = async (text) => {
    held += text;
    if (!started) {
      const i = held.indexOf('<sheetData>');
      if (i < 0) return;                       // header not seen yet; keep buffering
      held = held.slice(i + '<sheetData>'.length);
      started = true;
    }
    // Hold back enough to recognise the closing tag if it straddles a chunk boundary.
    if (held.length > HOLD) {
      const cut = held.length - HOLD;
      const out = held.slice(0, cut);
      held = held.slice(cut);
      if (out) await onChunk(out);
    }
  };

  await new Promise((resolve, reject) => {
    const s = f.internalStream('uint8array');
    let chain = Promise.resolve();
    s.on('data', (chunk) => {
      s.pause();
      chain = chain.then(() => handle(dec.decode(chunk, { stream: true }))).then(() => s.resume(), reject);
    });
    s.on('error', reject);
    s.on('end', () => { chain.then(resolve, reject); });
    s.resume();
  });

  const tailIdx = held.lastIndexOf(CLOSE);
  const rest = tailIdx >= 0 ? held.slice(0, tailIdx) : held;
  if (rest) await onChunk(rest);
}
