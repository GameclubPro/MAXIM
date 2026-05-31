import { ChatEntityType, ManagedEntityAccessState } from '../prisma/prisma-client';
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
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
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
});
