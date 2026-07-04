import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import {
  ManagedEntityAccessLossService,
  classifyMaxTerminalChatActionError,
  resolveManagedEntityAccessLossReason,
} from './managed-entity-access-loss.service';

function createMaxApiError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), {
    response: {
      status,
      data: {
        ...(code ? { code } : {}),
        message,
      },
    },
  });
}

function createMaxBotRegistry(botIds: readonly string[]) {
  return {
    getActionableBots: jest.fn().mockReturnValue(botIds.map((id) => ({ id }))),
  };
}

describe('classifyMaxTerminalChatActionError', () => {
  it('does not classify message.not.found as managed entity access loss', () => {
    expect(
      classifyMaxTerminalChatActionError(
        createMaxApiError(404, 'Request failed with status code 404', 'message.not.found'),
      ),
    ).toEqual(
      expect.objectContaining({
        kind: 'message_not_found',
        code: 'message.not.found',
      }),
    );
  });

  it('classifies chat.not.found as managed entity access loss', () => {
    expect(
      classifyMaxTerminalChatActionError(
        createMaxApiError(404, 'Request failed with status code 404', 'chat.not.found'),
      ),
    ).toEqual(
      expect.objectContaining({
        kind: 'managed_entity_access_lost',
        reason: 'chat_not_found',
        code: 'chat.not.found',
      }),
    );
  });

  it('keeps bare 404 terminal but unknown', () => {
    expect(classifyMaxTerminalChatActionError(createMaxApiError(404, 'Not found'))).toEqual(
      expect.objectContaining({
        kind: 'terminal_unknown',
        statusCode: 404,
      }),
    );
  });

  it('does not resolve message.not.found as access loss', () => {
    const classification = classifyMaxTerminalChatActionError(
      createMaxApiError(404, 'Request failed with status code 404', 'message.not.found'),
    );
    expect(classification).toEqual(expect.objectContaining({ kind: 'message_not_found' }));
    expect(resolveManagedEntityAccessLossReason('delete', classification!)).toBeNull();
  });

  it('resolves bare send 403/404 as managed entity access loss', () => {
    expect(
      resolveManagedEntityAccessLossReason(
        'send',
        classifyMaxTerminalChatActionError(createMaxApiError(403, 'Forbidden'))!,
      ),
    ).toBe('bot_denied');
    expect(
      resolveManagedEntityAccessLossReason(
        'send',
        classifyMaxTerminalChatActionError(createMaxApiError(404, 'Not found'))!,
      ),
    ).toBe('chat_not_found');
  });

  it('does not resolve bare edit 404 as access loss but resolves edit 403', () => {
    expect(
      resolveManagedEntityAccessLossReason(
        'edit',
        classifyMaxTerminalChatActionError(createMaxApiError(404, 'Not found'))!,
      ),
    ).toBeNull();
    expect(
      resolveManagedEntityAccessLossReason(
        'edit',
        classifyMaxTerminalChatActionError(createMaxApiError(403, 'Forbidden'))!,
      ),
    ).toBe('bot_denied');
  });

  it('does not resolve bare delete 403/404 as managed entity access loss', () => {
    expect(
      resolveManagedEntityAccessLossReason(
        'delete',
        classifyMaxTerminalChatActionError(createMaxApiError(403, 'Forbidden'))!,
      ),
    ).toBeNull();
    expect(
      resolveManagedEntityAccessLossReason(
        'delete',
        classifyMaxTerminalChatActionError(createMaxApiError(404, 'Not found'))!,
      ),
    ).toBeNull();
  });

  it('still resolves explicit chat loss errors for delete operations', () => {
    expect(
      resolveManagedEntityAccessLossReason(
        'delete',
        classifyMaxTerminalChatActionError(
          createMaxApiError(403, 'Request failed with status code 403', 'chat.denied'),
        )!,
      ),
    ).toBe('bot_denied');
    expect(
      resolveManagedEntityAccessLossReason(
        'delete',
        classifyMaxTerminalChatActionError(
          createMaxApiError(404, 'Request failed with status code 404', 'chat.not.found'),
        )!,
      ),
    ).toBe('chat_not_found');
  });
});

describe('ManagedEntityAccessLossService', () => {
  it('marks bot membership removed, denies existing access edges, clears caches and night jobs', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      chatBotMembership: {
        findUnique: jest.fn(),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        findFirst: jest.fn(),
      },
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      vkParsingPost: {
        updateMany: jest.fn().mockResolvedValue({ count: 4 }),
      },
      vkParsingSource: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn().mockResolvedValue(null),
      resolveBotId: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const nightModeTransitionScheduler = {
      clearChatJobs: jest.fn().mockResolvedValue(undefined),
    };
    const rosterSyncJob = {
      getState: jest.fn().mockResolvedValue('delayed'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const rosterSyncQueue = {
      getJob: jest.fn().mockResolvedValue(rosterSyncJob),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
      nightModeTransitionScheduler as never,
      rosterSyncQueue as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: ' chat-1 ',
        botId: ' bot-1 ',
        reason: 'chat_not_found',
        source: 'unit-test',
      }),
    ).resolves.toEqual({
      chatId: 'chat-1',
      botId: 'bot-1',
      nextOwnerBotId: null,
      updatedAccessEdges: 2,
      cleanup: {
        nightModeJobsCleared: true,
        canceledBroadcasts: 1,
        canceledBroadcastDeliveries: 3,
        canceledBroadcastOccurrences: 1,
        clearedVkPublishPosts: 4,
        pausedVkSources: 2,
        removedRosterSyncJobs: 1,
      },
    });

    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      title: 'Managed chat',
      entityType: ChatEntityType.CHAT,
      accessLostReason: 'chat_not_found',
      accessLostSource: 'unit-test',
      lastMaxErrorCode: undefined,
      lastMaxErrorMessage: undefined,
      lastMaxStatusCode: undefined,
    });
    expect(prisma.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        botId: 'bot-1',
      },
      data: expect.objectContaining({
        state: ManagedEntityAccessState.BOT_DENIED,
        botRole: 'MEMBER',
        expiresAt: null,
        deniedReason: 'chat_not_found',
        source: 'unit-test',
      }),
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(chatContextCache.clearManagedEntitiesRecentBootstrapForChat).toHaveBeenCalledWith(
      'chat-1',
      'chat',
    );
    expect(nightModeTransitionScheduler.clearChatJobs).toHaveBeenCalledWith('chat-1');
    expect(rosterSyncQueue.getJob).toHaveBeenCalledWith('chat-admin-roster-sync__chat-1');
    expect(rosterSyncJob.remove).toHaveBeenCalledTimes(1);
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          syncStatus: 'ERROR',
          nextSyncAt: null,
          circuitReasonCode: 'max.access_lost',
        }),
      }),
    );
  });

  it('keeps runtime work when a promoted replacement bot has confirmed access', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      chatBotMembership: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'ACTIVE',
          permissionsSnapshot: {
            checkedAt: new Date().toISOString(),
            isAdmin: true,
            isOwner: false,
            permissions: [],
          },
        }),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      managedBroadcast: {
        updateMany: jest.fn(),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn(),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn(),
      },
      vkParsingPost: {
        updateMany: jest.fn(),
      },
      vkParsingSource: {
        updateMany: jest.fn(),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn().mockResolvedValue('bot-2'),
      resolveBotId: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const nightModeTransitionScheduler = {
      clearChatJobs: jest.fn(),
    };
    const rosterSyncQueue = {
      getJob: jest.fn(),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
      nightModeTransitionScheduler as never,
      rosterSyncQueue as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: 'bot-1',
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: 'bot-1',
        nextOwnerBotId: 'bot-2',
        updatedAccessEdges: 1,
        cleanup: {
          nightModeJobsCleared: false,
          canceledBroadcasts: null,
          canceledBroadcastDeliveries: null,
          canceledBroadcastOccurrences: null,
          clearedVkPublishPosts: null,
          pausedVkSources: null,
          removedRosterSyncJobs: null,
        },
      }),
    );

    expect(prisma.chatBotMembership.findUnique).toHaveBeenCalledWith({
      where: {
        chatId_botId: {
          chatId: 'chat-1',
          botId: 'bot-2',
        },
      },
      select: {
        status: true,
        permissionsSnapshot: true,
        botAccessState: true,
        botAccessExpiresAt: true,
      },
    });
    expect(nightModeTransitionScheduler.clearChatJobs).not.toHaveBeenCalled();
    expect(rosterSyncQueue.getJob).not.toHaveBeenCalled();
    expect(prisma.managedBroadcast.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
  });

  it('cleans runtime work when the replacement bot only has stale snapshot access', async () => {
    const staleCheckedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHANNEL,
        }),
      },
      chatBotMembership: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'ACTIVE',
          permissionsSnapshot: {
            checkedAt: staleCheckedAt,
            isAdmin: true,
            isOwner: true,
            permissions: ['delete_messages', 'add_remove_members'],
          },
        }),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      vkParsingPost: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      vkParsingSource: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn().mockResolvedValue('bot-3'),
      resolveBotId: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const nightModeTransitionScheduler = {
      clearChatJobs: jest.fn().mockResolvedValue(undefined),
    };
    const rosterSyncQueue = {
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
      nightModeTransitionScheduler as never,
      rosterSyncQueue as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'channel-1',
        botId: 'bot-1',
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'channel-1',
        botId: 'bot-1',
        nextOwnerBotId: 'bot-3',
        cleanup: expect.objectContaining({
          nightModeJobsCleared: true,
          canceledBroadcasts: 1,
          canceledBroadcastDeliveries: 2,
          canceledBroadcastOccurrences: 1,
          clearedVkPublishPosts: 3,
          pausedVkSources: 1,
          removedRosterSyncJobs: 0,
        }),
      }),
    );

    expect(prisma.chatBotMembership.findUnique).toHaveBeenCalledWith({
      where: {
        chatId_botId: {
          chatId: 'channel-1',
          botId: 'bot-3',
        },
      },
      select: {
        status: true,
        permissionsSnapshot: true,
        botAccessState: true,
        botAccessExpiresAt: true,
      },
    });
    expect(nightModeTransitionScheduler.clearChatJobs).toHaveBeenCalledWith('channel-1');
    expect(prisma.managedBroadcast.updateMany).toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalled();
    expect(chatContextCache.clearManagedEntitiesRecentBootstrapForChat).toHaveBeenCalledWith(
      'channel-1',
      'channel',
    );
  });

  it('keeps runtime work when another actionable bot has a fresh granted access edge', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      chatBotMembership: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({ botId: 'bot-2' }),
      },
      managedBroadcast: {
        updateMany: jest.fn(),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn(),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn(),
      },
      vkParsingPost: {
        updateMany: jest.fn(),
      },
      vkParsingSource: {
        updateMany: jest.fn(),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn().mockResolvedValue(null),
      resolveBotId: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const nightModeTransitionScheduler = {
      clearChatJobs: jest.fn(),
    };
    const rosterSyncQueue = {
      getJob: jest.fn(),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
      nightModeTransitionScheduler as never,
      rosterSyncQueue as never,
      createMaxBotRegistry(['bot-1', 'bot-2']) as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: 'bot-1',
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: 'bot-1',
        nextOwnerBotId: null,
        cleanup: {
          nightModeJobsCleared: false,
          canceledBroadcasts: null,
          canceledBroadcastDeliveries: null,
          canceledBroadcastOccurrences: null,
          clearedVkPublishPosts: null,
          pausedVkSources: null,
          removedRosterSyncJobs: null,
        },
      }),
    );

    expect(prisma.managedEntityAccessEdge.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          botId: { in: ['bot-2'] },
          state: ManagedEntityAccessState.GRANTED,
        }),
      }),
    );
    expect(nightModeTransitionScheduler.clearChatJobs).not.toHaveBeenCalled();
    expect(rosterSyncQueue.getJob).not.toHaveBeenCalled();
    expect(prisma.managedBroadcast.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
  });

  it('keeps runtime work when the lost bot is unresolved but another actionable bot has fresh confirmed access', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      chatBotMembership: {
        findMany: jest.fn().mockResolvedValue([
          {
            botId: 'bot-2',
            status: ChatBotMembershipStatus.ACTIVE,
            permissionsSnapshot: null,
            botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
            botAccessExpiresAt: new Date(Date.now() + 60_000),
          },
        ]),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      managedBroadcast: {
        updateMany: jest.fn(),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn(),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn(),
      },
      vkParsingPost: {
        updateMany: jest.fn(),
      },
      vkParsingSource: {
        updateMany: jest.fn(),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn(),
      resolveBotId: jest.fn().mockResolvedValue(null),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const nightModeTransitionScheduler = {
      clearChatJobs: jest.fn(),
    };
    const rosterSyncQueue = {
      getJob: jest.fn(),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
      nightModeTransitionScheduler as never,
      rosterSyncQueue as never,
      createMaxBotRegistry(['bot-2']) as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: null,
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: null,
        updatedAccessEdges: 0,
        cleanup: {
          nightModeJobsCleared: false,
          canceledBroadcasts: null,
          canceledBroadcastDeliveries: null,
          canceledBroadcastOccurrences: null,
          clearedVkPublishPosts: null,
          pausedVkSources: null,
          removedRosterSyncJobs: null,
        },
      }),
    );

    expect(maxBotLinkService.markChatBotRemoved).not.toHaveBeenCalled();
    expect(prisma.managedEntityAccessEdge.updateMany).not.toHaveBeenCalled();
    expect(prisma.chatBotMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          botId: { in: ['bot-2'] },
          status: ChatBotMembershipStatus.ACTIVE,
        }),
      }),
    );
    expect(nightModeTransitionScheduler.clearChatJobs).not.toHaveBeenCalled();
    expect(rosterSyncQueue.getJob).not.toHaveBeenCalled();
    expect(prisma.managedBroadcast.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
  });

  it('cleans runtime work when surviving bot access proof is stale', async () => {
    const staleCheckedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      chatBotMembership: {
        findMany: jest.fn().mockResolvedValue([
          {
            botId: 'bot-2',
            status: ChatBotMembershipStatus.ACTIVE,
            permissionsSnapshot: {
              checkedAt: staleCheckedAt,
              isAdmin: true,
              isOwner: false,
              permissions: [],
            },
            botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
            botAccessExpiresAt: new Date(Date.now() - 60_000),
          },
        ]),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      vkParsingPost: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      vkParsingSource: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn().mockResolvedValue(null),
      resolveBotId: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const nightModeTransitionScheduler = {
      clearChatJobs: jest.fn().mockResolvedValue(undefined),
    };
    const rosterSyncQueue = {
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
      nightModeTransitionScheduler as never,
      rosterSyncQueue as never,
      createMaxBotRegistry(['bot-1', 'bot-2']) as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: 'bot-1',
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        cleanup: expect.objectContaining({
          nightModeJobsCleared: true,
          canceledBroadcasts: 1,
          canceledBroadcastDeliveries: 2,
          canceledBroadcastOccurrences: 1,
          clearedVkPublishPosts: 3,
          pausedVkSources: 1,
          removedRosterSyncJobs: 0,
        }),
      }),
    );

    expect(nightModeTransitionScheduler.clearChatJobs).toHaveBeenCalledWith('chat-1');
    expect(prisma.managedBroadcast.updateMany).toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalled();
  });

  it('does not mutate private direct dialogs', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn(),
      },
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      { markChatBotRemoved: jest.fn(), resolveBotId: jest.fn() } as never,
      {
        invalidate: jest.fn(),
        clearManagedEntitiesRecentBootstrapForChat: jest.fn(),
      } as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: '12345',
        botId: 'bot-1',
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toBeNull();

    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
  });

  it('does not mark every access edge bot-denied when the lost bot cannot be resolved', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn(),
      resolveBotId: jest.fn().mockResolvedValue(null),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: null,
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: null,
        updatedAccessEdges: 0,
      }),
    );

    expect(maxBotLinkService.markChatBotRemoved).not.toHaveBeenCalled();
    expect(prisma.managedEntityAccessEdge.updateMany).not.toHaveBeenCalled();
  });
});
