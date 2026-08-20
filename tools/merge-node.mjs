// Run the SAME merge the extension runs, but in Node against a real folder.
//
// Why this exists: on 2026-08-20 the in-browser merge died three times with Chromium's opaque
// "state cached in an interface object … changed since it was read from disk", each time leaving a
// multi-gigabyte .crswap behind. Node has no File System Access API and no swap files, so running
// the identical merge here either produces the deliverables or reproduces the fault somewhere we
// can actually read a stack trace.
//
//   node --max-old-space-size=8192 tools/merge-node.mjs "C:\path\to\export folder"
//
// Nothing is written outside the folder you name, and no chunk file is modified — merge only reads
// the chunk workbooks and writes COMBINED_* outputs plus its own scratch, exactly as in the browser.
import { readdir, stat, open, unlink, rename, readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { mergeFolder } from '../src/core/merge.js';

const dirPath = process.argv[2];
if (!dirPath) { console.error('usage: node tools/merge-node.mjs "<folder>"'); process.exit(1); }

// A FileSystemDirectoryHandle stand-in over the real filesystem. Only the surface src/core/fs.js
// actually uses: entries(), getFileHandle(), removeEntry(), and on a handle: getFile(),
// createWritable(), move().
function nodeDir(root) {
  const p = (name) => path.join(root, name);
  const fileHandle = (name) => ({
    kind: 'file',
    name,
    async getFile() {
      const st = await stat(p(name));
      return {
        size: st.size,
        async arrayBuffer() { const b = await readFile(p(name)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
        async text() { return readFile(p(name), 'utf8'); },
        // merge's readLines() pipes this through TextDecoderStream
        stream() { return Readable.toWeb(createReadStream(p(name))); },
      };
    },
    async createWritable(opts) {
      // keepExistingData:true is the append path (appendText); everything else truncates.
      const fh = await open(p(name), opts && opts.keepExistingData ? 'a+' : 'w');
      return {
        async write(chunk) {
          // Accepts a string, a Blob, a Uint8Array, or {type:'write',position,data}
          if (chunk && typeof chunk === 'object' && chunk.type === 'write') {
            const data = typeof chunk.data === 'string' ? Buffer.from(chunk.data) : Buffer.from(await chunk.data.arrayBuffer());
            await fh.write(data, 0, data.length, chunk.position);
            return;
          }
          let buf;
          if (typeof chunk === 'string') buf = Buffer.from(chunk);
          else if (chunk instanceof Uint8Array) buf = Buffer.from(chunk);
          else buf = Buffer.from(await chunk.arrayBuffer());   // Blob
          await fh.write(buf);
        },
        async close() { await fh.close(); },
      };
    },
    async move(to) { await rename(p(name), p(to)); },
  });
  return {
    name: path.basename(root),
    async getFileHandle(name, opts) {
      if (!(opts && opts.create)) await stat(p(name));   // must throw when absent, like FSA
      else { const fh = await open(p(name), 'a'); await fh.close(); }
      return fileHandle(name);
    },
    async getDirectoryHandle() { throw new Error('subdirectories are not needed for merge'); },
    async removeEntry(name) { await unlink(p(name)); },
    async *entries() {
      for (const e of await readdir(root, { withFileTypes: true })) if (e.isFile()) yield [e.name, fileHandle(e.name)];
    },
  };
}

const started = Date.now();
const dir = nodeDir(dirPath);
console.log('merging', dirPath);
try {
  await mergeFolder(ExcelJS, dir, {
    onStatus: (m) => console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${m}`),
  });
  console.log(`\ndone in ${Math.round((Date.now() - started) / 1000)}s`);
} catch (e) {
  console.error('\nMERGE FAILED:', e && e.message);
  console.error(e && e.stack);
  process.exit(2);
}
