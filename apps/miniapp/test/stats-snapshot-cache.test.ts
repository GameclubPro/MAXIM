import assert from 'node:assert/strict';
import test from 'node:test';
import { readStatsSnapshotMirror, saveStatsSnapshot } from '../src/lib/stats-snapshot-cache';

type IdleCallback = () => void;

function installWindowMock(options: {
  initialItems?: Record<string, string>;
  idleCallbacks?: IdleCallback[];
}) {
  const store = new Map(Object.entries(options.initialItems ?? {}));
  const idleCallbacks = options.idleCallbacks ?? [];
  const windowLike = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
    requestIdleCallback: (callback: IdleCallback) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    },
    cancelIdleCallback: () => {},
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  } as unknown as Window & typeof globalThis;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: windowLike,
  });

  return {
    store,
    idleCallbacks,
  };
}

test.afterEach(() => {
  delete (globalThis as { window?: Window }).window;
});

test('stats snapshot mirror reuses parsed raw values', () => {
  const key = 'maxim:stats-snapshot:v7:channel:chat-1:7d:overview';
  installWindowMock({
    initialItems: {
      [key]: JSON.stringify({
        savedAt: Date.now(),
        value: { ok: true },
      }),
    },
  });

  const originalParse = JSON.parse;
  let parseCount = 0;
  JSON.parse = ((text: string) => {
    parseCount += 1;
    return originalParse(text);
  }) as typeof JSON.parse;

  try {
    assert.deepEqual(readStatsSnapshotMirror('channel', ['chat-1', '7d', 'overview']), {
      ok: true,
    });
    assert.deepEqual(readStatsSnapshotMirror('channel', ['chat-1', '7d', 'overview']), {
      ok: true,
    });
  } finally {
    JSON.parse = originalParse;
  }

  assert.equal(parseCount, 1);
});

test('stats snapshot save defers storage write but keeps pending value readable', () => {
  const { store, idleCallbacks } = installWindowMock({});
  const key = 'maxim:stats-snapshot:v7:channel:chat-2:7d:overview';

  saveStatsSnapshot('channel', ['chat-2', '7d', 'overview'], { count: 42 });

  assert.equal(store.has(key), false);
  assert.deepEqual(readStatsSnapshotMirror('channel', ['chat-2', '7d', 'overview']), {
    count: 42,
  });
  assert.equal(idleCallbacks.length, 1);

  idleCallbacks[0]?.();

  assert.equal(typeof store.get(key), 'string');
  assert.deepEqual(JSON.parse(store.get(key) ?? '{}').value, { count: 42 });
});
