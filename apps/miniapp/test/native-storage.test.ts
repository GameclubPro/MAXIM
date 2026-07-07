import assert from 'node:assert/strict';
import test from 'node:test';
import { readLocalMirrorItem, writeLocalMirrorItem } from '../src/lib/native-storage';

const originalWindow = globalThis.window;

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
