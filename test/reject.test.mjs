import test from 'node:test';
import assert from 'node:assert/strict';

// rules.js is pure (no DOM/network/localStorage) — import directly.
const { defaultCfg, normalizeCfg, evaluateDoc, vatDivergencePct, dupKeyOf } = await import('../src/reject/rules.js');

const NOW = Date.parse('2026-07-27T12:00:00Z');
const doc = (over = {}) => ({
  uuid: 'U-1', internalID: 'A-1', status: 'Valid',
  documentTypeNamePrimaryLang: 'Invoice', documentTypeNameSecondaryLang: 'فاتورة',
  dateTimeRecevied: '2026-07-25T12:00:00Z',   // API's real spelling; 2 days old vs NOW
  totalSales: 1000, netAmount: 1000, totalAmount: 1140,
  issuer: { id: '100-200-300', name: 'Seller A' },
  taxTotals: [{ taxType: 'T1', amount: 140 }],
  invoiceLines: [{ salesTotal: 1000, lineTaxableItems: [{ taxType: 'T1', rate: 14, amount: 140 }] }],
  ...over,
});
const ev = (cfgOver, d, seen) => evaluateDoc(normalizeCfg({ ...defaultCfg(), ...cfgOver }), d, { seen, nowMs: NOW });

test('clean doc under default config passes', () => {
  const r = ev({}, doc());
  assert.equal(r.verdict, 'pass');
  assert.equal(r.eligible, true);
  assert.equal(r.firings.length, 0);
});

test('normalizeCfg: garbage → defaults; empty issuer list disables the mode', () => {
  assert.deepEqual(normalizeCfg(null), defaultCfg());
  assert.deepEqual(normalizeCfg('x'), defaultCfg());
  const c = normalizeCfg({ issuer: { mode: 'allow', list: [] }, vat: { on: true, tolPct: 9999 }, windowDays: -5 });
  assert.equal(c.issuer.mode, 'off', 'empty allow-list would flag everything — must disable');
  assert.equal(c.vat.tolPct, 50, 'tolerance clamped');
  assert.equal(c.windowDays, 1, 'window clamped');
});

test('issuer blocklist rejects; TINs compare as digits', () => {
  const r = ev({ issuer: { mode: 'block', list: ['100200300'] } }, doc());   // doc has '100-200-300'
  assert.equal(r.verdict, 'reject');
  assert.equal(r.firings[0].id, 'ISSUER-BLOCKED');
  assert.match(r.firings[0].en, /Seller A/);
  assert.match(r.firings[0].ar, /Seller A/);
});

test('issuer allow-list flags (not rejects) unknown issuers — fail-closed', () => {
  const r = ev({ issuer: { mode: 'allow', list: ['999'] } }, doc());
  assert.equal(r.verdict, 'flag');
  assert.equal(r.firings[0].id, 'ISSUER-NOT-ALLOWED');
});

test('amount rules: over max and under min reject, resolved into the reason', () => {
  const over = ev({ amount: { on: true, max: 1000, min: null } }, doc());
  assert.equal(over.verdict, 'reject');
  assert.equal(over.firings[0].id, 'AMOUNT-OVER');
  assert.match(over.firings[0].en, /1,140/);
  assert.match(over.firings[0].en, /1,000/);
  const under = ev({ amount: { on: true, max: null, min: 5000 } }, doc());
  assert.equal(under.firings[0].id, 'AMOUNT-UNDER');
});

test('vatDivergencePct: clean 0; header/lines mismatch measured; missing data null', () => {
  assert.equal(vatDivergencePct(doc()), 0);
  const bad = doc({ taxTotals: [{ taxType: 'T1', amount: 200 }] });   // lines still say 140
  assert.ok(Math.abs(vatDivergencePct(bad) - 30) < 1e-9, '|200-140|/200 = 30%');
  assert.equal(vatDivergencePct(doc({ invoiceLines: [] })), null);
  assert.equal(vatDivergencePct(doc({ taxTotals: [] })), null);
  const extra = doc({ invoiceLines: [{ lineTaxableItems: [{ taxType: 'T1', amount: 140 }, { taxType: 'T4', amount: 10 }] }] });
  assert.ok(vatDivergencePct(extra) > 0, 'line tax absent from header is a divergence');
});

test('VAT rule: mismatch rejects with resolved %, unverifiable flags (fail-closed)', () => {
  const r = ev({ vat: { on: true, tolPct: 2 } }, doc({ taxTotals: [{ taxType: 'T1', amount: 200 }] }));
  assert.equal(r.verdict, 'reject');
  assert.equal(r.firings[0].id, 'VAT-MISMATCH');
  assert.match(r.firings[0].en, /30\.0%/);
  const u = ev({ vat: { on: true, tolPct: 2 } }, doc({ invoiceLines: [] }));
  assert.equal(u.verdict, 'flag');
  assert.equal(u.firings[0].id, 'VAT-UNVERIFIABLE');
  const okr = ev({ vat: { on: true, tolPct: 2 } }, doc({ taxTotals: [{ taxType: 'T1', amount: 141 }] }));
  assert.equal(okr.verdict, 'pass', 'divergence inside tolerance passes');
});

test('duplicates: seen key rejects; evaluateDoc never mutates the seen set', () => {
  const key = dupKeyOf(doc());
  assert.equal(key, '100200300|A-1|1140.00');
  const seen = new Set([key]);
  const r = ev({}, doc(), seen);
  assert.equal(r.verdict, 'reject');
  assert.equal(r.firings[0].id, 'DUP');
  const fresh = ev({}, doc(), new Set());
  assert.equal(fresh.verdict, 'pass');
  assert.equal(fresh.dupKey, key, 'key reported so the scanner can register it');
  assert.equal(new Set().size, 0);
  const s2 = new Set(); ev({}, doc(), s2);
  assert.equal(s2.size, 0, 'engine must not self-register keys');
});

test('dupKeyOf: partial identity → no key → dup rule cannot fire', () => {
  assert.equal(dupKeyOf(doc({ internalID: null })), null);
  const r = ev({}, doc({ internalID: null, uuid: 'U-1' }), new Set(['|1140.00']));
  assert.ok(!r.firings.some((f) => f.id === 'DUP'));
});

test('type filter rejects disallowed types only when enabled', () => {
  const cn = doc({ documentTypeNamePrimaryLang: 'Credit Note', documentTypeNameSecondaryLang: 'إشعار دائن' });
  assert.equal(ev({}, cn).verdict, 'pass', 'filter off → pass');
  const r = ev({ types: { on: true, invoice: true, credit: false, debit: true } }, cn);
  assert.equal(r.verdict, 'reject');
  assert.equal(r.firings[0].id, 'TYPE-DISALLOWED');
  assert.match(r.firings[0].en, /إشعار دائن/, 'reason carries the document-language type name');
});

test('rejection window: expired and future-dated docs are ineligible', () => {
  assert.equal(ev({}, doc({ dateTimeRecevied: '2026-07-01T00:00:00Z' })).eligible, false, '26 days > 14-day window');
  assert.equal(ev({}, doc({ dateTimeRecevied: '2026-08-01T00:00:00Z' })).eligible, false, 'future timestamp is not verifiable');
  assert.equal(ev({}, doc({ dateTimeRecevied: null })).eligible, false, 'missing timestamp is not verifiable');
  assert.equal(ev({ windowDays: 30 }, doc({ dateTimeRecevied: '2026-07-01T00:00:00Z' })).eligible, true, 'wider window');
  assert.equal(ev({}, doc({ dateTimeRecevied: undefined, dateTimeReceived: '2026-07-26T00:00:00Z' })).eligible, true, 'accepts the corrected spelling too');
});

test('T-020 per-type window resolver overrides the cfg fallback', () => {
  const d5 = doc({ dateTimeRecevied: '2026-07-22T12:00:00Z' });   // 5 days old vs NOW
  const base = evaluateDoc(normalizeCfg(defaultCfg()), d5, { nowMs: NOW });
  assert.equal(base.eligible, true, 'cfg 14d allows a 5-day-old doc');
  assert.equal(base.windowDays, 14, 'result reports the window it used');
  const tight = evaluateDoc(normalizeCfg(defaultCfg()), d5, { nowMs: NOW, resolveWindow: () => 3 });
  assert.equal(tight.eligible, false, 'per-type 3d window closes it');
  assert.equal(tight.windowDays, 3);
  const junk = evaluateDoc(normalizeCfg(defaultCfg()), d5, { nowMs: NOW, resolveWindow: () => 'not-a-number' });
  assert.equal(junk.eligible, true, 'non-numeric resolver output falls back to cfg');
  assert.equal(junk.windowDays, 14);
});

test('missing core fields flag DATA-MISSING and never auto-reject alone', () => {
  const r = ev({}, doc({ uuid: null }));
  assert.equal(r.verdict, 'flag');
  assert.equal(r.firings[0].id, 'DATA-MISSING');
});

test('verdict precedence: any hard firing wins over flags', () => {
  const r = ev({ issuer: { mode: 'block', list: ['100200300'] }, vat: { on: true } }, doc({ invoiceLines: [] }));
  assert.equal(r.verdict, 'reject');
  const ids = r.firings.map((f) => f.id);
  assert.ok(ids.includes('ISSUER-BLOCKED') && ids.includes('VAT-UNVERIFIABLE'), 'trace keeps every firing');
});

// ── submit.js dry-run + audit (needs localStorage stub BEFORE import) ────────
const bag = new Map();
globalThis.localStorage = {
  getItem: (k) => (bag.has(k) ? bag.get(k) : null),
  setItem: (k, v) => bag.set(k, String(v)),
  removeItem: (k) => bag.delete(k),
};
const { submitRejections, liveRejectAvailable, auditRuns } = await import('../src/reject/submit.js');

test('submit: live path unset → forced dry-run, per-item results, audit recorded', async () => {
  bag.clear();
  assert.equal(liveRejectAvailable(), false, 'v1 ships without a captured live endpoint');
  const seen = [];
  const items = [
    { uuid: 'U-1', reason: 'r1', doc: { internalID: 'A-1', issuerId: '100', totalAmount: 5 }, rules: ['DUP'] },
    { uuid: 'U-2', reason: 'r2', doc: { internalID: 'A-2', issuerId: '200', totalAmount: 6 }, rules: ['AMOUNT-OVER'] },
  ];
  const { dryRun, results } = await submitRejections(items, { dryRun: false, onItem: (i, r) => seen.push([i, r.ok, r.dry]) });   // even an explicit live request stays dry without the endpoint
  assert.equal(dryRun, true);
  assert.deepEqual(results.map((r) => [r.ok, r.dry]), [[true, true], [true, true]]);
  assert.deepEqual(seen, [[0, true, true], [1, true, true]]);
  const audit = auditRuns();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].dryRun, true);
  assert.equal(audit[0].count, 2);
  assert.deepEqual(audit[0].items.map((x) => x.result), ['dry', 'dry']);
  assert.equal(audit[0].items[0].reason, 'r1');
  assert.deepEqual(audit[0].items[1].rules, ['AMOUNT-OVER']);
});
