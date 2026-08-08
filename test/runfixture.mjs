// Shared "drive one real orchestrator run against a stubbed portal" fixture.
// Extracted so tests that care about a run's SIDE EFFECTS (the folder log, SPEC-011) don't have to
// re-derive the stub setup that orchestrator.test.mjs already worked out.
import ExcelJS from 'exceljs';
import { fakeDir } from './fakefs.mjs';
import { invoices } from './fixtures.mjs';

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (exp) => `h.${b64url({ exp })}.s`;
const okResp = (body) => ({ status: 200, ok: true, json: async () => body, headers: { get: () => null } });

// A real portal session always carries the logged-in taxpayer (SPEC-010's folder guard needs it).
export const TEST_RIN = '100000001';

export function installGlobals() {
  if (globalThis.__runfixtureInstalled) return;
  globalThis.__runfixtureInstalled = true;
  globalThis.window = globalThis.window || { ExcelJS };
  if (!globalThis.window.ExcelJS) globalThis.window.ExcelJS = ExcelJS;
  if (!globalThis.localStorage) {
    const bag = new Map();
    globalThis.localStorage = {
      getItem: (k) => (bag.has(k) ? bag.get(k) : null),
      setItem: (k, v) => bag.set(k, String(v)),
      removeItem: (k) => bag.delete(k),
      get length() { return bag.size; },
      key: (i) => [...bag.keys()][i] ?? null,
    };
  }
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...a) => realSetTimeout(fn, 0, ...a);
}

export function stubFetch({ nRows = 5 } = {}) {
  const detail = invoices[0].detail;
  const rows = Array.from({ length: nRows }, (_, k) => ({ source: { uuid: 'U' + k, documentStatusEN: 'Valid' } }));
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/search')) return okResp({ result: rows, metadata: { totalCount: rows.length } });
    if (u.includes('/details')) return okResp({ ...detail, uuid: u.split('/documents/')[1].split('/details')[0] });
    return okResp({});
  };
}

export const makePlan = (over = {}) => ({
  v: 1, key: 'testkey', source: 'invoices', year: '2025', dir: 'Sent', dateField: 'Issue',
  statuses: ['Valid', 'Invalid', 'Rejected', 'Cancelled'],
  from: '2025-01-01', to: '2025-01-31', cap: 10000, totalRows: 5,
  chunks: [{ id: 'c1', label: '2025-01', count: 5, fromISO: '2025-01-01T00:00:00Z', toISO: '2025-01-31T23:59:59Z' }],
  doneIds: [], failedIds: [], ...over,
});

// Runs one chunk to completion in a fresh fake folder. Returns the folder plus every status line
// (with its meta, so callers can assert on the terminal one).
export async function runOnce(over = {}) {
  installGlobals();
  localStorage.setItem('USER_DATA', JSON.stringify({ access_token: jwt(Math.floor(Date.now() / 1000) + 7200), profile: { TaxRin: TEST_RIN } }));
  stubFetch();
  const { createOrchestrator } = await import('../src/core/orchestrator.js');
  const dir = fakeDir();
  const status = [];
  const orch = createOrchestrator({ onStatus: (m, meta) => status.push({ m, meta }) });
  orch.setFolder(dir);
  await orch.start(makePlan(over));
  return { dir, status, orch };
}
