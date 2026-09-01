import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildPublicationDraftStorageKey,
  clearPublicationDraft,
  parsePublicationDraftEnvelope,
  preparePublicationDraftForIndexedPersistence,
  PUBLICATION_DRAFT_TTL_MS,
  resolvePublicationDraftLoadState,
  savePublicationDraft,
} from '../src/features/publications/publication-draft-storage';
import { createEmptyPublicationDraft } from '../src/features/publications/publication-model';

test('keeps image bytes outside the frequently rewritten publication draft record', () => {
  const draft = createEmptyPublicationDraft();
  draft.text = 'Текст можно продолжать печатать';
  draft.images = [
    { base64: 'large-private-payload', mimeType: 'image/jpeg', fileName: 'photo.jpg' },
  ];

  const persisted = preparePublicationDraftForIndexedPersistence(draft);

  assert.equal(persisted.hasImages, true);
  assert.equal(persisted.images, draft.images);
  assert.deepEqual(persisted.draft.images, []);
  assert.equal(JSON.stringify(persisted.draft).includes('large-private-payload'), false);
  assert.equal(persisted.draft.text, draft.text);
});

test('reads legacy inline drafts and lightweight split-media records', () => {
  const legacy = parsePublicationDraftEnvelope({
    version: 1,
    savedAt: '2026-09-01T08:00:00.000Z',
    draft: {
      text: 'Старый черновик',
      images: [{ base64: 'legacy-photo', mimeType: 'image/jpeg', fileName: 'legacy.jpg' }],
    },
  });
  const current = parsePublicationDraftEnvelope({
    version: 3,
    savedAt: '2026-09-01T08:01:00.000Z',
    hasImages: true,
    imageCount: 1,
    draft: { text: 'Новый черновик', images: [] },
  });

  assert.deepEqual(
    legacy?.images.map((image) => image.base64),
    ['legacy-photo'],
  );
  assert.equal(current?.text, 'Новый черновик');
  assert.deepEqual(current?.images, []);
});

test('local storage fallback never receives publication image bytes', async () => {
  const previousWindow = globalThis.window;
  const values = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      indexedDB: undefined,
      localStorage,
      location: { hash: '', search: '' },
      MAX: undefined,
      WebApp: undefined,
    },
  });

  try {
    const draft = createEmptyPublicationDraft();
    draft.text = 'Лёгкая резервная копия';
    draft.images = [
      { base64: 'must-not-enter-local-storage', mimeType: 'image/jpeg', fileName: 'photo.jpg' },
    ];

    await savePublicationDraft(draft, 'user-1');

    const storageKey = buildPublicationDraftStorageKey('user-1');
    const stored = values.get(storageKey) ?? '';
    assert.equal(stored.includes('must-not-enter-local-storage'), false);
    assert.equal(JSON.parse(stored).version, 3);
    assert.equal(JSON.parse(stored).hasImages, true);
    assert.equal(JSON.parse(stored).imageCount, 1);
    assert.equal(values.has(buildPublicationDraftStorageKey(null)), false);
    await clearPublicationDraft('user-1');
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    });
  }
});

test('uses the newest draft and reports photos missing from a newer lightweight fallback', () => {
  const resolved = resolvePublicationDraftLoadState({
    nowMs: Date.parse('2026-09-01T10:00:00.000Z'),
    indexedEnvelope: {
      version: 3,
      savedAt: '2026-09-01T09:00:00.000Z',
      hasImages: true,
      imageCount: 1,
      draft: { text: 'Старый текст', images: [] },
    },
    indexedMediaEnvelope: {
      version: 1,
      images: [{ base64: 'old-photo', mimeType: 'image/jpeg', fileName: 'old.jpg' }],
    },
    localEnvelope: {
      version: 3,
      savedAt: '2026-09-01T09:01:00.000Z',
      hasImages: true,
      imageCount: 1,
      draft: { text: 'Свежий текст', images: [] },
    },
  });

  assert.equal(resolved.source, 'local');
  assert.equal(resolved.draft?.text, 'Свежий текст');
  assert.equal(resolved.imagesNeedReselection, true);
  assert.deepEqual(resolved.draft?.images, []);
  assert.equal(resolved.discardIndexed, true);
});

test('prefers complete indexed media when split records have the same timestamp', () => {
  const envelope = {
    version: 3,
    savedAt: '2026-09-01T09:00:00.000Z',
    hasImages: true,
    imageCount: 1,
    draft: { text: 'Один текст', images: [] },
  };
  const resolved = resolvePublicationDraftLoadState({
    nowMs: Date.parse('2026-09-01T10:00:00.000Z'),
    indexedEnvelope: envelope,
    indexedMediaEnvelope: {
      version: 1,
      images: [{ base64: 'photo', mimeType: 'image/jpeg', fileName: 'photo.jpg' }],
    },
    localEnvelope: envelope,
  });

  assert.equal(resolved.source, 'indexed');
  assert.equal(resolved.imagesNeedReselection, false);
  assert.deepEqual(
    resolved.draft?.images.map((image) => image.base64),
    ['photo'],
  );
});

test('expires stale draft metadata and media together', () => {
  const nowMs = Date.parse('2026-09-01T10:00:00.000Z');
  const expiredSavedAt = new Date(nowMs - PUBLICATION_DRAFT_TTL_MS - 1).toISOString();
  const expiredEnvelope = {
    version: 3,
    savedAt: expiredSavedAt,
    hasImages: true,
    imageCount: 1,
    draft: { text: 'Просрочено', images: [] },
  };
  const resolved = resolvePublicationDraftLoadState({
    nowMs,
    indexedEnvelope: expiredEnvelope,
    indexedMediaEnvelope: {
      version: 1,
      images: [{ base64: 'private-photo', mimeType: 'image/jpeg', fileName: 'old.jpg' }],
    },
    localEnvelope: expiredEnvelope,
  });

  assert.equal(resolved.draft, null);
  assert.equal(resolved.discardIndexed, true);
  assert.equal(resolved.discardLocal, true);
});

test('serializes autosaves and rewrites the separate media store only when its array changes', () => {
  const source = readFileSync(
    new URL('../src/features/publications/publication-draft-storage.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /const STORAGE_VERSION = 3;/u);
  assert.match(source, /const DB_VERSION = 2;/u);
  assert.match(source, /const MEDIA_STORE_NAME = 'media';/u);
  assert.match(
    source,
    /const mediaChanged =[\s\S]*?imagesNeedReselection \|\| !cachedMedia\?\.stored \|\|/u,
  );
  assert.match(source, /cachedMedia\.images !== persisted\.images/u);
  assert.match(source, /mediaChanged \? persisted\.images : undefined/u);
  assert.match(source, /enqueueDraftStorageMutation\(storageKey/u);
});
