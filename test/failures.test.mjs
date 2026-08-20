// SPEC-028 T-262 — eta_failures.jsonl → retry-eligible uuid list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFailureUuids, pruneFailureLines } from '../src/core/failures.js';

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

  assert.deepEqual(parseFailureUuids('').uuids, [], 'empty text');
  assert.deepEqual(parseFailureUuids(null).uuids, [], 'absent file (null) is empty, not a crash');
  // a line that is valid JSON but not an object must count as bad, not throw
  assert.equal(parseFailureUuids('42\n"str"').badLines, 2);
});

test('T-278 pruning removes exactly the recovered documents and keeps everything else', () => {
  const text = [
    L({ at: 't1', chunk: 'c1', source: 'invoices', uuid: 'U1', err: 'FORBIDDEN' }),
    L({ at: 't2', chunk: 'c1', source: 'invoices', uuid: 'U2', err: 'timeout' }),
    L({ at: 't3', chunk: 'c2', kind: 'over_cap', warn: 'over_cap_single_day' }),   // no uuid — history, keep
    L({ at: 't4', chunk: 'c1', kind: 'pdf', uuid: 'U1', err: 'NOT_FOUND' }),       // same doc, pdf line
    '{"torn": "half a line',                                                        // unreadable — keep, never guess
    L({ at: 't5', chunk: 'c3', source: 'invoices', uuid: 'U3', err: '500' }),
  ].join('\n');

  const r = pruneFailureLines(text, new Set(['U1', 'U3']));
  assert.equal(r.removed, 2, 'the U1 and U3 document-drop lines went');
  const left = r.text.split('\n').filter(Boolean);
  assert.equal(left.length, 4);
  assert.ok(left.some((l) => l.includes('U2')), 'a document that is still missing stays listed');
  assert.ok(left.some((l) => l.includes('"kind":"pdf"')),
    "U1's PDF line stays: re-exporting the document does not make its missing official PDF appear");
  assert.ok(left.some((l) => l.includes('over_cap')), 'range-level history is not a document and is kept');
  assert.ok(left.some((l) => l.includes('torn')), 'an unreadable line is evidence — never dropped on a guess');
});

test('T-279 pruning is a no-op when nothing was recovered — a huge log is not rewritten for nothing', () => {
  const text = L({ at: 't1', uuid: 'U9', err: 'FORBIDDEN' }) + '\n';
  assert.equal(pruneFailureLines(text, new Set(['U1'])).text, null, 'no overlap → no rewrite');
  assert.equal(pruneFailureLines(text, new Set()).text, null, 'empty recovery set → no rewrite');
  assert.equal(pruneFailureLines('', new Set(['U1'])).text, null, 'no file → nothing to do');
  // and when every document entry is recovered the file is emptied, not left with a stale tail
  assert.equal(pruneFailureLines(text, new Set(['U9'])).text, '');
});
