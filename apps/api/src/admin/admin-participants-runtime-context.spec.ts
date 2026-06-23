import { createAdminParticipantsRuntimeContext } from './admin-participants-runtime-context';

describe('AdminParticipantsRuntimeContext', () => {
  it('exposes participants infrastructure through typed accessors', () => {
    const cache = new Map();
    const target = {
      prisma: { chatSettings: {} },
      maxClient: { getChatMembersPage: jest.fn() },
      logger: { warn: jest.fn(), log: jest.fn() },
      chatParticipantsPageCache: cache,
      assertReadOnlyChatAdmin: jest.fn(),
      buildParticipantViolationCountWhere: jest.fn(),
      buildProfileMentionHandoffUrl: jest.fn(),
      buildUserProfileUrl: jest.fn(),
      ensureEntityType: jest.fn(),
      getManagedEntityHeader: jest.fn(),
      normalizeMaxProfileUrl: jest.fn(),
      prepareManualModerationTarget: jest.fn(),
      readTrimmedString: jest.fn(),
      resolveBackgroundReadBotAssignment: jest.fn(),
      resolveLogsDashboardFrom: jest.fn(),
      toSafeInteger: jest.fn(),
    };
    const context = createAdminParticipantsRuntimeContext(target);

    expect(context.prisma).toBe(target.prisma);
    expect(context.maxClient).toBe(target.maxClient);
    expect(context.logger).toBe(target.logger);
    expect(context.chatParticipantsPageCache).toBe(cache);
  });

  it('delegates participants ports without losing the legacy target context', async () => {
    const user = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };
    const target = {
      prefix: 'legacy',
      calls: [] as string[],
      prisma: { chatSettings: {} },
      maxClient: { getChatMembersPage: jest.fn() },
      logger: { warn: jest.fn(), log: jest.fn() },
      chatParticipantsPageCache: new Map(),
      assertReadOnlyChatAdmin(chatId: string, userId: string, entityType?: string | null) {
        this.calls.push(`${this.prefix}:read:${chatId}:${userId}:${entityType ?? 'all'}`);
        return Promise.resolve();
      },
      buildParticipantViolationCountWhere(
        chatId: string,
        userIds: readonly string[],
        from: Date,
        to: Date,
      ) {
        return {
          chatId: `${this.prefix}:${chatId}`,
          userId: { in: userIds.map((userId) => `${this.prefix}:${userId}`) },
          createdAt: { gte: from, lte: to },
        };
      },
      buildProfileMentionHandoffUrl(
        chatId: string,
        entityType: string,
        userId: string,
        displayName: string | null,
      ) {
        return `${this.prefix}:handoff:${chatId}:${entityType}:${userId}:${displayName ?? ''}`;
      },
      buildUserProfileUrl(username: string | null) {
        return username ? `${this.prefix}:profile:${username}` : null;
      },
      ensureEntityType(chatId: string, userId: string, expectedEntityType: string) {
        this.calls.push(`${this.prefix}:entity:${chatId}:${userId}:${expectedEntityType}`);
        return Promise.resolve();
      },
      getManagedEntityHeader(chatId: string) {
        return Promise.resolve({
          id: chatId,
          title: `${this.prefix}:${chatId}`,
          entityType: 'chat',
          participantsCount: 7,
        });
      },
      normalizeMaxProfileUrl(value: string | null) {
        return value ? `${this.prefix}:normalized:${value}` : null;
      },
      prepareManualModerationTarget(chatId: string, targetUserIdRaw: string) {
        return Promise.resolve(`${this.prefix}:target:${chatId}:${targetUserIdRaw.trim()}`);
      },
      readTrimmedString(value: unknown) {
        return typeof value === 'string' && value.trim() ? `${this.prefix}:${value.trim()}` : null;
      },
      resolveBackgroundReadBotAssignment(chatId: string) {
        return Promise.resolve(`${this.prefix}:bot:${chatId}`);
      },
      resolveLogsDashboardFrom(_range: string, to: Date) {
        return new Date(to.getTime() - 1000);
      },
      toSafeInteger(value: unknown) {
        return typeof value === 'number' ? Math.trunc(value) + this.prefix.length : 0;
      },
    };
    const context = createAdminParticipantsRuntimeContext(target);
    const now = new Date('2026-06-23T00:00:00.000Z');

    await context.assertReadOnlyChatAdmin('chat-1', 'admin-1', 'chat');
    await context.ensureEntityType('chat-1', 'admin-1', 'chat');

    expect(target.calls).toEqual([
      'legacy:read:chat-1:admin-1:chat',
      'legacy:entity:chat-1:admin-1:chat',
    ]);
    expect(
      context.buildParticipantViolationCountWhere('chat-1', ['user-1'], now, now),
    ).toMatchObject({
      chatId: 'legacy:chat-1',
      userId: { in: ['legacy:user-1'] },
    });
    expect(context.buildProfileMentionHandoffUrl('chat-1', 'chat', 'user-1', 'User')).toBe(
      'legacy:handoff:chat-1:chat:user-1:User',
    );
    expect(context.buildUserProfileUrl('username')).toBe('legacy:profile:username');
    await expect(context.getManagedEntityHeader('chat-1', user, 'chat')).resolves.toMatchObject({
      title: 'legacy:chat-1',
      participantsCount: 7,
    });
    expect(context.normalizeMaxProfileUrl('https://max.ru/u')).toBe(
      'legacy:normalized:https://max.ru/u',
    );
    await expect(context.prepareManualModerationTarget('chat-1', ' user-1 ', user)).resolves.toBe(
      'legacy:target:chat-1:user-1',
    );
    expect(context.readTrimmedString(' value ')).toBe('legacy:value');
    await expect(context.resolveBackgroundReadBotAssignment('chat-1')).resolves.toBe(
      'legacy:bot:chat-1',
    );
    expect(context.resolveLogsDashboardFrom('24h', now)).toEqual(
      new Date('2026-06-22T23:59:59.000Z'),
    );
    expect(context.toSafeInteger(10.8)).toBe(16);
  });
});
