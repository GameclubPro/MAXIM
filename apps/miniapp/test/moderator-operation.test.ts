import assert from 'node:assert/strict';
import test from 'node:test';
import { moderatorOperationKey, readModeratorOperation, saveModeratorOperation, clearModeratorOperation } from '../src/lib/moderator-operation';
import { randomUUID } from 'node:crypto';

const request = () => ({ operationId: randomUUID(), moderatorKey: '1'.repeat(24), expectedRevision: 4 });
function fixture() {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const local = new Map<string, string>();
  const native = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => ({ value: native.get(key) ?? null }),
    setItem: async (key: string, value: string) => { native.set(key, value); },
    removeItem: async (key: string) => { native.delete(key); },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    WebApp: { initData: 'user_id=fixture', DeviceStorage: storage },
    localStorage: { getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => local.set(key, value),
      removeItem: (key: string) => local.delete(key) },
  } });
  return { local, native, storage, restore() {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  } };
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
    assert.equal(await readModeratorOperation(moderatorOperationKey('second:moderation', 'chat', '-123')), null);
    assert.equal(await readModeratorOperation(moderatorOperationKey('first:moderation', 'channel', '-123')), null);
    await clearModeratorOperation(key, pending.operationId);
    assert.equal(await readModeratorOperation(key), null);
  } finally { f.restore(); }
});

test('a stale success cannot erase a newer saved decision', async () => {
  const f = fixture();
  try {
    const key = moderatorOperationKey('account', 'chat', randomUUID());
    const older = request(), newer = request();
    await saveModeratorOperation(key, older);
    await saveModeratorOperation(key, newer);
    await clearModeratorOperation(key, older.operationId);
    assert.deepEqual(await readModeratorOperation(key), newer);
    assert.equal(JSON.parse(f.native.get(key)!).operationId, newer.operationId);
  } finally { f.restore(); }
});

test('a delayed native read cannot resurrect an operation cleared while it was pending', async () => {
  const f = fixture();
  try {
    const key = moderatorOperationKey('account', 'chat', randomUUID());
    const pending = request();
    let resolveRead!: (result: { value: string }) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    f.storage.getItem = async () => { started(); return new Promise((resolve) => { resolveRead = resolve; }); };
    const result = readModeratorOperation(key);
    await reading;
    await clearModeratorOperation(key, pending.operationId);
    resolveRead({ value: JSON.stringify(pending) });
    assert.equal(await result, null);
    assert.equal(f.local.has(key), false);
  } finally { f.restore(); }
});
