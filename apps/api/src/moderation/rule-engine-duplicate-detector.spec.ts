import type { ChatSettings } from '../prisma/prisma-client';
import { normalizeForDetection } from './rule-engine-normalization';
import { adaptMaxMessageNavigationView } from './navigation/max-navigation-view.adapter';
import { extractNavigationEvidence } from './navigation/navigation-evidence.extractor';
import { extractClientClickableTextEvidence } from './navigation/client-clickable-text.extractor';
import type { NavigationTargetEvidence } from './navigation/navigation-evidence.types';
import {
  DUPLICATE_STATE_BUDGET_MS,
  DuplicateStateBudgetExceededError,
  RuleEngineDuplicateDetector,
} from './rule-engine-duplicate-detector';

function buildSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    duplicateWarnEnabled: true,
    duplicateMuteEnabled: false,
    duplicateBanEnabled: false,
    duplicateBotMessageEnabled: false,
    duplicateWarnWindowSec: 60,
    duplicateMuteWindowSec: 60,
    duplicateBanWindowSec: 60,
    duplicateWarnMaxCount: 1,
    duplicateMuteMaxCount: 2,
    duplicateBanMaxCount: 3,
    duplicateDetectionPreset: 'STANDARD',
    duplicateIgnoreLinksEnabled: false,
    duplicateIgnorePhonesEnabled: false,
    duplicateNearMatchEnabled: false,
    ...overrides,
  } as ChatSettings;
}

class InMemoryRevisionedRedisCounter {
  private readonly states = new Map<
    string,
    { revision: number; membershipKeys: string[]; countSnapshots: Map<string, number> }
  >();
  private readonly memberships = new Map<string, Map<string, number>>();

  async replaceRevisionedSetMembershipsBeforeDeadline(params: {
    stateKey: string;
    member: string;
    revision: number;
    membershipKeys: readonly string[];
    windowSeconds: number;
    ttlSeconds: number;
  }) {
    const current = this.states.get(params.stateKey);
    if (current && params.revision < current.revision) {
      return { kind: 'stale' as const };
    }
    if (current && params.revision === current.revision) {
      const sameKeys =
        current.membershipKeys.length === params.membershipKeys.length &&
        current.membershipKeys.every((key) => params.membershipKeys.includes(key));
      if (!sameKeys) {
        return { kind: 'stale' as const };
      }
      return {
        kind: 'replayed' as const,
        counts: params.membershipKeys.map((key) => current.countSnapshots.get(key) ?? 0),
      };
    }

    for (const key of current?.membershipKeys ?? []) {
      const membership = this.memberships.get(key);
      membership?.delete(params.member);
      if (membership?.size === 0) {
        this.memberships.delete(key);
      }
    }
    for (const key of params.membershipKeys) {
      const membership = this.memberships.get(key) ?? new Map<string, number>();
      membership.set(params.member, params.revision);
      this.memberships.set(key, membership);
    }

    const windowMs = params.windowSeconds * 1_000;
    const cutoffMs = params.revision - windowMs;
    const countSnapshots = new Map(
      params.membershipKeys.map((key) => {
        const count = Array.from(this.memberships.get(key)?.values() ?? []).filter(
          (timestampMs) => timestampMs > cutoffMs && timestampMs <= params.revision,
        ).length;
        return [key, count];
      }),
    );
    this.states.set(params.stateKey, {
      revision: params.revision,
      membershipKeys: [...params.membershipKeys],
      countSnapshots,
    });
    return {
      kind: 'applied' as const,
      counts: params.membershipKeys.map((key) => countSnapshots.get(key) ?? 0),
    };
  }
}

function navigationTarget(url: string): NavigationTargetEvidence {
  return {
    kind: 'external_url',
    target: url,
    normalizedTarget: new URL(url).toString(),
    enforceable: true,
    origins: [],
  };
}

function navigationTargetsFromMessage(
  message: Record<string, unknown>,
): NavigationTargetEvidence[] {
  return extractNavigationEvidence(adaptMaxMessageNavigationView(message)).targets;
}

function detectRevision(params: {
  detector: RuleEngineDuplicateDetector;
  messageId: string;
  revision: number;
  text: string;
  settings?: ChatSettings;
  trackCurrentText?: boolean;
}) {
  return params.detector.detectWithin({
    chatId: 'chat-1',
    userId: 'user-1',
    messageId: params.messageId,
    eventTimestampMs: params.revision,
    rawText: params.text,
    compactText: normalizeForDetection(params.text),
    settings: params.settings ?? buildSettings(),
    trackCurrentText: params.trackCurrentText,
  });
}

describe('RuleEngineDuplicateDetector', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe.each(['STANDARD', 'STRICT', 'CUSTOM'] as const)('%s text identity', (preset) => {
    it('preserves case-sensitive URL destinations when navigation evidence is not supplied', () => {
      const detector = new RuleEngineDuplicateDetector(
        new InMemoryRevisionedRedisCounter() as never,
      );
      const settings = buildSettings({
        duplicateDetectionPreset: preset,
        duplicateNearMatchEnabled: true,
      });
      const prefix = 'Comfortable swimming lessons available every weekday for families';
      const first = detector.buildFingerprints(
        `${prefix} https://example.org/Offer?id=Token`,
        settings,
      );
      const second = detector.buildFingerprints(
        `${prefix} https://example.org/offer?id=token`,
        settings,
      );
      expect(first.find((part) => part.type === 'exact')?.value).not.toBe(
        second.find((part) => part.type === 'exact')?.value,
      );
      if (preset === 'CUSTOM')
        expect(first.find((part) => part.type === 'near')?.value).not.toBe(
          second.find((part) => part.type === 'near')?.value,
        );
    });

    it.each([
      ...[
        'ABC$value-Z',
        'ABC-$value',
        '$value-ABC',
        'ABC:$value',
        '$value/ABC',
        '$value.ABC',
        '_$value',
        '$value_',
        'ABC[($value)]',
        '[($value)]Z',
        'x$value',
        '$value*x',
        'x = $value',
        '2 $value',
        'x $value',
        'Номера $value',
        'Коды $value',
        'Идентификаторы $value',
        'Артикулы $value',
      ].map((expression) => [
        `protected expression ${expression}`,
        `Подробное описание оборудования с гарантией и доставкой по стране: ${expression.replace('$value', '+79991234567')}`,
        `Подробное описание оборудования с гарантией и доставкой по стране: ${expression.replace('$value', '+79991234568')}`,
      ]),
      ...[
        '+79991234567',
        '+12025550123',
        '79991234567',
        '19991234567',
        '89991234567',
        '999-123-45-67',
      ].map((phone) => [
        `bare quantity after ${phone}`,
        `Подробная инструкция для участников доступна после регистрации телефон: ${phone} 1000`,
        `Подробная инструкция для участников доступна после регистрации телефон: ${phone} 2000`,
      ]),
      ...['Телевизор', 'Тележка', 'Телескоп', 'Мобильность', 'Звонок', 'Звонки'].map((label) => [
        `product phone-prefix ${label}`,
        `${label} 999-123-45-67 продаётся с подробным описанием гарантии и доставкой по стране`,
        `${label} 999-123-45-68 продаётся с подробным описанием гарантии и доставкой по стране`,
      ]),
      ...['. ', '\n'].map((separator) => [
        `numeric phrase after phone ${JSON.stringify(separator)}`,
        `Запись на встречу открыта для всех желающих телефон: +7 (999) 123-45-67${separator}100 участников`,
        `Запись на встречу открыта для всех желающих телефон: +7 (999) 123-45-67${separator}200 участников`,
      ]),
      ...[' ', '\t', '\n', '. '].map((separator) => [
        `numeric fragments separated by URL across ${JSON.stringify(separator)}`,
        `Подробная инструкция для участников доступна после регистрации: данные +7999${separator}https://example.test${separator}1234567 пользователей`,
        `Подробная инструкция для участников доступна после регистрации: данные +7999${separator}https://example.test${separator}1234568 пользователей`,
      ]),
      [
        'numeric punctuation boundaries across a URL',
        'Подробная инструкция для участников доступна после регистрации: данные +7999 https://example.test 123.45.67 пользователей',
        'Подробная инструкция для участников доступна после регистрации: данные +7999 https://example.test 123 .45 .67 пользователей',
      ],
      ...['Серия', 'Модель', 'Версия', ''].map((label) => [
        label ? `grouped ${label}` : 'unlabelled grouped number',
        `${label} (999-123-45-67) доступна для заказа в нашем интернет магазине с доставкой по стране`,
        `${label} (999-123-45-68) доступна для заказа в нашем интернет магазине с доставкой по стране`,
      ]),
      [
        'calendar date',
        'Family swimming registration remains available until 22.09.2026 for every participant',
        'Family swimming registration remains available until 23.09.2026 for every participant',
      ],
      [
        'long price',
        'The advertised equipment purchase price totals 123456789 rubles including delivery',
        'The advertised equipment purchase price totals 223456789 rubles including delivery',
      ],
      [
        'phone-shaped order ID',
        'Номер заказа 1234567890 для получения оплаченного оборудования отправлен представителю организации',
        'Номер заказа 2234567890 для получения оплаченного оборудования отправлен представителю организации',
      ],
      [
        'wrapped part identifier',
        'Артикул (999-123-45-67) доступен для заказа в нашем интернет магазине с доставкой по стране',
        'Артикул (999-123-45-68) доступен для заказа в нашем интернет магазине с доставкой по стране',
      ],
      [
        'long modified part identifier',
        'Артикул нового оборудования для нашего каталога (999-123-45-67) доступен для заказа с доставкой по стране',
        'Артикул нового оборудования для нашего каталога (999-123-45-68) доступен для заказа с доставкой по стране',
      ],
      [
        'wrapped order identifier',
        'Номер заказа №(123-456-78-90) доступен для получения оплаченного оборудования сегодня',
        'Номер заказа №(123-456-78-91) доступен для получения оплаченного оборудования сегодня',
      ],
      [
        'phone label word suffix',
        'Recall 1234567890 подтвержден для оборудования с доставкой по стране после регистрации',
        'Recall 1234567891 подтвержден для оборудования с доставкой по стране после регистрации',
      ],
      [
        'phone-shaped price',
        'Продается промышленное предприятие стоимостью 9000000000 рублей документы готовы подробности по запросу',
        'Продается промышленное предприятие стоимостью 9100000000 рублей документы готовы подробности по запросу',
      ],
      [
        'phone-shaped measurement',
        'Согласно технической документации суммарная масса оборудования составляет 9000000000 кг включая упаковку',
        'Согласно технической документации суммарная масса оборудования составляет 9100000000 кг включая упаковку',
      ],
      [
        'comma placement',
        'Казнить, нельзя помиловать виновного сегодня согласно решению комиссии',
        'Казнить нельзя, помиловать виновного сегодня согласно решению комиссии',
      ],
      [
        'internal punctuation',
        'Подробная инструкция, для участников встречи доступна после завершения регистрации',
        'Подробная инструкция! для участников встречи доступна после завершения регистрации',
      ],
      [
        'numeric range',
        'Available equipment packages carry identification numbers 100-200-300 for ordering',
        'Available equipment packages carry identification numbers 100-200-400 for ordering',
      ],
      [
        'phone-adjacent label',
        'Family swimming registration remains available under code A+7 (999) 123-45-67 today',
        'Family swimming registration remains available under code B+7 (999) 123-45-67 today',
      ],
      [
        'price digits',
        'Стоимость заказа составляет 100 рублей',
        'Стоимость заказа составляет 1000 рублей',
      ],
      [
        'mixed alphabet',
        'Код предложения ABC доступен для оформления',
        'Код предложения АБС доступен для оформления',
      ],
      [
        'short words',
        'Подробная инструкция для участников встречи доступна до начала регистрации',
        'Подробная инструкция для участников встречи доступна от начала регистрации',
      ],
      [
        'negation position',
        'Сегодня продаю оборудование не покупаю материалы доставка доступна участникам встречи',
        'Сегодня не продаю оборудование покупаю материалы доставка доступна участникам встречи',
      ],
      [
        'word order',
        'Продавец переводит покупателю деньги после подтверждения получения товара',
        'Покупатель переводит продавцу деньги после подтверждения получения товара',
      ],
      [
        'numeric order',
        'Стоимость доставки сегодня 100 рублей завтра 200 рублей для каждого участника',
        'Стоимость доставки сегодня 200 рублей завтра 100 рублей для каждого участника',
      ],
      [
        'signed number',
        'Температура хранения оборудования составляет -10 градусов согласно инструкции производителя',
        'Температура хранения оборудования составляет +10 градусов согласно инструкции производителя',
      ],
      ...[
        ['status emoji', '✅', '❌'],
        ['CJK words', '同意', '拒绝'],
        ['Arabic words', 'قبول', 'رفض'],
        ['extended Latin letters', 'départ', 'dúpart'],
        ['combining marks', 'का', 'की'],
        ['comparison operator', 'условие 5 < 9', 'условие 5 > 9'],
        ['arithmetic operator', 'условие 5 * 9', 'условие 5 / 9'],
        ['currency', 'стоимость 100 €', 'стоимость 100 $'],
        ['percentage', 'изменение 10%', 'изменение 10'],
        ['emoji joiner', '👩‍💻', '👩💻'],
        ['emoji joiner spacing', '👩‍💻', '👩 ‍ 💻'],
        ['variation selector', '❤', '❤️'],
        ['variation selector spacing', '❤️‍🔥', '❤ ️‍🔥'],
        ['numeric separator', 'значение ١٫٥', 'значение ١٬٥'],
        ['numeric dash', 'изменение －10', 'изменение 10'],
        ['symbol position', '✅ разрешено ❌ запрещено', 'разрешено ✅ запрещено ❌'],
        ['format control', 'порядок\u200fслов', 'порядокслов'],
      ].map(([label, first, second]) => [
        label,
        `Подробная инструкция для участников встречи доступна после завершения регистрации ${first}`,
        `Подробная инструкция для участников встречи доступна после завершения регистрации ${second}`,
      ]),
    ])('does not merge different %s', async (_name, first, second) => {
      const detector = new RuleEngineDuplicateDetector(
        new InMemoryRevisionedRedisCounter() as never,
      );
      const settings = buildSettings({
        duplicateDetectionPreset: preset,
        duplicateNearMatchEnabled: true,
      });
      await detectRevision({ detector, messageId: 'first', revision: 100, text: first, settings });
      await expect(
        detectRevision({ detector, messageId: 'second', revision: 200, text: second, settings }),
      ).resolves.toEqual({});
      await expect(
        detectRevision({ detector, messageId: 'repeat', revision: 300, text: second, settings }),
      ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });
    });

    it('matches case and whitespace changes', async () => {
      const detector = new RuleEngineDuplicateDetector(
        new InMemoryRevisionedRedisCounter() as never,
      );
      const settings = buildSettings({ duplicateDetectionPreset: preset });
      await detectRevision({
        detector,
        messageId: 'first',
        revision: 100,
        text: 'Стоимость заказа составляет 100 рублей',
        settings,
      });
      await expect(
        detectRevision({
          detector,
          messageId: 'repeat',
          revision: 200,
          text: ' СТОИМОСТЬ  заказа\nсоставляет 100 рублей ',
          settings,
        }),
      ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });
    });

    it('allows cosmetic punctuation spacing without losing its position or protected symbols', () => {
      const detector = new RuleEngineDuplicateDetector(
        new InMemoryRevisionedRedisCounter() as never,
      );
      const settings = buildSettings({
        duplicateDetectionPreset: preset,
        duplicateNearMatchEnabled: true,
      });
      const first =
        'Подробная инструкция, для участников встречи доступна после завершения регистрации 同意 ✅';
      const second =
        'ПОДРОБНАЯ инструкция ,  для участников встречи доступна после завершения регистрации 同意 ✅';
      const fingerprints = [first, second].map((text) =>
        detector.buildFingerprints(text, settings),
      );
      if (preset === 'STANDARD') {
        expect(fingerprints.flat().some((part) => part.type === 'near')).toBe(false);
        return;
      }
      expect(fingerprints[0]!.find((part) => part.type === 'near')?.value).toBeDefined();
      expect(fingerprints[0]!.find((part) => part.type === 'near')?.value).toBe(
        fingerprints[1]!.find((part) => part.type === 'near')?.value,
      );
      expect(fingerprints[0]!.find((part) => part.type === 'exact')?.value).not.toBe(
        fingerprints[1]!.find((part) => part.type === 'exact')?.value,
      );
    });
  });

  it('still matches true rotated phones in STRICT while preserving surrounding labels', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const settings = buildSettings({ duplicateDetectionPreset: 'STRICT' });
    const text = (phone: string) =>
      `Подробная инструкция для участников встречи доступна после завершения регистрации телефон: ${phone}`;
    await detectRevision({
      detector,
      messageId: 'phone-1',
      revision: 100,
      text: text('+7 (999) 123-45-67'),
      settings,
    });
    await expect(
      detectRevision({
        detector,
        messageId: 'phone-2',
        revision: 200,
        text: text('+7 (999) 123-45-68'),
        settings,
      }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'content' } });
  });

  it.each([' ', '\t', '\n', '. '])(
    'still matches true labelled phones and visible URLs in STRICT across %j',
    async (separator) => {
      const detector = new RuleEngineDuplicateDetector(
        new InMemoryRevisionedRedisCounter() as never,
      );
      const settings = buildSettings({ duplicateDetectionPreset: 'STRICT' });
      const first = `Подробная инструкция для участников встречи доступна после завершения регистрации телефон: +7 (999) 123-45-67${separator}https://example.test/first`;
      const second = `Подробная инструкция для участников встречи доступна после завершения регистрации телефон: +7 (999) 123-45-68${separator}https://example.test/second`;
      const firstNear = detector
        .buildFingerprints(first, settings)
        .find((fingerprint) => fingerprint.type === 'near');
      const secondNear = detector
        .buildFingerprints(second, settings)
        .find((fingerprint) => fingerprint.type === 'near');
      expect(firstNear).toBeDefined();
      expect(firstNear?.value).toBe(secondNear?.value);
      await detectRevision({
        detector,
        messageId: 'phone-link-first',
        revision: 100,
        text: first,
        settings,
      });
      await expect(
        detectRevision({
          detector,
          messageId: 'phone-link-second',
          revision: 200,
          text: second,
          settings,
        }),
      ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'content' } });
    },
  );

  it('uses only true phones for explicit CUSTOM value matching without near', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const settings = buildSettings({
      duplicateDetectionPreset: 'CUSTOM',
      duplicateIgnorePhonesEnabled: true,
      duplicateNearMatchEnabled: false,
    });
    await detectRevision({
      detector,
      messageId: 'order-1',
      revision: 100,
      text: 'Номер заказа 1234567890 готов',
      settings,
    });
    await expect(
      detectRevision({
        detector,
        messageId: 'order-2',
        revision: 200,
        text: 'Документ номер 1234567890 проверен',
        settings,
      }),
    ).resolves.toEqual({});
    await detectRevision({
      detector,
      messageId: 'phone-1',
      revision: 300,
      text: 'Телефон +7 (999) 123-45-67: доставка',
      settings,
    });
    await expect(
      detectRevision({
        detector,
        messageId: 'phone-2',
        revision: 400,
        text: 'Связаться +7 (999) 123-45-67: консультация',
        settings,
      }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'phone' } });
  });

  describe.each(['STRICT', 'CUSTOM'] as const)('%s protected numeric expressions', (preset) => {
    it.each([
      [
        'quantity after an unknown-length international phone',
        'телефон: +44 20 7946 0958 100 участников',
        'телефон: +44 20 7946 0958 200 участников',
      ],
      ...['телефон:', 'выражение'].map((label) => [
        `spaced right arithmetic after ${label}`,
        `${label} +79991234567 + 2`,
        `${label} +79991234568 + 2`,
      ]),
      [
        'long arithmetic first operand',
        'Выражение +79991234567 +79991234568',
        'Выражение +79991234569 +79991234568',
      ],
      [
        'long arithmetic second operand',
        'Выражение +79991234567 +79991234568',
        'Выражение +79991234567 +79991234569',
      ],
      ...['^', '×', '÷', '⋅', '<', '>', '≠', '≈', '≤', '≥', '＋'].map((operator) => [
        `left arithmetic operator ${operator}`,
        `выражение 2 ${operator} +79991234567`,
        `выражение 2 ${operator} +79991234568`,
      ]),
      ...['₽', '$', '€', '£'].flatMap((currency) =>
        ['', ' '].map((spacing) => [
          `currency prefix ${currency} with ${JSON.stringify(spacing)}`,
          `${currency}${spacing}+79991234567`,
          `${currency}${spacing}+79991234568`,
        ]),
      ),
      ...['тыс.', 'участников', 'kB', 'MB', 'GiB'].map((unit) => [
        `quantity or storage suffix ${unit}`,
        `телефон: +79991234567 ${unit}`,
        `телефон: +79991234568 ${unit}`,
      ]),
      ...['Артикул телефона:', 'Код телефона:'].map((label) => [
        `identifier label ${label}`,
        `${label} +79991234567`,
        `${label} +79991234568`,
      ]),
    ])(
      'preserves %s without creating a phone-only match',
      async (_name, firstValue, secondValue) => {
        const detector = new RuleEngineDuplicateDetector(
          new InMemoryRevisionedRedisCounter() as never,
        );
        const settings = buildSettings({
          duplicateDetectionPreset: preset,
          duplicateIgnorePhonesEnabled: true,
          duplicateNearMatchEnabled: true,
        });
        const prefix =
          'Подробная инструкция для участников встречи доступна после завершения регистрации';
        await detectRevision({
          detector,
          messageId: 'protected-first',
          revision: 100,
          text: `${prefix}: ${firstValue}`,
          settings,
        });
        await expect(
          detectRevision({
            detector,
            messageId: 'protected-changed',
            revision: 200,
            text: `${prefix}: ${secondValue}`,
            settings,
          }),
        ).resolves.toEqual({});
        await expect(
          detectRevision({
            detector,
            messageId: 'protected-unrelated',
            revision: 300,
            text: `Сведения о наличии оборудования опубликованы для покупателя нового товара: ${firstValue}`,
            settings,
          }),
        ).resolves.toEqual({});
        await expect(
          detectRevision({
            detector,
            messageId: 'protected-repeat',
            revision: 400,
            text: `${prefix}: ${secondValue}`,
            settings,
          }),
        ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });
      },
    );
  });

  it.each([' ', '\n'])(
    'recognizes both explicitly labelled CUSTOM list phones across %j',
    (separator) => {
      const detector = new RuleEngineDuplicateDetector(
        new InMemoryRevisionedRedisCounter() as never,
      );
      const settings = buildSettings({
        duplicateDetectionPreset: 'CUSTOM',
        duplicateIgnorePhonesEnabled: true,
      });
      const text = `Телефоны: +7 (999) 123-45-67${separator}+7 (999) 123-45-68`;
      expect(
        detector
          .buildFingerprints(text, settings)
          .filter((fingerprint) => fingerprint.type === 'phone')
          .map((fingerprint) => fingerprint.value),
      ).toEqual(['79991234567', '79991234568']);
    },
  );

  it.each([' ', '\n'])(
    'still matches rotated explicitly labelled STRICT phone lists across %j',
    async (separator) => {
      const detector = new RuleEngineDuplicateDetector(
        new InMemoryRevisionedRedisCounter() as never,
      );
      const settings = buildSettings({ duplicateDetectionPreset: 'STRICT' });
      const prefix =
        'Подробная инструкция для участников встречи доступна после завершения регистрации телефоны:';
      await detectRevision({
        detector,
        messageId: 'list-first',
        revision: 100,
        text: `${prefix} +7 (999) 123-45-67${separator}+7 (999) 123-45-68`,
        settings,
      });
      await expect(
        detectRevision({
          detector,
          messageId: 'list-rotated',
          revision: 200,
          text: `${prefix} +7 (999) 123-45-69${separator}+7 (999) 123-45-70`,
          settings,
        }),
      ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'content' } });
    },
  );

  it.each([
    ...[
      'ABC+79991234567Z',
      'ABC-+79991234567',
      '+79991234567-ABC',
      'ABC:+79991234567',
      '+79991234567/ABC',
      '+79991234567.ABC',
      '_+79991234567',
      '+79991234567_',
      'ABC[(+79991234567)]',
      '[(+79991234567)]Z',
      'x+12345678901',
      '+12345678901*x',
      'x = +79991234567',
      '2 +79991234567',
      'x +79991234567',
      'Номера +79991234567',
      'Коды +79991234567',
      'Идентификаторы +79991234567',
      'Артикулы +79991234567',
      'https://example.test/+79991234567',
      'https://example.test/?phone=+79991234567',
      '+79991234567@example.test',
      'tel:+79991234567',
      'Телефон +79991234567 1000',
      'Телефон +12025550123 1000',
      'Телефон 79991234567 1000',
      'Phone 19991234567 1000',
      'Телефон 89991234567 1000',
      'Телефон 999-123-45-67 1000',
    ].map((expression) => [
      `Продаётся оборудование с гарантией: ${expression}`,
      `Требуется помощь в новом проекте: ${expression}`,
    ]),
    ...['Телевизор', 'Тележка', 'Телескоп', 'Мобильность', 'Звонок', 'Звонки'].map((label) => [
      `${label} 999-123-45-67 продаётся с подробным описанием`,
      `${label} 999-123-45-67 требуется для нового оборудования`,
    ]),
    ...['Серия', 'Модель', 'Версия', ''].map((label) => [
      `${label} (999-123-45-67) доступна для заказа в нашем интернет магазине`,
      `${label} (999-123-45-67) опубликована после завершения регистрации участников`,
    ]),
    ['Артикул (999-123-45-67) доступен', 'Код заказа №(999-123-45-67) подтвержден'],
    [
      'Артикул нового оборудования для нашего каталога [(999-123-45-67)] доступен',
      'Номер заказа нового оборудования для нашего склада №[(999-123-45-67)] подтвержден',
    ],
    ['Recall 1234567890 подтвержден', 'Расширенный recall 1234567890 опубликован'],
  ])(
    'does not join unrelated protected values through CUSTOM phone matching: %s',
    async (first, second) => {
      const detector = new RuleEngineDuplicateDetector(
        new InMemoryRevisionedRedisCounter() as never,
      );
      const settings = buildSettings({
        duplicateDetectionPreset: 'CUSTOM',
        duplicateIgnorePhonesEnabled: true,
        duplicateNearMatchEnabled: false,
      });
      await detectRevision({
        detector,
        messageId: 'protected-original',
        revision: 100,
        text: first,
        settings,
      });
      await expect(
        detectRevision({
          detector,
          messageId: 'unrelated-protected',
          revision: 200,
          text: second,
          settings,
        }),
      ).resolves.toEqual({});
    },
  );

  it.each(['STRICT', 'CUSTOM'] as const)(
    'does not merge long text with different hidden destinations in %s',
    async (preset) => {
      const detector = new RuleEngineDuplicateDetector(
        new InMemoryRevisionedRedisCounter() as never,
      );
      const text =
        'Подробная инструкция для участников встречи доступна после завершения регистрации';
      const params = {
        chatId: 'chat-1',
        userId: 'user-1',
        rawText: text,
        compactText: normalizeForDetection(text),
        settings: buildSettings({
          duplicateDetectionPreset: preset,
          duplicateNearMatchEnabled: true,
        }),
      };
      await detector.detectWithin({
        ...params,
        messageId: 'first',
        eventTimestampMs: 100,
        navigationTargets: [navigationTarget('https://example.com/one')],
      });
      await expect(
        detector.detectWithin({
          ...params,
          messageId: 'second',
          eventTimestampMs: 200,
          navigationTargets: [navigationTarget('https://example.com/two')],
        }),
      ).resolves.toEqual({});
    },
  );

  it('retains STRICT rotated visible-link matching with real navigation evidence', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const settings = buildSettings({ duplicateDetectionPreset: 'STRICT' });
    const detect = (messageId: string, eventTimestampMs: number, link: string) => {
      const text = `Подробная инструкция для участников встречи доступна после завершения регистрации ${link}`;
      return detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId,
        eventTimestampMs,
        rawText: text,
        compactText: normalizeForDetection(text),
        settings,
        navigationTargets: navigationTargetsFromMessage({ body: { text } }),
      });
    };
    await expect(detect('first', 100, 'https://example.com/one')).resolves.toEqual({});
    await expect(detect('second', 200, 'https://example.com/two')).resolves.toMatchObject({
      hit: { count: 1, fingerprintType: 'content' },
    });
  });

  it('waits for the side-effecting Redis result and enforces the same message', async () => {
    let finishMutation: ((result: { kind: 'applied'; counts: number[] }) => void) | undefined;
    const redisCounter = {
      replaceRevisionedSetMembershipsBeforeDeadline: jest.fn(
        () =>
          new Promise<{ kind: 'applied'; counts: number[] }>((resolve) => {
            finishMutation = resolve;
          }),
      ),
    };
    const detector = new RuleEngineDuplicateDetector(redisCounter as never);
    let settled = false;

    const detection = detector
      .detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-2',
        eventTimestampMs: 1_800_000_000_000,
        rawText: 'same message',
        compactText: 'same message',
        settings: buildSettings(),
      })
      .finally(() => {
        settled = true;
      });

    await Promise.resolve();
    expect(settled).toBe(false);

    finishMutation?.({ kind: 'applied', counts: [2] });

    await expect(detection).resolves.toEqual({
      hit: {
        count: 1,
        windowSec: 60,
        hash: expect.any(String),
        fingerprintType: 'exact',
      },
      decision: {
        action: 'WARN',
        count: 1,
        threshold: 1,
        windowSec: 60,
        hash: expect.any(String),
        fingerprintType: 'exact',
        nextAction: null,
      },
    });
  });

  it('returns a deletion hit when every optional reaction is disabled', async () => {
    const redisCounter = {
      replaceRevisionedSetMembershipsBeforeDeadline: jest
        .fn()
        .mockResolvedValue({ kind: 'applied', counts: [2] }),
    };
    const detector = new RuleEngineDuplicateDetector(redisCounter as never);

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-2',
        eventTimestampMs: 1_800_000_000_000,
        rawText: 'same sufficiently detailed repeated message',
        compactText: 'same sufficiently detailed repeated message',
        settings: buildSettings({
          duplicateWarnEnabled: false,
          duplicateMuteEnabled: false,
          duplicateBanEnabled: false,
          duplicateWarnMaxCount: 1,
        }),
      }),
    ).resolves.toEqual({
      hit: {
        count: 1,
        windowSec: 60,
        hash: expect.any(String),
        fingerprintType: 'exact',
      },
    });
  });

  it('selects the strongest sanction across every matched fingerprint', async () => {
    const mutate = jest.fn().mockResolvedValue({ kind: 'applied', counts: [2, 4] });
    const detector = new RuleEngineDuplicateDetector({
      replaceRevisionedSetMembershipsBeforeDeadline: mutate,
    } as never);

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-4',
        eventTimestampMs: 1_800_000_000_000,
        rawText: 'Короткое объявление https://example.com/sale',
        compactText: 'короткое объявление https://example.com/sale',
        settings: buildSettings({
          duplicateDetectionPreset: 'CUSTOM',
          duplicateIgnoreLinksEnabled: true,
          duplicateMuteEnabled: true,
          duplicateBanEnabled: true,
        }),
      }),
    ).resolves.toEqual({
      hit: {
        count: 3,
        windowSec: 60,
        hash: expect.any(String),
        fingerprintType: 'link',
      },
      decision: {
        action: 'BAN',
        count: 3,
        threshold: 3,
        windowSec: 60,
        hash: expect.any(String),
        fingerprintType: 'link',
        nextAction: null,
      },
    });
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        membershipKeys: [expect.any(String), expect.any(String)],
        windowSeconds: 60,
        ttlSeconds: 181,
        countLimit: 21,
      }),
    );
  });

  it('never invents a stronger sanction than the enabled ladder permits', async () => {
    const detector = new RuleEngineDuplicateDetector({
      replaceRevisionedSetMembershipsBeforeDeadline: jest
        .fn()
        .mockResolvedValue({ kind: 'applied', counts: [2, 40] }),
    } as never);

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-40',
        eventTimestampMs: 1_800_000_000_000,
        rawText: 'Короткое объявление https://example.com/sale',
        compactText: 'короткое объявление https://example.com/sale',
        settings: buildSettings({
          duplicateDetectionPreset: 'CUSTOM',
          duplicateIgnoreLinksEnabled: true,
          duplicateMuteEnabled: true,
          duplicateBanEnabled: false,
        }),
      }),
    ).resolves.toMatchObject({
      hit: { count: 39, fingerprintType: 'link' },
      decision: { action: 'MUTE', count: 39, fingerprintType: 'link', nextAction: null },
    });
  });

  it('keeps insufficient STRICT text exact-only instead of creating fuzzy content history', async () => {
    const mutate = jest.fn().mockResolvedValue({ kind: 'applied', counts: [2] });
    const detector = new RuleEngineDuplicateDetector({
      replaceRevisionedSetMembershipsBeforeDeadline: mutate,
    } as never);

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'short-message',
        eventTimestampMs: 1_800_000_000_000,
        rawText: 'ок https://example.com/one',
        compactText: 'ок https://example.com/one',
        settings: buildSettings({ duplicateDetectionPreset: 'STRICT' }),
      }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ membershipKeys: [expect.stringContaining(':fingerprint:exact:')] }),
    );
  });

  it('keeps equal visible text with different structured links out of the exact history', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const settings = buildSettings({
      duplicateWarnEnabled: false,
      duplicateWarnMaxCount: 1,
    });

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        eventTimestampMs: 100,
        rawText: 'Подробнее',
        compactText: 'подробнее',
        settings,
        navigationTargets: [navigationTarget('https://example.com/one')],
      }),
    ).resolves.toEqual({});
    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-2',
        eventTimestampMs: 200,
        rawText: 'Подробнее',
        compactText: 'подробнее',
        settings,
        navigationTargets: [navigationTarget('https://example.com/two')],
      }),
    ).resolves.toEqual({});
    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-3',
        eventTimestampMs: 300,
        rawText: 'Подробнее',
        compactText: 'подробнее',
        settings,
        navigationTargets: [navigationTarget('https://example.com/two')],
      }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });
  });

  it.each(['STANDARD', 'STRICT', 'CUSTOM'] as const)(
    'preserves hidden destination associations in exact and approximate %s matching',
    async (preset) => {
      const detector = new RuleEngineDuplicateDetector(
        new InMemoryRevisionedRedisCounter() as never,
      );
      const settings = buildSettings({
        duplicateDetectionPreset: preset,
        duplicateNearMatchEnabled: true,
        duplicateWarnEnabled: false,
        duplicateWarnMaxCount: 1,
      });
      const text =
        'Participants can purchase comfortable iPhone equipment or practical Samsung devices today';
      const targets = (swapped: boolean) =>
        navigationTargetsFromMessage({
          body: {
            text,
            markup: ['iPhone', 'Samsung'].map((anchor, index) => ({
              type: 'link',
              from: text.indexOf(anchor),
              length: anchor.length,
              url: `https://example.com/${swapped ? 1 - index : index}`,
            })),
          },
        });
      const first = detector.buildFingerprints(text, settings, targets(false));
      const swapped = detector.buildFingerprints(text, settings, targets(true));
      expect(first.some((part) => part.type === 'exact')).toBe(true);
      if (preset !== 'STANDARD') expect(first.some((part) => part.type === 'near')).toBe(true);
      for (const part of first) {
        expect(swapped.find((candidate) => candidate.type === part.type)?.value).not.toBe(
          part.value,
        );
      }
      const detect = (messageId: string, eventTimestampMs: number, swap: boolean) =>
        detector.detectWithin({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId,
          eventTimestampMs,
          rawText: text,
          compactText: normalizeForDetection(text),
          settings,
          navigationTargets: targets(swap),
        });
      await expect(detect('first', 100, false)).resolves.toEqual({});
      await expect(detect('swapped', 200, true)).resolves.toEqual({});
      await expect(detect('repeated', 300, true)).resolves.toMatchObject({ hit: { count: 1 } });
    },
  );

  it.each([true, false])(
    'preserves visible case-sensitive URL order with navigation evidence supplied=%s',
    (provided) => {
      const detector = new RuleEngineDuplicateDetector(
        new InMemoryRevisionedRedisCounter() as never,
      );
      const settings = buildSettings();
      const fingerprint = (text: string) => {
        const view = adaptMaxMessageNavigationView({ body: { text } });
        return detector.buildFingerprints(
          text,
          settings,
          provided
            ? extractNavigationEvidence(view, {
                plainTextCandidates: extractClientClickableTextEvidence(view),
              }).targets
            : undefined,
        )[0]!.value;
      };
      expect(fingerprint('https://example.com/One https://example.com/one')).not.toBe(
        fingerprint('https://example.com/one https://example.com/One'),
      );
      expect(fingerprint('  https://example.com/one\nhttps://example.com/One  ')).toBe(
        fingerprint('https://example.com/one https://example.com/One'),
      );
      if (!provided)
        expect(fingerprint('VISIT https://example.com/one')).toBe(
          JSON.stringify({
            text: 'visit https://example.com/one',
            navigationIdentity: ['link:https://example.com/one'],
          }),
        );
    },
  );

  it('preserves CUSTOM value matching when the same link moves to another hidden anchor', () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const settings = buildSettings({
      duplicateDetectionPreset: 'CUSTOM',
      duplicateIgnoreLinksEnabled: true,
    });
    const fingerprints = (from: number) =>
      detector.buildFingerprints(
        'Buy Buy',
        settings,
        navigationTargetsFromMessage({
          body: {
            text: 'Buy Buy',
            markup: [{ type: 'link', from, length: 3, url: 'https://example.com/same' }],
          },
        }),
      );
    const first = fingerprints(0);
    const moved = fingerprints(4);
    expect(first.find((part) => part.type === 'exact')?.value).not.toBe(
      moved.find((part) => part.type === 'exact')?.value,
    );
    expect(first.find((part) => part.type === 'link')?.value).toBe(
      moved.find((part) => part.type === 'link')?.value,
    );
  });

  it('matches the same structured link across different visible text in custom mode', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const settings = buildSettings({
      duplicateDetectionPreset: 'CUSTOM',
      duplicateIgnoreLinksEnabled: true,
      duplicateWarnEnabled: false,
      duplicateWarnMaxCount: 1,
    });
    const target = navigationTarget('https://example.com/same');

    await detector.detectWithin({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-1',
      eventTimestampMs: 100,
      rawText: 'Первая подпись',
      compactText: 'первая подпись',
      settings,
      navigationTargets: [target],
    });
    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-2',
        eventTimestampMs: 200,
        rawText: 'Другая подпись',
        compactText: 'другая подпись',
        settings,
        navigationTargets: [target],
      }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'link' } });
  });

  it.each([
    [
      'open_app contact',
      { type: 'open_app', web_app: 'https://apps.example/start', contact_id: 101 },
      { type: 'open_app', web_app: 'https://apps.example/start', contact_id: 202 },
    ],
    [
      'chat-create payload',
      { type: 'chat', chat_title: 'Первая группа', start_payload: 'first' },
      { type: 'chat', chat_title: 'Вторая группа', start_payload: 'second' },
    ],
  ] as const)(
    'keeps equal text with a different hidden %s action out of exact history',
    async (_name, firstButton, secondButton) => {
      const detector = new RuleEngineDuplicateDetector(
        new InMemoryRevisionedRedisCounter() as never,
      );
      const settings = buildSettings({ duplicateWarnEnabled: false, duplicateWarnMaxCount: 1 });
      const targets = (button: Record<string, unknown>) =>
        navigationTargetsFromMessage({
          body: {
            text: 'Открыть',
            attachments: [{ type: 'inline_keyboard', payload: { buttons: [[button]] } }],
          },
        });

      await expect(
        detector.detectWithin({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'message-hidden-1',
          eventTimestampMs: 100,
          rawText: 'Открыть',
          compactText: 'открыть',
          settings,
          navigationTargets: targets(firstButton),
        }),
      ).resolves.toEqual({});
      await expect(
        detector.detectWithin({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'message-hidden-2',
          eventTimestampMs: 200,
          rawText: 'Открыть',
          compactText: 'открыть',
          settings,
          navigationTargets: targets(secondButton),
        }),
      ).resolves.toEqual({});
      await expect(
        detector.detectWithin({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'message-hidden-3',
          eventTimestampMs: 300,
          rawText: 'Открыть',
          compactText: 'открыть',
          settings,
          navigationTargets: targets(secondButton),
        }),
      ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });
    },
  );

  it('keeps normalized visible text semantics when a structured action is unchanged', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const settings = buildSettings({ duplicateWarnEnabled: false, duplicateWarnMaxCount: 1 });
    const targets = (text: string) =>
      navigationTargetsFromMessage({
        body: {
          text,
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [[{ type: 'link', url: 'https://example.com/same' }]],
              },
            },
          ],
        },
      });

    await detector.detectWithin({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'normalized-hidden-1',
      eventTimestampMs: 100,
      rawText: 'Подробнее',
      compactText: 'подробнее',
      settings,
      navigationTargets: targets('Подробнее'),
    });
    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'normalized-hidden-2',
        eventTimestampMs: 200,
        rawText: 'ПОДРОБНЕЕ',
        compactText: 'подробнее',
        settings,
        navigationTargets: targets('ПОДРОБНЕЕ'),
      }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });
  });

  it.each([
    [
      'Команда завтра утром принимает новые заявки возле главного входа после общей встречи',
      'Команда завтра утром не принимает новые заявки возле главного входа после общей встречи',
    ],
    [
      'Команда собирается завтра утром в зале 10 возле главного входа после общей встречи',
      'После общей встречи команда собирается завтра утром в зале 11 возле главного входа',
    ],
  ])('does not near-match text when a short semantic token changes', async (first, second) => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const settings = buildSettings({ duplicateDetectionPreset: 'STRICT' });

    await detectRevision({
      detector,
      messageId: 'message-1',
      revision: 100,
      text: first,
      settings,
    });
    await expect(
      detectRevision({
        detector,
        messageId: 'message-2',
        revision: 200,
        text: second,
        settings,
      }),
    ).resolves.toEqual({});
  });

  it('uses event timestamps rather than delayed processing time for the duplicate window', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'same detailed repeated message';

    await detectRevision({ detector, messageId: 'message-1', revision: 100_000, text });
    await expect(
      detectRevision({ detector, messageId: 'message-2', revision: 161_001, text }),
    ).resolves.toEqual({});
  });

  it('excludes a predecessor exactly on the event-time window boundary', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'same detailed repeated message';

    await detectRevision({ detector, messageId: 'message-1', revision: 100_000, text });
    await expect(
      detectRevision({ detector, messageId: 'message-2', revision: 160_000, text }),
    ).resolves.toEqual({});
  });

  it('does not make an earlier message actionable because a later event was processed first', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'same detailed repeated message';

    await detectRevision({ detector, messageId: 'message-later', revision: 150_000, text });
    await expect(
      detectRevision({ detector, messageId: 'message-earlier', revision: 100_000, text }),
    ).resolves.toEqual({});
  });

  it('does not merge both sides of an event into a double-width duplicate window', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'same detailed repeated message';

    await detectRevision({ detector, messageId: 'message-later', revision: 200_000, text });
    await detectRevision({ detector, messageId: 'message-earlier', revision: 100_000, text });
    await expect(
      detectRevision({ detector, messageId: 'message-middle', revision: 150_000, text }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });
  });

  it('counts only chronological predecessors in a reverse-processed cluster', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'same detailed repeated message';

    await detectRevision({ detector, messageId: 'message-later', revision: 150_000, text });
    await detectRevision({ detector, messageId: 'message-earlier', revision: 100_000, text });
    await expect(
      detectRevision({ detector, messageId: 'message-middle', revision: 125_000, text }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });

    await expect(
      detectRevision({ detector, messageId: 'message-newest', revision: 159_000, text }),
    ).resolves.toMatchObject({ hit: { count: 3, fingerprintType: 'exact' } });
  });

  it('moves a message membership from its created text to its edited text', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const firstText = 'original detailed message';
    const editedText = 'edited detailed message';

    await expect(
      detectRevision({ detector, messageId: 'message-1', revision: 100, text: firstText }),
    ).resolves.toEqual({});
    await expect(
      detectRevision({ detector, messageId: 'message-1', revision: 200, text: editedText }),
    ).resolves.toEqual({});
    await expect(
      detectRevision({ detector, messageId: 'message-2', revision: 300, text: editedText }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });

    await expect(
      detectRevision({ detector, messageId: 'message-3', revision: 400, text: firstText }),
    ).resolves.toEqual({});
  });

  it('restores the original membership when a later edit rolls text back', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const firstText = 'original detailed message';
    const editedText = 'edited detailed message';

    await detectRevision({ detector, messageId: 'message-1', revision: 100, text: firstText });
    await detectRevision({ detector, messageId: 'message-1', revision: 200, text: editedText });
    await detectRevision({ detector, messageId: 'message-1', revision: 300, text: firstText });

    await expect(
      detectRevision({ detector, messageId: 'message-2', revision: 400, text: firstText }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });
  });

  it('does not let a stale edit replace the latest message membership', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const latestText = 'latest detailed message';
    const staleText = 'stale detailed message';

    await detectRevision({ detector, messageId: 'message-1', revision: 200, text: latestText });
    await expect(
      detectRevision({ detector, messageId: 'message-1', revision: 100, text: staleText }),
    ).resolves.toEqual({});

    await expect(
      detectRevision({ detector, messageId: 'message-2', revision: 300, text: staleText }),
    ).resolves.toEqual({});
    await expect(
      detectRevision({ detector, messageId: 'message-3', revision: 400, text: latestText }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });
  });

  it('replays the first message outcome instead of current membership counts', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'same detailed message';

    await expect(
      detectRevision({ detector, messageId: 'message-a', revision: 100, text }),
    ).resolves.toEqual({});
    await expect(
      detectRevision({ detector, messageId: 'message-b', revision: 200, text }),
    ).resolves.toMatchObject({ hit: { count: 1 } });

    await expect(
      detectRevision({ detector, messageId: 'message-a', revision: 100, text }),
    ).resolves.toEqual({});
  });

  it('replays the original duplicate outcome after later counts grow', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'same detailed message';

    await detectRevision({ detector, messageId: 'message-a', revision: 100, text });
    const originalDuplicate = await detectRevision({
      detector,
      messageId: 'message-b',
      revision: 200,
      text,
    });
    await expect(
      detectRevision({ detector, messageId: 'message-c', revision: 300, text }),
    ).resolves.toMatchObject({ hit: { count: 2 } });

    await expect(
      detectRevision({ detector, messageId: 'message-b', revision: 200, text }),
    ).resolves.toEqual(originalDuplicate);
    expect(originalDuplicate).toMatchObject({ hit: { count: 1 } });
  });

  it('treats an equal-revision payload with different text as stale', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const originalText = 'original detailed message';
    const conflictingText = 'conflicting detailed message';

    await detectRevision({ detector, messageId: 'message-1', revision: 100, text: originalText });
    await expect(
      detectRevision({
        detector,
        messageId: 'message-1',
        revision: 100,
        text: conflictingText,
      }),
    ).resolves.toEqual({});

    await expect(
      detectRevision({ detector, messageId: 'message-2', revision: 200, text: originalText }),
    ).resolves.toMatchObject({ hit: { count: 1 } });
    await expect(
      detectRevision({ detector, messageId: 'message-3', revision: 300, text: conflictingText }),
    ).resolves.toEqual({});
  });

  it('clears the previous membership when the current edit cannot be tracked', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'original detailed message';

    await detectRevision({ detector, messageId: 'message-1', revision: 100, text });
    await expect(
      detectRevision({
        detector,
        messageId: 'message-1',
        revision: 200,
        text: 'blocked edit',
        trackCurrentText: false,
      }),
    ).resolves.toEqual({});

    await expect(
      detectRevision({ detector, messageId: 'message-2', revision: 300, text }),
    ).resolves.toEqual({});
  });

  it('propagates Redis failures so the webhook can retry the same message', async () => {
    const redisCounter = {
      replaceRevisionedSetMembershipsBeforeDeadline: jest
        .fn()
        .mockRejectedValue(new Error('redis unavailable')),
    };
    const detector = new RuleEngineDuplicateDetector(redisCounter as never);

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-2',
        eventTimestampMs: 1_800_000_000_000,
        rawText: 'same message',
        compactText: 'same message',
        settings: buildSettings(),
      }),
    ).rejects.toThrow('redis unavailable');
  });

  it('rejects within the shared budget when a deadline-aware Redis command stalls', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onBudgetExceeded = jest.fn();
    const redisCounter = {
      replaceRevisionedSetMembershipsBeforeDeadline: jest.fn(
        () => new Promise<never>(() => undefined),
      ),
    };
    const detector = new RuleEngineDuplicateDetector(redisCounter as never, onBudgetExceeded);
    const detection = detector.detectWithin({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-timeout',
      eventTimestampMs: 1_800_000_000_000,
      rawText: 'same message',
      compactText: 'same message',
      settings: buildSettings(),
    });
    const rejected = expect(detection).rejects.toBeInstanceOf(DuplicateStateBudgetExceededError);

    await jest.advanceTimersByTimeAsync(DUPLICATE_STATE_BUDGET_MS);

    await rejected;
    expect(onBudgetExceeded).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      timeoutMs: DUPLICATE_STATE_BUDGET_MS,
      source: 'caller_deadline',
    });
  });

  it('replays the original counter value after a response arrives beyond the caller deadline', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let finishLateResponse: ((result: { kind: 'applied'; counts: number[] }) => void) | undefined;
    const mutate = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ kind: 'applied'; counts: number[] }>((resolve) => {
            finishLateResponse = resolve;
          }),
      )
      .mockResolvedValueOnce({ kind: 'replayed', counts: [2] });
    const detector = new RuleEngineDuplicateDetector({
      replaceRevisionedSetMembershipsBeforeDeadline: mutate,
    } as never);
    const request = {
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-replayed',
      eventTimestampMs: 1_800_000_000_000,
      rawText: 'same message',
      compactText: 'same message',
      settings: buildSettings(),
    };
    const firstAttempt = detector.detectWithin(request);
    const firstRejected = expect(firstAttempt).rejects.toBeInstanceOf(
      DuplicateStateBudgetExceededError,
    );

    await jest.advanceTimersByTimeAsync(DUPLICATE_STATE_BUDGET_MS);
    await firstRejected;

    await expect(detector.detectWithin(request)).resolves.toEqual({
      hit: {
        count: 1,
        windowSec: 60,
        hash: expect.any(String),
        fingerprintType: 'exact',
      },
      decision: {
        action: 'WARN',
        count: 1,
        threshold: 1,
        windowSec: 60,
        hash: expect.any(String),
        fingerprintType: 'exact',
        nextAction: null,
      },
    });

    finishLateResponse?.({ kind: 'applied', counts: [2] });
    await Promise.resolve();
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  it('propagates a server-side deadline refusal without attempting later fingerprints', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mutate = jest.fn().mockResolvedValue({ kind: 'deadline_exceeded' });
    const detector = new RuleEngineDuplicateDetector({
      replaceRevisionedSetMembershipsBeforeDeadline: mutate,
    } as never);

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-expired',
        eventTimestampMs: 1_800_000_000_000,
        rawText: 'same message https://example.com',
        compactText: 'same message https://example.com',
        settings: {
          ...buildSettings(),
          duplicateDetectionPreset: 'CUSTOM',
          duplicateIgnoreLinksEnabled: true,
        } as ChatSettings,
      }),
    ).rejects.toMatchObject({
      code: 'DUPLICATE_STATE_BUDGET_EXCEEDED',
      source: 'redis_deadline',
      retryable: true,
    });

    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
