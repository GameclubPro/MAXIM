import { createAdminManagedEntitiesRuntimeContext } from './admin-managed-entities-runtime-context';

describe('AdminManagedEntitiesRuntimeContext', () => {
  it('exposes managed entities infrastructure through typed accessors', () => {
    const target = {
      prisma: { chat: {} },
      chatContextCache: { getManagedEntityHeader: jest.fn() },
      maxClient: { getOwnProfile: jest.fn() },
      logger: { warn: jest.fn() },
      maxBotRegistry: { getAllBots: jest.fn() },
      assertChatAdmin: jest.fn(),
      assertReadOnlyChatAdmin: jest.fn(),
      attachManagedEntityFavoriteTypes: jest.fn(),
      attachManagedEntityFavoriteTypesToDiff: jest.fn(),
      collectManagedEntitiesForMassAction: jest.fn(),
      createManagedEntitiesRefreshState: jest.fn(),
      ensureEntityType: jest.fn(),
      isManagedEntityRuntimeBotId: jest.fn(),
      listManagedEntitiesDetailed: jest.fn(),
      readTrimmedString: jest.fn(),
      resolveBackgroundReadBotAssignment: jest.fn(),
      runManagedEntitiesBoundedRefreshJob: jest.fn(),
      runManagedEntitiesRemoteFullRefresh: jest.fn(),
    };
    const context = createAdminManagedEntitiesRuntimeContext(target);

    expect(context.prisma).toBe(target.prisma);
    expect(context.chatContextCache).toBe(target.chatContextCache);
    expect(context.maxClient).toBe(target.maxClient);
    expect(context.logger).toBe(target.logger);
    expect(context.maxBotRegistry).toBe(target.maxBotRegistry);
  });

  it('delegates managed entities ports without losing the legacy target context', async () => {
    const user = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };
    const target = {
      prefix: 'legacy',
      adminCalls: [] as string[],
      prisma: { chat: {} },
      chatContextCache: { getManagedEntityHeader: jest.fn() },
      maxClient: { getOwnProfile: jest.fn() },
      logger: { warn: jest.fn() },
      readTrimmedString(value: unknown): string | null {
        return typeof value === 'string' && value.trim() ? `${this.prefix}:${value.trim()}` : null;
      },
      assertChatAdmin(
        chatId: string,
        userId: string,
        entityType?: string | null,
      ): Promise<void> {
        this.adminCalls.push(`${this.readTrimmedString(chatId)}:${userId}:${entityType ?? 'all'}`);
        return Promise.resolve();
      },
      assertReadOnlyChatAdmin(chatId: string, userId: string): Promise<void> {
        this.adminCalls.push(`read:${this.readTrimmedString(chatId)}:${userId}`);
        return Promise.resolve();
      },
      attachManagedEntityFavoriteTypes(userId: string, items: ReadonlyArray<{ id: string }>) {
        return Promise.resolve(items.map((item) => ({ ...item, title: `${this.prefix}:${userId}` })));
      },
      attachManagedEntityFavoriteTypesToDiff(_userId: string, diff: { mode: string } | null) {
        return Promise.resolve(diff ? { ...diff, marker: this.prefix } : diff);
      },
      collectManagedEntitiesForMassAction(
        authUser: typeof user,
        entityType: string,
        options?: { discoveryMode?: string },
      ) {
        return Promise.resolve([
          {
            id: `${this.prefix}:${authUser.userId}:${entityType}:${options?.discoveryMode}`,
          },
        ]);
      },
      createManagedEntitiesRefreshState(cursor: number | null, backoffActive: boolean) {
        return { cursor, backoffActive, marker: this.prefix };
      },
      ensureEntityType(chatId: string, userId: string, entityType: string): Promise<void> {
        this.adminCalls.push(`entity:${this.readTrimmedString(chatId)}:${userId}:${entityType}`);
        return Promise.resolve();
      },
      isManagedEntityRuntimeBotId(botId: string | null | undefined): boolean {
        return this.readTrimmedString(botId) === 'legacy:bot-1';
      },
      listManagedEntitiesDetailed(authUser: typeof user, entityType: string) {
        return Promise.resolve({
          items: [{ id: `${this.prefix}:${authUser.userId}:${entityType}` }],
          refresh: null,
        });
      },
      resolveBackgroundReadBotAssignment(chatId: string): Promise<string | undefined> {
        return Promise.resolve(this.readTrimmedString(chatId) ?? undefined);
      },
      runManagedEntitiesBoundedRefreshJob(authUser: typeof user, entityType: string) {
        return Promise.resolve({ continueAfterMs: `${this.prefix}:${authUser.userId}:${entityType}` });
      },
      runManagedEntitiesRemoteFullRefresh(authUser: typeof user, entityType: string) {
        return Promise.resolve({ continueAfterMs: `${this.prefix}:remote:${authUser.userId}:${entityType}` });
      },
    };
    const context = createAdminManagedEntitiesRuntimeContext(target);

    await context.assertChatAdmin(' chat-1 ', 'admin-1', 'chat');
    await context.assertReadOnlyChatAdmin(' chat-1 ', 'admin-1');
    await context.ensureEntityType(' chat-1 ', 'admin-1', 'chat');

    expect(target.adminCalls).toEqual([
      'legacy:chat-1:admin-1:chat',
      'read:legacy:chat-1:admin-1',
      'entity:legacy:chat-1:admin-1:chat',
    ]);
    await expect(context.attachManagedEntityFavoriteTypes('admin-1', [{ id: 'chat-1' }] as never)).resolves.toEqual([
      { id: 'chat-1', title: 'legacy:admin-1' },
    ]);
    await expect(
      context.attachManagedEntityFavoriteTypesToDiff('admin-1', { mode: 'patch' } as never),
    ).resolves.toEqual({ mode: 'patch', marker: 'legacy' });
    await expect(
      context.collectManagedEntitiesForMassAction(user, 'chat', { discoveryMode: 'cached-first' }),
    ).resolves.toEqual([{ id: 'legacy:admin-1:chat:cached-first' }]);
    expect(context.createManagedEntitiesRefreshState(5, false)).toEqual({
      cursor: 5,
      backoffActive: false,
      marker: 'legacy',
    });
    expect(context.isManagedEntityRuntimeBotId(' bot-1 ')).toBe(true);
    await expect(context.listManagedEntitiesDetailed(user, 'channel')).resolves.toEqual({
      items: [{ id: 'legacy:admin-1:channel' }],
      refresh: null,
    });
    await expect(context.resolveBackgroundReadBotAssignment(' chat-2 ')).resolves.toBe(
      'legacy:chat-2',
    );
    await expect(context.runManagedEntitiesBoundedRefreshJob(user, 'chat')).resolves.toEqual({
      continueAfterMs: 'legacy:admin-1:chat',
    });
    await expect(context.runManagedEntitiesRemoteFullRefresh(user, 'channel')).resolves.toEqual({
      continueAfterMs: 'legacy:remote:admin-1:channel',
    });
  });
});
