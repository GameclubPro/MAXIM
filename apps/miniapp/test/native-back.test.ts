import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATIVE_BACK_MODAL_CONFIRM_PRIORITY,
  registerNativeBackHandler,
  runNativeBackHandlers,
} from '../src/lib/native-back';

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
