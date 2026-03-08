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
    thematicFiltersBotButtonEnabled: false,
    thematicFiltersBotButtonUrl: '',
    thematicFiltersBotButtonText: 'Открыть',
    nightModeEnabled: false,
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
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
      domainAllowlist: ['example.com'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('allows links from the same domain in ALLOWLIST_ONLY mode', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const allowed = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://max.ru/channel/news',
      settings: buildSettings(),
      domainAllowlist: ['max.ru'],
    });
    const blocked = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://example.org/channel/another',
      settings: buildSettings(),
      domainAllowlist: ['max.ru'],
    });

    expect(allowed.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
    expect(blocked.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('normalizes legacy allowlist entries with path to domain-only matching', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://max.ru/another/path',
      settings: buildSettings(),
      domainAllowlist: ['max.ru/old/path?x=1'],
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

  it('detects TOPIC_FILTER_MISMATCH for long off-topic message when real estate filter is enabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Это длинное сообщение о процессах, дедлайнах, ролях в команде, еженедельных созвонах, постановке задач, бюджетировании, найме и согласовании рабочих документов без привязки к тематике объявлений.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(true);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for long auto-market message when auto filter is enabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продаю автомобиль с пробегом: двигатель обслужен, коробка передач без нареканий, VIN читается, комплект зимних шин и документы готовы к сделке хоть сегодня.',
      settings: buildSettings({ autoMarketTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for long real-estate message when real estate filter is enabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Сдаю квартиру в новом жилом комплексе: отдельная комната, свежий ремонт, долгосрочная аренда, адекватный собственник и удобный паркинг рядом с домом.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for room rental listing with strong real-estate context', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Сдам комнату в коммуналке: метро рядом, без комиссии, собственник на связи, показ вечером, можно быстро заселиться, документы в порядке.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('detects TOPIC_FILTER_MISMATCH for long office discussion with ambiguous room and studio wording', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'У нас в офисе есть комната переговоров, комната отдыха и студия записи для подкаста, обсуждаем график сотрудников и внутренние регламенты компании без связи с объявлениями.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(true);
  });

  it('detects TOPIC_FILTER_MISMATCH for long engineering discussion with code section wording', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'В репозитории есть участок кода для авторизации, участок миграции Prisma и участок с очередями, надо созвониться и распределить задачи по команде без связи с тематикой объявлений.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(true);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for real-estate ad with typos and loose wording', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам квартиу в новостройке, 2 комнате, этаж 7, метро рядом, балкон застеклен, собственник на месте, ипатека возможна, фотки и детали скину сразу в чат.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for land listing with plot markers', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продаю участок 12 соток в СНТ, земля в собственности, меживание уже сделано, кадастровый номер на руках, подъезд круглый год, электричество подключено, подходит под строительство дома и быструю сделку.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for slangy real-estate listing with typos', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продаеца двушка в апартах, собственик один, ремонт свежий, лоджия застеклена, метро рядом, без посредников, ипотека проходит, показ по договоренности в удобное время.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for commercial real-estate listing with broker slang', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Сдам ПСН на первой линии: помещение свободного назначения, мокрая точка, витринные окна, без комиссии, показ почти в любой день, документы готовы, подойдет под кофейню, магазин или салон.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for garage listing with colloquial real-estate wording', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам гаражный бокс 24 квадрата: сухой гараж, свет подключен, документы в порядке, собственник один, удобный заезд, можно хранить авто или вещи, быстрый выход на сделку без лишней беготни.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for office sublease listing with commercial real-estate markers', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Сдам офисное помещение в субаренду: open space, отдельный вход, арендные каникулы, офис в центре, без комиссии, собственник на связи, показ по договоренности, документы готовы к быстрому заезду.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for auto ad with typos and colloquial wording', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам автамобиль, пробег 148000, двиготель обслужен, коробка не пинается, кузов живой, один владелец, торг у капота, машина на ходу и без срочных вложений.',
      settings: buildSettings({ autoMarketTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for colloquial auto listing with new market jargon', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продаю Москвич: один хозяин, два ключа, автотека зелёная, своим ходом уедет куда надо, на механике, без рыжиков, документы на руках, любые проверки после осмотра у машины.',
      settings: buildSettings({ autoMarketTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for auto dismantling listing with contract parts', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Авто в разбор: контрактный двигатель, контрактная коробка, живая рейка, ступицы без люфта, запчасти отправлю быстро, машина после ДТП, но по железу еще много чего годного осталось.',
      settings: buildSettings({ autoMarketTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for commercial transport listing with feature markers', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продаю микроавтобус Isuzu: дизель, полный привод, камера заднего вида, парктроник, фаркоп, автозапуск, по технике без нареканий, документы на руках, коммерческий транспорт готов к работе сразу после покупки.',
      settings: buildSettings({ autoMarketTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for slangy auto listing with typos', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продаеца мотик, варик живой, ходовка не стучит, пластик целый, ПТС оригинал, переоформ без проблем, мото на бодром ходу, торг после осмотра реальному покупателю.',
      settings: buildSettings({ autoMarketTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for brand-heavy auto listing', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продаю жигу, Ладу 2114: мотор тянет бодро, коробас живой, ПТС оригинал, без запретов, переоформление сразу, по кузову без критики, торг у капота после осмотра.',
      settings: buildSettings({ autoMarketTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for auto listing with motorcycle wording', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам мотоцикл, собственник по ПТС, родной окрас, пробег честный, ГРМ обслужен, переоформление в ГИБДД без проблем, документы в порядке, торг у бака после осмотра.',
      settings: buildSettings({ autoMarketTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('allows message when any enabled thematic filter matches', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Автомобиль с пробегом в хорошем состоянии: двигатель сухой, АКПП работает ровно, второй комплект дисков и шин уже включен в цену, документы на руках.',
      settings: buildSettings({
        realEstateTopicFilterEnabled: true,
        autoMarketTopicFilterEnabled: true,
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('does not apply thematic filter to messages with length at or below 100 chars', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Короткий оффтоп про дедлайн и созвон без тематических слов.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('detects TOPIC_FILTER_MISMATCH for short auto-market message in real-estate chat', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам BMW, дизель, автомат, два ключа, без рыжиков, торг у капота.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(true);
  });

  it('detects TOPIC_FILTER_MISMATCH for short real-estate message in auto-market chat', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Сдам студию, 32 м, метро рядом, без комиссии, собственник.',
      settings: buildSettings({ autoMarketTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(true);
  });

  it('does not detect TOPIC_FILTER_MISMATCH for short ambiguous studio wording outside real estate', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Ищу студию дизайна для записи короткого ролика.',
      settings: buildSettings({ autoMarketTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(false);
  });

  it('still applies thematic filter to off-topic messages with media attachments', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Это длинное сообщение без явных тематических слов про встречу, отчеты, документы, сроки, бюджеты и планы команды, но основная информация и фото объявления находятся во вложении.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(true);
  });

  it('keeps real-estate filter strict for ambiguous non-property wording', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Мы обсуждаем аренду студии для подкаста: нужно согласовать часы записи, привезти микрофоны, проверить акустику, собрать монтажный план и подготовить выпуск без привязки к продаже или аренде жилья.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(true);
  });

  it('keeps auto-market filter strict for automation-related wording', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'В проекте обсуждаем автоматизацию релизов, автотесты, пайплайны CI, сборку контейнеров, мониторинг очередей и стабильность деплоя, поэтому сообщение длинное, но вообще не про продажу машин или запчастей.',
      settings: buildSettings({ autoMarketTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(true);
  });

  it('does not treat a single supporting auto token as sufficient topic match', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Разбираем производственный инцидент: у испытательного стенда заклинил двигатель, а дальше идет обсуждение бюджета команды, ролей дежурных, каналов связи, планирования спринтов и организационных процессов без тематических маркеров объявлений.',
      settings: buildSettings({ autoMarketTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(true);
  });

  it('does not treat a single supporting real-estate token as sufficient topic match', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'На встрече обсуждали планировку офиса, график переезда отдела, закупку мебели, видеостену, коммуникацию между командами и внутренние регламенты компании, но разговор вообще не касался тематики объявлений.',
      settings: buildSettings({ realEstateTopicFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH')).toBe(true);
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
      domainAllowlist: ['example.com'],
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
