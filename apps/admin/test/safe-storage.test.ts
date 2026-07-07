import assert from 'node:assert/strict';
import test from 'node:test';
import { readSessionStorageItem, writeSessionStorageItem } from '../src/safe-storage';

const originalWindow = globalThis.window;

function installWindow(sessionStorage: Storage): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { sessionStorage },
  });
}

function restoreWindow(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
}

test('returns null when sessionStorage is unavailable', () => {
  restoreWindow();

  assert.equal(readSessionStorageItem('maxim-admin'), null);
  assert.equal(writeSessionStorageItem('maxim-admin', '1'), false);
});

test('reads and writes sessionStorage when it is available', () => {
  const values = new Map<string, string>();
  installWindow({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage);

  assert.equal(writeSessionStorageItem('maxim-admin', '1'), true);
  assert.equal(readSessionStorageItem('maxim-admin'), '1');

  restoreWindow();
});

test('swallows sessionStorage read and write failures', () => {
  installWindow({
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  } as unknown as Storage);

  assert.equal(readSessionStorageItem('maxim-admin'), null);
  assert.equal(writeSessionStorageItem('maxim-admin', '1'), false);

  restoreWindow();
});
