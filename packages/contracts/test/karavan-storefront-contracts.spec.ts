import { describe, expect, it } from 'vitest';

import {
  karavanStorefrontAllowlistQuerySchema,
  karavanStorefrontAllowlistResponseSchema,
  karavanStorefrontAllowlistRevokeResponseSchema,
  karavanStorefrontDurationSchema,
  karavanStorefrontHandoffResponseSchema,
} from '@maxim/contracts/karavan-storefront';
import { chatSettingsSchema } from '@maxim/contracts';

describe('Karavan storefront contracts', () => {
  it('defaults the admin-only setting to false', () => {
    expect(chatSettingsSchema.parse({})).toEqual(
      expect.objectContaining({
        karavanStorefrontEnabled: true,
        karavanStorefrontAdminsOnly: false,
      }),
    );
  });

  it('accepts exactly the supported grant durations', () => {
    for (const duration of ['1d', '7d', '30d', '90d', 'forever']) {
      expect(karavanStorefrontDurationSchema.parse(duration)).toBe(duration);
    }
    expect(karavanStorefrontDurationSchema.safeParse('365d').success).toBe(false);
  });

  it('validates a paginated allowlist response and keeps expiry nullable', () => {
    const entry = {
      id: 'grant-1',
      chatId: 'chat-1',
      userId: 'user-1',
      displayName: 'Иван',
      expiresAt: null,
      createdByUserId: 'admin-1',
      sourceMessageId: 'message-1',
      createdAt: '2026-08-24T09:00:00.000Z',
      updatedAt: '2026-08-24T09:00:00.000Z',
    };

    expect(
      karavanStorefrontAllowlistResponseSchema.parse({
        items: [entry],
        hasMore: false,
        nextCursor: null,
      }),
    ).toEqual({
      items: [entry],
      hasMore: false,
      nextCursor: null,
    });
    expect(
      karavanStorefrontAllowlistResponseSchema.safeParse({
        items: [{ ...entry, expiresAt: 'not-a-date' }],
        hasMore: false,
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      karavanStorefrontAllowlistResponseSchema.parse({
        entries: [entry],
        nextCursor: 'next-entry',
      }),
    ).toEqual({
      items: [entry],
      hasMore: true,
      nextCursor: 'next-entry',
    });
  });

  it('normalizes bounded list query defaults and validates the bot handoff URL', () => {
    expect(karavanStorefrontAllowlistQuerySchema.parse({})).toEqual({
      limit: 50,
      includeExpired: false,
    });
    expect(karavanStorefrontAllowlistQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(
      karavanStorefrontHandoffResponseSchema.parse({
        botUrl: 'https://max.ru/major_bot?start=ks-abc',
      }),
    ).toEqual({ botUrl: 'https://max.ru/major_bot?start=ks-abc' });
    expect(
      karavanStorefrontHandoffResponseSchema.safeParse({ botUrl: 'javascript:alert(1)' }).success,
    ).toBe(false);
    expect(karavanStorefrontAllowlistRevokeResponseSchema.parse({ revoked: true })).toEqual({
      revoked: true,
    });
    expect(
      karavanStorefrontAllowlistRevokeResponseSchema.parse({ ok: true, message: 'Удалено' }),
    ).toEqual({ ok: true, message: 'Удалено' });
  });
});
