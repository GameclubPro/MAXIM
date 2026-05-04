import { ChatBotMembershipStatus } from '@prisma/client';
import type { MaxUpdate } from '@maxim/contracts';
import { ModerationService } from './moderation.service';

function createGroupMessageUpdate(type = 'message_created'): MaxUpdate {
  return {
    updateId: `upd-${type}-1`,
    type,
    message: {
      messageId: `mid-${type}-1`,
      chatId: '-100123',
      chatTitle: 'Shared chat',
      senderId: 'user-1',
      senderName: 'User 1',
      text: 'Привет',
      createdAt: new Date('2026-03-30T12:00:00.000Z').toISOString(),
    },
  };
}

type SharedChatLockGuard = {
  mode: 'allow';
  activeBotId: string;
  primaryBotId: string;
  assignedBotIds: string[];
  requiresExecutionLock: true;
};

describe('ModerationService shared chat ownership', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('skips non-primary group updates before moderation work starts', async () => {
    const prisma = {};
    const ruleEngine = {
      detect: jest.fn(),
    };
    const maxClient = {
      leaveCurrentChat: jest.fn(),
    };
    const maxBotLinkService = {
      getChatExecutionBinding: jest.fn().mockResolvedValue({
        chatId: '-100123',
        activeBotId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_bot',
        activeMembershipStatus: ChatBotMembershipStatus.ACTIVE,
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        shouldHandleGroupUpdate: false,
      }),
    };
    const maxBotContextService = {
      getActiveBotId: jest.fn().mockReturnValue('id613002203036_4_bot'),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      maxBotContextService as never,
    );

    await service.handleUpdate(createGroupMessageUpdate());

    expect(maxBotLinkService.getChatExecutionBinding).toHaveBeenCalledWith({
      chatId: '-100123',
      activeBotId: 'id613002203036_4_bot',
    });
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.leaveCurrentChat).not.toHaveBeenCalled();
  });

  it('still executes blocked-join protection for non-primary bot_added events in denied chats', async () => {
    const prisma = {
      chatAdminAllowlist: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const maxClient = {
      leaveCurrentChat: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      getChatExecutionBinding: jest.fn().mockResolvedValue({
        chatId: '-100123',
        activeBotId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_bot',
        activeMembershipStatus: ChatBotMembershipStatus.ACTIVE,
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        shouldHandleGroupUpdate: false,
      }),
    };
    const maxBotContextService = {
      getActiveBotId: jest.fn().mockReturnValue('id613002203036_4_bot'),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'MAX_JOIN_DENY_CHAT_IDS') {
          return '-100123';
        }
        return undefined;
      }),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      chatContextCache as never,
      undefined,
      configService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      maxBotContextService as never,
    );

    await service.handleUpdate(createGroupMessageUpdate('bot_added'));

    expect(maxClient.leaveCurrentChat).toHaveBeenCalledWith('-100123');
    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: { chatId: '-100123' },
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('-100123');
  });

  it('acquires only one shared execution lock for the same update across runtimes', async () => {
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        getActiveBotId: jest.fn().mockReturnValue('id613002203036_bot'),
      } as never,
    );

    const update = createGroupMessageUpdate();
    const guard: SharedChatLockGuard = {
      mode: 'allow' as const,
      activeBotId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
      requiresExecutionLock: true,
    };

    const first = await (
      service as unknown as {
        acquireSharedChatExecutionLock: (
          update: MaxUpdate,
          chatId: string,
          guard: SharedChatLockGuard,
        ) => Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null>;
        releaseSharedChatExecutionLock: (lock: {
          key: string;
          token: string;
          mode: 'redis' | 'memory';
        }) => Promise<void>;
      }
    ).acquireSharedChatExecutionLock(update, '-100123', guard);
    const second = await (
      service as unknown as {
        acquireSharedChatExecutionLock: (
          update: MaxUpdate,
          chatId: string,
          guard: SharedChatLockGuard,
        ) => Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null>;
      }
    ).acquireSharedChatExecutionLock(update, '-100123', guard);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    await (
      service as unknown as {
        releaseSharedChatExecutionLock: (lock: {
          key: string;
          token: string;
          mode: 'redis' | 'memory';
        }) => Promise<void>;
      }
    ).releaseSharedChatExecutionLock(first!);

    const third = await (
      service as unknown as {
        acquireSharedChatExecutionLock: (
          update: MaxUpdate,
          chatId: string,
          guard: SharedChatLockGuard,
        ) => Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null>;
      }
    ).acquireSharedChatExecutionLock(update, '-100123', guard);

    expect(third).not.toBeNull();
  });

  it('falls back to local execution when shared chat binding lookup stalls', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      callback: TimerHandler,
    ) => {
      const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
      queueMicrotask(() => {
        if (typeof callback === 'function') {
          callback();
        }
      });
      return timer;
    }) as unknown as typeof setTimeout);
    const clearTimeoutSpy = jest
      .spyOn(global, 'clearTimeout')
      .mockImplementation((() => undefined) as unknown as typeof clearTimeout);

    const maxBotLinkService = {
      getChatExecutionBinding: jest.fn().mockImplementation(() => new Promise(() => undefined)),
    };
    const maxBotContextService = {
      getActiveBotId: jest.fn().mockReturnValue('id613002203036_bot'),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'SHARED_CHAT_EXECUTION_LOOKUP_TIMEOUT_MS') {
          return 50;
        }
        return undefined;
      }),
    };

    try {
      const service = new ModerationService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        configService as never,
        undefined,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
        maxBotContextService as never,
      );

      const guard = await (
        service as unknown as {
          resolveSharedChatExecutionGuard: (
            update: MaxUpdate,
            chatId: string,
          ) => Promise<{
            mode: 'allow' | 'skip' | 'blocked-join-check-only';
            activeBotId: string | null;
            primaryBotId: string | null;
            assignedBotIds: string[];
            requiresExecutionLock?: boolean;
          }>;
        }
      ).resolveSharedChatExecutionGuard(createGroupMessageUpdate(), '-100123');

      expect(guard).toMatchObject({
        mode: 'allow',
        activeBotId: 'id613002203036_bot',
        primaryBotId: null,
        assignedBotIds: ['id613002203036_bot'],
        requiresExecutionLock: true,
      });
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('falls back to memory lock when redis shared execution lock acquisition stalls', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      callback: TimerHandler,
    ) => {
      const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
      queueMicrotask(() => {
        if (typeof callback === 'function') {
          callback();
        }
      });
      return timer;
    }) as unknown as typeof setTimeout);
    const clearTimeoutSpy = jest
      .spyOn(global, 'clearTimeout')
      .mockImplementation((() => undefined) as unknown as typeof clearTimeout);
    const redisCounter = {
      acquireLock: jest.fn().mockImplementation(() => new Promise(() => undefined)),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'SHARED_CHAT_EXECUTION_LOCK_TIMEOUT_MS') {
          return 50;
        }
        return undefined;
      }),
    };

    try {
      const service = new ModerationService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        configService as never,
        redisCounter as never,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          getActiveBotId: jest.fn().mockReturnValue('id613002203036_bot'),
        } as never,
      );

      const lock = await (
        service as unknown as {
          acquireSharedChatExecutionLock: (
            update: MaxUpdate,
            chatId: string,
            guard: SharedChatLockGuard,
          ) => Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null>;
        }
      ).acquireSharedChatExecutionLock(createGroupMessageUpdate(), '-100123', {
        mode: 'allow',
        activeBotId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_bot',
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        requiresExecutionLock: true,
      });

      expect(lock).toMatchObject({
        mode: 'memory',
      });
      expect(redisCounter.acquireLock).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});
