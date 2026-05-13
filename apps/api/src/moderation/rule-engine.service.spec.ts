import { LinkPolicy, type ChatSettings } from '@prisma/client';
import {
  COMMERCIAL_REAL_WORLD_NEGATIVE_CASES,
  COMMERCIAL_REAL_WORLD_POSITIVE_CASES,
} from './commercial-real-world.fixture';
import type { CommercialCampaignContext } from './commercial-campaign.util';
import {
  PROFANITY_EXACT_VARIANT_COUNT,
  TARGETED_INSULT_VARIANT_COUNT,
} from './profanity-lexicon';
import { RuleEngineService } from './rule-engine.service';

class MockRedisCounterService {
  private readonly counters = new Map<string, number>();

  async incrementWithTtl(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }
}

function buildSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  const base: ChatSettings = {
    id: '1',
    chatId: 'chat-1',
    duplicateWarnEnabled: true,
    duplicateMuteEnabled: true,
    duplicateBanEnabled: true,
    antiDuplicateEnabled: true,
    duplicateWarnWindowSec: 12 * 60 * 60,
    duplicateWarnMaxCount: 2,
    duplicateMuteWindowSec: 24 * 60 * 60,
    duplicateMuteMaxCount: 3,
    duplicateMuteDurationHours: 6,
    duplicateBanWindowSec: 48 * 60 * 60,
    duplicateBanMaxCount: 4,
    linkPolicy: LinkPolicy.ALLOWLIST_ONLY,
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
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
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
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    ...base,
    ...overrides,
  };
}

const DUPLICATE_SPAM_TEXT = 'продам курс по маркетингу пишите в личные сообщения сегодня скидка';

const COMMERCIAL_SENSITIVITY_PROFILES = {
  soft: {
    commercialAdsSensitivity: 'BALANCED' as const,
    commercialAdsWarnThreshold: 60,
    commercialAdsDeleteThreshold: 82,
  },
  balanced: {
    commercialAdsSensitivity: 'BALANCED' as const,
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
  },
  strict: {
    commercialAdsSensitivity: 'STRICT' as const,
    commercialAdsWarnThreshold: 38,
    commercialAdsDeleteThreshold: 55,
  },
};

function createRuleEngine(): RuleEngineService {
  return new RuleEngineService(new MockRedisCounterService() as never);
}

async function detectCommercialViolation(
  service: RuleEngineService,
  text: string,
  overrides: Partial<ChatSettings> = {},
  options: {
    commercialCampaignContext?: CommercialCampaignContext | null;
  } = {},
) {
  const result = await service.detect({
    chatId: 'chat-1',
    userId: 'u-1',
    text,
    settings: buildSettings({
      commercialAdsFilterEnabled: true,
      ...overrides,
    }),
    domainAllowlist: [],
    commercialCampaignContext: options.commercialCampaignContext,
  });

  return result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
}

describe('RuleEngineService', () => {
  it('ships with 2000+ exact profanity and insult variants', () => {
    expect(PROFANITY_EXACT_VARIANT_COUNT).toBeGreaterThanOrEqual(2000);
  });

  it('ships with a targeted-insult lexicon for ambiguous user-directed abuse', () => {
    expect(TARGETED_INSULT_VARIANT_COUNT).toBeGreaterThanOrEqual(250);
  });

  it('detects profanity and blocked links', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ты блять иди на http://bad.com',
      settings: buildSettings(),
      domainAllowlist: ['https://example.com'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('fails open when duplicate-state lookup stalls', async () => {
    jest.useFakeTimers();
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const redisCounter = {
        incrementWithTtl: jest.fn().mockImplementation(
          () =>
            new Promise<number>(() => {
              // Intentionally never resolves.
            }),
        ),
      };
      const service = new RuleEngineService(redisCounter as never);
      const resultPromise = service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: DUPLICATE_SPAM_TEXT,
        settings: buildSettings({
          antiDuplicateEnabled: true,
          commercialAdsFilterEnabled: false,
          duplicateBotMessageEnabled: false,
        }),
        domainAllowlist: [],
      });

      await jest.advanceTimersByTimeAsync(300);
      const result = await resultPromise;

      expect(result.duplicateDecision).toBeUndefined();
      expect(result.duplicateHit).toBeUndefined();
      expect(redisCounter.incrementWithTtl).toHaveBeenCalledTimes(1);
    } finally {
      consoleWarnSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('logs inner slow-stage breakdown with delta timings', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dateNowSpy = jest.spyOn(Date, 'now');
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    let now = 10_000;
    dateNowSpy.mockImplementation(() => now);
    jest.spyOn(service as any, 'hasProfanity').mockImplementation(() => {
      now += 3_400;
      return false;
    });

    try {
      await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: 'обычное длинное сообщение без ссылок и без нарушений',
        settings: buildSettings({
          antiDuplicateEnabled: true,
          commercialAdsFilterEnabled: false,
        }),
        domainAllowlist: [],
      });

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(consoleWarnSpy.mock.calls[0]?.[0] ?? '{}'));
      expect(payload.msg).toBe('Slow rule-engine detect completed close to the hot-path deadline');
      expect(payload.chatId).toBe('chat-1');
      expect(payload.latestStage).toBe('duplicate-state');
      expect(payload.stageDurations.profanity).toBe(3400);
      expect(payload.stageTimelineMs.profanity).toBeGreaterThanOrEqual(3400);
      expect(payload.stageDurations['duplicate-state']).toBe(0);
    } finally {
      consoleWarnSpy.mockRestore();
      dateNowSpy.mockRestore();
    }
  });

  it('allows only exact allowlisted links in ALLOWLIST_ONLY mode', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const allowed = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://max.ru/channel/news',
      settings: buildSettings(),
      domainAllowlist: ['https://max.ru/channel/news'],
    });
    const blocked = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://max.ru/channel/another',
      settings: buildSettings(),
      domainAllowlist: ['https://max.ru/channel/news'],
    });

    expect(allowed.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
    expect(blocked.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('normalizes legacy allowlist entries to canonical full-link matching', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://max.ru/old/path?x=1',
      settings: buildSettings(),
      domainAllowlist: ['max.ru/old/path?x=1'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('allows any path on an allowlisted domain rule', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const allowed = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://docs.max.ru/mini-apps/start?from=chat',
      settings: buildSettings(),
      domainAllowlist: ['domain:docs.max.ru'],
    });
    const blocked = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://sub.docs.max.ru/mini-apps/start',
      settings: buildSettings(),
      domainAllowlist: ['domain:docs.max.ru'],
    });

    expect(allowed.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
    expect(blocked.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('treats vk.com and vk.ru as the same allowlisted link', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://vk.ru/studia_svetlana_armavir',
      settings: buildSettings(),
      domainAllowlist: ['https://vk.com/studia_svetlana_armavir'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('detects blocked links with unicode domains', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'вакансии https://центр-занятости-иркутск38.рф',
      settings: buildSettings({
        linkPolicy: LinkPolicy.BLOCKLIST_ONLY,
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('detects bare MAX invite links without scheme', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'вступай max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObUh',
      settings: buildSettings({
        linkPolicy: LinkPolicy.BLOCKLIST_ONLY,
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('does not treat dotted russian words as blocked links', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам кузов Нивы.Весь перевареный, документы есть',
      settings: buildSettings({
        linkPolicy: LinkPolicy.BLOCKLIST_ONLY,
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('does not treat dotted addresses as blocked links', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'х.Тверской ул.Первомайская,34',
      settings: buildSettings({
        linkPolicy: LinkPolicy.BLOCKLIST_ONLY,
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('does not treat decimal values as blocked links', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Завтра доставка после 18.00 Куплю 30 шт.',
      settings: buildSettings({
        linkPolicy: LinkPolicy.BLOCKLIST_ONLY,
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('does not treat numbered cultivar list items as blocked links', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: [
        'Доброе утро!',
        '2.Humako Inches',
        '5.Dn-Bora Bora',
        '8.Dn- Цвет Сакуры',
        'тел.89883218131',
      ].join('\n'),
      settings: buildSettings({
        linkPolicy: LinkPolicy.BLOCKLIST_ONLY,
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('matches legacy allowlist rows with encoded trailing text', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU',
      settings: buildSettings(),
      domainAllowlist: [
        'https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU%20MAX%20%D0%BF%D0%BE%D0%B7%D0%B2%D0%BE%D0%BB%D1%8F%D0%B5%D1%82%20%D0%BE%D1%82%D0%BF%D1%80%D0%B0%D0%B2%D0%BB%D1%8F%D1%82%D1%8C',
      ],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('ignores bare branded domains when exact allowlisted URL is present', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'https://ura.news/news/1053075490 Читайте на URA.RU',
      settings: buildSettings(),
      domainAllowlist: ['https://ura.news/news/1053075490'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('does not detect PROFANITY when russian profanity filter is disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ты сука',
      settings: buildSettings({ russianProfanityFilterEnabled: false }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('detects PROFANITY in obfuscated russian mat with separators', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'да ты х*у_й какой-то',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY in core mat forms with common prefixes', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'мне похуй, ты меня заебал',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for common russian insults without mat roots', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ты идиот и мразь',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for common abusive russian words', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'сука, вы мудачье, гандоны и ублюдки',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for targeted ambiguous russian insults', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const samples = [
      'ты полный дурак',
      'вы все бараны',
      'ты реально даун',
      'этот псих пишет опять',
      'додик, уйди из чата',
      'ty durak',
    ];

    for (const text of samples) {
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text,
        settings: buildSettings(),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
    }
  });

  it('does not detect PROFANITY for safe exception words', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'подстрахуй меня, это педикюр и сукно',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for ambiguous insults in non-abusive russian contexts', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const samples = [
      'Вы продаете барана или только петухов?',
      'Фонд помогает семьям, где есть ребенок с синдромом Дауна.',
      'Психолог объяснил, как поддержать аутиста в школе.',
      'В редакторе выбран жирный шрифт для заголовка.',
      'На ферме овцы, козлы, петухи и свиньи.',
      'Книга Идиот Достоевского есть в школьной программе.',
    ];

    for (const text of samples) {
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text,
        settings: buildSettings(),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
    }
  });

  it('does not detect PROFANITY for canine context around "сука" in pet ads', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Чита. Срочно отдаётся собака, охранница. Сука, крупная. Стерилизованная, привитая. Привезу.',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for canine context around derived female-dog forms', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Питомник продает щенка: сучка с родословной, привита, паспорт есть.',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for livestock context around "скотина" in farm posts', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Ферма продаёт КРС: скотина на выпасе, коровы и бычки привиты, есть телята.',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for livestock sales copy with "скотина" in neutral farm context', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Принимаем заказы на свежую говядину. Скотина с частного хозяйства, выращена на натуральном откорме, без химии.',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for parasite context around "гнида"', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Мошка начинается в мае, эта гнида хоть и маленькая, но после её укусов всё чешется.',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY in neutral words that contain "ебе" fragment', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Доставлю щебень и песок тебе до подъезда',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY in neutral words with "ебл" fragment', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Важно потреблять воду и поддерживать режим',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY in neutral words with "дебилитац" fragment', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'После травмы началась длительная дебилитация организма',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY in url paths that start with latin "eb"', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Фото здесь https://disk.yandex.ru/d/EBjA4MZie9N5YA',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY in pure latin acronyms like EBD', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам Форд Фокус 3, комплектация EBD и ABS',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY in neutral age labels with standalone digits', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Подходит взрослым и детям от 6 лет',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY in safe mixed latin/cyrillic russian words', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Cпил дepевьев c вывозом, быстро и безопасно',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for Hyundai car ads with mixed latin/cyrillic text', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Срочная продажа от собственника. Прeкpaсный, удобный и функциoнальный автомобиль. Hyundai Santa Fe 2010г. Подробности по телефону.',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for latin product names like XUPING', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Ювелирная бижутерия XUPING, медицинский сплав, серьги и браслеты в наличии',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for surname-like forms such as "Гандонова"', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Вот не даст точно, Гандонова сегодня опять шутит',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('detects PROFANITY for added high-confidence abusive russian words', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ты падла, мудозвон и засранец',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for added vulgar and insulting families', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'опять эти залупы, шалавы и стервы',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('still detects PROFANITY for explicit "е*бать" form', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Е*бать, ну и новость',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for transliterated added abusive nouns', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'nu ty padla i mudozvon, a oni shalavy',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY when russian mat is split into short spaced tokens', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ну ты б л я т ь конечно',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY when russian insult is split into short spaced tokens', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ну ты с у к а конечно',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY when longer russian insults are split into letters or chunks', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const samples = ['д о л б о е б', 'у б л ю д о к', 'деб и л', 'пидо рас', 'бл я ть'];

    for (const text of samples) {
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text,
        settings: buildSettings(),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
    }
  });

  it('still detects PROFANITY in digit-obfuscated russian mat token', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ну ты 6лять конечно',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY in mixed-script and leetspeak mat obfuscations', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const samples = ['бл@ть', 'бл9ть', 'пuзда', 'хуu', 'мр@зь', 'p1zda', 'pizd@'];

    for (const text of samples) {
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text,
        settings: buildSettings(),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
    }
  });

  it('detects PROFANITY in latin transliteration of russian mat roots', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'zaebal uzhe etot spam',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('still detects PROFANITY for transliterated xuy-family forms', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'mne pohuy na etot spam',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for transliterated russian insults from the exact lexicon', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'nu ty pidor i mudak',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for narrow typo spellings and colloquial misspellings', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ну ты сцука, дибил и далбаеп',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for narrow transliterated typo spellings', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'nu ty pedor i mudag',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for expanded high-confidence abusive lexicon families', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ты полный лошара, быдло и тупорылый недоумок',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('does not detect PROFANITY for safe names like Pedro', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Педро и Pedro пришли на тренировку вовремя',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for safe words near expanded insult roots', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Хамлет, Hamlet, лохматый пес и dermatology курс приехали на выставку',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('detects PROFANITY for lexicon-only productive insult variants', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ты пидорнутый мудачина, это дебилизм',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('does not detect PROFANITY for surnames and names with profanity-like prefixes', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Сукачев, Sukarno, Пидоренко и Pidorenko приехали на регистрацию',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('detects COMMERCIAL_AD when russian ad markers are present', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам курс, скидка 50%, пишите в лс, цена 3000 руб',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('classifies COMMERCIAL_AD as HIGH with price and contact combo', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам курс, скидка 20%, цена 3000 руб, звоните и пишите в лс https://t.me/example',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    const violation = result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
    expect(violation).toBeDefined();
    expect(violation?.metadata?.decisionBand).toBe('HIGH');
  });

  it('does not detect COMMERCIAL_AD for promo mention without sale context', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Скидка? кто подскажет, где посмотреть',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it('keeps borderline commercial copy below detection on soft sensitivity', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Скидка на курс, пишите в лс',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 60,
        commercialAdsDeleteThreshold: 82,
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it('catches the same borderline commercial copy on strict sensitivity', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Скидка на курс, пишите в лс',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'STRICT',
        commercialAdsWarnThreshold: 40,
        commercialAdsDeleteThreshold: 58,
      }),
      domainAllowlist: [],
    });

    const violation = result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
    expect(violation).toBeDefined();
    expect(violation?.metadata?.decisionBand).toBe('HIGH');
  });

  it('detects COMMERCIAL_AD with +7 phone and records phone signal', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам курс, звоните +7 (999) 123-45-67',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    const violation = result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toContain('contact:phone');
  });

  it('detects commercial beauty ad when salon promo context is present', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Салон маникюра: акция недели, запись открыта, пишите в директ',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('does not detect COMMERCIAL_AD for private sale without promo context', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам кофемашину, пишите в лс',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it('does not detect COMMERCIAL_AD for private sale with marketplace link and self-pickup', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам галоши, самовывоз, авито: https://www.avito.ru/item123',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it('detects explicit service ad with phone on balanced sensitivity', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Услуги сантехника, звоните +7 (999) 123-45-67',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'BALANCED',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('detects direct service ad with phone on strict sensitivity', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Услуги сантехника, звоните +7 (999) 123-45-67',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'STRICT',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('detects service ad with channel link on balanced sensitivity', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Запись на маникюр, подробности в канале https://t.me/beauty_room',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'BALANCED',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('detects private service ad with phone on strict sensitivity when service intent is explicit', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Запись на маникюр по телефону +7 (999) 123-45-67',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'STRICT',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('detects buyout ad from real logs with phone numbers', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Выкупаем старую зерноочистительную технику в любом состоянии. +79271992333 +79603324233',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('detects commercial group invite from real logs with max link', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Приглашаю в свою группу Цветовод. Где можно покупать, продавать обмениваться цветами и опытом. Группа в MAX https://max.ru/join/RNzP5wpdj-U1n8shWC1R0M8hj50MyRIAiIcYsJ5BVu8',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('detects recruitment ad with salary and contact', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Вакансия: доход от 5000 в смену, отклики в тг',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('does not detect COMMERCIAL_AD for private sale with phone only', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам детскую коляску, звоните +7 (999) 123-45-67',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it('does not detect private kit sale from real logs just because it says набор', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'ПРОДАМ набор инструментов. 89029673914',
    );

    expect(violation).toBeUndefined();
  });

  it('does not detect bobrovaya stream ad from real logs by confusing it with eyebrow services', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'БОБРОВАЯ СТРУЯ 🦫 БАРСУЧИЙ ЖИР 🦡 Тел.89179343764',
    );

    expect(violation).toBeUndefined();
    expect(
      service.hasCommercialSpamMarkers('БОБРОВАЯ СТРУЯ 🦫 БАРСУЧИЙ ЖИР 🦡 Тел.89179343764'),
    ).toBe(false);
  });

  it('does not detect private property listing from real logs when store mention is just area context', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Продается 2х комнатная квартира п 41.8 кв. м. По адресу: Самарская обл., Волжский р-н, п. Придорожный. Квартира на первом этаже, теплая, индивидуальное отопление. В поселке есть магазин. Поселок тихий. Звонить 89608477286',
    );

    expect(violation).toBeUndefined();
  });

  it('detects COMMERCIAL_AD for private sale with phone only on strict sensitivity', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам детскую коляску, звоните +7 (999) 123-45-67',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'STRICT',
      }),
      domainAllowlist: [],
    });

    const violation = result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['contact:phone', 'combo:strict-intent+direct-deal']),
    );
  });

  it('does not detect COMMERCIAL_AD for non-sales request without contacts', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Ищу мастера, кто подскажет по ремонту?',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it('does not detect household request for master from real logs even with phone callback details', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Нужен мастер собрать, навесть кухню 2 метра. Врезать мойку. Писать в личку либо по телефону 8 912 433 93 18.',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'STRICT',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it('does not detect request for service specialist from real logs when user is looking for help', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Ищу мастера по маникюра в Южном. можно кто на дому принимает тоже, отзовитесь в личку пожалуйста',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'STRICT',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it.each(['BALANCED', 'STRICT'] as const)(
    'does not detect recommendation request for store with site link on %s sensitivity',
    async (sensitivity) => {
      const service = new RuleEngineService(new MockRedisCounterService() as never);
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: 'Подскажите хороший магазин дверей, кто заказывал? Вот сайт https://dveri.example.ru',
        settings: buildSettings({
          commercialAdsFilterEnabled: true,
          commercialAdsSensitivity: sensitivity,
        }),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
    },
  );

  it.each(['BALANCED', 'STRICT'] as const)(
    'does not detect recommendation request for salon channel on %s sensitivity',
    async (sensitivity) => {
      const service = new RuleEngineService(new MockRedisCounterService() as never);
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: 'Посоветуйте салон маникюра, пожалуйста. Нашла этот канал https://t.me/nailsalon',
        settings: buildSettings({
          commercialAdsFilterEnabled: true,
          commercialAdsSensitivity: sensitivity,
        }),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
    },
  );

  it.each(['BALANCED', 'STRICT'] as const)(
    'does not detect recommendation request for specialist with found phone on %s sensitivity',
    async (sensitivity) => {
      const service = new RuleEngineService(new MockRedisCounterService() as never);
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: 'Кто знает хорошего электрика? Нашла номер 8 912 000 00 00, это нормальный мастер?',
        settings: buildSettings({
          commercialAdsFilterEnabled: true,
          commercialAdsSensitivity: sensitivity,
        }),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
    },
  );

  it.each(['BALANCED', 'STRICT'] as const)(
    'does not detect household search for brigade even with reply CTA on %s sensitivity',
    async (sensitivity) => {
      const service = new RuleEngineService(new MockRedisCounterService() as never);
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: 'Ищу бригаду на ремонт, писать в личку',
        settings: buildSettings({
          commercialAdsFilterEnabled: true,
          commercialAdsSensitivity: sensitivity,
        }),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
    },
  );

  it('detects strict service ad from production-style phone log', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      '8-993-126-15-74 откачка септика 5 кубов. Выезжаем по Вашему звонку !',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'contact:phone',
        'service-specialty:септик',
        'service-specialty:откачк',
        'combo:strict-phone+self-promo',
      ]),
    );
  });

  it('detects strict resale ad with price and phone from production-style log', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Продам Опель Цена 70000 Звонить 89237272466',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'intent:продам',
        'contact:phone',
        'transaction:keywords',
        'combo:strict-intent+direct-deal',
      ]),
    );
  });

  it.each([
    'Ремонт квартир, звоните 8 999 123 45 67',
    'Электрик, звоните 8 999 123 45 67',
    'Маникюр, пишите в личку',
    'Клининг квартир, whatsapp 8 999 123 45 67',
  ])('detects bare service ad on balanced sensitivity: %s', async (text) => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text,
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'BALANCED',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('keeps fast commercial marker helper aligned for recommendation requests', () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);

    expect(
      service.hasCommercialSpamMarkers(
        'Подскажите хороший магазин дверей, кто заказывал? Вот сайт https://dveri.example.ru',
      ),
    ).toBe(false);
  });

  it('keeps fast commercial marker helper aligned for bare service ads', () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);

    expect(service.hasCommercialSpamMarkers('Электрик, звоните 8 999 123 45 67')).toBe(true);
  });

  it('does not detect job-seeking resume style message from real moderation logs', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Ищу вахту Охрана 15/15 зп от 6500 смена. 6 разряд водительское удостоверение категория В. все справки имеются предложение пишите в Личные Сообщения!',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeUndefined();
  });

  it('detects commercial audience growth invite from real moderation logs', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Чат для поиска подписчиков и клиентов для ваших проектов. https://max.ru/join/9_D9-tNFZkd1Nfrp9BuYpKnOdAFes0A5V_AHqn-94rQ',
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['group:чат', 'audience:клиент', 'deal-channel:link']),
    );
  });

  it('detects channel placement ad from enabled 2026 logs', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      '💥💥💥 Каналы на трафике. Перелива нет. Взрослая МЦА аудитория. 2500р 1/48. При покупке во всех каналах скидка 7700р. Пишите в MAX.',
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'channel-placement:каналы на трафике',
        'channel-placement:1/48',
        'transaction:price',
      ]),
    );
    expect(violation?.metadata?.primarySubtype).toBe('CHANNEL_PLACEMENT');
    expect(violation?.metadata?.reviewRecommended).toBe(false);
  });

  it('detects broker real-estate ad with commission and showing signals from enabled logs', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'ЖК Отражение. Тип квартиры: Евро 2к. Площадь 36 м². Отделка: ремонт мебель техника. Квартира на ключах. Показ 24/7. Ваша комиссия сверху. Цена 6 300 000 ₽. Звоните прямо сейчас: +7-952-523-48-42.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'property-agent:на-ключах',
        'property-agent:показ-247',
        'property-agent:комиссия-сверху',
      ]),
    );
    expect(violation?.metadata?.primarySubtype).toBe('PROPERTY_AGENT');
    expect(violation?.metadata?.reviewRecommended).toBe(false);
  });

  it('does not detect owner rental listing from real logs even with repair and phone', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Сдаётся уютная 2х комнатная квартира в районе Мкк г. Ялуторовска. В квартире хороший ремонт. Имеется застекленный балкон. Вся мебель и техника в наличии. Сдаётся на длительный срок, ответственным арендаторам. +7 900 000 00 00.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeUndefined();
  });

  it('detects house repair and lifting service from real logs after property-noise tuning', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Участником сво и пенсионерам скидка 35%. Подъем домов и бань, ремонт и строительство. Поднятие зданий и сооружений. Замена нижних венцов. Строительство беседок, террас, веранд и пристроек. Устройство и ремонт фундаментов, отмосток. Звоните +7 900 000 00 00.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'promo:скидк',
        'service-specialty:подъем-домов',
        'service-specialty:ремонт-фундаментов',
      ]),
    );
  });

  it('detects promo goods sale with samovyvoz when service and deal signals are strong', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Распродажа! Пена монтажная под пистолет 65л. Лето. 800 грамм, по 350 р. Самовывоз ул. Республиканская 32. ЭкономСтрой ДВ. +7 909 853 90 88.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['promo:распродаж', 'service-specialty:монтаж', 'transaction:price']),
    );
  });

  it('detects broker real-estate ad when your commission is implied by your markup', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Однушка Российский. Ремонт мебель техника. 43 кв, 4/7 этаж без лифта. Разбивка. Ваши сверху, любой заклад. Виктория +7 918 254 32 84.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['property-agent:комиссия-сверху']),
    );
  });

  it('does not add marketplace ozon signal for ozonation service ads', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Мытье окон, балконов, уборка любых помещений, химчистка ковролина, мягкой мебели, озонирование помещений для избавления от запахов. 89649606739.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).not.toEqual(
      expect.arrayContaining(['business:озон', 'business:ozon']),
    );
  });

  it('does not add club group signal for strawberry promotions from real logs', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Распродажа. Рассада клубники Клери 20 руб за штуку, Азия 20 руб за штуку. В наличии много сортов. Отправка по всей России. Сдек, Яндекс, пятерочка 89002600000.',
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).not.toEqual(expect.arrayContaining(['group:клуб']));
  });

  it('boosts a borderline service ad when the same sender repeats it across chats', async () => {
    const service = createRuleEngine();
    const text = 'Электрик, звоните 8 999 123 45 67';
    const withoutCampaign = await detectCommercialViolation(service, text, {
      ...COMMERCIAL_SENSITIVITY_PROFILES.soft,
    });
    const withCampaign = await detectCommercialViolation(
      service,
      text,
      {
        ...COMMERCIAL_SENSITIVITY_PROFILES.soft,
      },
      {
        commercialCampaignContext: {
          senderDistinctChatCount: 4,
          sameTextDistinctChatCount: 3,
          repeatedPhoneDistinctChatCount: 3,
          repeatedLinkDistinctChatCount: 0,
        },
      },
    );

    expect(withoutCampaign).toBeUndefined();
    expect(withCampaign).toBeDefined();
    expect(withCampaign?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'campaign:cross-chat-text',
        'campaign:sender-multi-chat',
        'combo:campaign+self-promo',
      ]),
    );
    expect(withCampaign?.metadata?.primarySubtype).toBe('SERVICES');
    expect(withCampaign?.metadata?.reviewRecommended).toBe(true);
    expect(withCampaign?.metadata?.reviewReasons).toEqual(
      expect.arrayContaining(['campaign-dependent']),
    );
  });

  it('does not let campaign repetition override a private owner rental listing', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Сдаётся уютная 2х комнатная квартира в районе Мкк г. Ялуторовска. В квартире хороший ремонт. Имеется застекленный балкон. Вся мебель и техника в наличии. Сдаётся на длительный срок, ответственным арендаторам. +7 900 000 00 00.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
      {
        commercialCampaignContext: {
          senderDistinctChatCount: 5,
          sameTextDistinctChatCount: 4,
          repeatedPhoneDistinctChatCount: 4,
          repeatedLinkDistinctChatCount: 0,
        },
      },
    );

    expect(violation).toBeUndefined();
  });

  it('detects self-promotional craft offer from real logs when contact is in personal messages and phone', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Кому нужно сделать иконостас, пишите в личные сообщения +79253552639 Отправлю в любой населённый пункт Большая просьба поделится объявлением! Сохраняйте номер телефона!',
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'intent:кому нужно сделать',
        'contact:пишите в личные сообщения',
        'contact:phone',
      ]),
    );
  });

  it('detects product catalog ad from real moderation logs', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Диваны на прямую от производителя. Самые доступные цены у нас. Пишите скинем каталог. Есть доставка по региону. Оплата при получении.',
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'business:каталог',
        'promo:доставк',
        'transaction:keywords',
        'combo:promo+deal',
        'combo:business+deal',
      ]),
    );
  });

  it('records unicode-safe price, transactional, urgency, and quantity signals', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Продам картофель, срочно, 10 шт, цена 3000 руб, доставка и оплата при получении.',
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'intent:продам',
        'transaction:price',
        'transaction:keywords',
        'booster:urgency',
        'booster:quantity',
      ]),
    );
  });

  describe('commercial real-world benchmark', () => {
    it.each(COMMERCIAL_REAL_WORLD_POSITIVE_CASES)(
      'detects $label',
      async ({
        text,
        expectedSubtype,
        reviewRecommended,
        expectedSignals,
        overrides,
        requireClassifier,
        campaignContext,
      }) => {
        const service = createRuleEngine();
        const violation = await detectCommercialViolation(service, text, overrides, {
          commercialCampaignContext: campaignContext,
        });

        expect(violation).toBeDefined();
        expect(violation?.metadata?.primarySubtype).toBe(expectedSubtype);
        if (typeof reviewRecommended === 'boolean') {
          expect(violation?.metadata?.reviewRecommended).toBe(reviewRecommended);
        }
        if (requireClassifier) {
          expect(violation?.metadata?.classifierVersion).toBeDefined();
          expect(violation?.metadata?.commercialProbability).toEqual(expect.any(Number));
          expect(violation?.metadata?.reviewProbability).toEqual(expect.any(Number));
        }
        expect(violation?.metadata?.matchedSignals).toEqual(
          expect.arrayContaining(expectedSignals),
        );
      },
    );

    it.each(COMMERCIAL_REAL_WORLD_NEGATIVE_CASES)('skips $label', async ({ text, overrides }) => {
      const service = createRuleEngine();
      const violation = await detectCommercialViolation(service, text, overrides);

      expect(violation).toBeUndefined();
    });
  });

  describe('commercial sensitivity matrix', () => {
    const cases = [
      {
        label: 'bare service ad',
        text: 'Маникюр, пишите в личку',
        expected: {
          soft: null,
          balanced: 'MEDIUM',
          strict: 'HIGH',
        },
      },
      {
        label: 'consultation leadgen',
        text: 'Бесплатная консультация, пишите в личку',
        expected: {
          soft: null,
          balanced: 'MEDIUM',
          strict: 'HIGH',
        },
      },
      {
        label: 'audience growth chat promo',
        text: 'Чат для поиска подписчиков и клиентов для ваших проектов. https://max.ru/join/9_D9-tNFZkd1Nfrp9BuYpKnOdAFes0A5V_AHqn-94rQ',
        expected: {
          soft: null,
          balanced: 'MEDIUM',
          strict: 'HIGH',
        },
      },
      {
        label: 'catalog delivery product ad',
        text: 'Диваны на прямую от производителя. Самые доступные цены у нас. Пишите скинем каталог. Есть доставка по региону. Оплата при получении.',
        expected: {
          soft: null,
          balanced: 'HIGH',
          strict: 'HIGH',
        },
      },
      {
        label: 'job-seeking resume post',
        text: 'Ищу вахту Охрана 15/15 зп от 6500 смена. 6 разряд водительское удостоверение категория В. все справки имеются предложение пишите в Личные Сообщения!',
        expected: {
          soft: null,
          balanced: null,
          strict: null,
        },
      },
      {
        label: 'recommendation request with site',
        text: 'Подскажите хороший магазин дверей, кто заказывал? Вот сайт https://dveri.example.ru',
        expected: {
          soft: null,
          balanced: null,
          strict: null,
        },
      },
      {
        label: 'free consultation with direct phone',
        text: 'Запись на бесплатную консультацию +79621548190.',
        expected: {
          soft: null,
          balanced: 'HIGH',
          strict: 'HIGH',
        },
      },
    ] as const;

    const profileSettings = {
      soft: COMMERCIAL_SENSITIVITY_PROFILES.soft,
      balanced: COMMERCIAL_SENSITIVITY_PROFILES.balanced,
      strict: COMMERCIAL_SENSITIVITY_PROFILES.strict,
    } as const;

    for (const [profileName, settings] of Object.entries(profileSettings)) {
      it.each(cases)(
        `applies ${profileName} profile correctly for $label`,
        async ({ text, expected }) => {
          const service = createRuleEngine();
          const violation = await detectCommercialViolation(service, text, settings);
          const expectedBand = expected[profileName as keyof typeof expected];

          if (expectedBand === null) {
            expect(violation).toBeUndefined();
            return;
          }

          expect(violation).toBeDefined();
          expect(violation?.metadata?.decisionBand).toBe(expectedBand);
        },
      );
    }
  });

  it('detects COMMERCIAL_AD with mixed latin/cyrillic obfuscation', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Pr0dam курс, скидка 30%, пишите в тeлeграм, цена 5000 руб',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('does not detect TOPIC_FILTER_MISMATCH when message starts with required codeword', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Недвижимость продам квартиру у метро, собственник, без комиссии, свежий ремонт, никто не прописан, документы готовы к сделке.',
      settings: buildSettings({
        thematicCodewordEnabled: true,
        thematicCodeword: 'недвижимость',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for normalized codeword variants with punctuation and hash', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '#Недвижимость: продам квартиру у метро, собственник, без комиссии, хороший ремонт, быстрый выход на сделку.',
      settings: buildSettings({
        thematicCodewordEnabled: true,
        thematicCodeword: 'недвижимость',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH when configured codeword contains hash or separators', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '#авто_рынок: продам гранту, мотор шепчет, два ключа, без штрафов и запретов, кузов живой, сел и поехал.',
      settings: buildSettings({
        thematicCodewordEnabled: true,
        thematicCodeword: '#Авто-рынок:',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('detects TOPIC_FILTER_MISMATCH when required codeword is not the first word', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам квартиру, недвижимость, метро рядом, собственник, хороший ремонт, свободная продажа, документы готовы, без комиссии.',
      settings: buildSettings({
        thematicCodewordEnabled: true,
        thematicCodeword: 'недвижимость',
      }),
      domainAllowlist: [],
    });

    const violation = result.violations.find((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH');
    expect(violation).toBeDefined();
    expect(violation?.metadata).toEqual(
      expect.objectContaining({
        mode: 'CODEWORD',
        requiredCodeword: 'недвижимость',
        messageFirstToken: 'продам',
      }),
    );
  });

  it('does not detect TOPIC_FILTER_MISMATCH for short message when codeword filter is enabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам квартиру у метро, собственник, без комиссии.',
      settings: buildSettings({
        thematicCodewordEnabled: true,
        thematicCodeword: 'недвижимость',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for attachment-only message when codeword filter is enabled and text is shorter than 90 chars', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '👍',
      settings: buildSettings({
        thematicCodewordEnabled: true,
        thematicCodeword: 'авторынок',
      }),
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('detects MESSAGE_TOO_LONG when effective length exceeds limit', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'short text',
      settings: buildSettings({ maxMessageLengthEnabled: true, maxMessageLength: 50 }),
      domainAllowlist: [],
      effectiveLength: 120,
    });

    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_TOO_LONG')).toBe(true);
  });

  it('detects MESSAGE_COUNT_LIMIT after exceeding configured message window', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      messageCountLimitEnabled: true,
      messageCountLimitMessages: 2,
      messageCountLimitWindowHours: 3,
    });

    const first = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'первое сообщение',
      settings,
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'второе сообщение',
      settings,
      domainAllowlist: [],
    });

    const third = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'третье сообщение',
      settings,
      domainAllowlist: [],
    });

    expect(first.violations.some((item) => item.ruleCode === 'MESSAGE_COUNT_LIMIT')).toBe(false);
    expect(second.violations.some((item) => item.ruleCode === 'MESSAGE_COUNT_LIMIT')).toBe(false);
    expect(third.violations.some((item) => item.ruleCode === 'MESSAGE_COUNT_LIMIT')).toBe(true);
  });

  it('detects MESSAGE_BLOCKED_WORD for configured stop words', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Сегодня обсуждаем казино и ставки.',
      settings: buildSettings({ messageLimitsBlockedWords: ['казино', 'ставки'] }),
      domainAllowlist: [],
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          metadata: expect.objectContaining({ blockedWord: 'казино' }),
        }),
      ]),
    );
  });

  it('detects MESSAGE_BLOCKED_WORD for common word endings of a configured stop word', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Сегодня обсуждаем ставки и букмекеров.',
      settings: buildSettings({ messageLimitsBlockedWords: ['ставка', 'букмекер'] }),
      domainAllowlist: [],
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          metadata: expect.objectContaining({ blockedWord: 'ставка' }),
        }),
      ]),
    );
  });

  it('does not detect MESSAGE_BLOCKED_WORD inside larger word', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Тут только казиношка без совпадения по целому слову.',
      settings: buildSettings({ messageLimitsBlockedWords: ['казино'] }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(false);
  });

  it('keeps vowel-final blocked words on exact matching to avoid unrelated false positives', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Для склада нужна тара и паллеты.',
      settings: buildSettings({ messageLimitsBlockedWords: ['таро'] }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(false);
  });

  it('avoids compiling blocked-word regexes for repeated non-matching detects on the same settings list', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const buildPatternSpy = jest.spyOn(service as any, 'buildMessageLimitsBlockedWordPattern');
    const settings = buildSettings({
      messageLimitsBlockedWords: ['крипта', 'казино', 'ставки'],
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'обычное сообщение без совпадений',
      settings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ещё одно обычное сообщение',
      settings,
      domainAllowlist: [],
    });

    expect(buildPatternSpy).toHaveBeenCalledTimes(0);
  });

  it('reuses normalized blocked-word lists across cloned settings payloads', () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const normalizeTokenSpy = jest.spyOn(service as any, 'normalizeMessageLimitsBlockedWordToken');

    const first = (service as any).resolveMessageLimitsBlockedWordList(['крипта', 'казино']);
    const second = (service as any).resolveMessageLimitsBlockedWordList(['крипта', 'казино']);

    expect(second).toBe(first);
    expect(normalizeTokenSpy).toHaveBeenCalledTimes(2);
  });

  it('compiles regexes only for blocked words that survive the compact-text prefilter', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const buildPatternSpy = jest.spyOn(service as any, 'buildMessageLimitsBlockedWordPattern');

    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Обход через к@3и-н0 тоже должен ловиться.',
      settings: buildSettings({ messageLimitsBlockedWords: ['крипта', 'казино', 'ставки'] }),
      domainAllowlist: [],
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          metadata: expect.objectContaining({ blockedWord: 'казино' }),
        }),
      ]),
    );
    expect(buildPatternSpy).toHaveBeenCalledTimes(1);
  });

  it('does not normalize malformed configured blocked words into a different token', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Комбинация ив сама по себе не должна ловиться.',
      settings: buildSettings({ messageLimitsBlockedWords: ['и/в'] }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(false);
  });

  it('detects MESSAGE_BLOCKED_WORD with special characters and digits', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Обход через к@3и-н0 тоже должен ловиться.',
      settings: buildSettings({ messageLimitsBlockedWords: ['казино'] }),
      domainAllowlist: [],
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          metadata: expect.objectContaining({ blockedWord: 'казино' }),
        }),
      ]),
    );
  });

  it('detects MESSAGE_BLOCKED_WORD for latin-configured short marketplace aliases', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Пишите по ВБ, там выложила карточки.',
      settings: buildSettings({ messageLimitsBlockedWords: ['wb'] }),
      domainAllowlist: [],
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          metadata: expect.objectContaining({ blockedWord: 'вб' }),
        }),
      ]),
    );
  });

  it('detects MESSAGE_BLOCKED_WORD inside obfuscated link text', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Линк: https://k-a-z-1-n-0.ru/join',
      settings: buildSettings({ messageLimitsBlockedWords: ['казино'] }),
      domainAllowlist: ['https://k-a-z-1-n-0.ru/join'],
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          metadata: expect.objectContaining({ blockedWord: 'казино' }),
        }),
      ]),
    );
  });

  it('detects VIDEO_BLOCKED when video messages are disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: buildSettings({ videoMessagesEnabled: false }),
      domainAllowlist: [],
      hasVideoAttachment: true,
    });

    expect(result.violations.some((item) => item.ruleCode === 'VIDEO_BLOCKED')).toBe(true);
  });

  it('detects FILE_BLOCKED when file messages are disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: buildSettings({ fileMessagesEnabled: false }),
      domainAllowlist: [],
      hasFileAttachment: true,
    });

    expect(result.violations.some((item) => item.ruleCode === 'FILE_BLOCKED')).toBe(true);
  });

  it('detects VOICE_BLOCKED when voice messages are disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: buildSettings({ voiceMessagesEnabled: false }),
      domainAllowlist: [],
      hasVoiceAttachment: true,
    });

    expect(result.violations.some((item) => item.ruleCode === 'VOICE_BLOCKED')).toBe(true);
  });

  it('detects PHOTO_RATE_LIMIT from second photo when cooldown is enabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 2,
    });

    const first = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });

    expect(first.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT')).toBe(false);
    expect(second.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT')).toBe(true);
  });

  it('detects STICKER_RATE_LIMIT from second sticker when cooldown is enabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      stickerMessageCooldownEnabled: true,
      stickerMessageCooldownMinutes: 5,
    });

    const first = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings,
      domainAllowlist: [],
      hasStickerAttachment: true,
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings,
      domainAllowlist: [],
      hasStickerAttachment: true,
    });

    expect(first.violations.some((item) => item.ruleCode === 'STICKER_RATE_LIMIT')).toBe(false);
    expect(second.violations.some((item) => item.ruleCode === 'STICKER_RATE_LIMIT')).toBe(true);
  });

  it('resets photo cooldown state when photo cooldown settings change', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const initialSettings = buildSettings({
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 12,
      updatedAt: new Date('2026-04-11T09:00:00.000Z'),
    });
    const updatedSettings = buildSettings({
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 1,
      updatedAt: new Date('2026-04-11T10:00:00.000Z'),
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: initialSettings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });

    const firstAfterSettingsChange = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: updatedSettings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });
    const secondAfterSettingsChange = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: updatedSettings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });

    expect(
      firstAfterSettingsChange.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT'),
    ).toBe(false);
    expect(
      secondAfterSettingsChange.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT'),
    ).toBe(true);
  });

  it('does not spend photo cooldown on a message blocked by another violation', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 2,
      messageLimitsBlockedWords: ['казино'],
    });

    const blockedAttempt = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'казино',
      settings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });
    const firstCleanAttempt = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'фото без нарушений',
      settings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });
    const secondCleanAttempt = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ещё одно фото без нарушений',
      settings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });

    expect(blockedAttempt.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(
      true,
    );
    expect(blockedAttempt.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT')).toBe(
      false,
    );
    expect(firstCleanAttempt.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT')).toBe(
      false,
    );
    expect(secondCleanAttempt.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT')).toBe(
      true,
    );
  });

  it('resets sticker cooldown state when sticker cooldown settings change', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const initialSettings = buildSettings({
      stickerMessageCooldownEnabled: true,
      stickerMessageCooldownMinutes: 10,
      updatedAt: new Date('2026-04-11T09:00:00.000Z'),
    });
    const updatedSettings = buildSettings({
      stickerMessageCooldownEnabled: true,
      stickerMessageCooldownMinutes: 5,
      updatedAt: new Date('2026-04-11T10:00:00.000Z'),
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: initialSettings,
      domainAllowlist: [],
      hasStickerAttachment: true,
    });

    const firstAfterSettingsChange = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: updatedSettings,
      domainAllowlist: [],
      hasStickerAttachment: true,
    });
    const secondAfterSettingsChange = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: updatedSettings,
      domainAllowlist: [],
      hasStickerAttachment: true,
    });

    expect(
      firstAfterSettingsChange.violations.some((item) => item.ruleCode === 'STICKER_RATE_LIMIT'),
    ).toBe(false);
    expect(
      secondAfterSettingsChange.violations.some((item) => item.ruleCode === 'STICKER_RATE_LIMIT'),
    ).toBe(true);
  });

  it('does not trigger PHOTO_RATE_LIMIT for sticker-only attachments', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 2,
      stickerMessageCooldownEnabled: true,
      stickerMessageCooldownMinutes: 5,
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings,
      domainAllowlist: [],
      hasStickerAttachment: true,
    });
    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings,
      domainAllowlist: [],
      hasStickerAttachment: true,
    });

    expect(second.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT')).toBe(false);
    expect(second.violations.some((item) => item.ruleCode === 'STICKER_RATE_LIMIT')).toBe(true);
  });

  it('does not emit legacy FLOOD violation', async () => {
    const enabledService = new RuleEngineService(new MockRedisCounterService() as never);
    const disabledService = new RuleEngineService(new MockRedisCounterService() as never);

    let enabledResult = await enabledService.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: buildSettings({ antiSpamEnabled: true }),
      domainAllowlist: [],
    });
    for (let index = 0; index < 5; index += 1) {
      enabledResult = await enabledService.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: '',
        settings: buildSettings({ antiSpamEnabled: true }),
        domainAllowlist: [],
      });
    }

    let disabledResult = await disabledService.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: buildSettings({ antiSpamEnabled: false }),
      domainAllowlist: [],
    });
    for (let index = 0; index < 5; index += 1) {
      disabledResult = await disabledService.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: '',
        settings: buildSettings({ antiSpamEnabled: false }),
        domainAllowlist: [],
      });
    }

    expect(enabledResult.violations.some((item) => item.ruleCode === 'FLOOD')).toBe(false);
    expect(disabledResult.violations.some((item) => item.ruleCode === 'FLOOD')).toBe(false);
  });

  it('allows one duplicate, then escalates to WARN/MUTE/BAN in sequence', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });
    const third = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });
    const fourth = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });
    const fifth = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(second.duplicateHit).toBeUndefined();
    expect(second.duplicateDecision).toBeUndefined();
    expect(third.duplicateDecision?.action).toBe('WARN');
    expect(third.duplicateDecision?.windowSec).toBe(12 * 60 * 60);
    expect(fourth.duplicateDecision?.action).toBe('MUTE');
    expect(fourth.duplicateDecision?.windowSec).toBe(12 * 60 * 60);
    expect(fifth.duplicateDecision?.action).toBe('BAN');
    expect(fifth.duplicateDecision?.windowSec).toBe(12 * 60 * 60);
  });

  it('starts with explanation when duplicate bot message stage is enabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({ duplicateBotMessageEnabled: true });

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });
    const third = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    expect(second.duplicateHit?.count).toBe(1);
    expect(second.duplicateDecision).toBeUndefined();
    expect(third.duplicateDecision?.action).toBe('WARN');
  });

  it('can warn on the first duplicate when no duplicates are allowed', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateWarnMaxCount: 1,
      duplicateMuteEnabled: true,
      duplicateMuteMaxCount: 2,
      duplicateBanEnabled: true,
      duplicateBanMaxCount: 3,
    });

    const first = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });
    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    expect(first.duplicateDecision).toBeUndefined();
    expect(second.duplicateDecision?.action).toBe('WARN');
    expect(second.duplicateDecision?.threshold).toBe(1);
  });

  it('falls back to MUTE when BAN stage is disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const localSettings = buildSettings({
      duplicateBanEnabled: false,
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: localSettings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: localSettings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: localSettings,
      domainAllowlist: [],
    });
    const fourth = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: localSettings,
      domainAllowlist: [],
    });

    expect(fourth.duplicateDecision?.action).toBe('MUTE');
  });

  it('tracks duplicate counters per user, not across the whole chat', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    const user1Second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    const user2First = await service.detect({
      chatId: 'chat-1',
      userId: 'user-2',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(user1Second.duplicateHit).toBeUndefined();
    expect(user1Second.duplicateDecision).toBeUndefined();
    expect(user2First.duplicateDecision).toBeUndefined();
  });

  it('does not react to duplicates when all duplicate stages are disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
      duplicateWarnMaxCount: 1,
      duplicateMuteMaxCount: 1,
      duplicateBanMaxCount: 1,
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    expect(second.duplicateHit).toBeUndefined();
    expect(second.duplicateDecision).toBeUndefined();
  });

  it('does not process duplicate moderation when anti-duplicate toggle is disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({ antiDuplicateEnabled: false });

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    expect(second.duplicateHit).toBeUndefined();
    expect(second.duplicateDecision).toBeUndefined();
  });

  it('does not track duplicates for messages with only allowlisted exact links', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const text = 'https://ura.news/news/1053075490 Читайте на URA.RU';

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings: buildSettings(),
      domainAllowlist: ['https://ura.news/news/1053075490'],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings: buildSettings(),
      domainAllowlist: ['https://ura.news/news/1053075490'],
    });

    expect(second.duplicateHit).toBeUndefined();
    expect(second.duplicateDecision).toBeUndefined();
    expect(second.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('tracks duplicates for long repeated messages with allowlisted links when body text is substantial', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const text =
      'Подробно разбираю ситуацию по заявке: сроки сдвинулись, новые условия уже согласованы, финальный статус и контакты оставляю ниже https://max.ru/channel/news/post-1';

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings: buildSettings(),
      domainAllowlist: ['https://max.ru/channel/news/post-1'],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings: buildSettings(),
      domainAllowlist: ['https://max.ru/channel/news/post-1'],
    });

    expect(second.duplicateHit).toBeUndefined();
    expect(second.duplicateDecision).toBeUndefined();
    expect(second.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('does not track duplicates for repeated messages with blocked links', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const text = 'смотри https://example.com/news это важно';

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(second.duplicateHit).toBeUndefined();
    expect(second.duplicateDecision).toBeUndefined();
    expect(second.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('does not track duplicates for repeated messages blocked by message limits', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      messageLimitsBlockedWords: ['скидка'],
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    expect(second.duplicateHit).toBeUndefined();
    expect(second.duplicateDecision).toBeUndefined();
    expect(second.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(true);
  });

  it('does not track duplicates for repeated messages with phone numbers', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const text = 'звоните +7 (999) 123-45-67, расскажу подробнее';

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(second.duplicateHit).toBeUndefined();
    expect(second.duplicateDecision).toBeUndefined();
  });

  it('does not track duplicates for short everyday phrases', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    let lastResult = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'спасибо большое',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    for (let index = 0; index < 4; index += 1) {
      lastResult = await service.detect({
        chatId: 'chat-1',
        userId: 'user-1',
        text: 'спасибо большое',
        settings: buildSettings(),
        domainAllowlist: [],
      });
    }

    expect(lastResult.duplicateHit).toBeUndefined();
    expect(lastResult.duplicateDecision).toBeUndefined();
  });

  it('blocks any links when link policy is BLOCKLIST_ONLY', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://example.com/news',
      settings: {
        ...buildSettings(),
        linkPolicy: LinkPolicy.BLOCKLIST_ONLY,
      },
      domainAllowlist: ['https://example.com/news'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('does not block links when link policy is ALERT_ONLY', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://bad.com',
      settings: {
        ...buildSettings(),
        linkPolicy: LinkPolicy.ALERT_ONLY,
      },
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });
});
