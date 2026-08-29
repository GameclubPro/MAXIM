import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS,
  MAX_PUBLISHER_AUTO_REPLY_BUTTONS,
  MAX_PUBLISHER_AUTO_REPLY_IMAGES,
  createPublisherAutoReplyRequestSchema,
  normalizePublisherAutoReplyPhrase,
  publisherAutoReplyContentInputSchema,
  publisherAutoReplyRuleSchema,
  updatePublisherAutoReplyRequestSchema,
} from '@maxim/contracts/publisher-auto-replies';

describe('publisher auto-reply contracts', () => {
  it('normalizes exact phrases with NFKC, Russian casing, and collapsed whitespace', () => {
    expect(normalizePublisherAutoReplyPhrase('  ПРАЙС\n\tНа  Сегодня  ')).toBe('прайс на сегодня');
    expect(normalizePublisherAutoReplyPhrase('ＦＡＱ')).toBe('faq');
    expect(normalizePublisherAutoReplyPhrase('İ')).toBe('i\u0307');
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
  });
});
