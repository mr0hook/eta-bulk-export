import test from 'node:test';
import assert from 'node:assert/strict';

// getToken() (imported transitively) reads localStorage; give it a token so apiGet reaches fetch.
globalThis.localStorage = { getItem: (k) => (k === 'USER_DATA' ? JSON.stringify({ access_token: 'tok' }) : null) };

const { apiGet, apiGetBlob, fetchPdf, probeCount, fetchAllRows, fetchDetails, makeGovernor, mapAdaptive } = await import('../src/api/client.js');
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

test('apiGet: 401 → AUTH, 403 → one retry then FORBIDDEN (never AUTH), 404 → NOT_FOUND', async () => {
  stubFetch(() => resp(401, {}));
  await assert.rejects(() => apiGet(API_ORIGIN + '/a'), (e) => e.code === 'AUTH');
  // 2026-08-19: per-document AccessDenied 403s (and WAF blips) must not masquerade as a dead
  // session — as AUTH they sent the run into token-renewal loops. One retry, then FORBIDDEN,
  // which callers treat as a dropped ROW, not a dropped session.
  let n403 = 0;
  stubFetch(() => { n403++; return resp(403, {}); });
  await assert.rejects(() => apiGet(API_ORIGIN + '/a'), (e) => e.code === 'FORBIDDEN');
  assert.equal(n403, 2, 'exactly one retry before giving up on a 403');
  n403 = 0;
  stubFetch(() => resp(n403++ === 0 ? 403 : 200, { okey: 1 }));
  assert.deepEqual(await apiGet(API_ORIGIN + '/a'), { okey: 1 }, 'a transient 403 recovers on the retry');
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
  // shortWait: 0 — the chunk was probed at 500 and holds 120, so SPEC-040 re-asks for the short
  // page before accepting it. That is the point of the guard; here it just must not change the rows.
  const rows = await fetchAllRows(INV, chunk, 'Sent', 'Issue', null, new Set(['Valid']), { pagePause: 0, shortWait: 0 });
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

// ── SPEC-025: the AIMD details governor ─────────────────────────────────────────────────────────
test('T-254 governor: halves on 429 (floor min), freezes growth for the cool-down, climbs +1 per rise, capped at max', () => {
  let tnow = 0;
  const g = makeGovernor({ start: 12, min: 3, max: 40, rise: 25, cooldownMs: 10000, now: () => tnow });
  assert.equal(g.limit(), 12);

  g.slow();
  assert.equal(g.limit(), 6, 'a 429 halves the pool');
  for (let i = 0; i < 100; i++) g.ok();
  assert.equal(g.limit(), 6, 'successes during the cool-down must not regrow the pool');

  tnow = 10001;
  for (let i = 0; i < 24; i++) g.ok();
  assert.equal(g.limit(), 6, '24 successes are not yet a rise');
  g.ok();
  assert.equal(g.limit(), 7, 'the 25th consecutive success grows the pool by 1');

  g.slow(); g.slow(); g.slow();
  assert.equal(g.limit(), 3, 'repeated 429s bottom out at the floor, never below');

  tnow = 100000;
  const c = makeGovernor({ start: 4, min: 1, max: 5, rise: 2, cooldownMs: 0, now: () => tnow });
  c.ok(); c.ok();
  assert.equal(c.limit(), 5);
  c.ok(); c.ok(); c.ok(); c.ok();
  assert.equal(c.limit(), 5, 'the old static CONC value is the ceiling');
});

test('T-255 mapAdaptive: in-flight work tracks the live limit (shrink drains, growth re-expands), output stays ordered', async () => {
  let limit = 4;
  const gov = { limit: () => limit };
  const started = []; const resolvers = [];
  const p = mapAdaptive([...Array(12).keys()], gov, (item, idx) => new Promise((res) => {
    started.push(idx);
    resolvers[idx] = () => res(item * 10);
  }));
  const inFlight = () => started.length - resolvers.filter((r, i) => r === null && started.includes(i)).length;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  await settle();
  assert.equal(started.length, 4, 'spawns exactly the starting limit');

  limit = 2;                     // portal pushed back: shrink mid-flight
  resolvers[0](); resolvers[0] = null; await settle();
  assert.equal(started.length, 4, 'over the new limit → the surplus drains, nothing new spawns');
  resolvers[1](); resolvers[1] = null; await settle();
  assert.equal(started.length, 4, 'still at 2 in flight = the new limit — no spawn');
  resolvers[2](); resolvers[2] = null; await settle();
  assert.equal(started.length, 5, 'dropping under the limit admits the next item');

  limit = 6;                     // portal recovered: grow
  resolvers[3](); resolvers[3] = null; await settle();
  assert.equal(started.length, 10, 'a completion under a raised limit refills the whole pool');

  for (let i = 4; i < 12; i++) { resolvers[i](); resolvers[i] = null; await settle(); }
  const out = await p;
  assert.deepEqual(out, [...Array(12).keys()].map((i) => i * 10), 'results keep item order whatever the limit did');
  void inFlight;
});

test('T-255b mapAdaptive: a thrown AUTH/STOPPED rejects the batch, empty input resolves', async () => {
  const gov = { limit: () => 3 };
  await assert.rejects(
    () => mapAdaptive([1, 2, 3, 4, 5], gov, async (x) => { if (x === 2) { const e = new Error('auth'); e.code = 'AUTH'; throw e; } return x; }),
    (e) => e.code === 'AUTH');
  assert.deepEqual(await mapAdaptive([], gov, async (x) => x), [], 'no items → resolves immediately');
});

test('T-263 a spurious AbortError (deadline firing mid-body) retries — only the caller\'s aborted signal is STOPPED', async () => {
  // The phantom-pause incident (2026-08-19): the 60s request deadline firing during r.json() on a
  // slow stream rejects with plain AbortError, and the old `e.name === 'AbortError'` check turned
  // that into STOPPED — the run loop then "paused itself" mid-details with no one touching it.
  let n = 0;
  stubFetch(() => { if (n++ === 0) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } return resp(200, { ok: 1 }); });
  const j = await apiGet(API_ORIGIN + '/a', {});
  assert.deepEqual(j, { ok: 1 });
  assert.equal(n, 2, 'the abort was retried like any transient failure, not treated as the user\'s Pause');

  const ctrl = new AbortController(); ctrl.abort();
  let called = 0;
  stubFetch(() => { called++; return resp(200, { ok: 1 }); });
  await assert.rejects(() => apiGet(API_ORIGIN + '/a', { signal: ctrl.signal }), (e) => e.code === 'STOPPED');
  assert.equal(called, 0, 'a genuinely aborted caller signal is STOPPED before any fetch');
});

test('T-256 apiGet marks a real 429 for the governor (onRate second arg), plain error backoff stays unmarked', async () => {
  let n = 0; const calls = [];
  stubFetch(() => (n++ === 0 ? resp(429, {}, { 'Retry-After': '0' }) : resp(200, { ok: 1 })));
  await apiGet(API_ORIGIN + '/a', { onRate: (w, isRate) => calls.push([w, isRate]) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], true, 'a 429 must carry the rate flag — it is what shrinks the details pool');

  n = 0; const calls2 = [];
  stubFetch(() => { if (n++ === 0) throw new Error('connection reset'); return resp(200, { ok: 1 }); });
  await apiGet(API_ORIGIN + '/a', { onRate: (w, isRate) => calls2.push([w, isRate]) });
  assert.equal(calls2.length, 1);
  assert.notEqual(calls2[0][1], true, 'a network blip must NOT shrink the pool');
});

test('T-240 a hung request times out into the retry path — and a user abort is still STOPPED', async () => {
  // 2026-08-19: the WAF tarpitted /details — connections held open, never answered — and with no
  // deadline all 40 workers hung silently ("stuck at chunk 2", zero log lines). A timeout must
  // read as a retryable failure, NOT as the user's pause.
  const hang = (url, opts) => new Promise((_, rej) => {
    const s = opts?.signal;
    if (s?.aborted) return rej(s.reason);
    s?.addEventListener('abort', () => rej(s.reason), { once: true });
  });
  globalThis.fetch = hang;
  const t0 = Date.now();
  await assert.rejects(
    () => apiGet(API_ORIGIN + '/a', { attempts: 2, timeoutMs: 40 }),
    (e) => e.code !== 'STOPPED',
    'a timeout must surface as an ordinary failure after retries, never as STOPPED');
  assert.ok(Date.now() - t0 < 30000, 'and it must not hang');

  const ctrl = new AbortController();
  const p = apiGet(API_ORIGIN + '/a', { attempts: 3, timeoutMs: 60000, signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 10);
  await assert.rejects(() => p, (e) => e.code === 'STOPPED', 'the user pause is still STOPPED');
});

// ---- SPEC-040 — a short page is a claim about the end of the data, and the portal lies ---------
test('T-288 a transient empty page mid-pagination no longer ends the run', async () => {
  // Exactly how 2024 Q1 lost 9,806 documents: the portal answered 200 with an empty result while
  // the window still held documents, `r.length < ps` read it as a clean end, and the chunk was
  // marked done. Three chunks each stopped on an exact page boundary; nothing was ever logged.
  const pages = [pageOf(100, 0), pageOf(100, 100), { result: [] }, pageOf(100, 200), pageOf(50, 300)];
  let p = 0, asked = [];
  stubFetch((url) => { asked.push(new URL(url).searchParams.get('Page')); const i = p++; return resp(200, i === 2 ? pages[2] : pages[i > 2 ? i - 1 : i]); });
  const rows = await fetchAllRows(INV, { count: 350, fromISO: 'a', toISO: 'b' }, 'Sent', 'Issue', null, null, { pagePause: 0, shortWait: 0 });
  assert.equal(rows.length, 350, 'the empty page is re-asked and the run continues to the real end');
  assert.equal(new Set(rows.map((r) => r.source.uuid)).size, 350, 'and the retry replaces the page, never duplicates it');
  assert.equal(asked[2], asked[3], 'the retry asks for the SAME page, not the next one');
});

test('T-289 a genuine end still ends — the retries stop and the rows are not duplicated', async () => {
  // The counterweight. A window that really does hold 130 documents must not spin, and must not
  // re-append the last page once per retry.
  let calls = 0;
  stubFetch(() => { calls++; return resp(200, calls === 1 ? pageOf(100, 0) : pageOf(30, 100)); });
  const rows = await fetchAllRows(INV, { count: 500, fromISO: 'a', toISO: 'b' }, 'Sent', 'Issue', null, null, { pagePause: 0, shortWait: 0 });
  assert.equal(rows.length, 130, 'the short page is believed once it repeats itself');
  assert.equal(calls, 5, 'page 1, page 2, and 3 re-asks of page 2 — bounded, not a spin');
});

test('T-290 a short page is accepted immediately once the planned count is already in hand', async () => {
  // No re-ask when there is nothing to be short of: this is the ordinary end of every chunk, and
  // paying three extra requests plus their waits on all of them would be a heavy price for nothing.
  let calls = 0;
  stubFetch(() => { calls++; return resp(200, calls === 1 ? pageOf(100, 0) : pageOf(20, 100)); });
  const rows = await fetchAllRows(INV, { count: 120, fromISO: 'a', toISO: 'b' }, 'Sent', 'Issue', null, null, { pagePause: 0, shortWait: 0 });
  assert.equal(rows.length, 120);
  assert.equal(calls, 2, 'two pages, no re-asks');
});
