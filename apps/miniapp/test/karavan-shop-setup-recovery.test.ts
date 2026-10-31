import assert from 'node:assert/strict';
import test from 'node:test';
import {
  karavanMarketplaceOperationSchema,
  karavanMarketplaceSetupSchema,
} from '@maxim/contracts/karavan-marketplace';
import type { StorageItemReadResult } from '../src/lib/native-storage';
import {
  readShopDraftRecovery,
  readShopSetupRecovery,
} from '../src/pages/settings/karavan-shop/setup-recovery';
import { shopSetupDraftKey } from '../src/pages/settings/karavan-shop/setup-intent';

const operationId = 'a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10';
const request = karavanMarketplaceSetupSchema.parse({
  operationId,
  chatIds: ['-123'],
  existingMarketplaceId: 'b0d9b7ce-0040-4c85-a7ec-e3cf6da94c10',
  expectedPolicyRevision: 1,
});
const operation = karavanMarketplaceOperationSchema.parse({
  operationId,
  state: 'partial',
  request,
  checkpoints: {
    marketplaceId: request.existingMarketplaceId,
    bindings: [{ chatId: '-123', state: 'failed', bindingId: null, generation: null }],
  },
});
const found = (value: unknown): StorageItemReadResult => ({
  status: 'found',
  value: JSON.stringify(value),
});
const unavailable = async (): Promise<StorageItemReadResult> => ({ status: 'unavailable' });
const draft = {
  mode: 'new',
  existingId: null,
  name: 'Соседи',
  rules: 'Правила',
  categories: ['services'],
  subcategories: ['services.repair'],
  initialized: true,
  admissionPolicy: 'applications',
  chatIds: ['-123'],
};

test('server active setup restores without replacing either storage copy or reading another operation', async () => {
  let reads = 0;
  const result = await readShopSetupRecovery(
    'setup',
    '-123',
    operation,
    async () => {
      reads++;
      throw new Error('Unexpected read');
    },
    { local: () => ({ status: 'missing' }), native: unavailable },
  );
  assert.deepEqual(result, { status: 'ready', request, operation });
  assert.equal(reads, 0);
});

test('submitted setup corruption, wrong entry chat and distinct mirror or server commands remain blocked', async () => {
  const otherRequest = { ...request, operationId: 'c0d9b7ce-0040-4c85-a7ec-e3cf6da94c10' };
  for (const [local, native, server, reason] of [
    [{ status: 'found', value: '{broken' }, { status: 'unavailable' }, operation, 'corrupt'],
    [found({ ...request, chatIds: ['-456', '-123'] }), { status: 'unavailable' }, null, 'corrupt'],
    [found(request), found(otherRequest), null, 'conflicting'],
    [found(otherRequest), { status: 'unavailable' }, operation, 'conflicting'],
  ] as const) {
    assert.deepEqual(
      await readShopSetupRecovery('setup', '-123', server, async () => operation, {
        local: () => local,
        native: async () => native,
      }),
      { status: 'error', reason, operation: server },
    );
  }
});

test('native and operation reads have finite errors; late completion cannot change recovery', async () => {
  let finishNative!: (value: StorageItemReadResult) => void;
  const native = new Promise<StorageItemReadResult>((resolve) => {
    finishNative = resolve;
  });
  const result = await readShopSetupRecovery(
    'setup',
    '-123',
    operation,
    async () => operation,
    {
      local: () => found(request),
      native: () => native,
    },
    1,
  );
  assert.deepEqual(result, { status: 'error', reason: 'unavailable', operation });
  finishNative(found(request));
  await native;
  assert.equal(result.status, 'error');
  assert.deepEqual(
    await readShopSetupRecovery(
      'setup',
      '-123',
      null,
      () => new Promise(() => {}),
      {
        local: () => found(request),
        native: unavailable,
      },
      1,
    ),
    { status: 'error', reason: 'unavailable', operation: null, request },
  );
});

test('a failed submitted setup reread retains its original identity on successful retry', async () => {
  let readable = false;
  const read = async () => {
    if (!readable) throw new Error('Unavailable');
    return operation;
  };
  const storage = { local: () => found(request), native: unavailable };
  assert.equal((await readShopSetupRecovery('setup', '-123', null, read, storage)).status, 'error');
  readable = true;
  assert.deepEqual(await readShopSetupRecovery('setup', '-123', null, read, storage), {
    status: 'ready',
    request,
    operation,
  });
});

test('drafts restore only the chosen action and leave incompatible legacy multi-chat drafts unused', async () => {
  const currentKey = shopSetupDraftKey('777', '-123', { kind: 'create' });
  const legacyDraft = { ...draft, chatIds: ['-123', '-456'] };
  const original = JSON.stringify(legacyDraft);
  const storage = new Map([['karavan-setup-draft:v1:777:-123', original]]);
  assert.deepEqual(
    await readShopDraftRecovery(
      '777',
      '-123',
      { kind: 'create' },
      {
        local: (key) =>
          storage.has(key) ? { status: 'found', value: storage.get(key)! } : { status: 'missing' },
        native: unavailable,
      },
    ),
    { status: 'ready', draft: null },
  );
  assert.equal(storage.get('karavan-setup-draft:v1:777:-123'), original);
  storage.set(
    currentKey,
    JSON.stringify({ ...draft, mode: 'existing', existingId: request.existingMarketplaceId }),
  );
  assert.deepEqual(
    await readShopDraftRecovery(
      '777',
      '-123',
      { kind: 'create' },
      {
        local: (key) =>
          storage.has(key) ? { status: 'found', value: storage.get(key)! } : { status: 'missing' },
        native: unavailable,
      },
    ),
    { status: 'error', reason: 'corrupt' },
  );
});

test('editable draft conflicts and stalled native reads reach a finite error without selecting a version', async () => {
  assert.deepEqual(
    await readShopDraftRecovery(
      '777',
      '-123',
      { kind: 'create' },
      {
        local: () => found(draft),
        native: async () => found({ ...draft, name: 'Другая копия' }),
      },
    ),
    { status: 'error', reason: 'conflicting' },
  );
  assert.deepEqual(
    await readShopDraftRecovery(
      '777',
      '-123',
      { kind: 'create' },
      {
        local: () => found(draft),
        native: () => new Promise(() => {}),
      },
      1,
    ),
    { status: 'error', reason: 'unavailable' },
  );
});
