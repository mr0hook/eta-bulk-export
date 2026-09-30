// T-304 — a locked export folder must read as an instruction, and must never surface as the ETA
// portal's own crash dialog.
//
// 2026-09-20 report (screenshot): the portal's "Oops! Application Error" boundary showing
// "NoModificationAllowedError: An attempt was made to write to a file or directory which could not
// be modified due to the state of the underlying filesystem." That is OUR write failing (an export
// file held open in Excel), escaping a drawer action as an unhandled rejection, and being rendered
// by the SPA as if the tax portal had crashed — with a "Report this error" button that goes to the
// ETA, not to us. We are injected at document_idle, so our own window listener is registered after
// the SPA's and cannot suppress that dialog: the fix is to leave no rejection unhandled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isFsLocked } from '../src/ui/flow.js';
import { t, setLang } from '../src/core/i18n.js';

const domEx = (name, message) => { const e = new Error(message); e.name = name; return e; };

test('T-304 the errors that mean "the folder is busy" are recognised by name and by text', () => {
  assert.ok(isFsLocked(domEx('NoModificationAllowedError',
    'An attempt was made to write to a file or directory which could not be modified due to the state of the underlying filesystem.')),
    'THE REPORTED ONE — a file held open by Excel or a sync client');
  assert.ok(isFsLocked(domEx('InvalidStateError',
    'An attempt was made to use an object that is not, or is no longer, usable: state cached in an interface object had changed')));
  assert.ok(isFsLocked(domEx('NotReadableError', 'The requested file could not be read')));
  // and it must not swallow everything else — those still show their own message
  assert.ok(!isFsLocked(domEx('TypeError', 'x is not a function')));
  assert.ok(!isFsLocked(domEx('NotAllowedError', 'The request is not allowed by the user agent')));
  assert.ok(!isFsLocked(null));
});

test('T-304b both languages tell the user what to close', () => {
  setLang('en');
  assert.match(t('ft.fileLocked'), /Excel/, 'EN names the thing to close');
  setLang('ar');
  assert.match(t('ft.fileLocked'), /Excel/, 'AR names it too');
  setLang('en');
});

// The wrapper is DOM code inside mountUI, which no node test can mount (see shadows.test.mjs).
// This pins the one line that must not be deleted: without it every async onclick can leak.
test('T-304c every wired drawer action is wrapped before mountUI returns', () => {
  const src = readFileSync(new URL('../src/ui/drawer.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function mountUI'));
  const guard = body.indexOf("for (const el of root.querySelectorAll('button, input, select'))");
  assert.ok(guard > 0, 'the guard pass over the wired handlers is gone — actions can leak into the portal error boundary again');
  assert.ok(guard < body.indexOf('return orch;'), 'and it must run after the handlers are wired');
  assert.ok(body.slice(guard, guard + 600).includes('actionErrText'), 'a caught action reports through the friendly translation');
  // Nothing may wire a handler after the pass has run — it would not be wrapped. The pass's own two
  // `.onclick` mentions (reading the handler, replacing it) are the block itself, so skip past them.
  const after = body.slice(guard + body.slice(guard).indexOf('};\n  }') + 6);
  assert.ok(!after.includes('.onclick = '),
    'a handler wired AFTER the guard pass would not be wrapped — wire it above, or wrap it yourself');
});
