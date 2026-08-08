// SPEC-010 / F-11 — TIN-scoped export folders.
// The bug this guards: chunk filenames carry no owner, and resume() decides what is already
// downloaded by filename presence alone (store.js:49 -> orchestrator.js:286). So a second company
// in the same folder silently inherits the first company's files and ships their invoices.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { fakeDir } from './fakefs.mjs';
import * as folder from '../src/core/folder.js';

// --- browser globals the orchestrator expects (integration tests below) ---
globalThis.window = { ExcelJS };
const lsBag = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsBag.has(k) ? lsBag.get(k) : null),
  setItem: (k, v) => lsBag.set(k, String(v)),
  removeItem: (k) => lsBag.delete(k),
  get length() { return lsBag.size; },
  key: (i) => [...lsBag.keys()][i] ?? null,
};
const loginAs = (rin, company = '') => {
  lsBag.set('USER_DATA', JSON.stringify({ access_token: 'h.e.s', profile: { TaxRin: rin } }));
  if (company) lsBag.set('TaxpayerNameAR', company); else lsBag.delete('TaxpayerNameAR');
};
const logout = () => { lsBag.delete('USER_DATA'); lsBag.delete('TaxpayerNameAR'); };
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms, ...a) => realSetTimeout(fn, 0, ...a);
after(() => { globalThis.setTimeout = realSetTimeout; });

const { createOrchestrator } = await import('../src/core/orchestrator.js');

const withData = async (dir, name = 'eInvoices_2026_Sent_abc_x_def.xlsx') => {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(new TextEncoder().encode('x')); await w.close();
};
const stampOf = async (dir) => JSON.parse(new TextDecoder().decode(dir.files.get(folder.STAMP)));

// ---------------------------------------------------------------- unit: folder.js

test('T-076 claim writes the stamp for the current taxpayer', async () => {
  const dir = fakeDir();
  const s = await folder.claim(dir, '111', 'شركة الألف');
  assert.ok(s, 'claim returns the stamp it wrote');
  const on = await stampOf(dir);
  assert.equal(on.v, 1);
  assert.equal(on.rin, '111');
  assert.equal(on.company, 'شركة الألف');
  assert.ok(on.claimedAt, 'records when it was claimed');
});

test('T-077 verify passes for the owner and never writes', async () => {
  const dir = fakeDir();
  await folder.claim(dir, '111', 'شركة الألف');
  const before = new TextDecoder().decode(dir.files.get(folder.STAMP));
  const keys = [...dir.files.keys()];

  const v = await folder.verify(dir, '111');

  assert.equal(v.state, 'ok');
  assert.equal(v.owner, '111');
  assert.equal(new TextDecoder().decode(dir.files.get(folder.STAMP)), before, 'stamp untouched');
  assert.deepEqual([...dir.files.keys()], keys, 'verify is read-only');
});

test('T-078 verify BLOCKS a different company and names the owner', async () => {
  const dir = fakeDir();
  await folder.claim(dir, '111', 'شركة الألف');

  const v = await folder.verify(dir, '222');

  assert.equal(v.state, 'blocked');
  assert.equal(v.owner, '111', 'the message can name who owns the folder');
  assert.equal(v.company, 'شركة الألف');
});

test('T-079 unstamped folder WITH data asks instead of guessing, and writes nothing', async () => {
  const dir = fakeDir();
  await withData(dir);

  const v = await folder.verify(dir, '111');

  assert.equal(v.state, 'needsConfirm', 'never auto-claims a folder that already holds exports');
  assert.equal(dir.files.has(folder.STAMP), false, 'nothing written while undecided');
});

test('T-080 unstamped EMPTY folder is fresh, and claiming it makes it ok', async () => {
  const dir = fakeDir();
  assert.equal((await folder.verify(dir, '111')).state, 'fresh');
  await folder.claim(dir, '111', 'شركة الألف');
  assert.equal((await folder.verify(dir, '111')).state, 'ok');
});

test('T-081 a corrupt stamp is treated as unstamped — never throws, never auto-claims over data', async () => {
  for (const junk of ['not json', '{"v":99,"rin":"111"}', '{}', '[]', '']) {
    const dir = fakeDir();
    await withData(dir);
    const fh = await dir.getFileHandle(folder.STAMP, { create: true });
    const w = await fh.createWritable(); await w.write(new TextEncoder().encode(junk)); await w.close();

    const v = await folder.verify(dir, '111');

    assert.equal(v.state, 'needsConfirm', `junk stamp ${JSON.stringify(junk)} falls back to asking`);
  }
});

test('T-082 unknown taxpayer cannot claim, and reads as unverified on a stamped folder', async () => {
  const dir = fakeDir();
  await folder.claim(dir, '111', 'شركة الألف');

  for (const rin of ['unknown', '', null, undefined]) {
    assert.equal((await folder.verify(dir, rin)).state, 'unverified', `rin ${JSON.stringify(rin)}`);
    assert.equal(await folder.claim(dir, rin, ''), null, 'claim refuses an unknown taxpayer');
  }
  assert.equal((await stampOf(dir)).rin, '111', 'the real owner survives untouched');
});

test('T-083 unknown taxpayer never auto-claims an unstamped folder holding data', async () => {
  const dir = fakeDir();
  await withData(dir);

  const v = await folder.verify(dir, 'unknown');

  assert.equal(v.state, 'unverified');
  assert.equal(dir.files.has(folder.STAMP), false);
});

// ---------------------------------------------------------------- integration: orchestrator

const orchWith = (confirmFolder) => {
  const status = [];
  const orch = createOrchestrator({ onStatus: (m, meta) => status.push({ m, meta }), confirmFolder });
  return { orch, status, errs: () => status.filter((s) => s.meta?.level === 'err' || s.meta?.level === 'warn') };
};

test('T-084 ensureDir refuses another company\'s folder and writes NOTHING', async () => {
  const dir = fakeDir();
  await folder.claim(dir, '111', 'شركة الألف');
  await withData(dir);
  const before = [...dir.files.keys()].sort();
  loginAs('222', 'شركة الباء');

  const { orch, errs } = orchWith(async () => true);
  orch.setFolder(dir);
  const got = await orch.ensureDir();

  assert.equal(got, null, 'no folder handed out');
  assert.deepEqual([...dir.files.keys()].sort(), before, 'not one byte written to the other company\'s folder');
  assert.ok(errs().length, 'the block is surfaced to the user, not silent');
  assert.ok(errs().some((e) => /111/.test(e.m)), 'the message names the owning taxpayer');
});

test('T-085 resume() on another company\'s folder does not read their progress or inherit their chunks', async () => {
  const dir = fakeDir();
  await folder.claim(dir, '111', 'شركة الألف');
  // company 111's progress + one downloaded chunk file
  const fh = await dir.getFileHandle('eta_progress_2026_Sent.json', { create: true });
  const w = await fh.createWritable();
  await w.write(new TextEncoder().encode(JSON.stringify({
    key: '2026_Sent_Issue_2026-01-01_2026-12-31', source: 'invoices', year: '2026', dir: 'Sent',
    field: 'Issue', from: '2026-01-01', to: '2026-12-31', statuses: [], chunks: [{ id: 'c1', label: 'x', count: 5 }], doneIds: [],
  })));
  await w.close();
  await withData(dir);
  loginAs('222', 'شركة الباء');

  const { orch } = orchWith(async () => true);
  orch.setFolder(dir);
  const p = await orch.resume();

  assert.equal(p, null, 'resume refuses — it must not adopt another company\'s plan');
});

test('T-086 a fresh folder is claimed automatically for the logged-in company', async () => {
  const dir = fakeDir();
  loginAs('333', 'شركة الجيم');

  const { orch } = orchWith(async () => { throw new Error('must not ask on an empty folder'); });
  orch.setFolder(dir);
  const got = await orch.ensureDir();

  assert.ok(got, 'usable');
  assert.equal((await stampOf(dir)).rin, '333');
});

test('T-087 a legacy folder asks once — declining blocks, confirming claims it', async () => {
  loginAs('444', 'شركة الدال');

  const no = fakeDir(); await withData(no);
  const { orch: o1 } = orchWith(async () => false);
  o1.setFolder(no);
  assert.equal(await o1.ensureDir(), null, 'declining blocks');
  assert.equal(no.files.has(folder.STAMP), false, 'and stamps nothing');

  const yes = fakeDir(); await withData(yes);
  let asked = 0;
  const { orch: o2 } = orchWith(async () => { asked++; return true; });
  o2.setFolder(yes);
  assert.ok(await o2.ensureDir(), 'confirming unblocks');
  assert.equal((await stampOf(yes)).rin, '444');
  await o2.ensureDir(); await o2.ensureDir();
  assert.equal(asked, 1, 'asked once, not on every call');
});

test('T-089 logged out: merge may proceed on a claimed folder (warned), runs may not', async () => {
  const dir = fakeDir();
  await folder.claim(dir, '111', 'شركة الألف');
  await withData(dir);
  logout();

  const { orch, status } = orchWith(async () => true);
  orch.setFolder(dir);

  assert.ok(await orch.ensureDir({ allowUnverified: true }), 'merge path proceeds');
  assert.ok(status.some((s) => s.meta?.level === 'warn'), 'and warns that the owner is unverified');
  assert.equal(await orch.ensureDir(), null, 'the run path still refuses');
});

test('T-090 logged out on an UNCLAIMED folder: even merge refuses', async () => {
  const dir = fakeDir();
  await withData(dir);
  logout();

  const { orch } = orchWith(async () => true);
  orch.setFolder(dir);

  assert.equal(await orch.ensureDir({ allowUnverified: true }), null, 'no stamp = no basis to proceed');
  assert.equal(dir.files.has(folder.STAMP), false);
});

test('T-088 logged out: a stamped folder is usable but reported unverified, an unstamped one is not claimed', async () => {
  const stamped = fakeDir(); await folder.claim(stamped, '111', 'شركة الألف');
  const bare = fakeDir(); await withData(bare);
  logout();

  assert.equal((await folder.verify(stamped, null)).state, 'unverified');
  assert.equal((await folder.verify(bare, null)).state, 'unverified');
  assert.equal(bare.files.has(folder.STAMP), false);
});
