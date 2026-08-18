// SPEC-022 T-219, T-220, T-230, T-231 — the pasted list: parsing, classification, the RIN predicate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseList, listKey, rinMatch, rinIdsOf, UUIDS_MAX, RINS_MAX } from '../src/core/listinput.js';

const UU = (n) => Array.from({ length: n }, (_, i) => ('U' + String(i).padStart(25, '0')).slice(0, 26));

test('T-219 a messy paste parses: separators, dupes, case', () => {
  const a = '5tgh0pbmz50f17kwj7b4tt5mt0';                       // lowercase → normalised
  const b = '9AZKT0PBMZ50F17KWJ7B4TT5MT';
  const r = parseList(`  ${a},${b};\n${a.toUpperCase()}\t${b}  \n\nnot-a-uuid `);
  assert.equal(r.kind, 'uuid');
  assert.deepEqual(r.items, [a.toUpperCase(), b], 'deduped, first-seen order, uppercased');
  assert.deepEqual(r.invalid, ['not-a-uuid']);
  assert.equal(r.error, undefined);
});

test('T-220 empty · garbage-only · too many · mixed', () => {
  assert.equal(parseList('').kind, 'empty');
  assert.equal(parseList('   \n\t ').kind, 'empty');

  const junk = parseList('hello world 12345 xyz');              // 12345: neither 9 nor 14 digits
  assert.equal(junk.kind, 'empty');
  assert.deepEqual(junk.invalid, ['hello', 'world', '12345', 'xyz']);

  const over = parseList(UU(UUIDS_MAX + 1).join('\n'));
  assert.equal(over.error, 'too_many');
  assert.deepEqual(over.items, [], 'an over-cap list yields nothing to run');

  const overR = parseList(Array.from({ length: RINS_MAX + 1 }, (_, i) => String(100000000 + i)).join(' '));
  assert.equal(overR.error, 'too_many');

  const mixed = parseList(UU(1)[0] + '\n123456789');
  assert.equal(mixed.error, 'mixed');
  assert.deepEqual(mixed.items, [], 'a mixed paste never runs either export');
});

test('T-219 listKey is order-independent and content-sensitive', () => {
  const [u1, u2, u3] = UU(3);
  assert.equal(listKey([u1, u2]), listKey([u2, u1]));
  assert.notEqual(listKey([u1, u2]), listKey([u1, u3]));
  assert.notEqual(listKey([u1]), listKey([u1, u2]));
});

test('T-230 RIN paste: 9- and 14-digit ids pass, dupes collapse, a 7-digit typo is surfaced', () => {
  const r = parseList('123456789, 12345678901234\n123456789 1234567');
  assert.equal(r.kind, 'rin');
  assert.deepEqual(r.items, ['123456789', '12345678901234']);
  assert.deepEqual(r.invalid, ['1234567']);
});

test('T-231 rinMatch keeps a row when issuer OR receiver is in the set, any spelling', () => {
  const m = rinMatch(['123456789']);
  assert.ok(m({ issuerId: '123456789' }), 'flat issuer');
  assert.ok(m({ receiverId: ' 123456789 ' }), 'flat receiver, trimmed');
  assert.ok(m({ issuer: { id: '123456789' } }), 'nested issuer');
  assert.ok(m({ receiver: { id: 123456789 } }), 'nested receiver, numeric');
  assert.ok(!m({ issuerId: '999999999', receiverId: '888888888' }), 'no match drops');
  assert.ok(!m({}), 'a row with no ids never matches and never throws');
  assert.ok(!m(null), 'null row never throws');
  assert.deepEqual(rinIdsOf({ issuerId: '1', receiver: { id: '2' } }), ['1', '2']);
  assert.deepEqual(rinIdsOf({}), [], 'id-less rows are detectable so the run can fail loud');
});

test('T-231b the REAL portal row shape matches (live-verified 2026-08-19)', () => {
  // Captured from api-portal /documents/search: the RINs live in recipientId / submitterId /
  // issuerUserId's prefix — issuerTaxPayerId and recipientTaxPayerId are internal ids, NOT RINs.
  const portalRow = {
    issuerTaxPayerId: '827787', issuerUserId: '340035072:dbcdee03-94e7-4ee2-95c0-3af454f3ec9e',
    submitterId: '340035072', recipientTaxPayerId: '1079855', recipientId: '521230144',
    recipientName: 'Egypt Control System', documentStatusEN: 'Valid',
  };
  assert.deepEqual(rinIdsOf(portalRow), ['521230144', '340035072', '340035072']);
  assert.ok(rinMatch(['521230144'])(portalRow), 'receiver-side counterparty matches');
  assert.ok(rinMatch(['340035072'])(portalRow), 'issuer-side matches (a Received doc, seen from the buyer)');
  assert.ok(!rinMatch(['1079855'])(portalRow), 'the internal taxpayer id must NEVER match — it is not a RIN');
  assert.ok(!rinMatch(['827787'])(portalRow), 'issuerTaxPayerId likewise');
});
