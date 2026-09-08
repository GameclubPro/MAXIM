import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATIVE_BACK_MODAL_CONFIRM_PRIORITY,
  isElementInTopmostNativeBackModal,
  registerNativeBackHandler,
  runNativeBackHandlers,
} from '../src/lib/native-back';
import { isTopmostModalDialog } from '../src/lib/dialog-focus';

test('closes the top-most dialog layer before the app-level Back handler', () => {
  const handled: string[] = [];
  const unregisterApp = registerNativeBackHandler(
    () => {
      handled.push('app');
      return true;
    },
    { priority: 0 },
  );
  const unregisterImageViewer = registerNativeBackHandler(
    () => {
      handled.push('image-viewer');
      return true;
    },
    { priority: 720 },
  );

  try {
    assert.equal(runNativeBackHandlers(), true);
    assert.deepEqual(handled, ['image-viewer']);
  } finally {
    unregisterImageViewer();
    unregisterApp();
  }
});

test('closes a nested confirmation before its underlying details sheet', () => {
  const handled: string[] = [];
  const unregisterDetails = registerNativeBackHandler(
    () => {
      handled.push('details');
      return true;
    },
    { priority: 720 },
  );
  const unregisterConfirmation = registerNativeBackHandler(
    () => {
      handled.push('confirmation');
      return true;
    },
    { priority: NATIVE_BACK_MODAL_CONFIRM_PRIORITY },
  );

  try {
    assert.equal(runNativeBackHandlers(), true);
    assert.deepEqual(handled, ['confirmation']);
  } finally {
    unregisterConfirmation();
    unregisterDetails();
  }
});

test('alert dialogs own focus and dismissal before an underlying explanation', () => {
  const previousDocument = globalThis.document;
  const trigger = {} as Element;
  const details = {
    contains: (element: Element) => element === trigger,
    hasAttribute: () => false,
    getAttribute: () => null,
  } as unknown as HTMLElement;
  const confirmation = {
    contains: () => false,
    hasAttribute: () => false,
    getAttribute: () => null,
  } as unknown as HTMLElement;
  globalThis.document = {
    querySelectorAll: (selector: string) => {
      assert.match(selector, /\[role="alertdialog"\]/u);
      return [details, confirmation];
    },
  } as unknown as Document;
  try {
    assert.equal(isElementInTopmostNativeBackModal(trigger), false);
    assert.equal(isTopmostModalDialog(details), false);
    assert.equal(isTopmostModalDialog(confirmation), true);
  } finally {
    globalThis.document = previousDocument;
  }
});
