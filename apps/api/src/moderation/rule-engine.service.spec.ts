import { LinkPolicy, type ChatSettings } from '@prisma/client';
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
    duplicateKickEnabled: true,
    duplicateBanEnabled: true,
    antiDuplicateEnabled: true,
    duplicateWarnWindowSec: 12 * 60 * 60,
    duplicateWarnMaxCount: 2,
    duplicateKickWindowSec: 24 * 60 * 60,
    duplicateKickMaxCount: 3,
    duplicateBanWindowSec: 48 * 60 * 60,
    duplicateBanMaxCount: 4,
    linkPolicy: LinkPolicy.ALLOWLIST_ONLY,
    botSpeechStyle: null,
    greetingEnabled: false,
    greetingBotMessageEnabled: true,
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
    textFiltersRulesButtonEnabled: false,
    thematicCodewordEnabled: false,
    thematicCodeword: '',
    thematicFiltersBotMessageEnabled: false,
    thematicFiltersWarnEnabled: false,
    thematicFiltersBanEnabled: false,
    thematicFiltersKickEnabled: false,
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
    nightModeOpenMessageEnabled: true,
    nightModeOpenMessageText: '',
    nightModeBotButtonEnabled: false,
    nightModeBotButtonUrl: '',
    nightModeBotButtonText: 'Открыть',
    nightModeRulesButtonEnabled: false,
    linkBotMessageEnabled: true,
    linkBotMessageText: '',
    linkWarnEnabled: false,
    linkWarnMessageText: '',
    linkBanEnabled: false,
    linkKickEnabled: false,
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
    banDurationHours: 6,
    warnThreshold: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const DUPLICATE_SPAM_TEXT = 'продам курс по маркетингу пишите в личные сообщения сегодня скидка';

describe('RuleEngineService', () => {
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
      text: "Продам кузов Нивы.Весь перевареный, документы есть",
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

  it('does not detect PROFANITY for insults without mat roots', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ты идиот и мразь',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
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
      text: 'Продам курс, цена 3000 руб, звоните и пишите в лс https://t.me/example',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    const violation = result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
    expect(violation).toBeDefined();
    expect(violation?.metadata?.decisionBand).toBe('HIGH');
  });

  it('classifies weak commercial context as LOW', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Скидка? кто подскажет, где посмотреть',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    const violation = result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
    expect(violation).toBeDefined();
    expect(violation?.metadata?.decisionBand).toBe('LOW');
  });

  it('classifies intent + contact without price as non-LOW commercial violation', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам кофемашину, пишите в лс',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    const violation = result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
    expect(violation).toBeDefined();
    expect(violation?.metadata?.decisionBand).not.toBe('LOW');
  });

  it('classifies intent + link without price as non-LOW commercial violation', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Запись на маникюр, подробности в канале https://t.me/beauty_room',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    const violation = result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
    expect(violation).toBeDefined();
    expect(violation?.metadata?.decisionBand).not.toBe('LOW');
  });

  it('classifies russian phone number as contact signal for commercial ad', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам детскую коляску, звоните +7 (999) 123-45-67',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    const violation = result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
    expect(violation).toBeDefined();
    expect(violation?.metadata?.decisionBand).toBe('MEDIUM');
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
      text: 'Pr0dam услуги, пишите в тeлeграм, цена 5000 руб',
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

  it('escalates duplicate action to WARN/KICK/BAN for 12h/24h/48h windows', async () => {
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

    expect(second.duplicateHit?.count).toBe(1);
    expect(second.duplicateDecision).toBeUndefined();
    expect(third.duplicateDecision?.action).toBe('WARN');
    expect(third.duplicateDecision?.windowSec).toBe(12 * 60 * 60);
    expect(fourth.duplicateDecision?.action).toBe('KICK');
    expect(fourth.duplicateDecision?.windowSec).toBe(24 * 60 * 60);
    expect(fifth.duplicateDecision?.action).toBe('BAN');
    expect(fifth.duplicateDecision?.windowSec).toBe(48 * 60 * 60);
  });

  it('falls back to KICK when BAN stage is disabled', async () => {
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

    expect(fourth.duplicateDecision?.action).toBe('KICK');
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

    expect(user1Second.duplicateHit?.count).toBe(1);
    expect(user1Second.duplicateDecision).toBeUndefined();
    expect(user2First.duplicateDecision).toBeUndefined();
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
