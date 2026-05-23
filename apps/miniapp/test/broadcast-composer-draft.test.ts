import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isBroadcastComposerDraftEmpty,
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
