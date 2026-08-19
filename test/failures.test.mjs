// SPEC-028 T-262 — eta_failures.jsonl → retry-eligible uuid list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFailureUuids } from '../src/core/failures.js';

const L = (o) => JSON.stringify(o);

test('T-262 parser: dedup, exclusions, torn lines, order', () => {
  const text = [
    L({ at: 't1', chunk: 'c1', source: 'invoices', uuid: 'U1', err: 'FORBIDDEN' }),
    L({ at: 't2', chunk: 'c1', source: 'invoices', uuid: 'U2', err: 'timeout' }),
    L({ at: 't3', chunk: 'c1', kind: 'pdf', uuid: 'U1', err: 'NOT_FOUND' }),          // pdf-only → excluded
    L({ at: 't4', chunk: 'c2', kind: 'over_cap', warn: 'over_cap_single_day' }),      // no uuid → excluded
    L({ at: 't5', chunk: 'c3', source: 'receipts', uuid: 'R1', err: 'FORBIDDEN' }),   // receipts → excluded
    L({ at: 't6', chunk: 'c4', source: 'invoices', uuid: 'U1', err: 'FORBIDDEN' }),   // dup of U1 → once
    '{"torn": "line without closi',                                                    // crash-torn tail → skipped
    '',
    L({ at: 't7', chunk: 'c5', source: 'invoices', uuid: 'U3', err: '500' }),
  ].join('\n');

  const p = parseFailureUuids(text);
  assert.deepEqual(p.uuids, ['U1', 'U2', 'U3'], 'deduped, order of first appearance, exclusions applied');
  assert.equal(p.pdfOnly, 1);
  assert.equal(p.receipts, 1);
  assert.equal(p.badLines, 1);

  assert.deepEqual(parseFailureUuids(''), { uuids: [], pdfOnly: 0, receipts: 0, badLines: 0 }, 'empty text');
  assert.deepEqual(parseFailureUuids(null).uuids, [], 'absent file (null) is empty, not a crash');
  // a line that is valid JSON but not an object must count as bad, not throw
  assert.equal(parseFailureUuids('42\n"str"').badLines, 2);
});
