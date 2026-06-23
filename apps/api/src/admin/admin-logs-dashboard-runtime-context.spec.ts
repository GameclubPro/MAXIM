import { createAdminLogsDashboardRuntimeContext } from './admin-logs-dashboard-runtime-context';

describe('AdminLogsDashboardRuntimeContext', () => {
  it('exposes logs dashboard infrastructure through typed accessors', () => {
    const logsCache = new Map();
    const moderationCache = new Map();
    const membershipCache = new Map();
    const target = {
      prisma: { chat: {} },
      logger: { warn: jest.fn() },
      chatContextCache: { getManagedEntityHeader: jest.fn() },
      logsDashboardResponseCache: logsCache,
      moderationFeedPageCache: moderationCache,
      membershipActivityFeedPageCache: membershipCache,
      assertChatAdmin: jest.fn(),
      assertReadOnlyChatAdmin: jest.fn(),
      buildProfileMentionHandoffUrl: jest.fn(),
      ensureEntityType: jest.fn(),
      readTrimmedString: jest.fn(),
      resolveUserProfiles: jest.fn(),
      toIsoString: jest.fn(),
    };
    const context = createAdminLogsDashboardRuntimeContext(target);

    expect(context.prisma).toBe(target.prisma);
    expect(context.logger).toBe(target.logger);
    expect(context.chatContextCache).toBe(target.chatContextCache);
    expect(context.logsDashboardResponseCache).toBe(logsCache);
    expect(context.moderationFeedPageCache).toBe(moderationCache);
    expect(context.membershipActivityFeedPageCache).toBe(membershipCache);
  });

  it('delegates logs dashboard ports without losing the legacy target context', async () => {
    const target = {
      prefix: 'legacy',
      calls: [] as string[],
      prisma: { chat: {} },
      logger: { warn: jest.fn() },
      chatContextCache: { getManagedEntityHeader: jest.fn() },
      logsDashboardResponseCache: new Map(),
      moderationFeedPageCache: new Map(),
      membershipActivityFeedPageCache: new Map(),
      assertChatAdmin(chatId: string, userId: string, entityType?: string | null) {
        this.calls.push(`${this.prefix}:admin:${chatId}:${userId}:${entityType ?? 'all'}`);
        return Promise.resolve();
      },
      assertReadOnlyChatAdmin(chatId: string, userId: string, entityType?: string | null) {
        this.calls.push(`${this.prefix}:read:${chatId}:${userId}:${entityType ?? 'all'}`);
        return Promise.resolve();
      },
      buildProfileMentionHandoffUrl(
        chatId: string,
        entityType: string,
        userId: string,
        displayName: string | null,
      ) {
        return `${this.prefix}:handoff:${chatId}:${entityType}:${userId}:${displayName ?? ''}`;
      },
      ensureEntityType(chatId: string, userId: string, expectedEntityType: string) {
        this.calls.push(`${this.prefix}:entity:${chatId}:${userId}:${expectedEntityType}`);
        return Promise.resolve();
      },
      readTrimmedString(value: unknown) {
        return typeof value === 'string' && value.trim() ? `${this.prefix}:${value.trim()}` : null;
      },
      resolveUserProfiles(_chatId: string, _entityType: string, userIds: readonly string[]) {
        return Promise.resolve(
          new Map(
            userIds.map((userId) => [
              userId,
              {
                displayName: `${this.prefix}:${userId}`,
                avatarUrl: null,
                profileUrl: null,
                profileHandoffUrl: null,
              },
            ]),
          ),
        );
      },
      toIsoString(value: unknown) {
        return value instanceof Date ? `${this.prefix}:${value.toISOString()}` : null;
      },
    };
    const context = createAdminLogsDashboardRuntimeContext(target);

    await context.assertChatAdmin('chat-1', 'admin-1', 'channel');
    await context.assertReadOnlyChatAdmin('chat-1', 'admin-1', 'chat');
    await context.ensureEntityType('chat-1', 'admin-1', 'chat');

    expect(target.calls).toEqual([
      'legacy:admin:chat-1:admin-1:channel',
      'legacy:read:chat-1:admin-1:chat',
      'legacy:entity:chat-1:admin-1:chat',
    ]);
    expect(context.buildProfileMentionHandoffUrl('chat-1', 'chat', 'user-1', 'User')).toBe(
      'legacy:handoff:chat-1:chat:user-1:User',
    );
    expect(context.readTrimmedString(' value ')).toBe('legacy:value');
    await expect(context.resolveUserProfiles('chat-1', 'chat', ['user-1'])).resolves.toEqual(
      new Map([
        [
          'user-1',
          {
            displayName: 'legacy:user-1',
            avatarUrl: null,
            profileUrl: null,
            profileHandoffUrl: null,
          },
        ],
      ]),
    );
    expect(context.toIsoString(new Date('2026-06-23T00:00:00.000Z'))).toBe(
      'legacy:2026-06-23T00:00:00.000Z',
    );
  });
});
