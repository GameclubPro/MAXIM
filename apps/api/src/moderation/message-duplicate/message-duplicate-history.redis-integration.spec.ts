import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { RedisCounterService } from '../redis-counter.service';
import {
  digestDuplicateContent,
  extractDuplicateMessageContent,
} from './message-duplicate-content';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import type { MessageDuplicateBinding } from './message-duplicate-state';
import {
  MessageDuplicatePolicyService,
  MESSAGE_DUPLICATE_CONTROL_KEY,
} from './message-duplicate-policy.service';
import { duplicateSettings } from './message-duplicate-test-fixtures';
import { MessageDuplicateMetricsService } from './message-duplicate-metrics.service';
import {
  duplicateTelemetryKey,
  DUPLICATE_TELEMETRY_BUCKET_MS,
} from './message-duplicate-telemetry';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
const local = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
(local ? describe : describe.skip)('message duplicate Redis integration', () => {
  let redis: RedisCounterService;
  let inspector: Redis;
  let history: MessageDuplicateHistoryService;
  let keys: Set<string>;
  let chatId: string;
  const settings = duplicateSettings();
  const start = Date.now() - 10000;
  beforeEach(() => {
    redis = new RedisCounterService(new ConfigService({ REDIS_URL: url }));
    inspector = new Redis(url);
    history = new MessageDuplicateHistoryService(redis);
    keys = new Set();
    chatId = randomUUID();
    const original = redis.replaceRevisionedSetMembershipsBeforeDeadline.bind(redis);
    jest
      .spyOn(redis, 'replaceRevisionedSetMembershipsBeforeDeadline')
      .mockImplementation((params) => {
        keys.add(params.stateKey);
        params.membershipKeys.forEach((key) => keys.add(key));
        return original(params);
      });
  });
  afterEach(async () => {
    await redis.deleteKeysByPattern(`dup:window:v1:${digestDuplicateContent(chatId)}:*`);
    await redis.deleteKeysByPattern(`dup:window:v1:${digestDuplicateContent(`${chatId}-other`)}:*`);
    if (keys.size) await inspector.del(...keys);
    await inspector.quit();
    await redis.onModuleDestroy();
  });
  const observe = (messageId: string, time: number, text = 'a', override = {}) =>
    history.observe({
      chatId,
      userId: '123',
      messageId,
      eventTimestampMs: start + time,
      controlRevision: 1,
      settings,
      content: extractDuplicateMessageContent({ message: { body: { text } } }),
      ...override,
    });

  it('merges concurrent diagnostic attempts atomically with TTL and isolates chats', async () => {
    const bucket = Math.floor(Date.now() / DUPLICATE_TELEMETRY_BUCKET_MS);
    const key = duplicateTelemetryKey(chatId, bucket);
    keys.add(key);
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        redis.mergeDuplicateTelemetry(
          key,
          index % 2
            ? { supported: 1, verified: 1, COMPARED_NO_MATCH: 1 }
            : { supported: 1, DEFERRED: 1 },
        ),
      ),
    );
    const metrics = new MessageDuplicateMetricsService(redis);
    try {
      expect(await metrics.readObservations(chatId)).toMatchObject({
        state: 'AVAILABLE',
        supportedAttempts: 24,
        verifiedAttempts: 12,
        coverage: 0.5,
        completeness: 'BEST_EFFORT',
        basis: 'ATTEMPTS',
      });
      expect(await metrics.readObservations(`${chatId}-other`)).toMatchObject({
        state: 'NO_DATA',
        coverage: null,
      });
      expect(await inspector.ttl(key)).toBeGreaterThan(7100);
      await inspector.set(key, JSON.stringify({ unexpected: 'private-data' }));
      expect(await metrics.readObservations(chatId)).toMatchObject({
        state: 'UNAVAILABLE',
        coverage: null,
        outcomes: [],
      });
    } finally {
      metrics.onModuleDestroy();
    }
  });

  it('returns a typed non-match separately from unverifiable history and stale revisions', async () => {
    const input = {
      chatId,
      userId: '123',
      messageId: 'typed',
      eventTimestampMs: start,
      controlRevision: 1,
      settings,
      content: extractDuplicateMessageContent({ message: { body: { text: 'hello' } } }),
    };
    expect(await history.observeWithOutcome(input)).toEqual({
      outcome: 'COMPARED_NO_MATCH',
      match: null,
    });
    expect(await history.observeWithOutcome({ ...input, eventTimestampMs: start - 100 })).toEqual({
      outcome: 'STALE',
      match: null,
    });
    expect(
      await history.observeWithOutcome({
        ...input,
        messageId: 'unverified',
        content: { ...input.content, complete: false, reason: 'invalid_content' },
      }),
    ).toEqual({ outcome: 'CONTENT_UNVERIFIED', match: null });
  });

  it('counts exact short repeats, not retries, and invalidates edits without retroactive hits', async () => {
    expect(await observe('a', 0)).toBeNull();
    expect(await observe('a', 0)).toBeNull();
    const hit = await observe('b', 100);
    expect(hit?.hit.count).toBe(1);
    expect(await history.stillMatches(chatId, hit!.binding)).toBe(true);
    expect((await observe('b', 100))?.hit.count).toBe(1);
    expect(await observe('a', 200, 'different')).toBeNull();
    expect(await history.stillMatches(chatId, hit!.binding)).toBe(false);
    expect(await observe('a', 0)).toBeNull();
    expect(await observe('c', 50)).toBeNull();
  });

  it.each([0x12345678, 0xdeadbeef, 0x5eedc0de])(
    'keeps invalidated proof revoked through seeded history transitions (seed %i)',
    async (seed) => {
      type Message = {
        id: string;
        text: string;
        at: number;
        version: number;
        generation: number;
        removed: boolean;
      };
      type Evidence = {
        binding: MessageDuplicateBinding;
        generation: number;
        targetVersion: number;
        originalVersion: number;
        invalidWhenCaptured: boolean;
      };
      const messages = new Map<string, Message>();
      const evidence = new Map<string, Evidence>();
      const exercised = new Set<string>();
      let generation = 0;
      let sequence = 0;
      let eventTime = Date.now();
      let randomState = seed;
      const pick = <T>(values: T[]): T => {
        randomState ^= randomState << 13;
        randomState ^= randomState >>> 17;
        randomState ^= randomState << 5;
        return values[(randomState >>> 0) % values.length]!;
      };
      const nextTime = () => (eventTime = Math.max(Date.now(), eventTime + 1));
      const current = () =>
        [...messages.values()].filter(
          (message) => message.generation === generation && !message.removed,
        );
      const content = (text: string) =>
        extractDuplicateMessageContent({ message: { body: { text } } });
      const runObservation = async (message: Message) => {
        const input = {
          chatId,
          userId: '123',
          messageId: message.id,
          eventTimestampMs: message.at,
          controlRevision: 1,
          settings,
          content: content(message.text),
        };
        const result = await history.observe(input);
        // Exact transport replay neither creates another occurrence nor changes its proof.
        expect(await history.observe(input)).toEqual(result);
        if (result) {
          const original = messages.get(result.binding.original!.messageId)!;
          const key = `${message.id}:${result.binding.lifecycleRevision}:${result.binding.original!.revision}`;
          if (!evidence.has(key)) {
            // Replay may return an old comparison snapshot. Only the proof check is authority.
            const live = await history.stillMatches(chatId, result.binding);
            if (live) {
              expect(original).toMatchObject({
                text: message.text,
                generation,
                removed: false,
              });
              expect(original.at).toBeLessThan(message.at);
            }
            evidence.set(key, {
              binding: result.binding,
              generation,
              targetVersion: message.version,
              originalVersion: original.version,
              invalidWhenCaptured: !live,
            });
          }
        }
        return result;
      };
      const append = async (text: string) => {
        const message: Message = {
          id: `model-${sequence++}`,
          text,
          at: nextTime(),
          version: 0,
          generation,
          removed: false,
        };
        messages.set(message.id, message);
        return runObservation(message);
      };
      // The oracle owns only business facts: material versions, deletion and history loss.
      // It deliberately does not reproduce Redis keys, fingerprints or window algorithms.
      const assertProofs = async () => {
        for (const saved of evidence.values()) {
          const target = messages.get(saved.binding.messageId)!;
          const original = messages.get(saved.binding.original!.messageId)!;
          const valid =
            !saved.invalidWhenCaptured &&
            saved.generation === generation &&
            !target.removed &&
            !original.removed &&
            target.version === saved.targetVersion &&
            original.version === saved.originalVersion;
          const matches = await history.stillMatches(chatId, saved.binding);
          if (matches) expect(valid).toBe(true);
          if (!valid) {
            expect(matches).toBe(false);
            expect(await history.qualify(chatId, saved.binding)).toBeNull();
          }
        }
      };
      const establishLivePair = async () => {
        const text = `live pair ${generation} ${sequence}`;
        expect(await append(text)).toBeNull();
        const repeat = await append(text);
        expect(repeat?.hit.count).toBe(1);
        expect(await history.stillMatches(chatId, repeat!.binding)).toBe(true);
        expect(await history.qualify(chatId, repeat!.binding)).toBe(1);
        expect(await history.qualify(chatId, repeat!.binding)).toBe(1);
      };
      await establishLivePair();
      const operations = ['observe', 'edit', 'remove', 'reset', 'qualify', 'retry', 'loss'];
      const prefix = ['retry', 'edit', 'remove', 'reset', 'loss', 'qualify', 'observe'];
      for (let step = 0; step < 90; step += 1) {
        const operation = prefix[step] ?? pick(operations);
        exercised.add(operation);
        if (operation === 'observe') {
          await append(pick(current()).text);
        } else if (operation === 'edit') {
          const message = pick(current());
          message.text = `${message.text} changed ${step}`;
          message.at = nextTime();
          message.version += 1;
          await history.observeLifecycle({
            chatId,
            messageId: message.id,
            eventTimestampMs: message.at,
            content: content(message.text),
          });
        } else if (operation === 'remove') {
          const message = pick(current());
          message.removed = true;
          await history.remove(chatId, message.id);
        } else if (operation === 'retry') {
          await runObservation(pick(current()));
        } else if (operation === 'qualify') {
          const saved = pick([...evidence.values()]);
          const first = await history.qualify(chatId, saved.binding);
          expect(await history.qualify(chatId, saved.binding)).toBe(first);
        } else {
          if (operation === 'reset') {
            await redis.resetDuplicateWindow(chatId, '123');
          } else {
            await redis.deleteKeysByPattern(`dup:window:v1:${digestDuplicateContent(chatId)}:*`);
          }
          generation += 1;
          await assertProofs();
          const [seconds, microseconds] = await inspector.time();
          eventTime = Math.max(
            eventTime,
            Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000),
          );
          // Real Redis TIME owns reset cutoffs. Fresh IDs and later events prove recovery.
          await establishLivePair();
        }
        await assertProofs();
        if (!current().length) await establishLivePair();
      }
      expect([...exercised].sort()).toEqual([...operations].sort());
      expect(evidence.size).toBeGreaterThan(10);
    },
    30_000,
  );

  it('does not let many links starve an enabled phone fingerprint', async () => {
    const override = {
      settings: duplicateSettings({
        duplicateDetectionPreset: 'CUSTOM',
        duplicateIgnoreLinksEnabled: true,
        duplicateIgnorePhonesEnabled: true,
      }),
    };
    const text = (prefix: string) =>
      `${prefix} +7 (999) 123-45-67 ${Array.from({ length: 24 }, (_, index) => `https://${prefix}.example/item-${index}`).join(' ')}`;
    await observe('original', 0, text('first'), override);
    const result = await observe('repeat', 100, text('second'), override);
    expect(result?.hit.fingerprintType).toBe('phone');
    expect(result?.hit.count).toBe(1);
    expect(await history.stillMatches(chatId, result!.binding)).toBe(true);
  });

  it.each(['Path', '?id=Token', '#Section'])(
    'does not merge case-sensitive link destinations (%s) in CUSTOM mode',
    async (suffix) => {
      const override = {
        settings: duplicateSettings({
          duplicateDetectionPreset: 'CUSTOM',
          duplicateIgnoreLinksEnabled: true,
        }),
      };
      await observe('original', 0, `First offer https://example.org/${suffix}`, override);
      expect(
        await observe(
          'different',
          100,
          `Another offer https://example.org/${suffix.toLowerCase()}`,
          override,
        ),
      ).toBeNull();
      expect(
        (await observe('repeat', 200, `Third offer https://example.org/${suffix}`, override))?.hit
          .fingerprintType,
      ).toBe('link');
    },
  );

  it('does not reuse observations from a prior rollout revision for new sanctions', async () => {
    await observe('a', 0);
    expect(await observe('b', 100, 'a', { controlRevision: 2 })).toBeNull();
    expect((await observe('c', 200, 'a', { controlRevision: 2 }))?.hit.count).toBe(1);
  });

  it('preserves a new event date under STRICT while still detecting a real repeat', async () => {
    const override = { settings: duplicateSettings({ duplicateDetectionPreset: 'STRICT' }) };
    const text = (date: string) =>
      `Family swimming registration remains available until ${date} for every participant`;
    await observe('original', 0, text('22.09.2026'), override);
    expect(await observe('new-date', 100, text('23.09.2026'), override)).toBeNull();
    const repeat = await observe('repeat', 200, text('23.09.2026'), override);
    expect(repeat?.hit.count).toBe(1);
    expect(await history.stillMatches(chatId, repeat!.binding)).toBe(true);
  });

  it('preserves plain-text destinations in CUSTOM near matching', async () => {
    const override = {
      settings: duplicateSettings({
        duplicateDetectionPreset: 'CUSTOM',
        duplicateNearMatchEnabled: true,
      }),
    };
    const prefix = 'Comfortable swimming lessons available every weekday for families';
    await observe('original', 0, `${prefix} https://example.org/Offer?id=Token`, override);
    expect(
      await observe('different', 100, `${prefix} https://example.org/offer?id=token`, override),
    ).toBeNull();
  });

  describe.each(['STRICT', 'CUSTOM'] as const)('%s Unicode comparison', (preset) => {
    it.each([
      ['✅', '❌'],
      ['同意', '拒绝'],
      ['условие 5 < 9', 'условие 5 > 9'],
    ])('does not qualify changed protected content (%s / %s)', async (first, second) => {
      const override = {
        settings: duplicateSettings({
          duplicateDetectionPreset: preset,
          duplicateNearMatchEnabled: true,
        }),
      };
      const text = (suffix: string) =>
        `Подробная инструкция для участников встречи доступна после завершения регистрации ${suffix}`;
      expect(await observe('original', 0, text(first), override)).toBeNull();
      expect(await observe('changed', 100, text(second), override)).toBeNull();
      const repeated = await observe('repeat', 200, text(second), override);
      expect(repeated?.hit).toMatchObject({ count: 1, fingerprintType: 'exact' });
      expect(repeated?.binding.original?.messageId).toBe('changed');
      expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
      expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
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
      ...['Серия', 'Модель', 'Версия', ''].map((label) => [
        label ? `grouped ${label}` : 'unlabelled grouped number',
        `${label} (999-123-45-67) доступна для заказа в нашем интернет магазине с доставкой по стране`,
        `${label} (999-123-45-68) доступна для заказа в нашем интернет магазине с доставкой по стране`,
      ]),
      [
        'order identifier',
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
        'Согласно технической документации масса оборудования составляет 9000000000 кг включая упаковку',
        'Согласно технической документации масса оборудования составляет 9100000000 кг включая упаковку',
      ],
      [
        'comma placement',
        'Казнить, нельзя помиловать виновного сегодня согласно решению комиссии',
        'Казнить нельзя, помиловать виновного сегодня согласно решению комиссии',
      ],
    ])('does not match or qualify changed %s', async (_label, first, second) => {
      const override = {
        settings: duplicateSettings({
          duplicateDetectionPreset: preset,
          duplicateNearMatchEnabled: true,
          duplicateIgnorePhonesEnabled: true,
        }),
      };
      await observe('original', 0, first, override);
      expect(await observe('changed', 100, second, override)).toBeNull();
      const repeated = await observe('repeat', 200, second, override);
      expect(repeated?.hit.fingerprintType).toBe('exact');
      expect(repeated?.binding.original?.messageId).toBe('changed');
      expect(await history.stillMatches(chatId, repeated!.binding)).toBe(true);
      expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
    });
  });

  it('keeps rotated true phones and punctuation spacing comparable under STRICT', async () => {
    const override = { settings: duplicateSettings({ duplicateDetectionPreset: 'STRICT' }) };
    const prefix =
      'Подробная инструкция, для участников встречи доступна после завершения регистрации телефон:';
    await observe('original', 0, `${prefix} +7 (999) 123-45-67`, override);
    const rotated = await observe('rotated', 100, `${prefix} +7 (999) 123-45-68`, override);
    expect(rotated?.hit.fingerprintType).toBe('content');
    expect(await history.qualify(chatId, rotated!.binding)).toBe(1);
    const spaced = await observe(
      'spaced',
      200,
      `${prefix.toUpperCase().replace(',', ' , ')} +7 (999) 123-45-69`,
      override,
    );
    expect(spaced?.hit.fingerprintType).toBe('near');
    expect(await history.stillMatches(chatId, spaced!.binding)).toBe(true);
    expect(await history.qualify(chatId, spaced!.binding)).toBe(1);
  });

  it.each(['. ', '\n'])(
    'keeps the numeric phrase after a true phone in STRICT across %j',
    async (separator) => {
      const override = { settings: duplicateSettings({ duplicateDetectionPreset: 'STRICT' }) };
      const text = (count: number) =>
        `Запись на встречу открыта для всех желающих телефон: +7 (999) 123-45-67${separator}${count} участников`;
      await observe('original', 0, text(100), override);
      expect(await observe('changed', 100, text(200), override)).toBeNull();
      const repeated = await observe('repeat', 200, text(200), override);
      expect(repeated?.hit.fingerprintType).toBe('exact');
      expect(repeated?.binding.original?.messageId).toBe('changed');
      expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
    },
  );

  it('does not treat order IDs as CUSTOM phone values even without near matching', async () => {
    const override = {
      settings: duplicateSettings({
        duplicateDetectionPreset: 'CUSTOM',
        duplicateIgnorePhonesEnabled: true,
      }),
    };
    await observe('order', 0, 'Номер заказа 1234567890 готов', override);
    expect(
      await observe('invoice', 100, 'Документ номер 1234567890 проверен', override),
    ).toBeNull();
    await observe('phone', 200, 'Телефон +7 (999) 123-45-67 для доставки', override);
    const repeated = await observe(
      'same-phone',
      300,
      'Связаться +7 (999) 123-45-67 для консультации',
      override,
    );
    expect(repeated?.hit.fingerprintType).toBe('phone');
    expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
  });

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
  ])('does not join protected values through CUSTOM phone matching: %s', async (first, second) => {
    const override = {
      settings: duplicateSettings({
        duplicateDetectionPreset: 'CUSTOM',
        duplicateIgnorePhonesEnabled: true,
        duplicateNearMatchEnabled: false,
      }),
    };
    await observe('protected-original', 0, first, override);
    expect(await observe('unrelated-protected', 100, second, override)).toBeNull();
  });

  describe.each(['STRICT', 'CUSTOM_PHONE'] as const)('%s bounded phone labels', (mode) => {
    it.each([
      ['Тел+79991234567', 'Тел+79991234568'],
      ['Телефон=+79991234567', 'Телефон=+79991234568'],
      ['Телефон79991234567', 'Телефон79991234568'],
      ['Phone19991234567', 'Phone19991234568'],
      ['Связаться +12025550123', 'Связаться +12025550124'],
      ['Связаться +80011122233', 'Связаться +80011122234'],
      [
        'Телефон:+79991234567 https://example.test/+79991234569',
        'Телефон:+79991234568 https://example.test/+79991234569',
      ],
    ])('qualifies a real phone with safe boundaries in %s', async (first, rotated) => {
      const strict = mode === 'STRICT';
      const override = {
        settings: duplicateSettings({
          duplicateDetectionPreset: strict ? 'STRICT' : 'CUSTOM',
          duplicateIgnorePhonesEnabled: !strict,
          duplicateNearMatchEnabled: false,
        }),
      };
      const description =
        'Подробная инструкция для участников встречи доступна после завершения регистрации';
      await observe('original', 0, `${description} ${first}`, override);
      const repeated = await observe(
        'repeat',
        100,
        strict ? `${description} ${rotated}` : `Новая консультация сегодня ${first}`,
        override,
      );
      expect(repeated?.hit.fingerprintType).toBe(strict ? 'content' : 'phone');
      expect(await history.stillMatches(chatId, repeated!.binding)).toBe(true);
      expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
    });

    it.each([
      'Телефон',
      'Телефоном',
      'Телефоны',
      'Тел.',
      'Позвоните',
      'Звоните',
      'WhatsApp',
      'Ватсап',
      'Viber',
      'Вайбер',
    ])(
      'matches and qualifies explicit %s evidence without an international prefix',
      async (label) => {
        const strict = mode === 'STRICT';
        const override = {
          settings: duplicateSettings({
            duplicateDetectionPreset: strict ? 'STRICT' : 'CUSTOM',
            duplicateIgnorePhonesEnabled: !strict,
            duplicateNearMatchEnabled: false,
          }),
        };
        const description =
          'Подробная инструкция для участников встречи доступна после завершения регистрации';
        const first = `${description} ${label}: 999-123-45-67`;
        const second = strict
          ? `${description} ${label}: 999-123-45-68`
          : `Связаться для консультации ${label}: 999-123-45-67`;
        expect(await observe('original', 0, first, override)).toBeNull();
        const matched = await observe('matched', 100, second, override);
        expect(matched?.hit).toMatchObject({
          count: 1,
          fingerprintType: strict ? 'content' : 'phone',
        });
        expect(await history.stillMatches(chatId, matched!.binding)).toBe(true);
        expect(await history.qualify(chatId, matched!.binding)).toBe(1);
      },
    );
  });

  it.each(['photo', 'video', 'audio', 'file', 'sticker', 'contact', 'location'])(
    'verifies TEXT with known unavailable %s and revokes material caption edits',
    async (type) => {
      const textSettings = duplicateSettings({ duplicateCompareMode: 'TEXT' });
      const content = (text: string) =>
        extractDuplicateMessageContent({
          message: { body: { text, attachments: [{ type, payload: {} }] } },
        });
      const input = { settings: textSettings, content: content('Повторяемая подпись') };
      expect(await observe('original', 0, '', input)).toBeNull();
      const repeated = await observe('repeat', 100, '', input);
      expect(repeated?.hit.fingerprintType).toBe('exact');
      expect(await history.stillMatches(chatId, repeated!.binding)).toBe(true);
      await history.observeLifecycle({
        chatId,
        messageId: 'original',
        eventTimestampMs: start + 200,
        content: content(' ПОВТОРЯЕМАЯ  подпись '),
      });
      expect(await history.stillMatches(chatId, repeated!.binding)).toBe(true);
      await history.observeLifecycle({
        chatId,
        messageId: 'original',
        eventTimestampMs: start + 300,
        content: content('Совершенно другая подпись'),
      });
      expect(await history.stillMatches(chatId, repeated!.binding)).toBe(false);
      expect(await history.qualify(chatId, repeated!.binding)).toBeNull();
      for (const mode of ['MESSAGE', 'IMAGE'] as const) {
        const unsupported = {
          ...input,
          settings: duplicateSettings(),
          ...(mode === 'IMAGE' ? { imageScope: 'SAME_AUTHOR' as const } : {}),
          mediaHashes: ['a'.repeat(64)],
        };
        expect(await observe(`${mode}-original`, 400, '', unsupported)).toBeNull();
        expect(await observe(`${mode}-repeat`, 500, '', unsupported)).toBeNull();
      }
    },
  );

  const imageInput = () => ({
    imageScope: 'CHAT' as const,
    content: extractDuplicateMessageContent({
      message: {
        body: {
          text: 'caption',
          attachments: [
            { type: 'image', payload: { photo_id: 'photo', url: 'https://i.oneme.ru/a' } },
          ],
        },
      },
    }),
    mediaHashes: ['a'.repeat(64)],
  });

  it.each(['SAME_AUTHOR', 'CHAT'] as const)(
    'never chains image repeats into another window (%s)',
    async (scope) => {
      const input = {
        ...imageInput(),
        imageScope: scope,
        settings: duplicateSettings({ duplicateWarnWindowSec: 86400 }),
      };
      await observe('original', 0, '', input);
      const morning = await observe('morning', 21 * 3600000, '', input);
      expect(morning?.binding.original?.messageId).toBe('original');
      expect(await history.qualify(chatId, morning!.binding)).toBe(1);
      expect(await observe('evening', 30 * 3600000, '', input)).toBeNull();
      const next = await observe('next', 43 * 3600000, '', input);
      expect(next?.binding.original?.messageId).toBe('evening');
      expect(next?.binding.original?.expiresAtMs).toBe(start + 54 * 3600000);
      expect(next?.hit.count).toBe(1);
    },
  );

  it('keeps another author’s shared image original on a per-author reset', async () => {
    const input = imageInput();
    await observe('original', 0, '', input);
    await redis.resetDuplicateWindow(chatId, '456');
    const afterReset = Date.now() - start + 100;
    const match = await observe('new-author', afterReset, '', { ...input, userId: '456' });
    expect(match?.binding.original?.messageId).toBe('original');
    expect(await history.qualify(chatId, match!.binding)).toBe(1);
  });

  it('does not promote a rejected message through an unmatched secondary fingerprint', async () => {
    const override = {
      settings: duplicateSettings({
        duplicateDetectionPreset: 'CUSTOM',
        duplicateIgnorePhonesEnabled: true,
      }),
    };
    await observe('original', 0, 'one +7 (999) 123-45-67', override);
    expect(await observe('rejected', 100, 'two +7 (999) 123-45-67', override)).not.toBeNull();
    await history.remove(chatId, 'original');
    expect(await observe('new', 200, 'two +7 (999) 123-45-67', override)).toBeNull();
  });

  it('isolates author escalation while sharing exact-image matching and replay snapshots', async () => {
    const input = imageInput();
    expect(await observe('a1', 0, '', input)).toBeNull();
    const a2 = await observe('a2', 100, '', input);
    expect(await history.qualify(chatId, a2!.binding)).toBe(1);
    const a3 = await observe('a3', 200, '', input);
    expect(await history.qualify(chatId, a3!.binding)).toBe(2);
    const b = await observe('b1', 300, '', { ...input, userId: '456' });
    expect(b?.hit.count).toBe(1);
    expect(await history.qualify(chatId, b!.binding)).toBe(1);
    expect(await history.stillMatches(chatId, b!.binding)).toBe(true);
    expect(await history.stillMatches(chatId, { ...b!.binding, requiredCount: 3 })).toBe(false);
    expect((await observe('a4', 400, '', input))?.hit.count).toBe(3);
    expect((await observe('b2', 500, '', { ...input, userId: '456' }))?.hit.count).toBe(2);
    expect((await observe('b1', 300, '', { ...input, userId: '456' }))?.hit.count).toBe(1);
  });

  it('atomically invalidates shared and author memberships when the original is edited', async () => {
    const input = imageInput();
    await observe('a1', 0, '', input);
    const b = await observe('b1', 100, '', { ...input, userId: '456' });
    await observe('a1', 200, '', {
      ...input,
      content: { ...input.content, complete: false, reason: 'invalid_content' },
    });
    expect(await history.stillMatches(chatId, b!.binding)).toBe(false);
    expect(await observe('a1', 0, '', input)).toBeNull();
  });

  it('does not assign an arbitrary shared original to one author when timestamps tie', async () => {
    const input = imageInput();
    await observe('a1', 0, '', input);
    expect(await observe('b1', 0, '', { ...input, userId: '456' })).toBeNull();
    expect((await observe('a2', 100, '', input))?.hit.count).toBe(1);
    expect((await observe('b2', 200, '', { ...input, userId: '456' }))?.hit.count).toBe(1);
  });

  it.each([59_999, 60_000, 60_001])(
    'uses an exclusive lower window bound at %ims',
    async (gapMs) => {
      const override = { settings: duplicateSettings({ duplicateWarnWindowSec: 60 }) };
      await observe('original', 0, 'a', override);
      const result = await observe('repeat', gapMs, 'a', override);
      if (gapMs < 60_000) {
        expect(result?.hit.count).toBe(1);
        expect(await history.stillMatches(chatId, result!.binding)).toBe(true);
      } else {
        expect(result).toBeNull();
      }
    },
  );

  it('preserves the event-time comparison window while a valid delete waits for dispatch', async () => {
    const now = Date.now();
    const override = { settings: duplicateSettings({ duplicateWarnWindowSec: 60 }) };
    await observe('original', now - start - 65_000, 'a', override);
    const hit = await observe('repeat', now - start - 10_000, 'a', override);
    expect(hit?.hit.count).toBe(1);
    expect(await history.stillMatches(chatId, hit!.binding)).toBe(true);
    await observe('original', now - start - 1_000, 'edited', override);
    expect(await history.stillMatches(chatId, hit!.binding)).toBe(false);
  });

  it('persists an explicitly global full policy without expiry and supports a permanent stop', async () => {
    keys.add(MESSAGE_DUPLICATE_CONTROL_KEY);
    keys.add(`${MESSAGE_DUPLICATE_CONTROL_KEY}:revision`);
    const policy = new MessageDuplicatePolicyService(redis, new ConfigService());
    const control = {
      version: 2,
      revision: 1,
      mode: 'full',
      scope: 'all_enabled_chats',
      chatIds: [],
      effectiveAt: new Date().toISOString(),
      expiresAt: null,
    };
    expect(await policy.set(control, 0)).toEqual({ applied: true, revision: 1 });
    expect(await inspector.ttl(MESSAGE_DUPLICATE_CONTROL_KEY)).toBe(-1);
    expect(await policy.resolve('-987654321', true)).toMatchObject({ mode: 'full', revision: 1 });
    expect(await policy.set({ ...control, mode: 'off', revision: 2 }, 1)).toEqual({
      applied: true,
      revision: 2,
    });
    expect(await inspector.ttl(MESSAGE_DUPLICATE_CONTROL_KEY)).toBe(-1);
    expect(await policy.resolve('-987654321', true)).toMatchObject({ mode: 'off', revision: 2 });
    expect(await policy.set(control, 0)).toEqual({ applied: false, revision: 2 });
  });
  it('materializes media after a pending phase and removes stale media after a text edit', async () => {
    const content = extractDuplicateMessageContent({
      message: {
        body: {
          caption: 'a',
          attachments: [{ type: 'file', payload: { url: 'https://fd.oneme.ru/a' } }],
        },
      },
    });
    expect(await observe('a', 0, '', { content })).toBeNull();
    expect(await observe('a', 0, '', { content, mediaHashes: ['a'.repeat(64)] })).toBeNull();
    expect(await observe('b', 100, '', { content, mediaHashes: ['b'.repeat(64)] })).toBeNull();
    const hit = await observe('c', 200, '', { content, mediaHashes: ['a'.repeat(64)] });
    expect(hit?.hit.count).toBe(1);
    expect(await observe('a', 300, 'other')).toBeNull();
    expect(await observe('a', 0, '', { content, mediaHashes: ['a'.repeat(64)] })).toBeNull();
    expect(await history.stillMatches(chatId, hit!.binding)).toBe(false);
  });
  it('isolates authors/chats and permits only one insertion under concurrent replay', async () => {
    await observe('a', 0);
    const results = await Promise.all(Array.from({ length: 8 }, () => observe('b', 100)));
    expect(results.every((result) => result?.hit.count === 1)).toBe(true);
    expect(await observe('c', 200, 'a', { userId: '456' })).toBeNull();
    expect(await observe('c', 200, 'a', { chatId: `${chatId}-other` })).toBeNull();
  });
  it('does not revive an old action after content changes away and back', async () => {
    await observe('original', 0);
    const old = await observe('target', 100);
    await observe('target', 200, 'different');
    await observe('target', 300, 'a');
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
  });

  it('does not revive old evidence when the original changes away and back', async () => {
    await observe('original', 0);
    const old = await observe('target', 100);
    await observe('original', 200, 'different');
    await observe('original', 300, 'a');
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    const next = await observe('next', 400);
    expect(next?.binding.original?.publishedAtMs).toBe(start + 300);
  });

  it.each(['original', 'target'])(
    'never revives a binding after lifecycle-only A -> B -> A on %s',
    async (messageId) => {
      await observe('original', 0);
      const old = await observe('target', 100);
      const edit = async (time: number, text: string) =>
        history.observeLifecycle({
          chatId,
          messageId,
          eventTimestampMs: start + time,
          content: extractDuplicateMessageContent({ message: { body: { text } } }),
        });
      await edit(200, 'different');
      expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
      await edit(300, 'a');
      expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
      expect(await history.qualify(chatId, old!.binding)).toBeNull();
      const fresh = await observe(messageId, 300);
      const next = await observe('next', 400);
      expect(next).not.toBeNull();
      if (messageId === 'original') {
        expect(next!.binding.original!.revision).not.toBe(old!.binding.original!.revision);
      } else {
        expect(fresh?.binding.lifecycleRevision).not.toBe(old!.binding.lifecycleRevision);
        expect(next!.binding.original!.revision).toBe(old!.binding.original!.revision);
      }
    },
  );

  it('keeps an equal-time conflict revoked after replay and an older event', async () => {
    await observe('original', 0);
    const old = await observe('target', 100);
    const edit = (time: number, text: string) =>
      history.observeLifecycle({
        chatId,
        messageId: 'original',
        eventTimestampMs: start + time,
        content: extractDuplicateMessageContent({ message: { body: { text } } }),
      });
    await edit(0, 'conflict');
    await edit(0, 'a');
    await edit(-1, 'a');
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    expect(await observe('original', 0)).toBeNull();
    await observe('original', 200);
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    expect((await observe('next', 300))?.binding.original?.messageId).toBe('original');
  });

  it('does not recreate an old lifecycle incarnation after its Redis record disappears', async () => {
    await observe('original', 0);
    const old = await observe('target', 100);
    const key = `dup:window:v1:${digestDuplicateContent(chatId)}:v2:life:${digestDuplicateContent('original')}:MESSAGE`;
    await inspector.del(key);
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    await observe('original', 0);
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    const next = await observe('next', 200);
    expect(next?.binding.original?.revision).not.toBe(old!.binding.original!.revision);
    expect(next?.binding.original?.originalId).not.toBe(old!.binding.original!.originalId);
  });

  it.each(['original', 'target'])(
    'never restores an old binding after only %s message state disappears',
    async (messageId) => {
      await observe('original', 0);
      const old = await observe('target', 100);
      const key = `dup:window:v1:${digestDuplicateContent(chatId)}:v2:message:${digestDuplicateContent(messageId)}:MESSAGE`;
      await inspector.del(key);
      expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
      const fresh = await observe(messageId, messageId === 'original' ? 0 : 100);
      expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
      if (messageId === 'target') {
        expect(fresh?.binding.lifecycleRevision).not.toBe(old!.binding.lifecycleRevision);
        expect(await history.stillMatches(chatId, fresh!.binding)).toBe(true);
      } else {
        const next = await observe('next', 200);
        expect(next?.binding.original?.revision).not.toBe(old!.binding.original!.revision);
        expect(next?.binding.original?.originalId).not.toBe(old!.binding.original!.originalId);
      }
    },
  );

  it('does not admit an unknown-time MAX replacement after a later cosmetic event', async () => {
    await observe('original', 0);
    const old = await observe('target', 100);
    const changed = extractDuplicateMessageContent({ message: { body: { text: 'replacement' } } });
    await history.invalidateLifecycle({ chatId, messageId: 'original', content: changed });
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    await observe('original', 200, 'replacement');
    expect(await observe('replacement-first', 300, 'replacement')).toBeNull();
    const next = await observe('replacement-repeat', 400, 'replacement');
    expect(next?.binding.original?.messageId).toBe('replacement-first');
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
  });

  it('preserves image escalation and the original identity through caption-only pending refresh', async () => {
    const input = imageInput();
    await observe('original', 0, '', input);
    const first = await observe('first', 100, '', input);
    expect(await history.qualify(chatId, first!.binding)).toBe(1);
    const captionContent = {
      ...input.content,
      text: 'New caption with another link',
      rawText: 'New caption with another link',
    };
    await history.observeLifecycle({
      chatId,
      messageId: 'original',
      eventTimestampMs: start + 200,
      publishedAtMs: start,
      content: captionContent,
    });
    await observe('original', 200, '', { ...input, content: captionContent, mediaHashes: [] });
    expect(await history.stillMatches(chatId, first!.binding)).toBe(true);
    await observe('original', 200, '', { ...input, content: captionContent });
    const next = await observe('next', 300, '', input);
    expect(next?.hit.count).toBe(2);
    expect(await history.qualify(chatId, next!.binding)).toBe(2);
    expect(next?.binding.original).toEqual(first!.binding.original);
  });

  it('does not grant another allowance after a caption-only refresh of the original', async () => {
    const input = {
      ...imageInput(),
      settings: duplicateSettings({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 2 }),
    };
    await observe('original', 0, '', input);
    expect(await observe('allowed', 100, '', input)).toBeNull();
    await observe('original', 200, '', { ...input, mediaHashes: [] });
    await observe('original', 200, '', input);
    const next = await observe('next', 300, '', input);
    expect(next?.hit.count).toBe(2);
    expect(await history.qualify(chatId, next!.binding)).toBe(2);
    expect(next?.binding.original?.publishedAtMs).toBe(start);
    expect(next?.binding.original?.observedAtMs).toBe(start);
  });

  it('revokes reused photo locators when independent bytes change and return', async () => {
    const input = imageInput();
    await observe('original', 0, '', input);
    const old = await observe('target', 100, '', input);
    await observe('original', 200, '', { ...input, mediaHashes: ['b'.repeat(64)] });
    await observe('original', 300, '', input);
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    const next = await observe('next', 400, '', input);
    expect(next?.binding.original?.publishedAtMs).toBe(start + 300);
    expect(next?.binding.original?.revision).not.toBe(old!.binding.original!.revision);
  });

  it('retains the original counter only after one independently verified locator refresh', async () => {
    const input = imageInput();
    await observe('original', 0, '', input);
    const old = await observe('target', 100, '', input);
    expect(await history.qualify(chatId, old!.binding)).toBe(1);
    const refreshed = extractDuplicateMessageContent({
      message: {
        body: {
          attachments: [
            { type: 'image', payload: { photo_id: 'renewed', url: 'https://i.oneme.ru/renewed' } },
          ],
        },
      },
    });
    await history.observeLifecycle({
      chatId,
      messageId: 'original',
      eventTimestampMs: start + 200,
      content: refreshed,
    });
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    await observe('original', 200, '', { ...input, content: refreshed, mediaHashes: [] });
    await observe('original', 200, '', { ...input, content: refreshed });
    const next = await observe('next', 300, '', input);
    expect(next?.hit.count).toBe(2);
    expect(next?.binding.original?.originalId).toBe(old!.binding.original!.originalId);
    expect(next?.binding.original?.revision).not.toBe(old!.binding.original!.revision);
    expect(next?.binding.original?.publishedAtMs).toBe(start);
    expect(next?.binding.original?.expiresAtMs).toBe(old!.binding.original!.expiresAtMs);
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
  });

  it('does not retain a counter through an unverified intermediate image source', async () => {
    const input = imageInput();
    await observe('original', 0, '', input);
    const old = await observe('target', 100, '', input);
    expect(await history.qualify(chatId, old!.binding)).toBe(1);
    const source = (photoId: string) =>
      extractDuplicateMessageContent({
        message: {
          body: {
            attachments: [
              {
                type: 'image',
                payload: { photo_id: photoId, url: `https://i.oneme.ru/${photoId}` },
              },
            ],
          },
        },
      });
    for (const [offset, photoId] of [
      [200, 'intermediate'],
      [300, 'photo'],
    ] as const) {
      await history.observeLifecycle({
        chatId,
        messageId: 'original',
        eventTimestampMs: start + offset,
        content: source(photoId),
      });
    }
    await observe('original', 300, '', input);
    const next = await observe('next', 400, '', input);
    expect(next?.hit.count).toBe(1);
    expect(next?.binding.original?.originalId).not.toBe(old!.binding.original!.originalId);
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
  });

  it('does not consume a second allowance when an accepted duplicate changes only its locator', async () => {
    const input = {
      ...imageInput(),
      settings: duplicateSettings({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 3 }),
    };
    await observe('original', 0, '', input);
    expect(await observe('allowed', 100, '', input)).toBeNull();
    const refreshed = extractDuplicateMessageContent({
      message: {
        body: {
          attachments: [
            { type: 'image', payload: { photo_id: 'new-locator', url: 'https://i.oneme.ru/new' } },
          ],
        },
      },
    });
    await observe('allowed', 200, '', { ...input, content: refreshed, mediaHashes: [] });
    expect(await observe('allowed', 200, '', { ...input, content: refreshed })).toBeNull();
    expect(await observe('allowed-second', 300, '', input)).toBeNull();
    const rejected = await observe('rejected', 400, '', input);
    expect(rejected?.hit.count).toBe(3);
    expect(await history.qualify(chatId, rejected!.binding)).toBe(3);
  });

  it('bounds accepted occurrence state across policy changes and verified locator refreshes', async () => {
    const input = imageInput();
    for (let revision = 0; revision < 24; revision += 1) {
      const changed = {
        settings: duplicateSettings({
          duplicateWarnEnabled: true,
          duplicateWarnMaxCount: 2,
          duplicateHistoryRevision: revision,
          duplicatePolicyRevision: revision,
        }),
      };
      await observe('original', 0, '', { ...input, ...changed });
      const refreshed = extractDuplicateMessageContent({
        message: {
          body: {
            attachments: [
              {
                type: 'image',
                payload: {
                  photo_id: `locator-${revision}`,
                  url: `https://i.oneme.ru/locator-${revision}`,
                },
              },
            ],
          },
        },
      });
      expect(
        await observe('accepted', 100 + revision * 100, '', {
          ...input,
          ...changed,
          content: refreshed,
        }),
      ).toBeNull();
    }
    const key = `dup:window:v1:${digestDuplicateContent(chatId)}:v2:message:${digestDuplicateContent('accepted')}:IMAGE`;
    const state = JSON.parse((await inspector.get(key))!);
    expect(Object.keys(state.accepted).length).toBeLessThanOrEqual(16);
    const next = await observe('next', 3000, '', {
      ...input,
      settings: duplicateSettings({
        duplicateWarnEnabled: true,
        duplicateWarnMaxCount: 2,
        duplicateHistoryRevision: 23,
        duplicatePolicyRevision: 23,
      }),
    });
    expect(next?.hit.count).toBe(2);
  });

  it('does not carry another policy context through a pending locator promotion', async () => {
    const input = {
      ...imageInput(),
      settings: duplicateSettings({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 2 }),
    };
    await observe('original', 0, '', input);
    expect(await observe('accepted', 100, '', input)).toBeNull();
    const refreshed = extractDuplicateMessageContent({
      message: {
        body: {
          attachments: [
            { type: 'image', payload: { photo_id: 'new-locator', url: 'https://i.oneme.ru/new' } },
          ],
        },
      },
    });
    await observe('accepted', 200, '', { ...input, content: refreshed, mediaHashes: [] });
    const changed = {
      ...input,
      settings: { ...input.settings, duplicateHistoryRevision: 1, duplicatePolicyRevision: 1 },
    };
    await observe('original', 0, '', changed);
    expect(await observe('accepted', 200, '', { ...changed, content: refreshed })).toBeNull();
    const key = `dup:window:v1:${digestDuplicateContent(chatId)}:v2:message:${digestDuplicateContent('accepted')}:IMAGE`;
    const state = JSON.parse((await inspector.get(key))!);
    expect(Object.keys(state.accepted)).toHaveLength(1);
    expect((await observe('next', 300, '', changed))?.hit.count).toBe(2);
  });

  it('resumes the same qualified count through one verified duplicate locator refresh', async () => {
    const input = imageInput();
    await observe('original', 0, '', input);
    const target = await observe('target', 100, '', input);
    expect(await history.qualify(chatId, target!.binding)).toBe(1);
    const refreshed = extractDuplicateMessageContent({
      message: {
        body: {
          attachments: [
            { type: 'image', payload: { photo_id: 'new-locator', url: 'https://i.oneme.ru/new' } },
          ],
        },
      },
    });
    await observe('target', 200, '', { ...input, content: refreshed, mediaHashes: [] });
    const resumed = await observe('target', 200, '', { ...input, content: refreshed });
    expect(resumed?.hit.count).toBe(1);
    expect(await history.qualify(chatId, resumed!.binding)).toBe(1);
    const next = await observe('next', 300, '', input);
    expect(next?.hit.count).toBe(2);
    expect(await history.qualify(chatId, next!.binding)).toBe(2);
  });

  it('keeps outside-period material introduction through an inside-period cosmetic edit', async () => {
    const dailySettings = duplicateSettings({
      duplicateWindowMode: 'DAILY',
      duplicateStartTimeMinutes: 540,
      duplicateEndTimeMinutes: 1080,
      duplicateTimezone: 'UTC',
      duplicateCompareMode: 'TEXT',
    });
    const at = (messageId: string, iso: string, text: string, publishedAtMs?: number) =>
      observe(messageId, Date.parse(iso) - start, text, { settings: dailySettings, publishedAtMs });
    const publication = Date.parse('2026-10-01T12:00:00Z');
    await at('old', '2026-10-01T12:00:00Z', 'a');
    await at('old', '2026-10-02T08:00:00Z', 'different', publication);
    await at('old', '2026-10-02T10:00:00Z', ' different ', publication);
    expect(await at('first', '2026-10-02T10:00:00.100Z', 'different')).toBeNull();
    const next = await at('next', '2026-10-02T10:00:00.200Z', 'different');
    expect(next?.binding.original?.messageId).toBe('first');
  });

  it('re-evaluates unchanged content when its comparison settings change', async () => {
    await observe('original', 0);
    await observe('target', 100);
    const changed = { settings: duplicateSettings({ duplicateWarnWindowSec: 3600 }) };
    expect(await observe('target', 200, 'a', changed)).toBeNull();
    const next = await observe('next', 300, 'a', changed);
    expect(next?.binding.original?.messageId).toBe('target');
    expect(next?.binding.original?.publishedAtMs).toBe(start + 100);
  });

  it('preserves material-edit time when pending media becomes verified', async () => {
    const file = (url: string) =>
      extractDuplicateMessageContent({
        message: {
          body: {
            attachments: [{ type: 'file', payload: { url } }],
          },
        },
      });
    const oldTime = start - 2 * 86400_000;
    await observe('old', oldTime - start, '', {
      content: file('https://fd.oneme.ru/old'),
      mediaHashes: ['a'.repeat(64)],
    });
    await observe('old', 0, '', {
      content: file('https://fd.oneme.ru/new'),
      publishedAtMs: oldTime,
    });
    await observe('old', 0, '', {
      content: file('https://fd.oneme.ru/new'),
      publishedAtMs: oldTime,
      mediaHashes: ['b'.repeat(64)],
    });
    const repeated = await observe('repeat', 100, '', {
      content: file('https://fd.oneme.ru/new'),
      mediaHashes: ['b'.repeat(64)],
    });
    expect(repeated?.binding.original?.publishedAtMs).toBe(start);
    expect(repeated?.binding.original?.messageId).toBe('old');
  });

  it.each(['TEXT', 'IMAGE'] as const)(
    'resets %s evidence and sanctions at each daily period',
    async (mode) => {
      const dailySettings = duplicateSettings({
        duplicateWindowMode: 'DAILY',
        duplicateStartTimeMinutes: 540,
        duplicateEndTimeMinutes: 1080,
        duplicateCompareMode: mode === 'TEXT' ? 'TEXT' : 'MESSAGE',
      });
      const extra =
        mode === 'IMAGE'
          ? {
              content: extractDuplicateMessageContent({
                message: {
                  body: {
                    attachments: [{ type: 'image', payload: { url: 'https://i.oneme.ru/a' } }],
                  },
                },
              }),
              imageScope: 'CHAT' as const,
              mediaHashes: ['a'.repeat(64)],
            }
          : {};
      const at = (id: string, iso: string, overrides = {}) =>
        observe(id, Date.parse(iso) - start, 'a', {
          settings: dailySettings,
          ...extra,
          ...overrides,
        });
      expect(await at('outside', '2026-09-29T05:59Z')).toBeNull();
      expect(await at('first', '2026-09-29T06:00Z')).toBeNull();
      const repeat = await at('repeat', '2026-09-29T14:59Z');
      expect(repeat?.binding.original?.messageId).toBe('first');
      expect(repeat?.binding.original?.expiresAtMs).toBe(Date.parse('2026-09-29T15:00Z'));
      expect(await history.qualify(chatId, repeat!.binding)).toBe(1);
      expect(await at('closed', '2026-09-29T15:00Z')).toBeNull();
      // Yesterday's unchanged original and rejected target cannot become today's evidence.
      expect(
        await at('first', '2026-09-30T06:00Z', { publishedAtMs: Date.parse('2026-09-29T06:00Z') }),
      ).toBeNull();
      expect(
        await at('repeat', '2026-09-30T06:01Z', { publishedAtMs: Date.parse('2026-09-29T14:59Z') }),
      ).toBeNull();
      expect(await at('new-day', '2026-09-30T06:02Z')).toBeNull();
      const next = await at('new-repeat', '2026-09-30T06:03Z');
      expect(next?.binding.original?.messageId).toBe('new-day');
      expect(await history.qualify(chatId, next!.binding)).toBe(1);
    },
  );

  it('never lets a pending media observation downgrade an already verified revision', async () => {
    await observe('a', 0);
    const hit = await observe('b', 100);
    await observe('b', 100, '', {
      content: {
        ...extractDuplicateMessageContent({ message: { body: { text: 'a' } } }),
        complete: false,
        reason: 'invalid_content',
      },
    });
    expect(await history.stillMatches(chatId, hit!.binding)).toBe(true);
  });
  it('keeps policy CAS revisions after expiry and never overwrites a concurrent operator', async () => {
    const key = `message-duplicate:test-control:${chatId}`;
    keys.add(key);
    keys.add(`${key}:revision`);
    const set = (expectedRevision: number) =>
      redis.compareAndSetRevisionedControl({
        key,
        expectedRevision,
        value: JSON.stringify({ version: 1, revision: expectedRevision + 1 }),
        expiresAtMs: Date.now() + 10000,
      });
    const result = await Promise.all([set(0), set(0)]);
    expect(result.filter((item) => item.applied)).toHaveLength(1);
    await inspector.del(key);
    expect(await set(0)).toEqual({ applied: false, revision: 1 });
    expect(await set(1)).toEqual({ applied: true, revision: 2 });
    expect(
      await new MessageDuplicatePolicyService(
        redis,
        new ConfigService({ MESSAGE_DUPLICATE_ENABLED: false }),
      ).resolve('-123'),
    ).toMatchObject({ mode: 'off' });
  });

  it('requires explicit CUSTOM link matching to join a URL containing a phone-shaped value', async () => {
    const url = 'https://example.test/?phone=+79991234567';
    const phoneOnly = duplicateSettings({
      duplicateDetectionPreset: 'CUSTOM',
      duplicateIgnorePhonesEnabled: true,
    });
    await observe('phone-only-original', 0, `Продажа оборудования ${url}`, { settings: phoneOnly });
    expect(
      await observe('phone-only-unrelated', 100, `Консультация для участников ${url}`, {
        settings: phoneOnly,
      }),
    ).toBeNull();
    const explicitLink = { ...phoneOnly, duplicateIgnoreLinksEnabled: true };
    await observe('link-original', 200, `Продажа оборудования ${url}`, { settings: explicitLink });
    const repeated = await observe('link-repeat', 300, `Консультация для участников ${url}`, {
      settings: explicitLink,
    });
    expect(repeated?.hit.fingerprintType).toBe('link');
    expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
  });
});
