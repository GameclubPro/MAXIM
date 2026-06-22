import {
  chatSummarySchema as rootChatSummarySchema,
  managedEntityHeaderSchema as rootManagedEntityHeaderSchema,
  updateManagedEntityFavoritesRequestSchema as rootUpdateManagedEntityFavoritesRequestSchema,
} from '@maxim/contracts';
import {
  chatSummarySchema,
  managedEntityHeaderSchema,
  updateManagedEntityFavoritesRequestSchema,
} from '@maxim/contracts/managed-entities';

describe('managed entities contract exports', () => {
  it('keeps root and subpath exports aligned', () => {
    expect(rootChatSummarySchema).toBe(chatSummarySchema);
    expect(rootManagedEntityHeaderSchema).toBe(managedEntityHeaderSchema);
    expect(rootUpdateManagedEntityFavoritesRequestSchema).toBe(
      updateManagedEntityFavoritesRequestSchema,
    );
  });

  it('deduplicates favorite filters while preserving the submitted order', () => {
    const result = updateManagedEntityFavoritesRequestSchema.parse({
      favoriteTypes: ['broadcast', 'important', 'broadcast', 'service', 'important'],
    });

    expect(result.favoriteTypes).toEqual(['broadcast', 'important', 'service']);
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
        reason: 'bot_denied',
        detectedAt: '2026-06-01T10:00:00.000Z',
      },
    ]);
  });
});
