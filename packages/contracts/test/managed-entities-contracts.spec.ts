import { describe, expect, it } from 'vitest';

import {
  chatSummarySchema as rootChatSummarySchema,
  managedEntityHeaderSchema as rootManagedEntityHeaderSchema,
  meSchema,
  updateManagedEntityFavoriteLabelsRequestSchema as rootUpdateManagedEntityFavoriteLabelsRequestSchema,
  updateManagedEntityFavoritesRequestSchema as rootUpdateManagedEntityFavoritesRequestSchema,
} from '@maxim/contracts';
import {
  chatSummarySchema,
  managedEntityFavoriteLabelsResponseSchema,
  managedEntityHeaderSchema,
  updateManagedEntityFavoriteLabelsRequestSchema,
  updateManagedEntityFavoritesRequestSchema,
} from '@maxim/contracts/managed-entities';

describe('managed entities contract exports', () => {
  it('keeps root and subpath exports aligned', () => {
    expect(rootChatSummarySchema).toBe(chatSummarySchema);
    expect(rootManagedEntityHeaderSchema).toBe(managedEntityHeaderSchema);
    expect(rootUpdateManagedEntityFavoritesRequestSchema).toBe(
      updateManagedEntityFavoritesRequestSchema,
    );
    expect(rootUpdateManagedEntityFavoriteLabelsRequestSchema).toBe(
      updateManagedEntityFavoriteLabelsRequestSchema,
    );
  });

  it('normalizes bounded favorite labels and rejects unknown categories', () => {
    expect(
      updateManagedEntityFavoriteLabelsRequestSchema.parse({
        labels: {
          important: '  VIP   чаты  ',
          watch: 'На контроле',
        },
        expectedRevision: null,
      }),
    ).toEqual({
      labels: {
        important: 'VIP чаты',
        watch: 'На контроле',
      },
      mode: 'replace',
      expectedRevision: null,
    });
    expect(() =>
      updateManagedEntityFavoriteLabelsRequestSchema.parse({
        labels: { unknown: 'Новая категория' },
        expectedRevision: null,
      }),
    ).toThrow();
    expect(() =>
      updateManagedEntityFavoriteLabelsRequestSchema.parse({
        labels: { important: 'Очень длинное название категории избранного' },
        expectedRevision: null,
      }),
    ).toThrow();
    expect(() =>
      updateManagedEntityFavoriteLabelsRequestSchema.parse({
        labels: { important: 'VIP\u0000чаты' },
        expectedRevision: null,
      }),
    ).toThrow();
    expect(
      updateManagedEntityFavoriteLabelsRequestSchema.parse({
        labels: { important: 'a'.repeat(24) },
        expectedRevision: null,
      }).labels.important,
    ).toBe('a'.repeat(24));
    expect(() =>
      updateManagedEntityFavoriteLabelsRequestSchema.parse({
        labels: { important: 'a'.repeat(25) },
        expectedRevision: null,
      }),
    ).toThrow();
    expect(
      updateManagedEntityFavoriteLabelsRequestSchema.parse({
        labels: { important: '😀'.repeat(24) },
        expectedRevision: null,
      }).labels.important,
    ).toBe('😀'.repeat(24));
    expect(() =>
      updateManagedEntityFavoriteLabelsRequestSchema.parse({
        labels: { important: '😀'.repeat(25) },
        expectedRevision: null,
      }),
    ).toThrow();
    expect(() =>
      updateManagedEntityFavoriteLabelsRequestSchema.parse({
        labels: { important: 'VIP' },
        expectedRevision: null,
        unexpected: true,
      }),
    ).toThrow();
  });

  it('distinguishes an uninitialized server profile from an intentional default reset', () => {
    expect(
      managedEntityFavoriteLabelsResponseSchema.parse({
        initialized: false,
        labels: {},
        revision: null,
      }),
    ).toEqual({ initialized: false, labels: {}, revision: null });
    expect(
      managedEntityFavoriteLabelsResponseSchema.parse({
        initialized: true,
        labels: {},
        revision: 1,
      }),
    ).toEqual({ initialized: true, labels: {}, revision: 1 });
    expect(() =>
      managedEntityFavoriteLabelsResponseSchema.parse({
        initialized: false,
        labels: { important: 'VIP' },
        revision: null,
      }),
    ).toThrow();
    expect(() =>
      managedEntityFavoriteLabelsResponseSchema.parse({
        initialized: false,
        labels: {},
        revision: 1,
      }),
    ).toThrow();
    expect(() =>
      managedEntityFavoriteLabelsResponseSchema.parse({
        initialized: true,
        labels: {},
        revision: null,
      }),
    ).toThrow();
    expect(() =>
      managedEntityFavoriteLabelsResponseSchema.parse({
        initialized: true,
        labels: {},
        revision: 0,
      }),
    ).toThrow();
    expect(() =>
      managedEntityFavoriteLabelsResponseSchema.parse({
        initialized: true,
        labels: { important: 'VIP\u0000чаты' },
        revision: 1,
      }),
    ).toThrow();
    expect(() =>
      managedEntityFavoriteLabelsResponseSchema.parse({
        initialized: true,
        labels: {},
        revision: 1,
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      updateManagedEntityFavoriteLabelsRequestSchema.parse({
        labels: {},
        mode: 'initialize',
      }),
    ).toThrow();
    expect(
      updateManagedEntityFavoriteLabelsRequestSchema.parse({
        labels: {},
        mode: 'replace',
        expectedRevision: 3,
      }),
    ).toEqual({ labels: {}, mode: 'replace', expectedRevision: 3 });
    expect(() =>
      updateManagedEntityFavoriteLabelsRequestSchema.parse({
        labels: {},
      }),
    ).toThrow();
    expect(
      updateManagedEntityFavoriteLabelsRequestSchema.parse({
        labels: { important: 'VIP' },
        mode: 'initialize',
      }),
    ).toEqual({ labels: { important: 'VIP' }, mode: 'initialize' });
    expect(() =>
      updateManagedEntityFavoriteLabelsRequestSchema.parse({
        labels: { important: 'VIP' },
        mode: 'initialize',
        expectedRevision: null,
      }),
    ).toThrow();
    expect(() =>
      updateManagedEntityFavoriteLabelsRequestSchema.parse({
        labels: { important: 'VIP' },
        mode: 'replace',
        expectedRevision: 0,
      }),
    ).toThrow();
  });

  it('deduplicates favorite filters while preserving the submitted order', () => {
    const result = updateManagedEntityFavoritesRequestSchema.parse({
      favoriteTypes: ['broadcast', 'important', 'broadcast', 'service', 'important'],
    });

    expect(result.favoriteTypes).toEqual(['broadcast', 'important', 'service']);
  });

  it('defaults the bot dialog handoff url without weakening URL validation', () => {
    expect(
      meSchema.parse({
        userId: 'admin-1',
        username: null,
        displayName: null,
      }).botDialogUrl,
    ).toBeNull();
    expect(() =>
      meSchema.parse({
        userId: 'admin-1',
        username: null,
        displayName: null,
        botDialogUrl: 'javascript:alert(1)',
      }),
    ).toThrow();
  });

  it('keeps access-loss diagnostics public and strips private bot internals', () => {
    const result = managedEntityHeaderSchema.parse({
      id: 'chat-1',
      title: 'Рабочий чат',
      entityType: 'chat',
      link: null,
      participantsCount: null,
      accessDiagnostics: {
        state: 'bot_access_lost',
        lastDetectedAt: '2026-06-01T10:00:00.000Z',
        lastCheckedAt: null,
        freshUntil: null,
        source: 'unknown',
        activeBotCount: 2,
        lostBots: [
          {
            botId: 'bot-1',
            botLabel: 'Primary Bot',
            reason: 'bot_denied',
            detectedAt: '2026-06-01T10:00:00.000Z',
            source: 'admin_roster_sync',
            lastMaxErrorCode: 'chat.denied',
            lastMaxErrorMessage: 'Forbidden',
            lastMaxStatusCode: 403,
          },
        ],
      },
    });

    expect(result.accessDiagnostics.lostBots).toEqual([
      {
        botId: 'bot-1',
        botLabel: 'Primary Bot',
        reason: 'bot_denied',
        detectedAt: '2026-06-01T10:00:00.000Z',
      },
    ]);
  });
});
