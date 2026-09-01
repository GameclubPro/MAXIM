import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureFilePickerReturnState,
  openFileInputPicker,
  resolveFileInputActivationMode,
  restoreFilePickerReturnState,
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

test('restores picker focus only to the previously active editable control without scrolling it', () => {
  const focusOptions: FocusOptions[] = [];
  const editor = {
    tagName: 'DIV',
    isContentEditable: true,
    isConnected: true,
    focus: (options: FocusOptions) => focusOptions.push(options),
  } as unknown as HTMLElement;
  const scrollCalls: ScrollToOptions[] = [];
  const containerScrollCalls: ScrollToOptions[] = [];
  const scrollContainer = {
    isConnected: true,
    scrollLeft: 8,
    scrollTop: 210,
    scrollTo: (options: ScrollToOptions) => containerScrollCalls.push(options),
  };
  const scrollTarget = {
    scrollX: 14,
    scrollY: 320,
    scrollTo: (options: ScrollToOptions) => scrollCalls.push(options),
  };
  const state = captureFilePickerReturnState(editor, scrollTarget, scrollContainer);

  assert.equal(restoreFilePickerReturnState(state, scrollTarget), true);
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.deepEqual(containerScrollCalls, [{ left: 8, top: 210, behavior: 'auto' }]);
  assert.deepEqual(scrollCalls, [{ left: 14, top: 320, behavior: 'auto' }]);
});

test('does not autofocus a non-editable control after returning from the picker', () => {
  const button = {
    tagName: 'BUTTON',
    isContentEditable: false,
    isConnected: true,
    focus: () => assert.fail('button focus must not be forced'),
  } as unknown as HTMLElement;
  const scrollCalls: ScrollToOptions[] = [];
  const scrollTarget = {
    scrollX: 0,
    scrollY: 88,
    scrollTo: (options: ScrollToOptions) => scrollCalls.push(options),
  };
  const state = captureFilePickerReturnState(button, scrollTarget);

  assert.equal(state.focusTarget, null);
  assert.equal(restoreFilePickerReturnState(state, scrollTarget), false);
  assert.deepEqual(scrollCalls, [{ left: 0, top: 88, behavior: 'auto' }]);
});
