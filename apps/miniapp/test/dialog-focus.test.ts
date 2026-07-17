import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDialogTabWrapTarget } from '../src/lib/dialog-focus';

function createFocusFixture() {
  const panel = {} as HTMLElement;
  const first = {} as HTMLElement;
  const middle = {} as HTMLElement;
  const last = {} as HTMLElement;
  const contained = new Set<Element>([panel, first, middle, last]);
  panel.contains = (element) => element !== null && contained.has(element as Element);

  return { panel, first, middle, last };
}

test('dialog focus trap wraps backward from an initially focused panel', () => {
  const { panel, first, middle, last } = createFocusFixture();

  assert.equal(resolveDialogTabWrapTarget(panel, panel, [first, middle, last], true), last);
});

test('dialog focus trap wraps forward from an initially focused panel', () => {
  const { panel, first, middle, last } = createFocusFixture();

  assert.equal(resolveDialogTabWrapTarget(panel, panel, [first, middle, last], false), first);
});

test('dialog focus trap leaves focus movement inside the dialog unchanged', () => {
  const { panel, first, middle, last } = createFocusFixture();

  assert.equal(resolveDialogTabWrapTarget(panel, middle, [first, middle, last], true), null);
  assert.equal(resolveDialogTabWrapTarget(panel, middle, [first, middle, last], false), null);
});
