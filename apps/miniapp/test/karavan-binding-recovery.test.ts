import assert from 'node:assert/strict';
import test from 'node:test';
import { readKaravanBindingRecovery } from '../src/pages/settings/karavan-binding-recovery';
import type { StorageItemReadResult } from '../src/lib/native-storage';

const key = 'karavan-binding:v1:777:-123';
const command = {
  marketplaceId: 'a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10',
  commandId: 'b0d9b7ce-0040-4c85-a7ec-e3cf6da94c10',
  expectedBindingGeneration: 1,
  action: 'recover_chat',
} as const;
const found = (value: unknown): StorageItemReadResult => ({
  status: 'found',
  value: JSON.stringify(value),
});

test('missing recovery copies permit a fresh request, including browser-only storage', async () => {
  for (const nativeStatus of ['missing', 'unavailable'] as const)
    assert.deepEqual(
      await readKaravanBindingRecovery(key, {
        local: () => ({ status: 'missing' }),
        native: async () => ({ status: nativeStatus }),
      }),
      { status: 'ready', request: null },
    );
});

test('a restored command retains the original identity and binding generation', async () => {
  for (const native of [{ status: 'unavailable' }, found(command)] as StorageItemReadResult[])
    assert.deepEqual(
      await readKaravanBindingRecovery(key, {
        local: () => found(command),
        native: async () => native,
      }),
      { status: 'ready', request: command },
    );
});

test('malformed JSON and schema-invalid commands reach a finite recovery error without changing evidence', async () => {
  for (const raw of ['{broken', '', JSON.stringify({ ...command, commandId: 'invalid' })]) {
    const mirror = new Map([[key, raw]]);
    const storage = {
      local: (scope: string): StorageItemReadResult => ({
        status: 'found',
        value: mirror.get(scope)!,
      }),
      native: async (): Promise<StorageItemReadResult> => ({ status: 'unavailable' }),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await readKaravanBindingRecovery(key, storage), {
        status: 'error',
        reason: 'corrupt',
      });
      assert.equal(mirror.get(key), raw);
    }
  }
});

test('a corrupt native copy cannot overwrite or hide the local command', async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const local = new Map([[key, JSON.stringify(command)]]);
  const native = new Map([[key, '{broken']]);
  const writes: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (scope: string) => local.get(scope) ?? null,
        setItem: (scope: string, value: string) => {
          writes.push(scope);
          local.set(scope, value);
        },
        removeItem: (scope: string) => {
          writes.push(scope);
          local.delete(scope);
        },
      },
      WebApp: {
        initData: 'test-init-data',
        DeviceStorage: {
          getItem: async (scope: string) => ({ value: native.get(scope) ?? null }),
          setItem: async (scope: string, value: string) => {
            writes.push(scope);
            native.set(scope, value);
          },
          removeItem: async (scope: string) => {
            writes.push(scope);
            native.delete(scope);
          },
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { dataset: { maxClient: 'native' } } },
  });
  try {
    assert.deepEqual(await readKaravanBindingRecovery(key), { status: 'error', reason: 'corrupt' });
    assert.equal(local.get(key), JSON.stringify(command));
    assert.equal(native.get(key), '{broken');
    assert.deepEqual(writes, []);
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  }
});

test('different valid local and native commands retain uncertainty instead of picking one', async () => {
  assert.deepEqual(
    await readKaravanBindingRecovery(key, {
      local: () => found(command),
      native: async () => found({ ...command, commandId: 'c0d9b7ce-0040-4c85-a7ec-e3cf6da94c10' }),
    }),
    { status: 'error', reason: 'conflicting' },
  );
});

test('read errors stay blocked and a successful reread restores the same original command', async () => {
  let nativeReadable = false;
  const storage = {
    local: (): StorageItemReadResult => ({ status: 'missing' }),
    native: async (): Promise<StorageItemReadResult> =>
      nativeReadable ? found(command) : { status: 'error' },
  };
  assert.deepEqual(await readKaravanBindingRecovery(key, storage), {
    status: 'error',
    reason: 'unavailable',
  });
  nativeReadable = true;
  assert.deepEqual(await readKaravanBindingRecovery(key, storage), {
    status: 'ready',
    request: command,
  });
});

test('a stalled native read terminates in a recoverable error; its late result cannot grant readiness', async () => {
  let resolveNative!: (value: StorageItemReadResult) => void;
  const pending = new Promise<StorageItemReadResult>((resolve) => {
    resolveNative = resolve;
  });
  const result = await readKaravanBindingRecovery(
    key,
    {
      local: () => ({ status: 'missing' }),
      native: () => pending,
    },
    1,
  );
  assert.deepEqual(result, { status: 'error', reason: 'unavailable' });
  resolveNative(found(command));
  await pending;
  assert.deepEqual(result, { status: 'error', reason: 'unavailable' });
});
