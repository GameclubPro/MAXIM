jest.mock('ioredis', () => {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const subscribers = new Set<(channel: string, payload: string) => void>();

  const createInstance = () => {
    const messageHandlers = new Set<(channel: string, payload: string) => void>();
    const instance = {
      get: jest.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
      exists: jest.fn().mockImplementation(async (key: string) => (store.has(key) ? 1 : 0)),
      mget: jest
        .fn()
        .mockImplementation(async (...keys: string[]) => keys.map((key) => store.get(key) ?? null)),
      ttl: jest.fn().mockImplementation(async (key: string) => (store.has(key) ? 60 : -2)),
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
          if (sets.delete(key)) {
            deleted += 1;
          }
        }
        return deleted;
      }),
      sadd: jest.fn().mockImplementation(async (key: string, ...values: string[]) => {
        const current = sets.get(key) ?? new Set<string>();
        let added = 0;
        for (const value of values) {
          if (!current.has(value)) {
            added += 1;
          }
          current.add(value);
        }
        sets.set(key, current);
        return added;
      }),
      smembers: jest
        .fn()
        .mockImplementation(async (key: string) => Array.from(sets.get(key) ?? [])),
      expire: jest
        .fn()
        .mockImplementation(async (key: string) => (store.has(key) || sets.has(key) ? 1 : 0)),
      eval: jest
        .fn()
        .mockImplementation(async (script: string, keyCount: number, ...input: string[]) => {
          const keys = input.slice(0, keyCount);
          const args = input.slice(keyCount);
          const publish = (channel: string, payload: string) => {
            for (const subscriber of subscribers) {
              subscriber(channel, payload);
            }
          };

          if (script.includes('incoming_timestamp')) {
            const incomingTimestamp = Number(args[0]);
            const incomingPriority = Number(args[1]);
            const currentEpoch = store.get(keys[0] ?? '');
            if (currentEpoch) {
              const [timestamp, priority] = currentEpoch.split(':').map(Number);
              if (
                timestamp > incomingTimestamp ||
                (timestamp === incomingTimestamp && priority > incomingPriority)
              ) {
                return 0;
              }
            }

            const opaqueKeyIndexes = [2, 4, 5, 6, 7, 8, 9];
            for (let index = 0; index < opaqueKeyIndexes.length; index += 1) {
              const offset = 8 + index * 5;
              const actual = store.get(keys[opaqueKeyIndexes[index] ?? -1] ?? '');
              const matches =
                args[offset] === '1' ? actual === args[offset + 1] : actual === undefined;
              if (!matches) {
                return -1;
              }
            }
            for (let index = 0; index < opaqueKeyIndexes.length; index += 1) {
              const key = keys[opaqueKeyIndexes[index] ?? -1] ?? '';
              const offset = 8 + index * 5;
              if (args[offset + 2] === 'set') {
                store.set(key, args[offset + 3] ?? '');
              } else if (args[offset + 2] === 'delete') {
                store.delete(key);
              }
            }
            store.set(keys[0] ?? '', args[2] ?? '');
            store.set(keys[1] ?? '', args[3] ?? '');
            store.set(keys[3] ?? '', String(Number(store.get(keys[3] ?? '') ?? '0') + 1));
            const recentMode = args[43];
            const recentEntityType = args[45];
            if (recentMode === 'grant') {
              const setKey = recentEntityType === 'chat' ? keys[10] : keys[11];
              if (setKey) {
                const users = sets.get(setKey) ?? new Set<string>();
                users.add(args[5] ?? '');
                sets.set(setKey, users);
              }
            } else if (recentMode === 'deny') {
              sets.get(keys[10] ?? '')?.delete(args[5] ?? '');
              sets.get(keys[11] ?? '')?.delete(args[5] ?? '');
            }
            publish(args[6] ?? '', args[7] ?? '');
            return 1;
          }

          if (script.includes('managed_entities_published_snapshot_set_cas')) {
            const actual = store.get(keys[0] ?? '');
            const matches = args[0] === '1' ? actual === args[1] : actual === undefined;
            if (!matches) {
              return 0;
            }
            store.set(keys[0] ?? '', args[2] ?? '');
            return 1;
          }

          if (script.includes('managed_entities_recent_bootstrap_upsert_cas')) {
            const global = store.get(keys[0] ?? '');
            const globalMatches = args[0] === '1' ? global === args[1] : global === undefined;
            if (!globalMatches) {
              return 0;
            }
            if (args[3] === '1') {
              const userScoped = store.get(keys[1] ?? '');
              const userMatches =
                args[4] === '1' ? userScoped === args[5] : userScoped === undefined;
              if (!userMatches) {
                return 0;
              }
            }
            store.set(keys[0] ?? '', args[2] ?? '');
            store.set(keys[2] ?? '', '1');
            if (args[3] === '1') {
              store.set(keys[1] ?? '', args[6] ?? '');
              const users = sets.get(keys[3] ?? '') ?? new Set<string>();
              users.add(args[8] ?? '');
              sets.set(keys[3] ?? '', users);
            }
            return 1;
          }

          if (script.includes('managed_entities_recent_bootstrap_remove_cas')) {
            const actual = store.get(keys[0] ?? '');
            const matches = args[0] === '1' ? actual === args[1] : actual === undefined;
            if (!matches) {
              return 0;
            }
            if (args[2] === 'set') {
              store.set(keys[0] ?? '', args[3] ?? '');
            } else if (args[2] === 'delete') {
              store.delete(keys[0] ?? '');
            }
            if (args[5] === 'global') {
              store.delete(keys[1] ?? '');
            } else {
              sets.get(keys[2] ?? '')?.delete(args[6] ?? '');
            }
            return 1;
          }

          if (script.includes('revision ~= ARGV[1]')) {
            if ((store.get(keys[0] ?? '') ?? '0') !== args[0]) {
              return 0;
            }
            store.set(keys[1] ?? '', args[1] ?? '');
            return 1;
          }
          if (script.includes('revision ~= ARGV[2]')) {
            if (
              store.get(keys[0] ?? '') !== args[0] ||
              (store.get(keys[1] ?? '') ?? '0') !== args[1]
            ) {
              return 0;
            }
            store.set(keys[0] ?? '', args[2] ?? '');
            store.set(keys[1] ?? '', String(Number(store.get(keys[1] ?? '') ?? '0') + 1));
            publish(args[3] ?? '', args[4] ?? '');
            return 1;
          }
          if (
            script.includes("redis.call('INCR', KEYS[1])") &&
            script.includes("redis.call('DEL', KEYS[2])")
          ) {
            store.set(keys[0] ?? '', String(Number(store.get(keys[0] ?? '') ?? '0') + 1));
            store.delete(keys[1] ?? '');
            publish(args[0] ?? '', args[1] ?? '');
            return 1;
          }

          const [currentKey, oppositeKey] = keys;
          const [
            expectedCurrentExists,
            expectedCurrent,
            expectedOppositeExists,
            expectedOpposite,
            nextCurrent,
            oppositeAction,
            nextOpposite,
          ] = args;
          const current = store.get(currentKey);
          const opposite = store.get(oppositeKey);
          const currentMatches =
            expectedCurrentExists === '1' ? current === expectedCurrent : current === undefined;
          const oppositeMatches =
            expectedOppositeExists === '1' ? opposite === expectedOpposite : opposite === undefined;
          if (!currentMatches || !oppositeMatches) {
            return 0;
          }

          store.set(currentKey, nextCurrent);
          if (oppositeAction === 'set') {
            store.set(oppositeKey, nextOpposite);
          } else if (oppositeAction === 'delete') {
            store.delete(oppositeKey);
          }
          return 1;
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
      multi: jest.fn().mockImplementation(() => {
        const operations: Array<[keyof typeof instance, ...unknown[]]> = [];
        const pipeline = {
          set: (key: string, value: string, ...args: unknown[]) => {
            operations.push(['set', key, value, ...args]);
            return pipeline;
          },
          del: (...keys: string[]) => {
            operations.push(['del', ...keys]);
            return pipeline;
          },
          sadd: (key: string, ...values: string[]) => {
            operations.push(['sadd', key, ...values]);
            return pipeline;
          },
          expire: (key: string, ttlSec: number) => {
            operations.push(['expire', key, ttlSec]);
            return pipeline;
          },
          incr: (key: string) => {
            operations.push(['set', key, String(Number(store.get(key) ?? '0') + 1)]);
            return pipeline;
          },
          exec: jest.fn().mockImplementation(async () => {
            const results: Array<[null, unknown]> = [];
            for (const [method, ...args] of operations) {
              results.push([
                null,
                await (instance[method] as (...values: unknown[]) => Promise<unknown>)(...args),
              ]);
            }
            return results;
          }),
        };
        return pipeline;
      }),
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
      __sets: sets,
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
import type { ChatSettings } from '../prisma/prisma-client';
import {
  ChatContextCacheService,
  type ManagedEntitiesPublishedSnapshot,
} from './chat-context-cache.service';

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
    duplicatePhotoEnabled: false,
    duplicatePhotoMatchPreset: 'SAME_IMAGE',
    duplicatePhotoScope: 'SAME_AUTHOR',
    duplicateDetectionPreset: 'STANDARD',
    duplicateIgnoreLinksEnabled: false,
    duplicateIgnorePhonesEnabled: false,
    duplicateNearMatchEnabled: false,
    duplicateWarnWindowSec: 43200,
    duplicateWarnMaxCount: 2,
    duplicateMuteWindowSec: 86400,
    duplicateMuteMaxCount: 3,
    duplicateMuteDurationHours: 6,
    duplicateBanWindowSec: 172800,
    duplicateBanMaxCount: 4,
    linkPolicy: 'ALLOWLIST_ONLY',
    linkPolicyRevision: 1,
    linkPolicyEffectiveAt: now,
    linkEscalationWindowHours: 24,
    linkWarnMaxCount: 2,
    linkMuteMaxCount: 3,
    linkBanMaxCount: 4,
    botSpeechStyle: null,
    botSpeechMedia: {},
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
    karavanStorefrontEnabled: false,
    karavanStorefrontAdminsOnly: false,
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
    photoMessagesEnabled: true,
    videoMessagesEnabled: true,
    fileMessagesEnabled: true,
    voiceMessagesEnabled: true,
    phoneNumbersEnabled: true,
    phoneNumbersBotMessageEnabled: false,
    phoneNumbersBotMessageText: '',
    phoneNumbersWarnEnabled: false,
    phoneNumbersMuteEnabled: false,
    phoneNumbersMuteDurationHours: 6,
    phoneNumbersBanEnabled: false,
    phoneNumbersEscalationWindowHours: 12,
    phoneNumbersWarnMaxCount: 2,
    phoneNumbersMuteMaxCount: 3,
    phoneNumbersBanMaxCount: 4,
    phoneNumbersAdminContactButtonEnabled: false,
    phoneNumbersAdminContactButtonUrl: '',
    messageLimitsBlockedWords: [],
    messageLimitsBlockedDomains: [],
    messageLimitsBotMessageEnabled: false,
    messageLimitsBotMessageText: '',
    messageLimitsWarnEnabled: false,
    messageLimitsWarnMessageText: '',
    messageLimitsBanEnabled: false,
    messageLimitsMuteEnabled: false,
    messageLimitsMuteDurationHours: 6,
    messageLimitsAdminContactButtonEnabled: false,
    messageLimitsAdminContactButtonUrl: '',
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
    profanityAdminContactButtonEnabled: false,
    profanityAdminContactButtonUrl: '',
    textFiltersBotMessageEnabled: false,
    textFiltersBotMessageText: '',
    textFiltersWarnEnabled: false,
    textFiltersWarnMessageText: '',
    textFiltersBanEnabled: false,
    textFiltersMuteEnabled: false,
    textFiltersMuteDurationHours: 6,
    textFiltersAdminContactButtonEnabled: false,
    textFiltersAdminContactButtonUrl: '',
    textFiltersBotButtonEnabled: false,
    textFiltersBotButtonUrl: '',
    textFiltersBotButtonText: 'Открыть',
    textFiltersBotButtons: [],
    textFiltersRulesButtonEnabled: false,
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
    requiredSubscriptionButtonText: '',
    requiredSubscriptionAdminContactButtonEnabled: false,
    requiredSubscriptionAdminContactButtonUrl: '',
    requiredSubscriptionWarnEnabled: false,
    requiredSubscriptionWarnMessageText: '',
    requiredSubscriptionBanEnabled: false,
    requiredSubscriptionMuteEnabled: false,
    requiredSubscriptionMuteDurationHours: 6,
    requiredSubscriptionDurationDays: 7,
    requiredSubscriptionExpiresAt: '',
    invitationAccessEnabled: false,
    invitationAccessRequiredCount: 1,
    invitationAccessBotMessageEnabled: true,
    invitationAccessBotMessageText: '',
    invitationAccessAdminContactButtonEnabled: false,
    invitationAccessAdminContactButtonUrl: '',
    invitationAccessWarnEnabled: false,
    invitationAccessWarnMessageText: '',
    invitationAccessBanEnabled: false,
    invitationAccessMuteEnabled: false,
    invitationAccessMuteDurationHours: 6,
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
    linkAdminContactButtonEnabled: false,
    linkAdminContactButtonUrl: '',
    linkBotButtonEnabled: false,
    linkBotButtonUrl: '',
    linkBotButtonText: 'Открыть',
    linkBotButtons: [],
    linkRulesButtonEnabled: false,
    duplicateBotMessageEnabled: false,
    duplicateBotMessageText: '',
    duplicateAdminContactButtonEnabled: false,
    duplicateAdminContactButtonUrl: '',
    duplicateBotButtonEnabled: false,
    duplicateBotButtonUrl: '',
    duplicateBotButtonText: 'Открыть',
    duplicateBotButtons: [],
    duplicateRulesButtonEnabled: false,
    messageLimitsRulesButtonEnabled: false,
    rulesAttachViolationsEnabled: true,
    adminBanCommandName: 'бан',
    adminBanAllCommandName: 'Бан!',
    adminMuteCommandName: 'мут',
    adminPermanentMuteCommandName: 'мут 88',
    adminRulesCommandName: 'правило',
    adminSilenceCommandName: 'тишина',
    adminOpenChatCommandName: 'тишина выкл',
    adminMuteCommandAliases: 'мут, мьют, мью, mute',
    adminRulesCommandAliases: 'правило, правила, rule, rules',
    muteDurationHours: 6,
    warnThreshold: 3,
    createdAt: now,
    updatedAt: now,
  };
}

function createConfigMock() {
  return {
    getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    get: jest.fn((_key: string, fallback?: unknown) => fallback),
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
    (Redis as unknown as { __sets: Map<string, Set<string>> }).__sets.clear();
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

  it('disables Redis ready check on the pub/sub subscriber connection', () => {
    const prisma = {} as never;

    new ChatContextCacheService(prisma, createConfigMock() as never, maxBotLinkService as never);

    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      duplicate: jest.Mock;
    };
    expect(redisInstance.duplicate).toHaveBeenCalledWith({ enableReadyCheck: false });
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
    expect(redisInstance.get).toHaveBeenCalledTimes(2);
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
      eval: jest.Mock;
      del: jest.Mock;
    };
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    store.set(
      ChatContextCacheService.cacheKey(chatId),
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
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(redisInstance.eval).toHaveBeenCalledWith(
      expect.stringContaining('revision ~= ARGV[2]'),
      2,
      ChatContextCacheService.cacheKey(chatId),
      ChatContextCacheService.chatContextRevisionKey(chatId),
      expect.stringContaining('"title":"Chat 1"'),
      '0',
      expect.stringContaining('"title":"Fresh title"'),
      expect.any(String),
      expect.any(String),
    );
    expect(store.get(ChatContextCacheService.cacheKey(chatId))).toEqual(
      expect.stringContaining('"title":"Fresh title"'),
    );
    expect(redisInstance.del).not.toHaveBeenCalled();
    expect(redisInstance.get).toHaveBeenCalledTimes(2);
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

  it('stores chat admin lookup backoff markers in redis with ttl', async () => {
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
    };

    await service.activateAdminLookupBackoff(' chat-1 ', 30);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.adminLookupBackoffKey('chat-1'),
      '1',
      'EX',
      30,
    );

    redisInstance.pttl.mockResolvedValueOnce(12_000);
    await expect(service.getAdminLookupBackoffRemainingMs(' chat-1 ')).resolves.toBe(12_000);
    expect(redisInstance.pttl).toHaveBeenCalledWith(
      ChatContextCacheService.adminLookupBackoffKey('chat-1'),
    );
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
      eval: jest.Mock;
    };

    await service.getChatContext(chatId, 'Chat title');
    await service.rememberChatAdminUser(chatId, 'user-2');

    await expect(service.getChatContext(chatId)).resolves.toEqual(
      expect.objectContaining({
        adminUserIds: ['user-1', 'user-2'],
      }),
    );
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(1);
    expect(redisInstance.eval).toHaveBeenCalledWith(
      expect.stringContaining('revision ~= ARGV[2]'),
      2,
      ChatContextCacheService.cacheKey(chatId),
      ChatContextCacheService.chatContextRevisionKey(chatId),
      expect.stringContaining('"user-1"'),
      expect.any(String),
      expect.stringContaining('"user-2"'),
      expect.any(String),
      expect.any(String),
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
      accessDiagnostics: {
        state: 'ok' as const,
        lastDetectedAt: null,
        lastCheckedAt: null,
        freshUntil: null,
        source: 'unknown' as const,
        activeBotCount: 0,
        lostBots: [],
      },
      viewerAccess: {
        state: 'checking' as const,
        reason: null,
        checkedAt: null,
        canEdit: false,
      },
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

    await service.activateManagedRefreshSourceBackoff(15);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.managedRefreshSourceBackoffKey(),
      '1',
      'EX',
      15,
    );

    redisInstance.get.mockResolvedValueOnce('1');
    await expect(service.isManagedRefreshSourceBackoffActive()).resolves.toBe(true);

    redisInstance.pttl.mockResolvedValueOnce(12_000);
    await expect(service.getManagedRefreshSourceBackoffRemainingMs()).resolves.toBe(12_000);
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
      eval: jest.Mock;
    };
    const snapshot = {
      version: 'snapshot-v1',
      builtAt: '2026-04-04T10:00:00.000Z',
      lastSyncedAt: '2026-04-04T09:59:00.000Z',
      itemCount: 1,
      itemsHash: 'hash-v1',
      items: [buildChatSummary('chat-1')],
    };

    await expect(
      service.setManagedEntitiesPublishedSnapshot('admin-1', 'chat', snapshot, 3600, {
        expectedVersion: null,
      }),
    ).resolves.toBe(true);
    expect(redisInstance.eval).toHaveBeenCalledWith(
      expect.stringContaining('managed_entities_published_snapshot_set_cas'),
      1,
      'chat:managed-view-snapshot:v1:chat:admin-1',
      '0',
      '',
      JSON.stringify(snapshot),
      '3600',
    );

    await expect(service.getManagedEntitiesPublishedSnapshot('admin-1', 'chat')).resolves.toEqual(
      snapshot,
    );
  });

  it('atomically upserts a visible entity and removes a stale opposite-tab card', async () => {
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
      eval: jest.Mock;
    };
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const currentKey = 'chat:managed-view-snapshot:v1:channel:admin-1';
    const oppositeKey = 'chat:managed-view-snapshot:v1:chat:admin-1';
    const staleSummary = {
      ...buildChatSummary('-100-forwarded'),
      link: 'https://max.ru/old-link',
      avatarUrl: 'https://cdn.max/old-avatar.png',
    };
    store.set(
      oppositeKey,
      JSON.stringify({
        version: 'old-chat-snapshot',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:00.000Z',
        itemCount: 1,
        itemsHash: 'old-hash',
        items: [staleSummary],
      }),
    );
    const baseSummary = buildChatSummary('-100-forwarded');
    const summary = {
      id: baseSummary.id,
      title: 'Новый канал',
      entityType: 'channel' as const,
      createdAt: baseSummary.createdAt,
      avatarUrl: null as string | null,
      channelOverview: baseSummary.channelOverview,
      primaryBotId: baseSummary.primaryBotId,
      assignedBots: baseSummary.assignedBots,
      sharedMode: baseSummary.sharedMode,
    };

    await service.upsertManagedEntityPublishedSnapshot('admin-1', summary, 3600);

    expect(redisInstance.eval).toHaveBeenCalledTimes(1);
    expect(redisInstance.eval.mock.calls[0]?.slice(1, 4)).toEqual([2, currentKey, oppositeKey]);
    expect(store.has(oppositeKey)).toBe(false);
    const stored = JSON.parse(store.get(currentKey) ?? 'null') as ManagedEntitiesPublishedSnapshot;
    expect(stored.version).toMatch(/^handshake:-100-forwarded:[0-9a-f-]+:current$/u);
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0]).toEqual(
      expect.objectContaining({
        id: '-100-forwarded',
        title: 'Новый канал',
        link: 'https://max.ru/old-link',
        avatarUrl: null,
        assignedBots: [],
      }),
    );
    expect(Array.isArray(stored.items[0]?.assignedBots)).toBe(true);
    await expect(
      service.getManagedEntitiesPublishedSnapshot('admin-1', 'channel'),
    ).resolves.toEqual(stored);
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

  it('returns user-scoped recent bootstrap entries before the larger global cache', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };
    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const userScoped = {
      ...buildChatSummary('chat-user'),
      title: 'User scoped chat',
    };
    const global = [
      ...Array.from({ length: 25 }, (_, index) => ({
        ...buildChatSummary(`chat-global-${index + 1}`),
        title: `Global chat ${index + 1}`,
      })),
      {
        ...buildChatSummary('chat-user'),
        title: 'Global stale title',
      },
    ];
    store.set(
      ChatContextCacheService.managedEntitiesRecentBootstrapKey('chat'),
      JSON.stringify(global),
    );
    store.set(
      ChatContextCacheService.managedEntitiesRecentBootstrapUserKey('chat', 'admin-1'),
      JSON.stringify([userScoped]),
    );

    await expect(service.getManagedEntitiesRecentBootstrap('chat', ' admin-1 ')).resolves.toEqual([
      expect.objectContaining({
        id: 'chat-user',
        title: 'User scoped chat',
        bootstrapUserIds: ['admin-1'],
      }),
      ...global.slice(0, 25),
    ]);
  });

  it('stores and clears user-scoped recent bootstrap rows by chat id', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };
    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );

    await service.upsertManagedEntitiesRecentBootstrap(
      buildChatSummary('chat-new'),
      900,
      'admin-1',
    );

    await expect(service.getManagedEntitiesRecentBootstrap('chat', 'admin-1')).resolves.toEqual([
      expect.objectContaining({
        id: 'chat-new',
        bootstrapUserIds: ['admin-1'],
      }),
    ]);

    await service.clearManagedEntitiesRecentBootstrapForChat('chat-new', 'chat');

    await expect(service.getManagedEntitiesRecentBootstrap('chat', 'admin-1')).resolves.toEqual([]);
  });

  it('merges concurrent standalone recent bootstrap upserts for the same user', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );

    await Promise.all([
      service.upsertManagedEntitiesRecentBootstrap(buildChatSummary('chat-a'), 900, 'admin-1'),
      service.upsertManagedEntitiesRecentBootstrap(buildChatSummary('chat-b'), 900, 'admin-1'),
    ]);

    const recent = await service.getManagedEntitiesRecentBootstrap('chat', 'admin-1');
    expect(recent.map((item) => item.id).sort()).toEqual(['chat-a', 'chat-b']);
  });

  it('preserves a concurrent recent bootstrap upsert while removing another item', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    await service.upsertManagedEntitiesRecentBootstrap(
      buildChatSummary('chat-remove'),
      900,
      'admin-1',
    );
    await service.upsertManagedEntitiesRecentBootstrap(
      buildChatSummary('chat-keep'),
      900,
      'admin-1',
    );

    await Promise.all([
      service.clearManagedEntitiesRecentBootstrapForChat('chat-remove', 'chat'),
      service.upsertManagedEntitiesRecentBootstrap(buildChatSummary('chat-new'), 900, 'admin-1'),
    ]);

    const recent = await service.getManagedEntitiesRecentBootstrap('chat', 'admin-1');
    expect(recent.map((item) => item.id).sort()).toEqual(['chat-keep', 'chat-new']);
  });

  it('lets an equal-millisecond removal beat a grant and rejects its delayed replay', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const eventAt = new Date('2026-08-20T10:00:00.123Z');

    await expect(
      service.applyAdminAccessEpochMutation({
        chatId: 'chat-epoch',
        userId: 'user-1',
        state: 'granted',
        eventAt,
        publishedSummary: buildChatSummary('chat-epoch'),
      }),
    ).resolves.toBe(true);
    await expect(
      service.applyAdminAccessEpochMutation({
        chatId: 'chat-epoch',
        userId: 'user-1',
        state: 'user_denied',
        eventAt,
      }),
    ).resolves.toBe(true);
    await expect(
      service.applyAdminAccessEpochMutation({
        chatId: 'chat-epoch',
        userId: 'user-1',
        state: 'granted',
        eventAt,
        publishedSummary: buildChatSummary('chat-epoch'),
      }),
    ).resolves.toBe(false);

    expect(store.get(ChatContextCacheService.adminAccessKey('chat-epoch', 'user-1'))).toBe(
      'user_denied',
    );
    expect(
      store.has(ChatContextCacheService.managedEntitiesPublishedSnapshotKey('user-1', 'chat')),
    ).toBe(false);
  });

  it('accepts a newer grant after an older removal epoch', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );

    await service.applyAdminAccessEpochMutation({
      chatId: 'chat-newer-grant',
      userId: 'user-1',
      state: 'user_denied',
      eventAt: new Date('2026-08-20T10:00:00.000Z'),
    });
    await expect(
      service.applyAdminAccessEpochMutation({
        chatId: 'chat-newer-grant',
        userId: 'user-1',
        state: 'granted',
        eventAt: new Date('2026-08-20T10:00:00.001Z'),
      }),
    ).resolves.toBe(true);
    await expect(service.getAdminAccess('chat-newer-grant', 'user-1')).resolves.toBe('granted');
  });

  it('removes only the affected published card under a denial epoch', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const other = buildChatSummary('chat-other');
    await service.setManagedEntitiesPublishedSnapshot(
      'user-1',
      'chat',
      {
        version: 'before-denial',
        builtAt: '2026-08-20T09:00:00.000Z',
        lastSyncedAt: null,
        itemCount: 2,
        itemsHash: 'before-denial',
        items: [buildChatSummary('chat-remove'), other],
      },
      3600,
      { expectedVersion: null },
    );

    await service.applyAdminAccessEpochMutation({
      chatId: 'chat-remove',
      userId: 'user-1',
      state: 'user_denied',
      eventAt: new Date('2026-08-20T10:00:00.000Z'),
    });

    await expect(service.getManagedEntitiesPublishedSnapshot('user-1', 'chat')).resolves.toEqual(
      expect.objectContaining({ items: [other], itemCount: 1 }),
    );
  });

  it('merges concurrent published grants for different chats of the same user', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );

    await Promise.all([
      service.applyAdminAccessEpochMutation({
        chatId: 'chat-a',
        userId: 'user-1',
        state: 'granted',
        eventAt: new Date('2026-08-20T10:00:00.000Z'),
        publishedSummary: buildChatSummary('chat-a'),
      }),
      service.applyAdminAccessEpochMutation({
        chatId: 'chat-b',
        userId: 'user-1',
        state: 'granted',
        eventAt: new Date('2026-08-20T10:00:00.001Z'),
        publishedSummary: buildChatSummary('chat-b'),
      }),
    ]);

    const snapshot = await service.getManagedEntitiesPublishedSnapshot('user-1', 'chat');
    expect(snapshot?.items.map((item) => item.id).sort()).toEqual(['chat-a', 'chat-b']);
  });

  it('rejects a stale full snapshot rebuild after an item-level grant', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const baseSnapshot: ManagedEntitiesPublishedSnapshot = {
      version: 'full-rebuild-base',
      builtAt: '2026-08-20T09:00:00.000Z',
      lastSyncedAt: null,
      itemCount: 1,
      itemsHash: 'full-rebuild-base',
      items: [buildChatSummary('chat-base')],
    };
    await service.setManagedEntitiesPublishedSnapshot('user-1', 'chat', baseSnapshot, 3600, {
      expectedVersion: null,
    });
    await service.applyAdminAccessEpochMutation({
      chatId: 'chat-concurrent-grant',
      userId: 'user-1',
      state: 'granted',
      eventAt: new Date('2026-08-20T10:00:00.000Z'),
      publishedSummary: buildChatSummary('chat-concurrent-grant'),
    });

    await expect(
      service.setManagedEntitiesPublishedSnapshot(
        'user-1',
        'chat',
        {
          ...baseSnapshot,
          version: 'stale-full-rebuild',
          builtAt: '2026-08-20T10:00:01.000Z',
        },
        3600,
        { expectedVersion: baseSnapshot.version },
      ),
    ).resolves.toBe(false);
    const stored = await service.getManagedEntitiesPublishedSnapshot('user-1', 'chat');
    expect(stored?.items.map((item) => item.id).sort()).toEqual([
      'chat-base',
      'chat-concurrent-grant',
    ]);
  });

  it('rejects a stale full-context load after an access mutation bumps the revision', async () => {
    let resolveOldRow!: (value: unknown) => void;
    const oldRow = new Promise((resolve) => {
      resolveOldRow = resolve;
    });
    const settings = buildSettings('chat-load-race');
    const staleRow = {
      id: 'chat-load-race',
      title: 'Race chat',
      settings,
      domains: [],
      admins: [{ userId: 'user-1' }],
      rules: null,
      primaryBotId: '777000_bot',
      botId: '777000_bot',
    };
    const freshRow = { ...staleRow, admins: [] };
    const prisma = {
      chat: {
        findUnique: jest.fn().mockReturnValueOnce(oldRow).mockResolvedValue(freshRow),
        upsert: jest.fn(),
      },
    };
    const service = new ChatContextCacheService(
      prisma as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );

    const pending = service.getChatContext('chat-load-race');
    await Promise.resolve();
    await Promise.resolve();
    await service.applyAdminAccessEpochMutation({
      chatId: 'chat-load-race',
      userId: 'user-1',
      state: 'user_denied',
      eventAt: new Date('2026-08-20T10:00:00.000Z'),
    });
    resolveOldRow(staleRow);

    await expect(pending).resolves.toEqual(expect.objectContaining({ adminUserIds: [] }));
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(2);
  });

  it('retries a denial when a stale context appears after the initial CAS read', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const contextKey = ChatContextCacheService.cacheKey('chat-missing-context-race');
    const staleContext = {
      chatId: 'chat-missing-context-race',
      title: 'Race chat',
      settings: buildSettings('chat-missing-context-race'),
      domainAllowlist: [],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    };
    const redis = (
      service as unknown as {
        redis: { eval: jest.Mock<Promise<unknown>, unknown[]> };
      }
    ).redis;
    const evaluate = redis.eval.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    redis.eval.mockImplementationOnce((...args: unknown[]) => {
      store.set(contextKey, JSON.stringify(staleContext));
      return evaluate(...args);
    });

    await expect(
      service.applyAdminAccessEpochMutation({
        chatId: 'chat-missing-context-race',
        userId: 'user-1',
        state: 'user_denied',
        eventAt: new Date('2026-08-20T10:00:00.000Z'),
      }),
    ).resolves.toBe(true);

    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(JSON.parse(store.get(contextKey) ?? 'null')).toEqual(
      expect.objectContaining({ adminUserIds: [] }),
    );
  });

  it('does not let a delayed title patch restore an admin removed from cached context', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const staleContext = {
      chatId: 'chat-title-race',
      title: 'Old title',
      settings: buildSettings('chat-title-race'),
      domainAllowlist: [],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    };
    store.set(ChatContextCacheService.cacheKey('chat-title-race'), JSON.stringify(staleContext));
    await service.applyAdminAccessEpochMutation({
      chatId: 'chat-title-race',
      userId: 'user-1',
      state: 'user_denied',
      eventAt: new Date('2026-08-20T10:00:00.000Z'),
    });

    (
      service as unknown as {
        reconcileCachedChatTitle: (
          chatId: string,
          value: typeof staleContext,
          title: string,
        ) => unknown;
      }
    ).reconcileCachedChatTitle('chat-title-race', staleContext, 'New title');
    await Promise.resolve();
    await Promise.resolve();

    const stored = JSON.parse(
      store.get(ChatContextCacheService.cacheKey('chat-title-race')) ?? 'null',
    ) as { title: string; adminUserIds: string[] };
    expect(stored).toEqual(expect.objectContaining({ title: 'New title', adminUserIds: [] }));
  });
});
