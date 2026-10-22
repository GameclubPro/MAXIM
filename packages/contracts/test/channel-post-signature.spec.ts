import { describe, expect, it } from 'vitest';
import {
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH,
  CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH,
  channelPostSignatureSettingsSchema,
  updateChannelPostSignatureRequestSchema,
} from '../src/channel-post-signature.js';

describe('channel post signature contracts', () => {
  it('keeps a fail-safe disabled default with stable link text', () => {
    expect(channelPostSignatureSettingsSchema.parse({})).toEqual({
      enabled: false,
      presentation: 'signature',
      text: CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
      url: '',
    });
  });

  it('supports a bounded full-width channel button presentation', () => {
    expect(
      channelPostSignatureSettingsSchema.parse({
        enabled: true,
        presentation: 'button',
        text: '📞 Заказать рекламу',
        url: 'https://example.test/ads',
      }),
    ).toEqual({
      enabled: true,
      presentation: 'button',
      text: '📞 Заказать рекламу',
      url: 'https://example.test/ads',
    });

    expect(() =>
      channelPostSignatureSettingsSchema.parse({
        enabled: true,
        presentation: 'button',
        text: 'x'.repeat(33),
        url: 'https://example.test/ads',
      }),
    ).toThrow();
  });

  it('trims saved text and rejects empty or oversized labels', () => {
    expect(
      updateChannelPostSignatureRequestSchema.parse({
        expectedRevision: 3,
        text: '  Читать канал  ',
      }),
    ).toEqual({
      expectedRevision: 3,
      text: 'Читать канал',
    });
    expect(
      updateChannelPostSignatureRequestSchema.safeParse({ expectedRevision: 3, text: '   ' })
        .success,
    ).toBe(false);
    expect(
      updateChannelPostSignatureRequestSchema.safeParse({
        expectedRevision: 3,
        text: 'a'.repeat(CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('normalizes an explicit HTTP(S) destination and allows clearing it', () => {
    expect(
      updateChannelPostSignatureRequestSchema.parse({
        expectedRevision: 3,
        url: '  HTTP://MAX.RU/advertising/../contact?from=channel  ',
      }),
    ).toEqual({ expectedRevision: 3, url: 'http://max.ru/contact?from=channel' });
    expect(
      updateChannelPostSignatureRequestSchema.parse({ expectedRevision: 3, url: '   ' }),
    ).toEqual({ expectedRevision: 3, url: '' });
  });

  it.each([
    'max://user/admin-1',
    'javascript:alert(1)',
    'https://admin:secret@max.ru/contact',
    'https://max.ru/contact https://example.test',
    `https://max.ru/${'a'.repeat(CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH)}`,
  ])('rejects an unsafe or oversized explicit destination %s', (url) => {
    expect(
      updateChannelPostSignatureRequestSchema.safeParse({ expectedRevision: 3, url }).success,
    ).toBe(false);
  });

  it('requires at least one field in a partial update', () => {
    expect(updateChannelPostSignatureRequestSchema.safeParse({}).success).toBe(false);
    expect(updateChannelPostSignatureRequestSchema.safeParse({ enabled: true }).success).toBe(
      false,
    );
    expect(updateChannelPostSignatureRequestSchema.safeParse({ expectedRevision: 3 }).success).toBe(
      false,
    );
    expect(
      updateChannelPostSignatureRequestSchema.parse({ expectedRevision: 3, enabled: true }),
    ).toEqual({
      expectedRevision: 3,
      enabled: true,
    });
  });
});
