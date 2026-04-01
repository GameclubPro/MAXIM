import { LinkPolicy, type ChatSettings } from '@prisma/client';
import { PROFANITY_EXACT_VARIANT_COUNT } from './profanity-lexicon';
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
  return {
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const DUPLICATE_SPAM_TEXT = 'продам курс по маркетингу пишите в личные сообщения сегодня скидка';

describe('RuleEngineService', () => {
  it('ships with 500+ exact profanity and insult variants', () => {
    expect(PROFANITY_EXACT_VARIANT_COUNT).toBeGreaterThanOrEqual(500);
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

  it('does not detect COMMERCIAL_AD for private service without promo context', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Запись на маникюр, подробности в канале https://t.me/beauty_room',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
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
