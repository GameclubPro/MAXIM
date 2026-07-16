import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveModerationFeedReason } from '../src/lib/moderation-feed-reason';

test('shows allowlist link reason instead of only message excerpt', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'LINK_BLOCKED_DELETE',
      metadata: { reason: 'Link https://spam.example is not in allowlist' },
    }),
    'Ссылка https://spam.example не входит в разрешенный список.',
  );
});

test('shows blocked word from moderation metadata', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'MESSAGE_BLOCKED_WORD_DELETE',
      metadata: { blockedWord: 'казино', reason: 'Blocked word detected: казино' },
    }),
    'Стоп-слово: казино.',
  );
});

test('summarizes commercial ad evidence', () => {
  const reason = resolveModerationFeedReason({
    ruleCode: 'COMMERCIAL_AD_DELETE',
    metadata: {
      reason: 'Detected Russian commercial ad pattern',
      primarySubtype: 'SERVICES',
      featureVector: {
        contactEvidence: 1,
        priceStructure: 1,
      },
    },
  });

  assert.match(reason, /Коммерческая реклама запрещена/u);
  assert.match(reason, /услуги/u);
  assert.match(reason, /контакт и цена/u);
});

test('shows required subscription targets when available', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
      metadata: { missingChannelTitles: ['Новости', 'Анонсы'] },
    }),
    'Нет подписки на обязательные чаты или каналы: Новости, Анонсы.',
  );
});

test('translates message length deletion reason', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'MESSAGE_TOO_LONG_DELETE',
      metadata: { reason: 'Message length 187 exceeds limit 100' },
    }),
    'Сообщение длиннее лимита: 187 из 100 символов.',
  );
});

test('explains duplicate moderation window', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'DUPLICATE_DELETE',
      metadata: { count: 2, threshold: 2, windowSec: 12 * 60 * 60 },
    }),
    'Повтор сообщения: 2/2 за 12ч.',
  );
});

test('keeps retired topic-filter violations readable in historical events', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'TOPIC_FILTER_MISMATCH',
      metadata: { requiredCodeword: 'максим' },
    }),
    'Сообщение должно начинаться с кодового слова "максим".',
  );
});
