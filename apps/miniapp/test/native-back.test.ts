import assert from 'node:assert/strict';
import test from 'node:test';
import { registerNativeBackHandler, runNativeBackHandlers } from '../src/lib/native-back';

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
