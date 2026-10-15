import assert from 'node:assert/strict';
import test from 'node:test';
import {
  moderatorOperationKey,
  readModeratorOperation,
  saveModeratorOperation,
  clearModeratorOperation,
  createModeratorOperationId,
} from '../src/lib/moderator-operation';
import { randomUUID } from 'node:crypto';

const request = () => ({
  operationId: randomUUID(),
  moderatorKey: '1'.repeat(24),
  expectedRevision: 4,
});
function fixture() {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const local = new Map<string, string>();
  const native = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => ({ value: native.get(key) ?? null }),
    setItem: async (key: string, value: string) => {
      native.set(key, value);
    },
    removeItem: async (key: string) => {
      native.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      WebApp: { initData: 'user_id=fixture', DeviceStorage: storage },
      localStorage: {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => local.set(key, value),
        removeItem: (key: string) => local.delete(key),
      },
    },
  });
  return {
    local,
    native,
    storage,
    restore() {
      if (original) Object.defineProperty(globalThis, 'window', original);
      else Reflect.deleteProperty(globalThis, 'window');
    },
  };
}

test('pending moderator operations survive reopening and stay account/entity scoped', async () => {
  const f = fixture();
  try {
    const key = moderatorOperationKey('first:moderation', 'chat', '-123');
    const pending = request();
    await saveModeratorOperation(key, pending);
    assert.deepEqual(await readModeratorOperation(key), pending);
    f.local.clear();
    assert.deepEqual(await readModeratorOperation(key), pending);
    assert.equal(
      await readModeratorOperation(moderatorOperationKey('second:moderation', 'chat', '-123')),
      null,
    );
    assert.equal(
      await readModeratorOperation(moderatorOperationKey('first:moderation', 'channel', '-123')),
      null,
    );
    await clearModeratorOperation(key, pending.operationId);
    assert.equal(await readModeratorOperation(key), null);
  } finally {
    f.restore();
  }
});

test('a stale success cannot erase a newer saved decision', async () => {
  const f = fixture();
  try {
    const key = moderatorOperationKey('account', 'chat', randomUUID());
    const older = request(),
      newer = request();
    await saveModeratorOperation(key, older);
    await saveModeratorOperation(key, newer);
    await clearModeratorOperation(key, older.operationId);
    assert.deepEqual(await readModeratorOperation(key), newer);
    assert.equal(JSON.parse(f.native.get(key)!).operationId, newer.operationId);
  } finally {
    f.restore();
  }
});

test('a delayed native read cannot resurrect an operation cleared while it was pending', async () => {
  const f = fixture();
  try {
    const key = moderatorOperationKey('account', 'chat', randomUUID());
    const pending = request();
    let resolveRead!: (result: { value: string }) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.storage.getItem = async () => {
      started();
      return new Promise((resolve) => {
        resolveRead = resolve;
      });
    };
    const result = readModeratorOperation(key);
    await reading;
    await clearModeratorOperation(key, pending.operationId);
    resolveRead({ value: JSON.stringify(pending) });
    assert.equal(await result, null);
    assert.deepEqual(JSON.parse(f.local.get(key)!), { cleared: pending.operationId });
  } finally {
    f.restore();
  }
});

test('failed persistent storage prevents an untracked assignment request', async () => {
  const f = fixture();
  try {
    const key = moderatorOperationKey('account', 'chat', randomUUID());
    window.localStorage.setItem = () => {
      throw new Error('quota');
    };
    f.storage.setItem = async () => {
      throw new Error('bridge unavailable');
    };
    await assert.rejects(saveModeratorOperation(key, request()));
    assert.equal(await readModeratorOperation(key), null);
  } finally {
    f.restore();
  }
});

test('malformed saved identities and excessive revisions cannot be resumed', async () => {
  const f = fixture();
  try {
    const key = moderatorOperationKey('account', 'chat', randomUUID());
    for (const bad of [
      { ...request(), expectedRevision: 2_147_483_647 },
      { ...request(), moderatorKey: 'private-id' },
      { ...request(), unexpected: true },
    ]) {
      f.local.set(key, JSON.stringify(bad));
      assert.equal(await readModeratorOperation(key), null);
    }
    assert.match(
      createModeratorOperationId(),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  } finally {
    f.restore();
  }
});

test('a failed native clear cannot resurrect a completed operation from its local mirror', async () => {
  const f = fixture();
  try {
    const key = moderatorOperationKey('account', 'chat', randomUUID());
    const pending = request();
    await saveModeratorOperation(key, pending);
    f.storage.setItem = async () => {
      throw new Error('bridge unavailable');
    };
    await clearModeratorOperation(key, pending.operationId);
    assert.equal(await readModeratorOperation(key), null);
    assert.deepEqual(JSON.parse(f.native.get(key)!), pending);
    assert.deepEqual(JSON.parse(f.local.get(key)!), { cleared: pending.operationId });
  } finally {
    f.restore();
  }
});

test('a stalled native write bounds the UI wait and preserves write order', async () => {
  const f = fixture();
  try {
    const key = moderatorOperationKey('account', 'chat', randomUUID());
    const pending = request();
    let release!: () => void;
    f.storage.setItem = async (key, value) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      f.native.set(key, value);
    };
    await assert.rejects(saveModeratorOperation(key, pending), { name: 'Error' });
    assert.deepEqual(JSON.parse(f.local.get(key)!), pending);
    release();
    assert.deepEqual(await readModeratorOperation(key), pending);
  } finally {
    f.restore();
  }
});
