import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRadioGroupNavigationIndex } from '../src/lib/radio-group-navigation';

test('radio group arrows move through options and wrap at both ends', () => {
  assert.equal(resolveRadioGroupNavigationIndex(1, 3, 'ArrowLeft'), 0);
  assert.equal(resolveRadioGroupNavigationIndex(1, 3, 'ArrowUp'), 0);
  assert.equal(resolveRadioGroupNavigationIndex(1, 3, 'ArrowRight'), 2);
  assert.equal(resolveRadioGroupNavigationIndex(1, 3, 'ArrowDown'), 2);
  assert.equal(resolveRadioGroupNavigationIndex(0, 3, 'ArrowLeft'), 2);
  assert.equal(resolveRadioGroupNavigationIndex(2, 3, 'ArrowRight'), 0);
});

test('radio group Home and End keys select the boundary options', () => {
  assert.equal(resolveRadioGroupNavigationIndex(1, 3, 'Home'), 0);
  assert.equal(resolveRadioGroupNavigationIndex(1, 3, 'End'), 2);
});

test('radio group navigation ignores unrelated keys and invalid ranges', () => {
  assert.equal(resolveRadioGroupNavigationIndex(1, 3, 'Enter'), null);
  assert.equal(resolveRadioGroupNavigationIndex(-1, 3, 'ArrowRight'), null);
  assert.equal(resolveRadioGroupNavigationIndex(3, 3, 'ArrowRight'), null);
  assert.equal(resolveRadioGroupNavigationIndex(0, 0, 'ArrowRight'), null);
});
