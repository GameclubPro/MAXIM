import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  bindChannelSuggestionDraftToThread,
  buildChannelSuggestionDraftStorageKey,
  buildChannelSuggestionThreadScope,
  clearChannelSuggestionDraft,
  loadChannelSuggestionDraft,
  parseChannelSuggestionDraftEnvelope,
  resolveChannelSuggestionDraftLoadState,
  saveChannelSuggestionDraft,
} from '../src/features/channel-suggestions/channel-suggestion-draft-storage';

const suggestionPageSource = readFileSync(
  new URL('../src/pages/channel-suggest-dialog-page.tsx', import.meta.url),
  'utf8',
);
const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const imageGridSource = readFileSync(
  new URL('../src/components/channel-suggestion-compose-image-grid.tsx', import.meta.url),
  'utf8',
);
const DIALOG_TOKEN_A = 'publisher-dialog-token-a-123456';
const DIALOG_TOKEN_B = 'publisher-dialog-token-b-123456';
const THREAD_SCOPE_A = buildChannelSuggestionThreadScope(DIALOG_TOKEN_A)!;
const THREAD_SCOPE_B = buildChannelSuggestionThreadScope(DIALOG_TOKEN_B)!;

test('scopes suggestion drafts to an authenticated user while keeping thread identity separate', () => {
  const key = buildChannelSuggestionDraftStorageKey({
    userId: 'user-1',
    chatId: 'channel-1',
    profile: 'publisher',
    threadScope: THREAD_SCOPE_A,
  });

  assert.equal(key, 'maxim:channel-suggestion-draft:v1:publisher:user-1:channel-1');
  assert.equal(THREAD_SCOPE_A.length, 32);
  assert.notEqual(THREAD_SCOPE_A, THREAD_SCOPE_B);
  assert.equal(key?.includes(DIALOG_TOKEN_A), false);
  assert.equal(
    buildChannelSuggestionDraftStorageKey({
      userId: 'user-1',
      chatId: 'channel-1',
      profile: 'publisher',
      threadScope: THREAD_SCOPE_B,
    }),
    key,
  );
  assert.equal(
    buildChannelSuggestionDraftStorageKey({
      userId: '',
      chatId: 'channel-1',
      profile: 'publisher',
      threadScope: THREAD_SCOPE_A,
    }),
    null,
  );
});

test('restores a bounded text and photo draft with its exact retry identity', () => {
  const now = Date.parse('2026-09-01T09:00:00.000Z');
  const restored = parseChannelSuggestionDraftEnvelope(
    {
      version: 1,
      savedAt: '2026-09-01T08:59:00.000Z',
      expiresAt: '2026-09-04T08:59:00.000Z',
      text: 'Подпись к фото',
      imageCount: 1,
      threadScope: THREAD_SCOPE_A,
      requestIdentity: {
        requestId: 'publisher-suggestion_12345678',
        draftRevision: 3,
        requestRevision: 3,
      },
    },
    now,
    {
      version: 1,
      attachments: [
        {
          type: 'image',
          base64: 'aW1hZ2U=',
          mimeType: 'image/jpeg',
          fileName: 'photo.jpg',
          size: 5,
        },
      ],
    },
  );

  assert.equal(restored?.text, 'Подпись к фото');
  assert.equal(restored?.attachments[0]?.previewUrl, 'data:image/jpeg;base64,aW1hZ2U=');
  assert.equal(restored?.requestIdentity.requestId, 'publisher-suggestion_12345678');
  assert.equal(restored?.imagesNeedReselection, false);
  assert.equal(restored?.imageCount, 1);
  assert.equal(restored?.threadScope, THREAD_SCOPE_A);
});

test('keeps text but requires an explicit decision when stored photo bytes are missing', () => {
  const restored = parseChannelSuggestionDraftEnvelope(
    {
      version: 1,
      savedAt: '2026-09-01T08:59:00.000Z',
      expiresAt: '2026-09-04T08:59:00.000Z',
      text: 'Подпись к двум фото',
      imageCount: 2,
      threadScope: THREAD_SCOPE_A,
      requestIdentity: {
        requestId: null,
        draftRevision: 2,
        requestRevision: null,
      },
    },
    Date.parse('2026-09-01T09:00:00.000Z'),
    null,
  );

  assert.equal(restored?.text, 'Подпись к двум фото');
  assert.deepEqual(restored?.attachments, []);
  assert.equal(restored?.imagesNeedReselection, true);
  assert.equal(restored?.imageCount, 2);
});

test('rejects expired drafts and identities that are not bound to a revision', () => {
  const envelope = {
    version: 1,
    savedAt: '2026-08-28T08:00:00.000Z',
    expiresAt: '2026-08-31T08:00:00.000Z',
    text: 'Черновик',
    imageCount: 0,
    threadScope: THREAD_SCOPE_A,
    requestIdentity: {
      requestId: 'publisher-suggestion_12345678',
      draftRevision: 2,
      requestRevision: null,
    },
  };

  assert.equal(
    parseChannelSuggestionDraftEnvelope(envelope, Date.parse('2026-09-01T09:00:00.000Z')),
    null,
  );
  assert.equal(
    parseChannelSuggestionDraftEnvelope(
      {
        ...envelope,
        savedAt: '2026-09-01T08:00:00.000Z',
        expiresAt: '2026-09-02T08:00:00.000Z',
      },
      Date.parse('2026-09-01T09:00:00.000Z'),
    ),
    null,
  );
});

test('keeps text and photos but rotates retry identity for another post thread', () => {
  const restored = parseChannelSuggestionDraftEnvelope(
    {
      version: 1,
      savedAt: '2026-09-01T08:59:00.000Z',
      expiresAt: '2026-09-04T08:59:00.000Z',
      text: 'Содержимое нужно сохранить',
      imageCount: 1,
      threadScope: THREAD_SCOPE_A,
      requestIdentity: {
        requestId: 'publisher-suggestion_12345678',
        draftRevision: 4,
        requestRevision: 4,
      },
    },
    Date.parse('2026-09-01T09:00:00.000Z'),
    {
      version: 1,
      attachments: [
        {
          type: 'image',
          base64: 'aW1hZ2U=',
          mimeType: 'image/jpeg',
          fileName: 'photo.jpg',
          size: 5,
        },
      ],
    },
  );
  assert.ok(restored);

  const rebound = bindChannelSuggestionDraftToThread(restored, THREAD_SCOPE_B);

  assert.equal(rebound.text, restored.text);
  assert.deepEqual(rebound.attachments, restored.attachments);
  assert.equal(rebound.threadScope, THREAD_SCOPE_B);
  assert.deepEqual(rebound.requestIdentity, {
    requestId: null,
    draftRevision: 5,
    requestRevision: null,
  });
});

test('prefers complete IndexedDB media over the lightweight fallback at the same revision', () => {
  const envelope = {
    version: 1,
    savedAt: '2026-09-01T08:59:00.000Z',
    expiresAt: '2026-09-04T08:59:00.000Z',
    text: 'Текст с фото',
    imageCount: 1,
    threadScope: THREAD_SCOPE_A,
    requestIdentity: {
      requestId: 'publisher-suggestion_12345678',
      draftRevision: 2,
      requestRevision: 2,
    },
  };
  const resolved = resolveChannelSuggestionDraftLoadState({
    indexedEnvelope: envelope,
    indexedMedia: {
      version: 1,
      attachments: [
        {
          type: 'image',
          base64: 'aW1hZ2U=',
          mimeType: 'image/jpeg',
          fileName: 'photo.jpg',
          size: 5,
        },
      ],
    },
    localEnvelope: envelope,
    threadScope: THREAD_SCOPE_A,
    nowMs: Date.parse('2026-09-01T09:00:00.000Z'),
  });

  assert.equal(resolved.source, 'indexed');
  assert.equal(resolved.draft?.imagesNeedReselection, false);
  assert.equal(resolved.draft?.attachments.length, 1);
});

test('localStorage fallback preserves text and retry identity without photo bytes', async () => {
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
      indexedDB: {
        open() {
          throw new Error('IndexedDB is blocked');
        },
      },
      localStorage,
    },
  });
  const scope = {
    userId: 'fallback-user',
    chatId: 'fallback-channel',
    profile: 'publisher' as const,
    threadScope: THREAD_SCOPE_A,
  };

  try {
    await saveChannelSuggestionDraft(scope, {
      text: 'Текст переживёт отказ IndexedDB',
      attachments: [
        {
          type: 'image',
          base64: 'private-image-payload',
          mimeType: 'image/jpeg',
          fileName: 'private.jpg',
          size: 16,
          previewUrl: 'data:image/jpeg;base64,private-image-payload',
        },
      ],
      requestIdentity: {
        requestId: 'publisher-suggestion_12345678',
        draftRevision: 3,
        requestRevision: 3,
      },
      imagesNeedReselection: false,
      imageCount: 1,
    });

    const storageKey = buildChannelSuggestionDraftStorageKey(scope)!;
    const rawFallback = values.get(storageKey) ?? '';
    assert.equal(rawFallback.includes('private-image-payload'), false);
    assert.equal(rawFallback.includes('previewUrl'), false);
    assert.equal(JSON.parse(rawFallback).imageCount, 1);

    const restored = await loadChannelSuggestionDraft(scope);
    assert.equal(restored?.text, 'Текст переживёт отказ IndexedDB');
    assert.equal(restored?.requestIdentity.requestId, 'publisher-suggestion_12345678');
    assert.deepEqual(restored?.attachments, []);
    assert.equal(restored?.imagesNeedReselection, true);
    assert.equal(restored?.imageCount, 1);

    await clearChannelSuggestionDraft(scope);
    assert.equal(values.has(storageKey), false);
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    });
  }
});

test('suggestion route wires the authoritative user and protects non-empty drafts on close', () => {
  assert.match(appSource, /KeyedChannelSuggestDialogPage[\s\S]*?userId=\{me\.userId\}/u);
  assert.match(suggestionPageSource, /setMaxClosingConfirmation\(shouldProtectClose\)/u);
  assert.match(suggestionPageSource, /document\.visibilityState === 'hidden'/u);
  assert.match(suggestionPageSource, /draftImagesNeedReselection[\s\S]*?Без фото/u);
  assert.match(
    suggestionPageSource,
    /clearChannelSuggestionDraft\(\{[\s\S]*?threadScope: draftThreadScope/u,
  );
  assert.match(
    suggestionPageSource,
    /if \(!draftHydrated \|\| !userId\.trim\(\)\) \{[\s\S]*?saveChannelSuggestionDraft/u,
  );
  assert.doesNotMatch(
    suggestionPageSource,
    /if \(!terminalDialogError \|\| !userId\.trim\(\)\) \{[\s\S]*?clearChannelSuggestionDraft/u,
  );
  assert.doesNotMatch(suggestionPageSource, /saveChannelSuggestionDraft\(\{[^}]*token[,:]/u);
  assert.match(imageGridSource, /disabled=\{busy\}[\s\S]*?onClick=\{\(\) => onRemove/u);
});
