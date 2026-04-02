jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    pttl: jest.fn().mockResolvedValue(-2),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    multi: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
  })),
);

import Redis from 'ioredis';
import type { ChatSettings } from '@prisma/client';
import { ChatContextCacheService } from './chat-context-cache.service';

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
    linkRulesButtonEnabled: false,
    duplicateBotMessageEnabled: false,
    duplicateBotMessageText: '',
    duplicateBotButtonEnabled: false,
    duplicateBotButtonUrl: '',
    duplicateBotButtonText: 'Открыть',
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
    getContextOrDefaultBotId: jest.fn().mockReturnValue('777000_bot'),
    rememberChatBotBinding: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
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
      300,
    );

    redisInstance.get.mockResolvedValueOnce('bot_denied');
    await expect(service.getAdminAccess('chat-1', 'user-1')).resolves.toBe('bot_denied');
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
    const exec = jest.fn().mockResolvedValue([[null, 3], [null, 1]]);
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
});
