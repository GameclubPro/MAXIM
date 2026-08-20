import { AdminParticipantsRuntime } from './admin-participants-runtime';
import {
  createAdminParticipantsRuntimeContext,
  type AdminParticipantsRuntimeContext,
} from './admin-participants-runtime-context';
import { createDeferred, createPrismaMock } from './admin-service-test-support';

const participantAdmin = {
  userId: 'admin-1',
  username: null,
  displayName: null,
  chatTitle: null,
};

function createParticipantsRuntimeContext(params: {
  prisma: ReturnType<typeof createPrismaMock>;
  maxClient: Record<string, unknown>;
  accessLossService: Record<string, unknown>;
}): AdminParticipantsRuntimeContext {
  return {
    prisma: params.prisma,
    maxClient: params.maxClient,
    logger: { warn: jest.fn(), log: jest.fn() },
    managedEntityAccessLossService: params.accessLossService,
    chatParticipantsPageCache: new Map(),
    assertReadOnlyChatAdmin: jest.fn().mockResolvedValue(undefined),
    buildParticipantViolationCountWhere: jest.fn(),
    buildProfileMentionHandoffUrl: jest.fn().mockReturnValue(null),
    buildUserProfileUrl: jest.fn().mockReturnValue(null),
    ensureEntityType: jest.fn().mockResolvedValue(undefined),
    getManagedEntityHeader: jest.fn().mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'chat',
      participantsCount: 1200,
    }),
    normalizeMaxProfileUrl: jest.fn().mockReturnValue(null),
    prepareManualModerationTarget: jest.fn(),
    readTrimmedString: jest.fn().mockReturnValue(null),
    resolveBackgroundReadBotAssignment: jest.fn().mockResolvedValue('bot-2'),
    resolveParticipantCleanupBotAssignment: jest.fn().mockResolvedValue('bot-2'),
    resolveLogsDashboardFrom: jest.fn(
      (_range: unknown, to: Date) => new Date(to.getTime() - 1_000),
    ),
    toSafeInteger: jest.fn((value: unknown) => (typeof value === 'number' ? Math.trunc(value) : 0)),
  } as unknown as AdminParticipantsRuntimeContext;
}

describe('AdminParticipantsRuntimeContext', () => {
  it('exposes participants infrastructure through typed accessors', () => {
    const cache = new Map();
    const target = {
      prisma: { chatSettings: {} },
      maxClient: { getChatMembersPage: jest.fn() },
      logger: { warn: jest.fn(), log: jest.fn() },
      managedEntityAccessLossService: { recordIfManagedEntityAccessLost: jest.fn() },
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
    expect(context.managedEntityAccessLossService).toBe(target.managedEntityAccessLossService);
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
        botId?: string | null,
      ) {
        return `${this.prefix}:handoff:${chatId}:${entityType}:${userId}:${displayName ?? ''}:${
          botId ?? ''
        }`;
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
    expect(context.buildProfileMentionHandoffUrl('chat-1', 'chat', 'user-1', 'User', 'bot-2')).toBe(
      'legacy:handoff:chat-1:chat:user-1:User:bot-2',
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

describe('AdminParticipantsRuntime access-loss probes', () => {
  it('records delayed terminal roster denial at probe start before returning an empty page', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue({
      nightModeTimezone: 'Europe/Moscow',
    });

    const rosterError = Object.assign(new Error('Request failed with status code 403'), {
      response: {
        status: 403,
        data: {
          code: 'chat.denied',
          message: 'access denied',
        },
      },
    });
    const rosterStarted = createDeferred<void>();
    const delayedRoster = createDeferred<never>();
    const maxClient = {
      getChatMembersPage: jest.fn().mockImplementation(() => {
        rosterStarted.resolve();
        return delayedRoster.promise;
      }),
    };
    const accessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
    };
    const runtime = new AdminParticipantsRuntime(
      createParticipantsRuntimeContext({ prisma, maxClient, accessLossService }),
    );

    const resultPromise = runtime.getChatParticipantsPage('chat-1', participantAdmin, {
      limit: 10,
      range: '7d',
    });
    await rosterStarted.promise;
    const newerLifecycleAt = new Date(Date.now() + 1_000);
    delayedRoster.reject(rosterError);
    const result = await resultPromise;

    expect(result).toEqual({
      items: [],
      totalCount: 1200,
      hasMore: false,
      nextCursor: null,
    });
    expect(prisma.moderationEvent.groupBy).not.toHaveBeenCalled();
    expect(prisma.chatParticipantModerationImmunity.findMany).not.toHaveBeenCalled();
    expect(accessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-2',
      source: 'admin_participants:roster',
      operation: 'lookup',
      error: rosterError,
      lifecycleEventAt: expect.any(Date),
      lifecycleEventType: 'live_probe_denied',
      lifecycleSource: 'live_probe',
    });
    const lifecycleEventAt = accessLossService.recordIfManagedEntityAccessLost.mock.calls[0][0]
      .lifecycleEventAt as Date;
    expect(lifecycleEventAt.getTime()).toBeLessThan(newerLifecycleAt.getTime());
  });

  it('uses the failing remote page epoch for a multi-page participant search', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chatSettings.findUnique.mockResolvedValue({
        nightModeTimezone: 'Europe/Moscow',
      });
      const secondPageStartedAt = new Date('2026-08-20T12:00:05.000Z');
      const rosterError = Object.assign(new Error('Request failed with status code 403'), {
        response: {
          status: 403,
          data: { code: 'chat.denied', message: 'access denied' },
        },
      });
      const maxClient = {
        getChatMembersPage: jest
          .fn()
          .mockImplementationOnce(async () => {
            jest.setSystemTime(secondPageStartedAt);
            return {
              items: [
                {
                  userId: 'user-1',
                  displayName: 'Другой участник',
                  username: null,
                  avatarUrl: null,
                  profileUrl: null,
                  role: 'member',
                  isBot: false,
                },
              ],
              nextMarker: 'page-2',
            };
          })
          .mockRejectedValueOnce(rosterError),
      };
      const accessLossService = {
        recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
      };
      const runtime = new AdminParticipantsRuntime(
        createParticipantsRuntimeContext({ prisma, maxClient, accessLossService }),
      );

      await expect(
        runtime.getChatParticipantsPage('chat-1', participantAdmin, {
          limit: 10,
          range: '7d',
          search: 'needle',
          roleFilter: 'all',
        }),
      ).resolves.toEqual({
        items: [],
        totalCount: 1200,
        hasMore: false,
        nextCursor: null,
      });

      expect(maxClient.getChatMembersPage).toHaveBeenCalledTimes(2);
      expect(accessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith(
        expect.objectContaining({
          error: rosterError,
          lifecycleEventAt: secondPageStartedAt,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('records a delayed terminal cleanup self-probe at probe start before rethrowing', async () => {
    const prisma = createPrismaMock();
    const probeError = Object.assign(new Error('Request failed with status code 404'), {
      response: {
        status: 404,
        data: {
          code: 'chat.not.found',
          message: 'chat not found',
        },
      },
    });
    const probeStarted = createDeferred<void>();
    const delayedProbe = createDeferred<never>();
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockImplementation(() => {
        probeStarted.resolve();
        return delayedProbe.promise;
      }),
      getChatMembersPage: jest.fn(),
    };
    const accessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
    };
    const runtime = new AdminParticipantsRuntime(
      createParticipantsRuntimeContext({ prisma, maxClient, accessLossService }),
    );

    const cleanupPromise = runtime.cleanupUnavailableChatParticipants(
      'chat-1',
      participantAdmin,
      {},
    );
    await probeStarted.promise;
    const newerLifecycleAt = new Date(Date.now() + 1_000);
    delayedProbe.reject(probeError);

    await expect(cleanupPromise).rejects.toBe(probeError);
    expect(accessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-2',
      source: 'admin_participants:cleanup_self_probe',
      operation: 'lookup',
      error: probeError,
      lifecycleEventAt: expect.any(Date),
      lifecycleEventType: 'live_probe_denied',
      lifecycleSource: 'live_probe',
    });
    const lifecycleEventAt = accessLossService.recordIfManagedEntityAccessLost.mock.calls[0][0]
      .lifecycleEventAt as Date;
    expect(lifecycleEventAt.getTime()).toBeLessThan(newerLifecycleAt.getTime());
    expect(maxClient.getChatMembersPage).not.toHaveBeenCalled();
  });

  it('does not record participant access loss for a transient cleanup self-probe failure', async () => {
    const prisma = createPrismaMock();
    const throttleError = Object.assign(new Error('Request failed with status code 429'), {
      response: {
        status: 429,
        data: {
          code: 'rate.limit',
          message: 'too many requests',
        },
      },
    });
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockRejectedValue(throttleError),
      getChatMembersPage: jest.fn(),
    };
    const accessLossService = {
      recordIfManagedEntityAccessLost: jest.fn(),
    };
    const runtime = new AdminParticipantsRuntime(
      createParticipantsRuntimeContext({ prisma, maxClient, accessLossService }),
    );

    await expect(
      runtime.cleanupUnavailableChatParticipants('chat-1', participantAdmin, {}),
    ).rejects.toBe(throttleError);

    expect(accessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
    expect(maxClient.getChatMembersPage).not.toHaveBeenCalled();
  });
});
