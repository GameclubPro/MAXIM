import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearBroadcastComposerDraft,
  hasAppliedBroadcastComposerReset,
  isBroadcastComposerDraftEmpty,
  loadBroadcastComposerDraft,
  markBroadcastComposerResetApplied,
  saveBroadcastComposerDraft,
  type BroadcastComposerDraft,
} from '../src/lib/broadcast-composer-draft';
import { createDefaultBroadcastCycleDraft } from '../src/lib/broadcast-schedule';

function createDraft(overrides: Partial<BroadcastComposerDraft> = {}): BroadcastComposerDraft {
  return {
    text: '',
    targetMode: 'current',
    targetChatIds: ['channel-1'],
    lastScopedTargetMode: 'current',
    buttons: [],
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    images: [],
    timingMode: 'now',
    scheduledSlots: [],
    scheduleTimezone: 'Europe/Moscow',
    cycle: createDefaultBroadcastCycleDraft(Date.parse('2026-05-06T10:00:00.000Z')),
    ...overrides,
  };
}

test('treats empty now and scheduled drafts as removable storage noise', () => {
  assert.equal(isBroadcastComposerDraftEmpty(createDraft()), true);
  assert.equal(isBroadcastComposerDraftEmpty(createDraft({ timingMode: 'scheduled' })), true);
});

test('keeps drafts with actual content, buttons, media, calendar slots, or cycles', () => {
  assert.equal(isBroadcastComposerDraftEmpty(createDraft({ text: 'Пост' })), false);
  assert.equal(
    isBroadcastComposerDraftEmpty(createDraft({ buttons: [{ text: '', url: 'https://max.ru' }] })),
    false,
  );
  assert.equal(isBroadcastComposerDraftEmpty(createDraft({ imageEnabled: true })), false);
  assert.equal(
    isBroadcastComposerDraftEmpty(
      createDraft({ timingMode: 'scheduled', scheduledSlots: ['2026-05-06T11:00:00.000Z'] }),
    ),
    false,
  );
  assert.equal(isBroadcastComposerDraftEmpty(createDraft({ timingMode: 'cycle' })), false);
});

test('clears chat broadcast composer local draft and tracks reset acknowledgement', async () => {
  const store = new Map<string, string>();
  const previousWindow = globalThis.window;
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };

  Object.defineProperty(globalThis, 'window', {
    value: { localStorage },
    configurable: true,
  });

  try {
    const entityId = '-71580425805146';
    const draftKey = `maxim:broadcast-composer:chat:${entityId}`;
    const resetAt = '2026-06-13T14:30:00.000Z';
    store.set(draftKey, JSON.stringify({ version: 1, draft: createDraft({ text: 'Старый пост' }) }));

    assert.equal(store.has(draftKey), true);
    assert.equal(hasAppliedBroadcastComposerReset('chat', entityId, resetAt), false);

    await clearBroadcastComposerDraft('chat', entityId);
    markBroadcastComposerResetApplied('chat', entityId, resetAt);

    assert.equal(store.has(draftKey), false);
    assert.equal(hasAppliedBroadcastComposerReset('chat', entityId, resetAt), true);
  } finally {
    Object.defineProperty(globalThis, 'window', {
      value: previousWindow,
      configurable: true,
    });
  }
});

test('drops saved draft images while preserving text content', () => {
  const store = new Map<string, string>();
  const previousWindow = globalThis.window;
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };

  Object.defineProperty(globalThis, 'window', {
    value: { localStorage },
    configurable: true,
  });

  try {
    const entityId = '-71580425805146';
    const draftKey = `maxim:broadcast-composer:chat:${entityId}`;
    store.set(
      draftKey,
      JSON.stringify({
        version: 1,
        draft: createDraft({
          text: 'Текст без зависшей картинки',
          images: [
            { base64: 'photo-1', mimeType: 'image/jpeg', fileName: 'one.jpg' },
            { base64: 'photo-1', mimeType: 'image/jpeg', fileName: 'copy.jpg' },
          ],
        }),
      }),
    );

    const draft = loadBroadcastComposerDraft('chat', entityId);

    assert.equal(draft?.text, 'Текст без зависшей картинки');
    assert.equal(draft?.images.length, 0);
    assert.equal(draft?.imageEnabled, false);
    assert.equal(draft?.imageBase64, '');
  } finally {
    Object.defineProperty(globalThis, 'window', {
      value: previousWindow,
      configurable: true,
    });
  }
});

test('saves broadcast drafts without local image payloads', () => {
  const store = new Map<string, string>();
  const previousWindow = globalThis.window;
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };

  Object.defineProperty(globalThis, 'window', {
    value: { localStorage },
    configurable: true,
  });

  try {
    const entityId = '-71580425805146';
    saveBroadcastComposerDraft(
      'chat',
      entityId,
      createDraft({
        text: 'Текст сохраняется',
        imageEnabled: true,
        imageBase64: 'photo-1',
        imageMimeType: 'image/jpeg',
        imageFileName: 'one.jpg',
        images: [{ base64: 'photo-1', mimeType: 'image/jpeg', fileName: 'one.jpg' }],
      }),
    );

    const draft = loadBroadcastComposerDraft('chat', entityId);

    assert.equal(draft?.text, 'Текст сохраняется');
    assert.equal(draft?.images.length, 0);
    assert.equal(draft?.imageEnabled, false);
    assert.equal(draft?.imageBase64, '');
  } finally {
    Object.defineProperty(globalThis, 'window', {
      value: previousWindow,
      configurable: true,
    });
  }
});

test('removes image-only local broadcast drafts', () => {
  const store = new Map<string, string>();
  const previousWindow = globalThis.window;
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };

  Object.defineProperty(globalThis, 'window', {
    value: { localStorage },
    configurable: true,
  });

  try {
    const entityId = '-71580425805146';
    const draftKey = `maxim:broadcast-composer:chat:${entityId}`;
    store.set(draftKey, JSON.stringify({ version: 1, draft: createDraft({ text: 'old' }) }));

    saveBroadcastComposerDraft(
      'chat',
      entityId,
      createDraft({
        imageEnabled: true,
        imageBase64: 'photo-1',
        imageMimeType: 'image/jpeg',
        imageFileName: 'one.jpg',
        images: [{ base64: 'photo-1', mimeType: 'image/jpeg', fileName: 'one.jpg' }],
      }),
    );

    assert.equal(store.has(draftKey), false);
  } finally {
    Object.defineProperty(globalThis, 'window', {
      value: previousWindow,
      configurable: true,
    });
  }
});
