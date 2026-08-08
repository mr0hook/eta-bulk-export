// File System Access + IndexedDB handle persistence. No chrome APIs (MAIN world).
const DB = 'etaBulk', STORE = 'handles';
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
export async function idbSet(k, v) { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }
export async function idbGet(k) { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction(STORE, 'readonly'); const rq = tx.objectStore(STORE).get(k); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); }

export const pickFolder = () => window.showDirectoryPicker({ mode: 'readwrite' });
export async function ensurePermission(handle) {
  if (!handle) return false; const o = { mode: 'readwrite' };
  if (await handle.queryPermission(o) === 'granted') return true;
  return (await handle.requestPermission(o)) === 'granted';
}
export async function writeBlob(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(blob); await w.close();
}
export async function subdir(dir, name) { return dir.getDirectoryHandle(name, { create: true }); }
export const writeText = (dir, name, text) => writeBlob(dir, name, new Blob([text], { type: 'text/plain' }));
export async function appendText(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  // Must know the true end-of-file. If getFile() fails we must NOT default to 0 — that would overwrite the
  // head of the (compliance-critical) failures log. Let it throw so the caller can retry the whole chunk.
  const size = (await fh.getFile()).size;
  const w = await fh.createWritable({ keepExistingData: true });
  await w.write({ type: 'write', position: size, data: text }); await w.close();
}
// One long-lived writable for streaming a scratch file. appendText re-opens with keepExistingData, and
// Chromium copies the WHOLE current file into a swap file on every open — O(N²) bytes on a multi-GB temp.
// Callers that own the file end-to-end (and can afford to truncate it) should stream through this instead.
export async function openWrite(dir, name) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();   // truncates: this is a fresh scratch file, not an append target
  return { write: (text) => w.write(text), close: () => w.close() };
}
export async function remove(dir, name) { await dir.removeEntry(name); }
export async function readText(dir, name) { try { const fh = await dir.getFileHandle(name); return await (await fh.getFile()).text(); } catch { return null; } }
export async function listFiles(dir, re) { const out = []; for await (const [n, h] of dir.entries()) if (h.kind === 'file' && (!re || re.test(n))) out.push(n); return out; }
export async function readArrayBuffer(dir, name) { const fh = await dir.getFileHandle(name); return (await fh.getFile()).arrayBuffer(); }
export async function* readLines(dir, name) {
  const fh = await dir.getFileHandle(name); const file = await fh.getFile();
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) { const { value, done } = await reader.read(); if (done) break; buf += value; let i; while ((i = buf.indexOf('\n')) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1); } }
  if (buf) yield buf;
}
