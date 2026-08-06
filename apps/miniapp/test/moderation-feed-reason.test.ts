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

test('keeps action-suffixed delete rules normalized to their base rule', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'LINK_BLOCKED_DELETE',
      metadata: {},
    }),
    'Ссылка запрещена настройками чата.',
  );
});

test('shows the configured delay for a bot-message auto-cleanup event', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
      metadata: {
        reason: 'Bot-authored message deleted after configured delay',
        delayMinutes: 2,
      },
    }),
    'Сообщение бота удалено по настройкам автоочистки через 2 мин.',
  );
});

test('preserves standalone moderation delete rule codes', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'NIGHT_MODE_DELETE',
      metadata: {
        nightModeStartTime: '20:00',
        nightModeEndTime: '06:00',
        nightModeTimezone: 'Europe/Moscow',
      },
    }),
    'Чат закрыт по ночному режиму 20:00-06:00 (Europe/Moscow).',
  );
  assert.equal(
    resolveModerationFeedReason({ ruleCode: 'MUTE_ACTIVE_DELETE', metadata: {} }),
    'Сообщение отправлено во время активного мута участника.',
  );
  assert.equal(
    resolveModerationFeedReason({ ruleCode: 'MANUAL_GROUP_CLOSE_DELETE', metadata: {} }),
    'Группа закрыта вручную, новые сообщения временно удаляются.',
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

test('distinguishes repeated photos and albums from text', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'DUPLICATE_DELETE',
      metadata: { fingerprintType: 'image', count: 1, windowSec: 3600 },
    }),
    'Повтор фото за 1ч.',
  );
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'DUPLICATE_BAN',
      metadata: { fingerprintType: 'image_set', count: 3, threshold: 2 },
    }),
    'Повтор альбома: 3/2.',
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
