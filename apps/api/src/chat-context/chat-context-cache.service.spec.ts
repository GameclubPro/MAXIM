jest.mock('ioredis', () => {
  const store = new Map<string, string>();
  const subscribers = new Set<(channel: string, payload: string) => void>();

  const createInstance = () => {
    const messageHandlers = new Set<(channel: string, payload: string) => void>();
    const instance = {
      get: jest.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
      mget: jest
        .fn()
        .mockImplementation(async (...keys: string[]) => keys.map((key) => store.get(key) ?? null)),
      pttl: jest.fn().mockResolvedValue(-2),
      set: jest.fn().mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      del: jest.fn().mockImplementation(async (...keys: string[]) => {
        let deleted = 0;
        for (const key of keys) {
          if (store.delete(key)) {
            deleted += 1;
          }
        }
        return deleted;
      }),
      publish: jest.fn().mockImplementation(async (channel: string, payload: string) => {
        for (const subscriber of subscribers) {
          subscriber(channel, payload);
        }
        return subscribers.size;
      }),
      subscribe: jest.fn().mockResolvedValue(1),
      on: jest.fn().mockImplementation((event: string, handler: unknown) => {
        if (event === 'message' && typeof handler === 'function') {
          const messageHandler = handler as (channel: string, payload: string) => void;
          messageHandlers.add(messageHandler);
          subscribers.add(messageHandler);
        }
        return instance;
      }),
      duplicate: jest.fn().mockImplementation(() => createInstance()),
      multi: jest.fn(),
      quit: jest.fn().mockImplementation(async () => {
        for (const handler of messageHandlers) {
          subscribers.delete(handler);
        }
        messageHandlers.clear();
      }),
    };

    return instance;
  };

  const RedisMock = Object.assign(
    jest.fn().mockImplementation(() => createInstance()),
    {
      __store: store,
      __subscribers: subscribers,
    },
  );

  return {
    __esModule: true,
    default: RedisMock,
  };
});

import Redis from 'ioredis';
import type { ChatSummary } from '@maxim/contracts';
import type { ChatSettings } from '@prisma/client';
import { ChatContextCacheService } from './chat-context-cache.service';

function buildChatSummary(chatId: string): ChatSummary {
  return {
    id: chatId,
    title: 'Chat title',
    createdAt: '2026-04-04T10:00:00.000Z',
    entityType: 'chat',
    link: null,
    channelOverview: null,
    primaryBotId: null,
    assignedBots: [],
    sharedMode: 'owned',
  };
}

function buildSettings(chatId: string): ChatSettings {
  const now = new Date();
  return {
    id: 'settings-1',
    chatId,
    duplicateWarnEnabled: true,
    duplicateMuteEnabled: true,
    duplicateBanEnabled: true,
    antiDuplicateEnabled: true,
    duplicateWarnWindowSec: 43200,
    duplicateWarnMaxCount: 2,
    duplicateMuteWindowSec: 86400,
    duplicateMuteMaxCount: 3,
    duplicateMuteDurationHours: 6,
    duplicateBanWindowSec: 172800,
    duplicateBanMaxCount: 4,
    linkPolicy: 'ALLOWLIST_ONLY',
    botSpeechStyle: null,
    greetingEnabled: false,
    greetingBotMessageEnabled: true,
    greetingDeleteBotMessageEnabled: false,
    greetingDeleteBotMessageDelayMinutes: 2,
    greetingBotMessageText: '',
    greetingBotButtonEnabled: false,
    greetingBotButtonUrl: '',
    greetingBotButtonText: 'Открыть',
    greetingBotButtons: [],
    greetingRulesButtonEnabled: false,
    deleteBotMessagesEnabled: true,
    deleteBotMessagesDelayMinutes: 2,
    removeBotsFromGroupEnabled: false,
    deleteSpammersEnabled: false,

    antiSpamEnabled: true,
    messageCountLimitEnabled: false,
    messageCountLimitMessages: 5,
    messageCountLimitWindowHours: 1,
    maxMessageLengthEnabled: false,
    maxMessageLength: 1500,
    photoMessageCooldownEnabled: false,
    photoMessageCooldownHours: 1,
    stickerMessageCooldownEnabled: false,
    stickerMessageCooldownMinutes: 5,
    videoMessagesEnabled: true,
    fileMessagesEnabled: true,
    voiceMessagesEnabled: true,
    messageLimitsBlockedWords: [],
    messageLimitsBotMessageEnabled: false,
    messageLimitsBotMessageText: '',
    messageLimitsWarnEnabled: false,
    messageLimitsBanEnabled: false,
    messageLimitsMuteEnabled: false,
    messageLimitsMuteDurationHours: 6,
    messageLimitsBotButtonEnabled: false,
    messageLimitsBotButtonUrl: '',
    messageLimitsBotButtonText: 'Открыть',
    messageLimitsBotButtons: [],
    russianProfanityFilterEnabled: true,
    commercialAdsFilterEnabled: false,
    commercialAdsSensitivity: 'BALANCED',
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
    profanityBotMessageEnabled: false,
    profanityWarnEnabled: false,
    profanityBanEnabled: false,
    profanityMuteEnabled: false,
    profanityMuteDurationHours: 6,
    textFiltersBotMessageEnabled: false,
    textFiltersBotMessageText: '',
    textFiltersWarnEnabled: false,
    textFiltersWarnMessageText: '',
    textFiltersBanEnabled: false,
    textFiltersMuteEnabled: false,
    textFiltersMuteDurationHours: 6,
    textFiltersBotButtonEnabled: false,
    textFiltersBotButtonUrl: '',
    textFiltersBotButtonText: 'Открыть',
    textFiltersBotButtons: [],
    textFiltersRulesButtonEnabled: false,
    thematicCodewordEnabled: false,
    thematicCodeword: '',
    thematicFiltersBotMessageEnabled: false,
    thematicFiltersWarnEnabled: false,
    thematicFiltersBanEnabled: false,
    thematicFiltersMuteEnabled: false,
    thematicFiltersMuteDurationHours: 6,
    thematicFiltersBotButtonEnabled: false,
    thematicFiltersBotButtonUrl: '',
    thematicFiltersBotButtonText: 'Открыть',
    thematicFiltersBotButtons: [],
    thematicFiltersRulesButtonEnabled: false,
    nightModeEnabled: false,
    nightModeStartTimeMinutes: 1380,
    nightModeEndTimeMinutes: 480,
    nightModeTimezone: 'Europe/Moscow',
    nightModeBotMessageEnabled: false,
    nightModeBotMessageText: '',
    nightModeCommentsEnabled: false,
    nightModeOpenMessageEnabled: true,
    nightModeOpenMessageText: '',
    nightModeBotButtonEnabled: false,
    nightModeBotButtonUrl: '',
    nightModeBotButtonText: 'Открыть',
    nightModeBotButtons: [],
    nightModeRulesButtonEnabled: false,
    nightModeForceCloseEnabled: false,
    nightModeForceCloseForever: false,
    nightModeForceCloseHours: 8,
    nightModeForceCloseDays: 0,
    nightModeForceCloseUntil: '',
    requiredSubscriptionEnabled: false,
    requiredSubscriptionChannelIds: [],
    requiredSubscriptionBotMessageEnabled: true,
    requiredSubscriptionBotMessageText: '',
    requiredSubscriptionWarnEnabled: false,
    requiredSubscriptionWarnMessageText: '',
    requiredSubscriptionBanEnabled: false,
    requiredSubscriptionMuteEnabled: false,
    requiredSubscriptionMuteDurationHours: 6,
    requiredSubscriptionDurationDays: 7,
    requiredSubscriptionExpiresAt: '',
    commentsEnabled: false,
    commentsAdminsEnabled: true,
    commentsAllEnabled: false,
    commentsChatBroadcastsEnabled: false,
    linkBotMessageEnabled: true,
    linkBotMessageText: '',
    linkWarnEnabled: false,
    linkWarnMessageText: '',
    linkBanEnabled: false,
    linkMuteEnabled: false,
    linkMuteDurationHours: 6,
    linkBotButtonEnabled: false,
    linkBotButtonUrl: '',
    linkBotButtonText: 'Открыть',
    linkBotButtons: [],
    linkRulesButtonEnabled: false,
    duplicateBotMessageEnabled: false,
    duplicateBotMessageText: '',
    duplicateBotButtonEnabled: false,
    duplicateBotButtonUrl: '',
    duplicateBotButtonText: 'Открыть',
    duplicateBotButtons: [],
    duplicateRulesButtonEnabled: false,
    messageLimitsRulesButtonEnabled: false,
    rulesAttachViolationsEnabled: true,
    muteDurationHours: 6,
    warnThreshold: 3,
    createdAt: now,
    updatedAt: now,
  };
}

describe('ChatContextCacheService', () => {
  const maxBotLinkService = {
    resolveBotRoute: jest.fn().mockResolvedValue({
      purpose: 'default',
      chatId: 'chat-1',
      primaryBotId: '777000_bot',
      botId: '777000_bot',
      candidateBotIds: ['777000_bot'],
      reason: 'chat_primary',
    }),
    resolveBotId: jest.fn().mockResolvedValue('777000_bot'),
    getContextOrDefaultBotId: jest.fn().mockReturnValue('777000_bot'),
    rememberChatBotBinding: jest.fn(),
  };

  beforeEach(() => {
    (Redis as unknown as { __store: Map<string, string> }).__store.clear();
    (
      Redis as unknown as { __subscribers: Set<(channel: string, payload: string) => void> }
    ).__subscribers.clear();
    jest.clearAllMocks();
    maxBotLinkService.resolveBotRoute.mockResolvedValue({
      purpose: 'default',
      chatId: 'chat-1',
      primaryBotId: '777000_bot',
      botId: '777000_bot',
      candidateBotIds: ['777000_bot'],
      reason: 'chat_primary',
    });
    maxBotLinkService.resolveBotId.mockResolvedValue('777000_bot');
    maxBotLinkService.getContextOrDefaultBotId.mockReturnValue('777000_bot');
  });

  it('loads existing chat context with a single read and caches the result', async () => {
    const chatId = 'chat-1';
    const settings = buildSettings(chatId);
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: chatId,
          title: 'Chat title',
          settings,
          domains: [{ domain: 'example.com' }],
          admins: [{ userId: 'user-1' }],
          rules: null,
        }),
        upsert: jest.fn(),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results[0].value as {
      get: jest.Mock;
    };
    redisInstance.get.mockResolvedValue(null);

    const context = await service.getChatContext(chatId, 'Chat title');

    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(context).toEqual({
      chatId,
      title: 'Chat title',
      settings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });
  });

  it('initializes missing chat context with an upsert fallback', async () => {
    const chatId = 'chat-1';
    const settings = buildSettings(chatId);
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({
          id: chatId,
          title: 'Chat title',
          settings,
          domains: [{ domain: 'example.com' }],
          admins: [{ userId: 'user-1' }],
          rules: null,
        }),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      get: jest.Mock;
    };
    redisInstance.get.mockResolvedValue(null);

    await expect(service.getChatContext(chatId, 'Chat title')).resolves.toEqual({
      chatId,
      title: 'Chat title',
      settings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });

    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.chat.upsert).toHaveBeenCalledTimes(1);
  });

  it('prefers the unified chat route when initializing a missing chat context row', async () => {
    const chatId = 'chat-2';
    const settings = buildSettings(chatId);
    maxBotLinkService.resolveBotRoute.mockResolvedValueOnce({
      purpose: 'default',
      chatId,
      primaryBotId: 'id613002203036_4_bot',
      botId: 'id613002203036_4_bot',
      candidateBotIds: ['id613002203036_4_bot'],
      reason: 'chat_cache',
    });
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({
          id: chatId,
          title: 'Chat title',
          settings,
          domains: [],
          admins: [],
          rules: null,
        }),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      get: jest.Mock;
    };
    redisInstance.get.mockResolvedValue(null);

    await service.getChatContext(chatId, 'Chat title');

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'default',
      chatId,
    });
    expect(maxBotLinkService.resolveBotId).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          botId: 'id613002203036_4_bot',
          primaryBotId: 'id613002203036_4_bot',
        }),
      }),
    );
  });

  it('deduplicates concurrent cold chat context loads', async () => {
    const chatId = 'chat-1';
    const settings = buildSettings(chatId);
    let resolveFindUnique!: (value: unknown) => void;
    const findUniquePromise = new Promise((resolve) => {
      resolveFindUnique = resolve;
    });
    const prisma = {
      chat: {
        findUnique: jest.fn().mockReturnValue(findUniquePromise),
        upsert: jest.fn(),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      get: jest.Mock;
      set: jest.Mock;
    };
    redisInstance.get.mockResolvedValue(null);

    const firstLoad = service.getChatContext(chatId, 'Chat title');
    const secondLoad = service.getChatContext(chatId, 'Chat title');

    resolveFindUnique({
      id: chatId,
      title: 'Chat title',
      settings,
      domains: [{ domain: 'example.com' }],
      admins: [{ userId: 'user-1' }],
      rules: null,
    });

    await expect(firstLoad).resolves.toEqual({
      chatId,
      title: 'Chat title',
      settings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });
    await expect(secondLoad).resolves.toEqual({
      chatId,
      title: 'Chat title',
      settings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });
    expect(redisInstance.get).toHaveBeenCalledTimes(1);
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
  });

  it('serves repeated chat context reads from the local cache before hitting redis again', async () => {
    const chatId = 'chat-1';
    const settings = buildSettings(chatId);
    const cachedSettings = JSON.parse(JSON.stringify(settings)) as ChatSettings;
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      get: jest.Mock;
    };
    redisInstance.get.mockResolvedValue(
      JSON.stringify({
        chatId,
        title: 'Chat title',
        settings: cachedSettings,
        domainAllowlist: ['example.com'],
        adminUserIds: ['user-1'],
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      }),
    );

    await expect(service.getChatContext(chatId, 'Chat title')).resolves.toEqual({
      chatId,
      title: 'Chat title',
      settings: cachedSettings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });
    await expect(service.getChatContext(chatId, 'Chat title')).resolves.toEqual({
      chatId,
      title: 'Chat title',
      settings: cachedSettings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });

    expect(redisInstance.get).toHaveBeenCalledTimes(1);
  });

  it('propagates chat context invalidation to other service instances', async () => {
    const chatId = 'chat-1';
    const initialSettings = buildSettings(chatId);
    const updatedSettings = {
      ...buildSettings(chatId),
      nightModeForceCloseEnabled: true,
      nightModeForceCloseForever: true,
    };
    const prismaReader = {
      chat: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: chatId,
            title: 'Chat title',
            settings: initialSettings,
            domains: [],
            admins: [],
            rules: null,
          })
          .mockResolvedValueOnce({
            id: chatId,
            title: 'Chat title',
            settings: updatedSettings,
            domains: [],
            admins: [],
            rules: null,
          }),
        upsert: jest.fn(),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const invalidator = new ChatContextCacheService(
      { chat: {} } as never,
      config as never,
      maxBotLinkService as never,
    );
    const reader = new ChatContextCacheService(
      prismaReader as never,
      config as never,
      maxBotLinkService as never,
    );

    await invalidator.onModuleInit();
    await reader.onModuleInit();

    await expect(reader.getChatContext(chatId, 'Chat title')).resolves.toMatchObject({
      chatId,
      settings: expect.objectContaining({
        nightModeForceCloseEnabled: false,
      }),
    });
    await invalidator.invalidate(chatId);
    await expect(reader.getChatContext(chatId, 'Chat title')).resolves.toMatchObject({
      chatId,
      settings: expect.objectContaining({
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: true,
      }),
    });

    expect(prismaReader.chat.findUnique).toHaveBeenCalledTimes(2);

    await invalidator.onModuleDestroy();
    await reader.onModuleDestroy();
  });

  it('patches cached chat titles without invalidating the full chat context', async () => {
    const chatId = 'chat-1';
    const cachedSettings = JSON.parse(JSON.stringify(buildSettings(chatId))) as ChatSettings;
    const prisma = {
      chat: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      get: jest.Mock;
      set: jest.Mock;
      del: jest.Mock;
    };
    redisInstance.get.mockResolvedValueOnce(
      JSON.stringify({
        chatId,
        title: 'Chat 1',
        settings: cachedSettings,
        domainAllowlist: ['example.com'],
        adminUserIds: ['user-1'],
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      }),
    );

    await expect(service.getChatContext(chatId, 'Fresh title')).resolves.toEqual({
      chatId,
      title: 'Fresh title',
      settings: cachedSettings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });

    await expect(service.getChatContext(chatId)).resolves.toEqual({
      chatId,
      title: 'Fresh title',
      settings: cachedSettings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });

    expect(prisma.chat.updateMany).toHaveBeenCalledWith({
      where: {
        id: chatId,
        title: {
          not: 'Fresh title',
        },
      },
      data: {
        title: 'Fresh title',
      },
    });
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.cacheKey(chatId),
      expect.stringContaining('"title":"Fresh title"'),
      'EX',
      60,
    );
    expect(redisInstance.del).not.toHaveBeenCalled();
    expect(redisInstance.get).toHaveBeenCalledTimes(1);
  });

  it('stores admin access decisions in redis with ttl', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      set: jest.Mock;
      get: jest.Mock;
      pttl: jest.Mock;
    };

    await service.setAdminAccess('chat-1', 'user-1', 'granted');
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.adminAccessKey('chat-1', 'user-1'),
      'granted',
      'EX',
      900,
    );

    redisInstance.get.mockResolvedValueOnce('bot_denied');
    await expect(service.getAdminAccess('chat-1', 'user-1')).resolves.toBe('bot_denied');
  });

  it('reads admin access decisions in batch with a single redis roundtrip', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      mget: jest.Mock;
    };
    redisInstance.mget.mockResolvedValueOnce(['granted', '0', null]);

    await expect(
      service.getAdminAccessBatch('chat-1', ['user-1', 'user-2', 'user-3']),
    ).resolves.toEqual(
      new Map([
        ['user-1', 'granted'],
        ['user-2', 'user_denied'],
        ['user-3', null],
      ]),
    );
    expect(redisInstance.mget).toHaveBeenCalledWith(
      ChatContextCacheService.adminAccessKey('chat-1', 'user-1'),
      ChatContextCacheService.adminAccessKey('chat-1', 'user-2'),
      ChatContextCacheService.adminAccessKey('chat-1', 'user-3'),
    );
  });

  it('patches cached chat admins without reloading chat context from prisma', async () => {
    const chatId = 'chat-1';
    const settings = buildSettings(chatId);
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: chatId,
          title: 'Chat title',
          settings,
          domains: [{ domain: 'example.com' }],
          admins: [{ userId: 'user-1' }],
          rules: null,
          primaryBotId: '777000_bot',
          botId: '777000_bot',
        }),
        upsert: jest.fn(),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      get: jest.Mock;
      set: jest.Mock;
    };
    redisInstance.get.mockResolvedValue(null);

    await service.getChatContext(chatId, 'Chat title');
    await service.rememberChatAdminUser(chatId, 'user-2');

    await expect(service.getChatContext(chatId)).resolves.toEqual(
      expect.objectContaining({
        adminUserIds: ['user-1', 'user-2'],
      }),
    );
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(1);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.cacheKey(chatId),
      expect.stringContaining('\"user-2\"'),
      'EX',
      60,
    );
  });

  it('stores and invalidates managed entity header cache entries', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      set: jest.Mock;
      get: jest.Mock;
      del: jest.Mock;
    };

    const header = {
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'chat' as const,
      link: 'https://max.ru/team',
      participantsCount: 42,
      primaryBotId: null,
      assignedBots: [],
      sharedMode: 'owned' as const,
    };

    await service.setManagedEntityHeader(header);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.managedEntityHeaderKey('chat-1', 'chat'),
      JSON.stringify(header),
      'EX',
      3600,
    );

    redisInstance.get.mockResolvedValueOnce(JSON.stringify(header));
    await expect(service.getManagedEntityHeader('chat-1', 'chat')).resolves.toEqual(header);

    await service.invalidateManagedEntityHeader('chat-1');
    expect(redisInstance.del).toHaveBeenCalledWith(
      ChatContextCacheService.managedEntityHeaderKey('chat-1', 'chat'),
      ChatContextCacheService.managedEntityHeaderKey('chat-1', 'channel'),
    );
  });

  it('fails open when managed entity header redis reads stall', async () => {
    jest.useFakeTimers();

    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      get: jest.Mock;
    };
    redisInstance.get.mockImplementationOnce(() => new Promise(() => undefined));

    const pendingHeader = service.getManagedEntityHeader('chat-1', 'channel');
    await jest.advanceTimersByTimeAsync(150);

    await expect(pendingHeader).resolves.toBeNull();
  });

  it('stores and reads managed entity bot avatar snapshots', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
      get: jest.fn().mockReturnValue(null),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      set: jest.Mock;
      get: jest.Mock;
    };

    await service.setManagedEntityBotProfile('777000_bot', {
      avatarUrl: 'https://cdn.max.ru/u/777000/avatar.jpg',
    });
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.managedEntityBotProfileKey('777000_bot'),
      JSON.stringify({ avatarUrl: 'https://cdn.max.ru/u/777000/avatar.jpg' }),
      'EX',
      6 * 60 * 60,
    );

    redisInstance.get.mockResolvedValueOnce(
      JSON.stringify({ avatarUrl: 'https://cdn.max.ru/u/777000/avatar.jpg' }),
    );

    await expect(service.getManagedEntityBotProfile('777000_bot')).resolves.toEqual({
      avatarUrl: 'https://cdn.max.ru/u/777000/avatar.jpg',
    });
  });

  it('stores managed entity refresh cooldown and backoff markers in redis', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      set: jest.Mock;
      get: jest.Mock;
      pttl: jest.Mock;
    };

    await service.activateManagedEntitiesRefreshCooldown('user-1', 'channel', 30);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.managedEntitiesRefreshCooldownKey('user-1', 'channel'),
      '1',
      'EX',
      30,
    );

    redisInstance.get.mockResolvedValueOnce('1');
    await expect(service.isManagedEntitiesRefreshCooldownActive('user-1', 'channel')).resolves.toBe(
      true,
    );

    await service.activateManagedEntitiesRefreshBackoff('user-1', 'channel', 60);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.managedEntitiesRefreshBackoffKey('user-1', 'channel'),
      '1',
      'EX',
      60,
    );

    redisInstance.get.mockResolvedValueOnce('1');
    await expect(service.isManagedEntitiesRefreshBackoffActive('user-1', 'channel')).resolves.toBe(
      true,
    );

    redisInstance.pttl.mockResolvedValueOnce(45_000);
    await expect(
      service.getManagedEntitiesRefreshBackoffRemainingMs('user-1', 'channel'),
    ).resolves.toBe(45_000);
  });

  it('stores managed giveaway runner retry state in redis', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      set: jest.Mock;
      pttl: jest.Mock;
      multi: jest.Mock;
      del: jest.Mock;
    };
    const exec = jest.fn().mockResolvedValue([
      [null, 3],
      [null, 1],
    ]);
    redisInstance.multi.mockReturnValue({
      incr: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec,
    });

    await service.activateManagedGiveawayRunnerBackoff('giveaway-1', 120);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.managedGiveawayRunnerBackoffKey('giveaway-1'),
      '1',
      'EX',
      120,
    );

    redisInstance.pttl.mockResolvedValueOnce(90_000);
    await expect(service.getManagedGiveawayRunnerBackoffRemainingMs('giveaway-1')).resolves.toBe(
      90_000,
    );

    await service.activateManagedGiveawayRunnerDefer('giveaway-1', 1800);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.managedGiveawayRunnerDeferKey('giveaway-1'),
      '1',
      'EX',
      1800,
    );

    redisInstance.pttl.mockResolvedValueOnce(600_000);
    await expect(service.getManagedGiveawayRunnerDeferRemainingMs('giveaway-1')).resolves.toBe(
      600_000,
    );

    await expect(
      service.incrementManagedGiveawayRunnerFailureCount('giveaway-1', 3600),
    ).resolves.toBe(3);
    expect(redisInstance.multi).toHaveBeenCalled();

    await service.clearManagedGiveawayRunnerRetryCounters('giveaway-1');
    expect(redisInstance.del).toHaveBeenCalledWith(
      ChatContextCacheService.managedGiveawayRunnerBackoffKey('giveaway-1'),
      ChatContextCacheService.managedGiveawayRunnerFailureCountKey('giveaway-1'),
    );

    await service.clearManagedGiveawayRunnerFailureState('giveaway-1');
    expect(redisInstance.del).toHaveBeenCalledWith(
      ChatContextCacheService.managedGiveawayRunnerBackoffKey('giveaway-1'),
      ChatContextCacheService.managedGiveawayRunnerFailureCountKey('giveaway-1'),
      ChatContextCacheService.managedGiveawayRunnerDeferKey('giveaway-1'),
    );
  });

  it('stores and restores managed entities published snapshots', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };
    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results[0].value as {
      get: jest.Mock;
      set: jest.Mock;
    };
    const snapshot = {
      version: 'snapshot-v1',
      builtAt: '2026-04-04T10:00:00.000Z',
      lastSyncedAt: '2026-04-04T09:59:00.000Z',
      itemCount: 1,
      itemsHash: 'hash-v1',
      items: [buildChatSummary('chat-1')],
    };

    await service.setManagedEntitiesPublishedSnapshot('admin-1', 'chat', snapshot, 3600);
    expect(redisInstance.set).toHaveBeenCalledWith(
      'chat:managed-view-snapshot:v1:chat:admin-1',
      JSON.stringify(snapshot),
      'EX',
      3600,
    );

    redisInstance.get.mockResolvedValueOnce(JSON.stringify(snapshot));
    await expect(service.getManagedEntitiesPublishedSnapshot('admin-1', 'chat')).resolves.toEqual(
      snapshot,
    );
  });

  it('stores and restores managed entities published diffs', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };
    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results[0].value as {
      get: jest.Mock;
      set: jest.Mock;
    };
    const diff = {
      baseVersion: 'snapshot-v1',
      nextVersion: 'snapshot-v2',
      added: [buildChatSummary('chat-2')],
      updated: [buildChatSummary('chat-3')],
      removedIds: ['chat-1'],
      orderedIds: ['chat-2', 'chat-3'],
      changeCount: 3,
    };

    await service.setManagedEntitiesPublishedDiff('admin-1', 'chat', 'snapshot-v1', diff, 3600);
    expect(redisInstance.set).toHaveBeenCalledWith(
      'chat:managed-view-diff:v1:chat:admin-1:snapshot-v1',
      JSON.stringify(diff),
      'EX',
      3600,
    );

    redisInstance.get.mockResolvedValueOnce(JSON.stringify(diff));
    await expect(
      service.getManagedEntitiesPublishedDiff('admin-1', 'chat', 'snapshot-v1'),
    ).resolves.toEqual(diff);
  });
});
