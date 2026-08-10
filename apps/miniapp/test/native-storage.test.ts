import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hydrateMirroredItem,
  readLocalMirrorItem,
  writeLocalMirrorItem,
} from '../src/lib/native-storage';
import { waitForNativeStorageRuntime } from '../src/lib/native-storage-runtime';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

function installWindow(localStorage: Storage): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage },
  });
}

function restoreWindow(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
}

function installDocument(script: EventTarget, dataset: Record<string, string>): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      documentElement: { dataset },
      querySelector: () => script,
    } as unknown as Document,
  });
}

function restoreDocument(): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: originalDocument,
  });
}

test('local mirror reads and writes through localStorage', () => {
  const values = new Map<string, string>();
  installWindow({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage);

  writeLocalMirrorItem('maxim:test', '1');

  assert.equal(readLocalMirrorItem('maxim:test'), '1');
  restoreWindow();
});

test('local mirror tolerates missing or restricted localStorage', () => {
  restoreWindow();
  assert.equal(readLocalMirrorItem('maxim:test'), null);

  installWindow({
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  } as unknown as Storage);

  assert.equal(readLocalMirrorItem('maxim:test'), null);
  assert.doesNotThrow(() => writeLocalMirrorItem('maxim:test', '1'));
  restoreWindow();
});

test('late MAX Bridge discovery can recover a native-only mirrored value', async () => {
  const values = new Map<string, string>();
  const dataset: Record<string, string> = { maxClient: 'browser' };
  const bridgeScript = new EventTarget();
  installWindow({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage);
  installDocument(bridgeScript, dataset);

  try {
    const availability = waitForNativeStorageRuntime({ timeoutMs: 250, pollIntervalMs: 5 });
    setTimeout(() => {
      dataset.maxClient = 'native';
      window.MAX = {
        WebApp: {
          initData: 'auth_date=1&hash=test',
          DeviceStorage: {
            getItem: async (key: string) => ({
              key,
              value: key === 'maxim:late-labels' ? '{"important":"VIP"}' : null,
            }),
          },
        },
      };
      bridgeScript.dispatchEvent(new Event('load'));
    }, 10);

    assert.equal(await availability, true);
    assert.equal(await hydrateMirroredItem('maxim:late-labels'), '{"important":"VIP"}');
    assert.equal(values.get('maxim:late-labels'), '{"important":"VIP"}');
  } finally {
    restoreDocument();
    restoreWindow();
  }
});
