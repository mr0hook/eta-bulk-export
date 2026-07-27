import test from 'node:test';
import assert from 'node:assert/strict';

// getToken() (imported transitively) reads localStorage; give it a token so apiGet reaches fetch.
globalThis.localStorage = { getItem: (k) => (k === 'USER_DATA' ? JSON.stringify({ access_token: 'tok' }) : null) };

const { apiGet, apiGetBlob, fetchPdf, probeCount, fetchAllRows, fetchDetails } = await import('../src/api/client.js');
const { SOURCES, API_ORIGIN } = await import('../src/api/sources.js');
const INV = SOURCES.invoices;

// minimal Response stub with a working headers.get
const resp = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  json: async () => body,
  headers: { get: (h) => headers[h] ?? headers[String(h).toLowerCase()] ?? null },
});
const stubFetch = (handler) => { globalThis.fetch = async (url, opts) => handler(url, opts); };

test('apiGet: origin guard rejects foreign hosts (token never leaks off-origin)', async () => {
  let called = false; stubFetch(() => { called = true; return resp(200, {}); });
  await assert.rejects(() => apiGet('https://evil.example.com/x'), (e) => e.code === 'BAD_URL');
  assert.equal(called, false, 'must not fetch a non-ETA origin');
});

test('apiGet: 401/403 → AUTH, 404 → NOT_FOUND', async () => {
  stubFetch(() => resp(401, {}));
  await assert.rejects(() => apiGet(API_ORIGIN + '/a'), (e) => e.code === 'AUTH');
  stubFetch(() => resp(403, {}));
  await assert.rejects(() => apiGet(API_ORIGIN + '/a'), (e) => e.code === 'AUTH');
  stubFetch(() => resp(404, {}));
  await assert.rejects(() => apiGet(API_ORIGIN + '/a'), (e) => e.code === 'NOT_FOUND');
});

test('apiGet: no token → AUTH before any fetch', async () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null };
  let called = false; stubFetch(() => { called = true; return resp(200, {}); });
  await assert.rejects(() => apiGet(API_ORIGIN + '/a'), (e) => e.code === 'AUTH');
  assert.equal(called, false, 'must not fetch without a token');
  globalThis.localStorage = saved;
});

test('apiGet: 429 honors Retry-After then returns (proves the header is respected, not just retry)', async () => {
  let n = 0; const waits = [];
  stubFetch(() => (n++ === 0 ? resp(429, {}, { 'Retry-After': '0' }) : resp(200, { ok: 1 })));
  const j = await apiGet(API_ORIGIN + '/a', { onRate: (w) => waits.push(w) });
  assert.deepEqual(j, { ok: 1 });
  assert.equal(n, 2, 'one 429 retry then success');
  // Retry-After:0 must yield a sub-second wait (jitter only). If the header were ignored the code
  // would fall back to 5000ms*2**0, so this assertion fails if the Retry-After handling is reverted.
  assert.equal(waits.length, 1);
  assert.ok(waits[0] < 1000, `Retry-After:0 → <1s wait, got ${waits[0]}ms`);
});

test('apiGet: negative Retry-After is ignored (falls back to backoff floor, no instant retry storm)', async () => {
  const realST = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); return realST(fn, 0); }; // record requested delay, fire immediately
  try {
    let n = 0;
    stubFetch(() => (n++ === 0 ? resp(429, {}, { 'Retry-After': '-5' }) : resp(200, { ok: 1 })));
    const j = await apiGet(API_ORIGIN + '/a', { onRate: () => {} });
    assert.deepEqual(j, { ok: 1 });
    assert.ok(delays.some((d) => d >= 5000), `negative Retry-After must not bypass backoff; delays=${delays}`);
  } finally { globalThis.setTimeout = realST; }
});

test('apiGet: aborted signal → STOPPED', async () => {
  stubFetch(() => resp(200, {}));
  await assert.rejects(() => apiGet(API_ORIGIN + '/a', { signal: { aborted: true } }), (e) => e.code === 'STOPPED');
});

test('apiGet: abort DURING backoff rejects immediately with STOPPED, not after the full wait (#12)', async () => {
  const ctl = new AbortController();
  let n = 0;
  stubFetch(() => { n++; if (n === 1) { ctl.abort(); return resp(500, {}); } return resp(200, {}); });
  const t0 = Date.now();
  await assert.rejects(() => apiGet(API_ORIGIN + '/a', { signal: ctl.signal, onRate: () => {} }), (e) => e.code === 'STOPPED');
  assert.ok(Date.now() - t0 < 500, 'did not sit through the 1.5s backoff'); // abort-aware sleep short-circuits
});

test('probeCount: 404 → 0; otherwise metadata.totalCount', async () => {
  stubFetch(() => resp(404, {}));
  assert.equal(await probeCount(INV, 'a', 'b', 'Sent', 'Issue', null, null, null, {}), 0);
  stubFetch(() => resp(200, { metadata: { totalCount: 42 } }));
  assert.equal(await probeCount(INV, 'a', 'b', 'Sent', 'Issue', null, null, null, {}), 42);
});

test('probeCount: missing/garbled totalCount throws BAD_COUNT, never a silent 0 (#6)', async () => {
  stubFetch(() => resp(200, { result: [] })); // 200 OK but no metadata.totalCount
  await assert.rejects(() => probeCount(INV, 'a', 'b', 'Sent', 'Issue', null, null, null, {}), (e) => e.code === 'BAD_COUNT');
  stubFetch(() => resp(404, {}));
  assert.equal(await probeCount(INV, 'a', 'b', 'Sent', 'Issue', null, null, null, {}), 0, 'a genuinely empty range is still 0');
});

test('fetchAllRows: paginates until a short page, then applies filterSet', async () => {
  const page1 = { result: Array.from({ length: 100 }, (_, k) => ({ source: { uuid: 'u' + k, documentStatusEN: k < 60 ? 'Valid' : 'Cancelled' } })) };
  const page2 = { result: Array.from({ length: 20 }, (_, k) => ({ source: { uuid: 'v' + k, documentStatusEN: 'Valid' } })) };
  let p = 0; stubFetch(() => resp(200, p++ === 0 ? page1 : page2));
  const chunk = { count: 500, fromISO: 'a', toISO: 'b' };
  const rows = await fetchAllRows(INV, chunk, 'Sent', 'Issue', null, new Set(['Valid']), { pagePause: 0 });
  assert.equal(rows.length, 80, '60 Valid on page1 + 20 Valid on page2, Cancelled filtered out');
});

const pageOf = (n, o = 0, st = 'Valid') => ({ result: Array.from({ length: n }, (_, k) => ({ source: { uuid: 'g' + (o + k), documentStatusEN: st } })) });

test('fetchAllRows: paginates to the true short page even past the probed count (#7 — grew since plan)', async () => {
  const pages = [pageOf(100, 0), pageOf(100, 100), pageOf(60, 200)]; // 260 real rows; chunk was probed at 200
  let p = 0; stubFetch(() => resp(200, pages[p++] || { result: [] }));
  const rows = await fetchAllRows(INV, { count: 200, fromISO: 'a', toISO: 'b' }, 'Sent', 'Issue', null, null, { pagePause: 0 });
  assert.equal(rows.length, 260, 'fetches all 260, not just the stale probed 200');
});

test('fetchAllRows: a 404 mid-pagination fails the chunk, not a silent truncation (#8)', async () => {
  let p = 0; stubFetch(() => (p++ < 2 ? resp(200, pageOf(100, p * 100)) : resp(404, {})));
  await assert.rejects(
    () => fetchAllRows(INV, { count: 1000, fromISO: 'a', toISO: 'b' }, 'Sent', 'Issue', null, null, { pagePause: 0 }),
    (e) => e.code === 'NOT_FOUND', 'a 404 after real pages throws so resume retries the chunk',
  );
});

test('fetchPdf/apiGetBlob: returns the official PDF blob; 404 → NOT_FOUND; origin-guarded', async () => {
  const pdf = (status) => ({ status, ok: status >= 200 && status < 300, blob: async () => new Blob(['%PDF-1.4 test']), headers: { get: () => null } });
  let seenUrl = ''; globalThis.fetch = async (url) => { seenUrl = String(url); return pdf(200); };
  const b = await fetchPdf(INV, 'UUID-1', {});
  assert.ok(b && b.size > 0, 'non-empty blob');
  assert.match(seenUrl, /\/documents\/UUID-1\/pdf$/, 'hits documents/{uuid}/pdf');
  stubFetch(() => pdf(404));
  await assert.rejects(() => fetchPdf(SOURCES.receipts, 'X', {}), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(() => apiGetBlob('https://evil.example.com/x'), (e) => e.code === 'BAD_URL');
});

test('fetchPdf: an HTML/JSON error page served as 200 is rejected, not saved as a PDF (#21)', async () => {
  globalThis.fetch = async () => ({ status: 200, ok: true, blob: async () => new Blob(['<html>not entitled</html>']), headers: { get: () => null } });
  await assert.rejects(() => fetchPdf(INV, 'X', {}), (e) => e.code === 'NOT_PDF', 'no %PDF magic → NOT_PDF, not a corrupt .pdf');
});

test('fetchAllRows: multi-status filterSet keeps only the selected statuses (#17)', async () => {
  const mixed = { result: [
    { source: { uuid: 'a', documentStatusEN: 'Valid' } },
    { source: { uuid: 'b', documentStatusEN: 'Cancelled' } },
    { source: { uuid: 'c', documentStatusEN: 'Valid' } },
    { source: { uuid: 'd', documentStatusEN: 'Rejected' } },
  ] };
  stubFetch(() => resp(200, mixed)); // one short page
  const rows = await fetchAllRows(INV, { count: 4, fromISO: 'a', toISO: 'b' }, 'Sent', 'Issue', null, new Set(['Valid', 'Rejected']), { pagePause: 0 });
  assert.deepEqual(rows.map((r) => r.source.uuid).sort(), ['a', 'c', 'd'], 'kept Valid+Rejected, dropped Cancelled');
});

test('fetchDetails: unwraps invoices (identity) and receipts (.receipt)', async () => {
  stubFetch(() => resp(200, { uuid: 'x', foo: 1 }));
  assert.equal((await fetchDetails(INV, 'x', {})).foo, 1);
  stubFetch(() => resp(200, { receipt: { uuid: 'r', bar: 2 } }));
  assert.equal((await fetchDetails(SOURCES.receipts, 'r', {})).bar, 2);
});
