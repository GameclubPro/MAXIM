jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
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
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('handles chat create race (P2002) and still returns chat context', async () => {
    const chatId = 'chat-1';
    const settings = buildSettings(chatId);
    const prisma = {
      chat: {
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        update: jest.fn().mockResolvedValue(undefined),
        findUnique: jest.fn().mockResolvedValue({
          id: chatId,
          title: 'Chat title',
          settings,
          domains: [{ domain: 'example.com' }],
          admins: [{ userId: 'user-1' }],
        }),
      },
      chatSettings: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(prisma as never, config as never);
    const redisInstance = (Redis as unknown as jest.Mock).mock.results[0].value as {
      get: jest.Mock;
      set: jest.Mock;
    };
    redisInstance.get.mockResolvedValue(null);

    const context = await service.getChatContext(chatId, 'Chat title');

    expect(prisma.chatSettings.createMany).toHaveBeenCalledWith({
      data: [{ chatId }],
      skipDuplicates: true,
    });
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(1);
    expect(context).toEqual({
      chatId,
      title: 'Chat title',
      settings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });
    expect(redisInstance.set).toHaveBeenCalledTimes(1);
  });

  it('stores admin access decisions in redis with ttl', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService({} as never, config as never);
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      set: jest.Mock;
      get: jest.Mock;
    };

    await service.setAdminAccess('chat-1', 'user-1', 'granted');
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.adminAccessKey('chat-1', 'user-1'),
      'granted',
      'EX',
      60,
    );

    redisInstance.get.mockResolvedValueOnce('bot_denied');
    await expect(service.getAdminAccess('chat-1', 'user-1')).resolves.toBe('bot_denied');
  });

  it('stores and invalidates managed entity header cache entries', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService({} as never, config as never);
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
    };

    await service.setManagedEntityHeader(header);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.managedEntityHeaderKey('chat-1', 'chat'),
      JSON.stringify(header),
      'EX',
      60,
    );

    redisInstance.get.mockResolvedValueOnce(JSON.stringify(header));
    await expect(service.getManagedEntityHeader('chat-1', 'chat')).resolves.toEqual(header);

    await service.invalidateManagedEntityHeader('chat-1');
    expect(redisInstance.del).toHaveBeenCalledWith(
      ChatContextCacheService.managedEntityHeaderKey('chat-1', 'chat'),
      ChatContextCacheService.managedEntityHeaderKey('chat-1', 'channel'),
    );
  });

  it('stores managed entity refresh cooldown and backoff markers in redis', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService({} as never, config as never);
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      set: jest.Mock;
      get: jest.Mock;
    };

    await service.activateManagedEntitiesRefreshCooldown('user-1', 'channel', 30);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.managedEntitiesRefreshCooldownKey('user-1', 'channel'),
      '1',
      'EX',
      30,
    );

    redisInstance.get.mockResolvedValueOnce('1');
    await expect(
      service.isManagedEntitiesRefreshCooldownActive('user-1', 'channel'),
    ).resolves.toBe(true);

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
  });
});
