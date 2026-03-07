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
    duplicateKickEnabled: true,
    duplicateBanEnabled: true,
    antiDuplicateEnabled: true,
    duplicateWarnWindowSec: 43200,
    duplicateWarnMaxCount: 2,
    duplicateKickWindowSec: 86400,
    duplicateKickMaxCount: 3,
    duplicateBanWindowSec: 172800,
    duplicateBanMaxCount: 4,
    linkPolicy: 'ALLOWLIST_ONLY',
    greetingEnabled: false,
    greetingBotMessageEnabled: true,
    greetingBotMessageText: '',
    greetingBotButtonEnabled: false,
    greetingBotButtonUrl: '',
    greetingBotButtonText: 'Открыть',
    deleteBotMessagesEnabled: true,
    deleteBotMessagesDelayMinutes: 2,
    removeBotsFromGroupEnabled: false,
    globalUserBlacklistEnabled: false,
    globalCrossChatSpamEnabled: false,
    antiSpamEnabled: true,
    maxMessageLengthEnabled: false,
    maxMessageLength: 1500,
    photoMessageCooldownEnabled: false,
    photoMessageCooldownHours: 1,
    stickerMessageCooldownEnabled: false,
    stickerMessageCooldownMinutes: 5,
    videoMessagesEnabled: true,
    fileMessagesEnabled: true,
    voiceMessagesEnabled: true,
    messageLimitsBotMessageEnabled: false,
    messageLimitsBotMessageText: '',
    messageLimitsWarnEnabled: false,
    messageLimitsBanEnabled: false,
    messageLimitsKickEnabled: false,
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
    profanityKickEnabled: false,
    textFiltersBotMessageEnabled: false,
    textFiltersBotMessageText: '',
    textFiltersWarnEnabled: false,
    textFiltersWarnMessageText: '',
    textFiltersBanEnabled: false,
    textFiltersKickEnabled: false,
    textFiltersBotButtonEnabled: false,
    textFiltersBotButtonUrl: '',
    textFiltersBotButtonText: 'Открыть',
    realEstateTopicFilterEnabled: false,
    autoMarketTopicFilterEnabled: false,
    thematicFiltersBotMessageEnabled: false,
    thematicFiltersWarnEnabled: false,
    thematicFiltersBanEnabled: false,
    thematicFiltersKickEnabled: false,
    nightModeEnabled: false,
    nightModeStartTimeMinutes: 1380,
    nightModeEndTimeMinutes: 480,
    nightModeTimezone: 'Europe/Moscow',
    nightModeBotMessageEnabled: true,
    nightModeBotMessageText: '',
    nightModeBotButtonEnabled: false,
    nightModeBotButtonUrl: '',
    nightModeBotButtonText: 'Открыть',
    linkBotMessageEnabled: true,
    linkBotMessageText: '',
    linkWarnEnabled: false,
    linkWarnMessageText: '',
    linkBanEnabled: false,
    linkKickEnabled: false,
    linkBotButtonEnabled: false,
    linkBotButtonUrl: '',
    linkBotButtonText: 'Открыть',
    duplicateBotMessageEnabled: false,
    duplicateBotMessageText: '',
    duplicateBotButtonEnabled: false,
    duplicateBotButtonUrl: '',
    duplicateBotButtonText: 'Открыть',
    banDurationHours: 6,
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
    });
    expect(redisInstance.set).toHaveBeenCalledTimes(1);
  });
});
