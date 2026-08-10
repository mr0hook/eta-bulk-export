import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDir } from './fakefs.mjs';
import { runKey, filePrefix, chunkFile, writeProgress, readProgress, scanDoneFromFolder, chunkStates } from '../src/core/store.js';
import { appendText } from '../src/core/fs.js';

// store.js mirrors to localStorage too (saveState); stub it so imports/side-effects don't throw.
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, key: () => null, length: 0 };

const plan = () => ({
  key: runKey('invoices', '2025', 'Sent', 'Issue', '2025-01-01', '2025-12-31'),
  source: 'invoices', year: '2025', dir: 'Sent', dateField: 'Issue', from: '2025-01-01', to: '2025-12-31',
  statuses: ['Valid'], totalRows: 300, cap: 10000,
  chunks: [{ id: 'c1', label: '2025-01', count: 100 }, { id: 'c2', label: '2025-02', count: 200 }],
  doneIds: ['c1'], failedIds: [],
});

test('runKey: field composition + receipts prefix', () => {
  assert.equal(runKey('invoices', '2025', 'Sent', 'Issue', 'a', 'b'), '2025_Sent_Issue_a_b');
  assert.ok(runKey('receipts', '2025', 'All', 'DateTimeReceived', 'a', 'b').startsWith('receipts_'));
});

test('chunkFile: safe-named, source-prefixed, deterministic', () => {
  const p = plan();
  assert.equal(filePrefix(p), 'eInvoices');
  const f = chunkFile(p, p.chunks[0]);
  assert.ok(f.startsWith('eInvoices_2025_Sent_') && f.endsWith('.xlsx'));
  assert.match(f, /^[0-9A-Za-z_.\-]+$/, 'no filesystem-unsafe chars');
  assert.equal(f, chunkFile(p, p.chunks[0]), 'deterministic for the same chunk');
});

test('chunkFile: BLOCKER regression — sub-minute chunks with identical labels get distinct files', () => {
  const p = plan();
  const a = { id: '2024-03-01T10:00:07Z_2024-03-01T10:00:14Z', label: '2024-03-01 10:00→ 2024-03-01 10:00', count: 9000 };
  const b = { id: '2024-03-01T10:00:14Z_2024-03-01T10:00:29Z', label: '2024-03-01 10:00→ 2024-03-01 10:00', count: 9000 };
  assert.equal(a.label, b.label, 'labels collide (minute resolution) — the original bug');
  assert.notEqual(chunkFile(p, a), chunkFile(p, b), 'but distinct chunk.ids yield distinct files → no overwrite');
});

test('chunkFile: HIGH regression — a different status filter over the same range gets a distinct file', () => {
  const p = plan();
  const p2 = { ...plan(), statuses: ['Valid', 'Cancelled'] };
  assert.notEqual(chunkFile(p, p.chunks[0]), chunkFile(p2, p2.chunks[0]), 'filter signature separates the files → no false "done"');
});

test('writeProgress → readProgress: done/remaining/doneRows computed from done set', async () => {
  const dir = fakeDir(); const p = plan();
  await writeProgress(dir, p, 'running');
  const back = await readProgress(dir);
  assert.equal(back.status, 'running');
  assert.equal(back.totalChunks, 2);
  assert.equal(back.doneChunks, 1);
  assert.equal(back.remainingChunks, 1);
  assert.equal(back.doneRows, 100, 'sums counts of DONE chunks only (c1=100)');
  assert.deepEqual(back.doneIds, ['c1']);
});

test('writeProgress: carries the jobId, so a folder-only resume can still checkpoint', async () => {
  const dir = fakeDir();
  await writeProgress(dir, { ...plan(), jobId: 'abc123' }, 'running');
  assert.equal((await readProgress(dir)).jobId, 'abc123');
  // A plan minted before this field existed must still write a file, not throw or emit undefined.
  const dir2 = fakeDir();
  await writeProgress(dir2, plan(), 'running');
  assert.equal((await readProgress(dir2)).jobId, '');
});

test('chunkStates: one char per chunk in plan order, done > running > failed', () => {
  const p = { chunks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], doneIds: ['a'], failedIds: ['c'] };
  assert.equal(chunkStates(p, 'b'), 'drfp');
  assert.equal(chunkStates(p), 'dpfp', 'no chunk in flight → nothing reads as running');
  // A resumed run skips its finished chunks without re-running them; they must stay 'd'.
  assert.equal(chunkStates({ ...p, doneIds: ['a', 'b'] }, 'b'), 'ddfp', 'done beats running');
  // A failed chunk being retried is in flight, not red — same precedence flow.js chunkMap uses.
  assert.equal(chunkStates({ ...p, failedIds: ['b'] }, 'b'), 'drpp', 'running beats failed');
});

test('chunkStates: degrades to an empty string rather than throwing on a shapeless plan', () => {
  assert.equal(chunkStates(null), '');
  assert.equal(chunkStates({}), '');
  assert.equal(chunkStates({ chunks: [{ id: 'a' }] }), 'p', 'missing doneIds/failedIds → all pending');
});

test('scanDoneFromFolder: reconstructs done ids from present .xlsx files only', async () => {
  const dir = fakeDir(); const p = plan();
  // materialise only c2's file — c1's is absent
  const fh = await dir.getFileHandle(chunkFile(p, p.chunks[1]), { create: true });
  const w = await fh.createWritable(); await w.write('x'); await w.close();
  assert.deepEqual(await scanDoneFromFolder(dir, p), ['c2'], 'only the present file counts as done');
});

test('readProgress: missing file → null (no throw)', async () => {
  assert.equal(await readProgress(fakeDir()), null);
});

test('appendText: MEDIUM regression — getFile() failure throws instead of overwriting the log head (#11)', async () => {
  const dir = fakeDir();
  await appendText(dir, 'log.jsonl', 'line1\n');
  const realGFH = dir.getFileHandle.bind(dir);
  dir.getFileHandle = async (name, opts) => { const h = await realGFH(name, opts); if (name === 'log.jsonl') h.getFile = async () => { throw new Error('locked'); }; return h; };
  await assert.rejects(() => appendText(dir, 'log.jsonl', 'line2\n'), /locked/, 'must throw, not default to position 0');
  assert.equal(new TextDecoder().decode(dir.files.get('log.jsonl')), 'line1\n', 'existing log head is intact');
});

test('writeProgress: HIGH regression — two runs sharing a folder do not clobber each other', async () => {
  const dir = fakeDir();
  const inv = { ...plan(), failedIds: ['f9'] }; // an invoices run with a failed chunk
  const rcp = { ...plan(), key: runKey('receipts', '2025', 'All', 'DateTimeReceived', 'a', 'b'), source: 'receipts', dir: 'All', dateField: 'DateTimeReceived', failedIds: [] };
  await writeProgress(dir, inv, 'incomplete');
  await writeProgress(dir, rcp, 'done'); // must NOT overwrite the invoices progress
  const backInv = await readProgress(dir, inv);
  const backRcp = await readProgress(dir, rcp);
  assert.equal(backInv.source, 'invoices');
  assert.deepEqual(backInv.failedIds, ['f9'], 'invoices failed chunk survived the later receipts run');
  assert.equal(backRcp.source, 'receipts');
});
