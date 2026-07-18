import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildPublicationCreateIdentityStorageKey,
  clearPublicationCreateIdentity,
  parsePublicationCreateIdentityRecord,
  parsePublicationCreateIdentityStorageValue,
  readPublicationCreateIdentity,
  writePublicationCreateIdentity,
  type PublicationCreateIdentityStorage,
} from '../src/features/publications/publication-create-request-storage';

const requestIdsHookSource = readFileSync(
  new URL('../src/features/publications/use-publication-request-ids.ts', import.meta.url),
  'utf8',
);

function createMemoryStorage(): PublicationCreateIdentityStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

const validRecord = {
  requestId: 'pending-create-001',
  fingerprint: 'v1:0123456789abcdef0123456789abcdef',
};

test('pending create storage uses the publication draft user scope', () => {
  assert.equal(
    buildPublicationCreateIdentityStorageKey('1001'),
    'maxim:publications-composer:v1:1001:pending-create:v1',
  );
  assert.equal(
    buildPublicationCreateIdentityStorageKey('user 2'),
    'maxim:publications-composer:v1:user%202:pending-create:v1',
  );
  assert.notEqual(
    buildPublicationCreateIdentityStorageKey('1001'),
    buildPublicationCreateIdentityStorageKey('1002'),
  );
});

test('validates and normalizes the persisted create identity record', () => {
  assert.deepEqual(
    parsePublicationCreateIdentityRecord({
      requestId: `  ${validRecord.requestId}  `,
      fingerprint: ` ${validRecord.fingerprint} `,
    }),
    validRecord,
  );
  assert.equal(parsePublicationCreateIdentityRecord({ ...validRecord, text: 'secret' }), null);
  assert.equal(parsePublicationCreateIdentityRecord({ ...validRecord, requestId: 'short' }), null);
  assert.equal(
    parsePublicationCreateIdentityRecord({ ...validRecord, fingerprint: 'invalid' }),
    null,
  );
  assert.equal(parsePublicationCreateIdentityRecord(Object.create(validRecord)), null);
  assert.equal(parsePublicationCreateIdentityRecord(null), null);
  assert.equal(parsePublicationCreateIdentityStorageValue('{broken'), null);
  assert.equal(parsePublicationCreateIdentityStorageValue('x'.repeat(513)), null);
});

test('writes, restores, and clears only the compact identity record', () => {
  const storage = createMemoryStorage();
  const storageKey = buildPublicationCreateIdentityStorageKey('1001');
  writePublicationCreateIdentity(storageKey, validRecord, storage);

  assert.deepEqual(readPublicationCreateIdentity(storageKey, storage), validRecord);
  assert.equal(storage.values.get(storageKey), JSON.stringify(validRecord));
  assert.equal((storage.values.get(storageKey) ?? '').length < 256, true);

  clearPublicationCreateIdentity(storageKey, storage);
  assert.equal(readPublicationCreateIdentity(storageKey, storage), null);
});

test('rejects corrupted storage and silently tolerates unavailable WebView storage', () => {
  const storage = createMemoryStorage();
  const storageKey = buildPublicationCreateIdentityStorageKey('1001');
  storage.values.set(storageKey, JSON.stringify({ ...validRecord, mediaBase64: 'secret' }));
  assert.equal(readPublicationCreateIdentity(storageKey, storage), null);
  assert.equal(storage.values.has(storageKey), false);

  const unavailableStorage: PublicationCreateIdentityStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(readPublicationCreateIdentity(storageKey, unavailableStorage), null);
  assert.doesNotThrow(() =>
    writePublicationCreateIdentity(storageKey, validRecord, unavailableStorage),
  );
  assert.doesNotThrow(() => clearPublicationCreateIdentity(storageKey, unavailableStorage));
});

test('clears persisted identity only when a create save is confirmed', () => {
  const confirmSaveBlock = requestIdsHookSource.slice(
    requestIdsHookSource.indexOf('confirmSaveSuccess()'),
    requestIdsHookSource.indexOf('confirmTestSuccess()'),
  );
  assert.match(
    confirmSaveBlock,
    /saveKindRef\.current === 'create'[\s\S]*?clearPublicationCreateIdentity/u,
  );
  assert.doesNotMatch(requestIdsHookSource, /onError[\s\S]*?clearPublicationCreateIdentity/u);
});
