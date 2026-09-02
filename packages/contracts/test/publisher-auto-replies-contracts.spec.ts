import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS,
  MAX_PUBLISHER_AUTO_REPLY_BUTTONS,
  MAX_PUBLISHER_AUTO_REPLY_IMAGES,
  MAX_PUBLISHER_AUTO_REPLY_PHRASES,
  MAX_PUBLISHER_AUTO_REPLY_PREVIEW_MESSAGE_LENGTH,
  createPublisherAutoReplyV2RequestSchema,
  createPublisherAutoReplyRequestSchema,
  normalizePublisherAutoReplyPhrase,
  publisherAutoReplyContentInputSchema,
  publisherAutoReplyPreviewRequestSchema,
  publisherAutoReplyPreviewResponseSchema,
  publisherAutoReplyPhraseSchema,
  publisherAutoReplyRuleSchema,
  publisherAutoReplyRuleV2Schema,
  updatePublisherAutoReplyV2RequestSchema,
  updatePublisherAutoReplyRequestSchema,
} from '@maxim/contracts/publisher-auto-replies';

describe('publisher auto-reply contracts', () => {
  it('normalizes exact phrases with NFKC, Russian casing, and collapsed whitespace', () => {
    expect(normalizePublisherAutoReplyPhrase('  ПРАЙС\n\tНа  Сегодня  ')).toBe('прайс на сегодня');
    expect(normalizePublisherAutoReplyPhrase('ＦＡＱ')).toBe('faq');
    expect(normalizePublisherAutoReplyPhrase('İ')).toBe('i\u0307');
    expect(publisherAutoReplyPhraseSchema.safeParse('İ'.repeat(80)).success).toBe(false);
  });

  it('defaults enabled rules to the bounded product cooldown', () => {
    const request = createPublisherAutoReplyRequestSchema.parse({
      requestId: 'request_12345',
      phrase: '  ПРАЙС   ',
      content: { text: '**Ответ**', textFormat: 'markdown' },
    });

    expect(request).toMatchObject({
      phrase: 'ПРАЙС',
      enabled: true,
      cooldownSeconds: DEFAULT_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS,
      content: { images: [], buttons: [] },
    });
  });

  it('accepts up to eight publication-compatible link buttons', () => {
    const buttons = Array.from({ length: MAX_PUBLISHER_AUTO_REPLY_BUTTONS }, (_, index) => ({
      text: `Кнопка ${index + 1}`,
      url: `https://example.com/${index + 1}`,
      row: index,
    }));

    expect(publisherAutoReplyContentInputSchema.safeParse({ text: 'Ответ', buttons }).success).toBe(
      true,
    );
    expect(
      publisherAutoReplyContentInputSchema.safeParse({
        text: 'Ответ',
        buttons: [...buttons, { text: 'Лишняя', url: 'https://example.com/extra', row: 8 }],
      }).success,
    ).toBe(false);
    expect(
      publisherAutoReplyContentInputSchema.safeParse({
        text: 'Ответ',
        buttons: [{ text: 'Опасная', url: 'javascript:alert(1)', row: 0 }],
      }).success,
    ).toBe(false);
    expect(
      publisherAutoReplyContentInputSchema.safeParse({
        text: 'Ответ',
        buttons: [{ text: 'Чужой профиль', url: 'https://max.ru/bot?start=pmh-secret', row: 0 }],
      }).success,
    ).toBe(false);
  });

  it('accepts text, images, or both but rejects empty and oversized image sets', () => {
    expect(publisherAutoReplyContentInputSchema.safeParse({ text: 'Ответ' }).success).toBe(true);
    expect(
      publisherAutoReplyContentInputSchema.safeParse({
        images: [{ type: 'image-ref', assetId: 'asset-1' }],
      }).success,
    ).toBe(true);
    expect(publisherAutoReplyContentInputSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(
      publisherAutoReplyContentInputSchema.safeParse({
        text: '',
        images: Array.from({ length: MAX_PUBLISHER_AUTO_REPLY_IMAGES + 1 }, (_, index) => ({
          type: 'image-ref',
          assetId: `asset-${index}`,
        })),
      }).success,
    ).toBe(false);
  });

  it('requires optimistic versioning and at least one update', () => {
    expect(
      updatePublisherAutoReplyRequestSchema.safeParse({
        requestId: 'request_12345',
        expectedVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      updatePublisherAutoReplyRequestSchema.safeParse({
        requestId: 'request_12345',
        expectedVersion: 2,
        enabled: false,
      }).success,
    ).toBe(true);
  });

  it('normalizes bounded v2 phrase lists and keeps matching modes off by default', () => {
    const request = createPublisherAutoReplyV2RequestSchema.parse({
      requestId: 'request_v2_12345',
      phrases: ['  ПРАЙС  ', ' ЦЕНА\nСЕГОДНЯ '],
      content: { text: 'Ответ' },
    });

    expect(request).toMatchObject({
      phrases: ['ПРАЙС', 'ЦЕНА СЕГОДНЯ'],
      matchInContext: false,
      fuzzyMatch: false,
    });
    expect(
      createPublisherAutoReplyV2RequestSchema.safeParse({
        requestId: 'request_v2_12346',
        phrases: Array.from(
          { length: MAX_PUBLISHER_AUTO_REPLY_PHRASES + 1 },
          (_, index) => `Фраза ${index}`,
        ),
        content: { text: 'Ответ' },
      }).success,
    ).toBe(false);
  });

  it('rejects normalized duplicate, expanded, and oversized-total v2 phrases', () => {
    const base = { requestId: 'request_v2_12345', content: { text: 'Ответ' } };

    expect(
      createPublisherAutoReplyV2RequestSchema.safeParse({
        ...base,
        phrases: [' ПРАЙС ', 'прайс'],
      }).success,
    ).toBe(false);
    expect(
      createPublisherAutoReplyV2RequestSchema.safeParse({
        ...base,
        phrases: ['İ'.repeat(80)],
      }).success,
    ).toBe(false);
    expect(
      createPublisherAutoReplyV2RequestSchema.safeParse({
        ...base,
        phrases: ['а', 'б', 'в', 'г', 'д', 'е'].map((letter) => letter.repeat(70)),
      }).success,
    ).toBe(false);
  });

  it('requires at least one v2 update and accepts independent matching toggles', () => {
    expect(
      updatePublisherAutoReplyV2RequestSchema.safeParse({
        requestId: 'request_v2_12345',
        expectedVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      updatePublisherAutoReplyV2RequestSchema.parse({
        requestId: 'request_v2_12345',
        expectedVersion: 2,
        matchInContext: true,
      }),
    ).toMatchObject({ matchInContext: true });
  });

  it('bounds preview input and validates explicit match provenance', () => {
    expect(
      publisherAutoReplyPreviewRequestSchema.safeParse({
        message: 'x'.repeat(MAX_PUBLISHER_AUTO_REPLY_PREVIEW_MESSAGE_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      publisherAutoReplyPreviewRequestSchema.parse({
        message: 'Подскажите прайс',
        draft: {
          phrases: [' ПРАЙС '],
          matchInContext: true,
          fuzzyMatch: false,
        },
      }).draft,
    ).toEqual({
      phrases: ['ПРАЙС'],
      matchInContext: true,
      fuzzyMatch: false,
      enabled: true,
    });
    expect(
      publisherAutoReplyPreviewRequestSchema.parse({
        message: 'Подскажите прайс',
        draft: {
          phrases: ['Прайс'],
          matchInContext: false,
          fuzzyMatch: false,
          enabled: false,
        },
      }).draft?.enabled,
    ).toBe(false);
    expect(
      publisherAutoReplyPreviewResponseSchema.parse({
        outcome: 'matched',
        selected: {
          ruleId: null,
          phrase: 'Прайс',
          matchKind: 'exact_context',
          distance: 0,
          matchedDraft: true,
        },
      }),
    ).toMatchObject({ outcome: 'matched', selected: { matchedDraft: true } });
    expect(
      publisherAutoReplyPreviewResponseSchema.safeParse({
        outcome: 'no_match',
        selected: null,
        debugText: 'not public',
      }).success,
    ).toBe(false);
    expect(
      publisherAutoReplyPreviewResponseSchema.safeParse({
        outcome: 'matched',
        selected: null,
      }).success,
    ).toBe(false);
    expect(
      publisherAutoReplyPreviewResponseSchema.safeParse({
        outcome: 'ambiguous',
        selected: {
          ruleId: 'rule-1',
          phrase: 'Прайс',
          matchKind: 'exact_full',
          distance: 0,
          matchedDraft: false,
        },
      }).success,
    ).toBe(false);
    expect(
      publisherAutoReplyPreviewResponseSchema.safeParse({
        outcome: 'matched',
        selected: {
          ruleId: 'rule-1',
          phrase: 'Прайс',
          matchKind: 'exact_full',
          distance: 0,
          matchedDraft: true,
        },
      }).success,
    ).toBe(false);
  });

  it('keeps normalized phrases and delivery internals out of public rules', () => {
    const rule = {
      id: 'rule-1',
      chatId: 'chat-1',
      phrase: 'Прайс',
      enabled: true,
      cooldownSeconds: 30,
      version: 1,
      currentContentRevisionId: 'content-1',
      content: {
        id: 'content-1',
        revision: 1,
        text: 'Ответ',
        textFormat: 'plain',
        images: [],
        buttons: [],
        createdAt: '2026-08-29T10:00:00.000Z',
      },
      createdByUserId: 'admin-1',
      updatedByUserId: 'admin-1',
      createdAt: '2026-08-29T10:00:00.000Z',
      updatedAt: '2026-08-29T10:00:00.000Z',
      archivedAt: null,
    };

    expect(publisherAutoReplyRuleSchema.parse(rule)).toEqual(rule);
    expect(
      publisherAutoReplyRuleSchema.safeParse({ ...rule, normalizedPhrase: 'прайс' }).success,
    ).toBe(false);
    expect(
      publisherAutoReplyRuleSchema.safeParse({
        ...rule,
        phrases: ['Прайс'],
        matchInContext: false,
        fuzzyMatch: false,
      }).success,
    ).toBe(false);

    const { phrase: _legacyPhrase, ...v2RuleBase } = rule;
    void _legacyPhrase;
    expect(
      publisherAutoReplyRuleV2Schema.parse({
        ...v2RuleBase,
        phrases: ['Прайс', 'Стоимость'],
        matchInContext: true,
        fuzzyMatch: false,
      }),
    ).toMatchObject({ phrases: ['Прайс', 'Стоимость'], matchInContext: true });
  });
});
