import { ModerationService } from './moderation.service';

describe('ModerationService chat admin access lookups', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes a bounded timeout to remote admin access reads', async () => {
    const maxClient = {
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'CHAT_ADMIN_LOOKUP_TIMEOUT_MS') {
          return 1500;
        }
        return undefined;
      }),
    };

    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      configService as never,
    );

    await (
      service as unknown as {
        loadRemoteChatAdminAccessBatch: (
          chatId: string,
          userIds: readonly string[],
        ) => Promise<Map<string, 'granted' | 'user_denied'>>;
      }
    ).loadRemoteChatAdminAccessBatch('-100123', ['user-1']);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      '-100123',
      ['user-1'],
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        timeoutMs: 1500,
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
  });

  it('fails open instead of hanging when a remote chat admin lookup never resolves', async () => {
    const maxClient = {
      getChatMembersAccess: jest.fn().mockImplementation(() => new Promise(() => undefined)),
      getCurrentChatMemberAccess: jest.fn(),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'CHAT_ADMIN_LOOKUP_TIMEOUT_MS') {
          return 50;
        }
        return undefined;
      }),
    };

    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      configService as never,
    );

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

    try {
      const lookup = (
        service as unknown as {
          executeRemoteChatAdminLookupWithGuard: <T>(
            operation: () => Promise<T>,
            context: {
              chatId: string;
              userIds: readonly string[];
              botId?: string | null;
            },
          ) => Promise<T>;
        }
      ).executeRemoteChatAdminLookupWithGuard(
        () => maxClient.getChatMembersAccess('-100123', ['user-1'], {}),
        {
          chatId: '-100123',
          userIds: ['user-1'],
        },
      );

      await expect(lookup).rejects.toMatchObject({ code: 'ECONNABORTED' });
      expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('does not block ordinary moderation on synchronous remote admin reads when local admins are already known', async () => {
    jest.useFakeTimers();
    let loggerWarnSpy: jest.SpyInstance | undefined;
    try {
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        getChatMembersAccess: jest.fn().mockImplementation(() => new Promise(() => undefined)),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };
      const chatContextCache = {
        getChatContext: jest.fn().mockResolvedValue({
          chatId: 'chat-1',
          title: 'Chat 1',
          settings: {
            antiDuplicateEnabled: true,
            duplicateWarnEnabled: true,
            duplicateMuteEnabled: true,
            duplicateBanEnabled: true,
            duplicateWarnWindowSec: 43200,
            duplicateWarnMaxCount: 2,
            duplicateMuteWindowSec: 86400,
            duplicateMuteMaxCount: 3,
            duplicateBanWindowSec: 172800,
            duplicateBanMaxCount: 4,
            linkPolicy: 'ALLOWLIST_ONLY',
            botSpeechStyle: 'FRIENDLY',
            greetingEnabled: false,
            greetingBotMessageEnabled: false,
            greetingDeleteBotMessageEnabled: false,
            greetingDeleteBotMessageDelayMinutes: 2,
            greetingBotMessageText: '',
            greetingBotButtonEnabled: false,
            greetingBotButtonUrl: '',
            greetingBotButtonText: 'Открыть',
            greetingRulesButtonEnabled: false,
            requiredSubscriptionEnabled: false,
            requiredSubscriptionChannelIds: [],
            requiredSubscriptionBotMessageEnabled: true,
            requiredSubscriptionBotMessageText: '',
            requiredSubscriptionWarnEnabled: false,
            requiredSubscriptionWarnMessageText: '',
            requiredSubscriptionBanEnabled: false,
            requiredSubscriptionMuteEnabled: false,
            requiredSubscriptionMuteDurationHours: 6,
            invitationAccessEnabled: false,
            invitationAccessRequiredCount: 1,
            invitationAccessBotMessageEnabled: true,
            invitationAccessBotMessageText: '',
            invitationAccessWarnEnabled: false,
            invitationAccessWarnMessageText: '',
            invitationAccessBanEnabled: false,
            invitationAccessMuteEnabled: false,
            invitationAccessMuteDurationHours: 6,
            commentsEnabled: false,
            commentsAdminsEnabled: true,
            commentsAllEnabled: false,
            commentsChatBroadcastsEnabled: false,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
            removeBotsFromGroupEnabled: true,
            deleteSpammersEnabled: false,
            profanityEnabled: false,
            profanityLevel: 'MEDIUM',
            profanityWarnEnabled: false,
            profanityMuteEnabled: false,
            profanityBanEnabled: false,
            linksEnabled: false,
            linksWarnEnabled: false,
            linksMuteEnabled: false,
            linksBanEnabled: false,
            commercialAdsEnabled: false,
            commercialAdsWarnEnabled: false,
            commercialAdsMuteEnabled: false,
            commercialAdsBanEnabled: false,
            commercialAdsSensitivity: 'BALANCED',
            thematicFiltersEnabled: false,
            thematicFiltersKeywords: [],
            thematicFiltersWarnEnabled: false,
            thematicFiltersMuteEnabled: false,
            thematicFiltersBanEnabled: false,
            messageLimitsEnabled: false,
            messageLimitsMaxCount: 5,
            messageLimitsWindowSec: 10,
            messageLimitsWarnEnabled: false,
            messageLimitsMuteEnabled: false,
            messageLimitsBanEnabled: false,
            duplicateBotMessageEnabled: false,
            duplicateBotMessageText: '',
            textFiltersWarnEnabled: false,
            textFiltersWarnMessageText: '',
            thematicFiltersWarnMessageText: '',
            linkWarnMessageText: '',
            messageLimitsWarnMessageText: '',
            muteDurationHours: 6,
            rulesAttachViolationsEnabled: false,
            nightModeEnabled: false,
            nightModeStartTimeMinutes: 0,
            nightModeEndTimeMinutes: 0,
            nightModeTimezone: 'UTC',
            nightModeBotMessageEnabled: false,
            nightModeBotMessageText: '',
            nightModeCommentsEnabled: false,
            nightModeBotButtonEnabled: false,
            nightModeBotButtonUrl: '',
            nightModeBotButtonText: '',
            nightModeRulesButtonEnabled: false,
            nightModeForceCloseEnabled: false,
            nightModeForceCloseForever: false,
            nightModeForceCloseUntil: null,
            channelAutoPostButtonsEnabled: false,
            channelAutoPostButtonsMode: 'OFF',
          },
          domainAllowlist: [],
          adminUserIds: ['admin-1'],
          rulesPublishedUrl: null,
          rulesPublishedMessageId: null,
        }),
        getAdminAccess: jest.fn().mockResolvedValue(null),
        setAdminAccess: jest.fn().mockResolvedValue(undefined),
        invalidate: jest.fn().mockResolvedValue(undefined),
      };
      const configService = {
        get: jest.fn((key: string) => {
          if (key === 'CHAT_ADMIN_LOOKUP_TIMEOUT_MS') {
            return 250;
          }
          if (key === 'CHAT_ADMIN_SYNC_REMOTE_LOOKUP_WHEN_LOCAL_ADMINS_KNOWN') {
            return false;
          }
          return undefined;
        }),
      };

      const service = new ModerationService(
        {
          violation: { create: jest.fn() },
          moderationEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
          webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
        } as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
        undefined,
        configService as never,
      );
      loggerWarnSpy = jest
        .spyOn(
          (service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      await expect(
        service.handleUpdate({
          updateId: 'u-1',
          type: 'message_created',
          message: {
            messageId: 'm-1',
            chatId: 'chat-1',
            senderId: 'user-1',
            senderName: 'User 1',
            text: 'обычное сообщение',
            createdAt: '2026-03-31T12:00:00.000Z',
          },
          raw: {},
        } as never),
      ).resolves.toBeUndefined();

      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
    } finally {
      loggerWarnSpy?.mockRestore();
      jest.useRealTimers();
    }
  });

  it('batches shared-cache admin reads within the same chat before remote lookup', async () => {
    const maxClient = {
      getChatMembersAccess: jest.fn(),
      getCurrentChatMemberAccess: jest.fn(),
    };
    const chatContextCache = {
      getAdminAccess: jest.fn(),
      getAdminAccessBatch: jest.fn().mockResolvedValue(
        new Map([
          ['user-1', 'granted'],
          ['iduser-1', null],
          ['user-2', null],
          ['iduser-2', 'user_denied'],
        ]),
      ),
      setAdminAccess: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
      chatContextCache as never,
    );

    const [first, second] = await Promise.all([
      (
        service as unknown as {
          getRemoteChatAdminAccess: (
            chatId: string,
            userId: string,
            options?: {
              allowLookup?: boolean;
            },
          ) => Promise<'granted' | 'user_denied' | null>;
        }
      ).getRemoteChatAdminAccess('chat-1', 'user-1', {
        allowLookup: false,
      }),
      (
        service as unknown as {
          getRemoteChatAdminAccess: (
            chatId: string,
            userId: string,
            options?: {
              allowLookup?: boolean;
            },
          ) => Promise<'granted' | 'user_denied' | null>;
        }
      ).getRemoteChatAdminAccess('chat-1', 'user-2', {
        allowLookup: false,
      }),
    ]);

    expect(first).toBe('granted');
    expect(second).toBe('user_denied');
    expect(chatContextCache.getAdminAccessBatch).toHaveBeenCalledTimes(1);
    expect(chatContextCache.getAdminAccessBatch).toHaveBeenCalledWith(
      'chat-1',
      expect.arrayContaining(['user-1', 'iduser-1', 'user-2', 'iduser-2']),
    );
    expect(chatContextCache.getAdminAccess).not.toHaveBeenCalled();
    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();
  });

  it('backs off remote admin lookups after denied MAX responses', async () => {
    const deniedError = Object.assign(new Error('Request failed with status code 403'), {
      response: {
        status: 403,
        data: {
          message: 'Request failed with status code 403',
        },
      },
    });
    const maxClient = {
      getChatMembersAccess: jest.fn().mockRejectedValue(deniedError),
      getCurrentChatMemberAccess: jest.fn(),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
    );
    const accessService = service as unknown as {
      getRemoteChatAdminAccess: (
        chatId: string,
        userId: string,
      ) => Promise<'granted' | 'user_denied' | null>;
    };

    await expect(accessService.getRemoteChatAdminAccess('chat-denied', 'user-1')).resolves.toBe(
      null,
    );
    await expect(accessService.getRemoteChatAdminAccess('chat-denied', 'user-1')).resolves.toBe(
      null,
    );

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
  });

  it('batches concurrent global spammer exemption lookups within the same admin scope', async () => {
    const prisma = {
      adminGlobalSpammerExemption: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'iduser-1' }]),
      },
    };
    const service = new ModerationService(prisma as never, {} as never, {} as never, {} as never);

    const [first, second] = await Promise.all([
      (
        service as unknown as {
          resolveGlobalSpammerExemptUserIds: (
            userIds: readonly string[],
            adminUserIds: readonly string[] | undefined,
            options?: {
              chatId?: string;
            },
          ) => Promise<Set<string>>;
        }
      ).resolveGlobalSpammerExemptUserIds(['user-1'], ['admin-1'], {
        chatId: 'chat-1',
      }),
      (
        service as unknown as {
          resolveGlobalSpammerExemptUserIds: (
            userIds: readonly string[],
            adminUserIds: readonly string[] | undefined,
            options?: {
              chatId?: string;
            },
          ) => Promise<Set<string>>;
        }
      ).resolveGlobalSpammerExemptUserIds(['user-2'], ['admin-1'], {
        chatId: 'chat-1',
      }),
    ]);

    expect(first).toEqual(new Set(['user-1']));
    expect(second).toEqual(new Set());
    expect(prisma.adminGlobalSpammerExemption.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.adminGlobalSpammerExemption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          adminUserId: {
            in: expect.arrayContaining(['admin-1', 'idadmin-1']),
          },
          userId: {
            in: expect.arrayContaining(['user-1', 'iduser-1', 'user-2', 'iduser-2']),
          },
        },
        select: {
          userId: true,
          decision: true,
          updatedAt: true,
        },
      }),
    );
  });

  it('patches cached chat context after persisting a remotely confirmed admin grant', async () => {
    const chatContextCache = {
      rememberChatAdminUser: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      chatAdminAllowlist: {
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      chatContextCache as never,
      undefined,
      { get: jest.fn() } as never,
    );

    await (
      service as unknown as {
        persistRemoteAdminGrant: (chatId: string, userId: string) => Promise<void>;
      }
    ).persistRemoteAdminGrant('chat-1', 'user-1');

    expect(prisma.chatAdminAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_userId: {
          chatId: 'chat-1',
          userId: 'user-1',
        },
      },
      create: {
        chatId: 'chat-1',
        userId: 'user-1',
      },
      update: {},
    });
    expect(chatContextCache.rememberChatAdminUser).toHaveBeenCalledWith('chat-1', 'user-1');
    expect(chatContextCache.invalidate).not.toHaveBeenCalled();
  });
});
