import assert from 'node:assert/strict';
import test from 'node:test';
import { getAutoReplyDraftStorageKey } from '../src/lib/auto-reply-draft';
import { buildPublisherAutoRepliesRoute } from '../src/pages/publisher-entity-modules-page-model';
import {
  AUTO_REPLY_PHRASE_MAX_LENGTH,
  createEmptyAutoReplyDraft,
  getAutoReplyAuthoringStateLabel,
  isActiveAutoReplyAuthoringState,
  normalizeAutoReplyPhrase,
  validateAutoReplyDraft,
} from '../src/pages/publisher-auto-replies-page-model';

test('auto-reply phrases preserve display case while normalizing unicode whitespace', () => {
  assert.equal(normalizeAutoReplyPhrase('  ПРАЙС\n\tдля  VIP  '), 'ПРАЙС для VIP');
  assert.equal(normalizeAutoReplyPhrase('ＰＲＩＣＥ'), 'PRICE');
  assert.equal(AUTO_REPLY_PHRASE_MAX_LENGTH, 80);
});

test('auto-reply draft requires an exact phrase and text or an image', () => {
  const empty = createEmptyAutoReplyDraft();
  assert.deepEqual(validateAutoReplyDraft(empty), {
    phrase: 'Введите кодовую фразу.',
    content: 'Добавьте текст или хотя бы одно фото.',
  });

  assert.deepEqual(validateAutoReplyDraft({ ...empty, phrase: 'Прайс', text: '**Ответ**' }), {});
  assert.deepEqual(
    validateAutoReplyDraft({
      ...empty,
      phrase: 'Фото',
      retainedAssets: [{ id: 'asset-1', mimeType: 'image/jpeg', fileName: 'photo.jpg' }],
    }),
    {},
  );
});

test('auto-reply routes and draft keys remain scoped and encoded', () => {
  assert.equal(
    buildPublisherAutoRepliesRoute('chat/with?symbols'),
    '/publisher/chat/chat%2Fwith%3Fsymbols/auto-replies',
  );
  assert.notEqual(
    getAutoReplyDraftStorageKey('chat-1', 'rule-1'),
    getAutoReplyDraftStorageKey('chat-1', 'rule-2'),
  );
  assert.notEqual(
    getAutoReplyDraftStorageKey('chat-1', null),
    getAutoReplyDraftStorageKey('chat-2', null),
  );
});

test('bot authoring polls only active states and presents the next expected step', () => {
  assert.equal(isActiveAutoReplyAuthoringState('awaiting_phrase'), true);
  assert.equal(isActiveAutoReplyAuthoringState('review'), true);
  assert.equal(isActiveAutoReplyAuthoringState('completed'), false);
  assert.equal(isActiveAutoReplyAuthoringState('canceled'), false);
  assert.equal(getAutoReplyAuthoringStateLabel('awaiting_content'), 'Публик ждёт текст или фото');
});
