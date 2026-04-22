import assert from 'node:assert/strict';
import test from 'node:test';
import {
  openFileInputPicker,
  resolveFileInputActivationMode,
} from '../src/lib/file-input-picker';

test('resolveFileInputActivationMode keeps direct native tap for Android webviews', () => {
  assert.equal(resolveFileInputActivationMode('android'), 'native-tap');
  assert.equal(resolveFileInputActivationMode(' Android '), 'native-tap');
});

test('resolveFileInputActivationMode uses programmatic picker outside Android', () => {
  assert.equal(resolveFileInputActivationMode('ios'), 'programmatic');
  assert.equal(resolveFileInputActivationMode('desktop'), 'programmatic');
  assert.equal(resolveFileInputActivationMode(undefined), 'programmatic');
});

test('openFileInputPicker prefers showPicker when it is available', () => {
  const calls: string[] = [];
  const input = {
    disabled: false,
    showPicker: () => calls.push('showPicker'),
    click: () => calls.push('click'),
  } as unknown as HTMLInputElement;

  const result = openFileInputPicker(input);

  assert.equal(result, 'shown');
  assert.deepEqual(calls, ['showPicker']);
});

test('openFileInputPicker falls back to click when showPicker throws', () => {
  const calls: string[] = [];
  const input = {
    disabled: false,
    showPicker: () => {
      calls.push('showPicker');
      throw new Error('not supported');
    },
    click: () => calls.push('click'),
  } as unknown as HTMLInputElement;

  const result = openFileInputPicker(input);

  assert.equal(result, 'clicked');
  assert.deepEqual(calls, ['showPicker', 'click']);
});

test('openFileInputPicker returns noop for disabled inputs', () => {
  const calls: string[] = [];
  const input = {
    disabled: true,
    showPicker: () => calls.push('showPicker'),
    click: () => calls.push('click'),
  } as unknown as HTMLInputElement;

  const result = openFileInputPicker(input);

  assert.equal(result, 'noop');
  assert.deepEqual(calls, []);
});
