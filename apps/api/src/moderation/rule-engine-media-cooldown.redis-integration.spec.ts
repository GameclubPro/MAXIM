import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { RuleEngineService } from './rule-engine.service';
import type { ChatSettings } from '../prisma/prisma-client';
import { RedisCounterService } from './redis-counter.service';
import {
  ANTI_SPAM_BURST_LIMIT,
  ANTI_SPAM_BURST_WINDOW_SEC,
  RuleEngineMessageLimitsDetector,
} from './rule-engine-message-limits.detector';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
const local = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

(local ? describe : describe.skip)('media cooldown Redis integration', () => {
  let redis: RedisCounterService;
  let inspector: Redis;
  let detector: RuleEngineMessageLimitsDetector;
  let chatId: string;
  let settings: ChatSettings;
  let now: number;

  beforeEach(() => {
    redis = new RedisCounterService(new ConfigService({ REDIS_URL: url }));
    inspector = new Redis(url);
    detector = new RuleEngineMessageLimitsDetector(redis);
    chatId = randomUUID();
    now = Date.now();
    settings = {
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 1,
      stickerMessageCooldownEnabled: true,
      stickerMessageCooldownMinutes: 1,
      updatedAt: new Date(now - 86_400_000),
    } as ChatSettings;
  });

  afterEach(async () => {
    let cursor = '0';
    do {
      const [next, keys] = await inspector.scan(cursor, 'MATCH', `*${chatId}*`, 'COUNT', 100);
      cursor = next;
      if (keys.length) await inspector.del(...keys);
    } while (cursor !== '0');
    await inspector.quit();
    await redis.onModuleDestroy();
  });

  const observe = (messageId: string, eventTimestampMs: number, overrides = {}) => {
    const input = {
      chatId,
      userId: 'user',
      messageId,
      eventTimestampMs,
      settings,
      hasStickerAttachment: true,
      ...overrides,
    };
    return detector.detectMediaCooldownLimits(input);
  };

  const burstWindowKey = () =>
    `message:anti-spam-burst:v2:${chatId}:user:${ANTI_SPAM_BURST_LIMIT}:${ANTI_SPAM_BURST_WINDOW_SEC}`;

  it('replays the original violation without counting delivery twice or accusing the original', async () => {
    expect(await observe('first', now - 1000)).toEqual([]);
    expect(await observe('repeat', now)).toEqual([
      expect.objectContaining({ ruleCode: 'STICKER_RATE_LIMIT' }),
    ]);
    expect(await observe('repeat', now)).toEqual([
      expect.objectContaining({ ruleCode: 'STICKER_RATE_LIMIT' }),
    ]);
    expect(await observe('first', now - 1000)).toEqual([]);
  });

  it.each([
    ['sticker', 60_000, {}],
    ['photo', 3_600_000, { hasStickerAttachment: false, hasPhotoAttachment: true }],
  ])(
    'permits %s exactly at its event-time boundary despite processing delay',
    async (_, windowMs, flags) => {
      const start = now - windowMs + 30_000;
      expect(await observe('first', start, flags)).toEqual([]);
      expect(await observe('too-early', start + windowMs - 1, flags)).toHaveLength(1);
      expect(await observe('boundary', start + windowMs, flags)).toEqual([]);
      expect(await observe('too-early', start + windowMs - 1, flags)).toHaveLength(1);
    },
  );

  it('does not restart the cooldown when an unrelated setting is saved', async () => {
    await observe('first', now - 1000);
    settings = { ...settings, updatedAt: new Date(now), greetingEnabled: true };
    expect(await observe('second', now)).toEqual([
      expect.objectContaining({ ruleCode: 'STICKER_RATE_LIMIT' }),
    ]);
  });

  it('does not extend the interval after a rejected attempt', async () => {
    await observe('first', now - 30_000);
    expect(await observe('blocked', now)).toHaveLength(1);
    expect(await observe('next', now + 30_000)).toEqual([]);
  });

  it('does not sanction a late original or move the accepted timestamp backwards', async () => {
    await observe('newer', now - 1000);
    expect(await observe('late-original', now - 2000)).toEqual([]);
    expect(await observe('next', now)).toHaveLength(1);
  });

  it('skips expired or untrusted future events without consuming the interval', async () => {
    expect(await observe('expired', now - 61_000)).toEqual([]);
    expect(await observe('future', now + 120_000)).toEqual([]);
    expect(await observe('valid', now)).toEqual([]);
  });

  it('does not count a message without a trusted timestamp', async () => {
    expect(await observe('unknown', now, { eventTimestampMs: undefined })).toEqual([]);
    expect(await observe('valid', now)).toEqual([]);
  });

  it('never mutates Redis when the command misses its absolute deadline', async () => {
    const key = `cooldown-test:${chatId}`;
    const memberKey = `${key}:member`;
    expect(
      await redis.claimEventCooldown({
        key,
        memberKey,
        eventTimestampMs: now,
        windowSeconds: 60,
        deadlineAtMs: now - 1,
      }),
    ).toBe('deadline_exceeded');
    expect(await inspector.mget(key, memberKey)).toEqual([null, null]);
  });

  it('lets the Redis clock reject an expired burst deadline without late membership writes', async () => {
    const key = `burst-deadline:${chatId}`;
    const stateKey = `${key}:state`;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now - 2000);
    try {
      // FLAG: The application clock passes both prechecks; the real Redis Lua guard owns expiry.
      expect(
        await redis.replaceRevisionedSetMembershipsBeforeDeadline({
          stateKey,
          member: 'member',
          revision: now - 1000,
          membershipKeys: [key],
          windowSeconds: ANTI_SPAM_BURST_WINDOW_SEC,
          ttlSeconds: 60,
          deadlineAtMs: now - 1,
        }),
      ).toEqual({ kind: 'deadline_exceeded' });
    } finally {
      clock.mockRestore();
    }
    expect(await inspector.exists(key, stateKey)).toBe(0);
  });

  it('propagates a lost response and recovers the same decision on retry', async () => {
    await observe('first', now - 1000);
    const original = redis.claimEventCooldown.bind(redis);
    jest.spyOn(redis, 'claimEventCooldown').mockImplementationOnce(async (params) => {
      await original(params);
      throw new Error('response lost');
    });
    await expect(observe('repeat', now)).rejects.toThrow('response lost');
    expect(await observe('repeat', now)).toHaveLength(1);
  });

  it('admits only one concurrent message and keeps chat and author scopes separate', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => observe(`message-${index}`, now)),
    );
    expect(results.filter((result) => result.length === 0)).toHaveLength(1);
    expect(await observe('other-author', now, { userId: 'other' })).toEqual([]);
    expect(await observe('other-chat', now, { chatId: `${chatId}-other` })).toEqual([]);
  });

  it('does not ban on six messages when the first is outside the six-second window', async () => {
    const config = { ...settings, antiSpamEnabled: true };
    for (let index = 0; index < 6; index++) {
      const input = {
        chatId,
        userId: 'user',
        messageId: `burst-${index}`,
        settings: config,
        eventTimestampMs: now - 5500 + (index === 5 ? 6000 : index * 1000),
      };
      expect(await detector.detectAntiSpamBurstLimit(input)).toBeNull();
    }
  });

  it('replays the sixth-message burst decision without accusing the first message', async () => {
    const config = { ...settings, antiSpamEnabled: true };
    const input = (index: number) => ({
      chatId,
      userId: 'user',
      messageId: `burst-${index}`,
      settings: config,
      eventTimestampMs: now - 1000 + index,
    });
    for (let index = 0; index < 5; index++) {
      expect(await detector.detectAntiSpamBurstLimit(input(index))).toBeNull();
    }
    const sixth = input(5);
    expect(await detector.detectAntiSpamBurstLimit(sixth)).toMatchObject({
      ruleCode: 'MESSAGE_RATE_LIMIT',
    });
    expect(await inspector.zcard(burstWindowKey())).toBe(6);
    expect(await detector.detectAntiSpamBurstLimit(sixth)).toMatchObject({
      ruleCode: 'MESSAGE_RATE_LIMIT',
    });
    expect(await detector.detectAntiSpamBurstLimit(input(0))).toBeNull();
    expect(await inspector.zcard(burstWindowKey())).toBe(6);
  });

  it.each(['burst', 'count'] as const)(
    'keeps independent moderation after a committed %s response misses its deadline',
    async (kind) => {
      const config = {
        ...settings,
        antiSpamEnabled: kind === 'burst',
        messageCountLimitEnabled: kind === 'count',
        messageCountLimitMessages: 1,
        messageCountLimitWindowHours: 1,
        messageLimitsBlockedWords: ['спаммаркер'],
        messageLimitsBlockedDomains: [],
        phoneNumbersEnabled: true,
      };
      const input = (index: number) => ({
        chatId,
        userId: 'user',
        messageId: `limit-${index}`,
        settings: config,
        eventTimestampMs: now - 1000 + index,
      });
      const threshold = kind === 'burst' ? ANTI_SPAM_BURST_LIMIT : 1;
      for (let index = 0; index < threshold; index++) {
        expect(
          await (kind === 'burst'
            ? detector.detectAntiSpamBurstLimit(input(index))
            : detector.detectMessageCountLimit(input(index))),
        ).toBeNull();
      }
      const original = redis.replaceRevisionedSetMembershipsBeforeDeadline.bind(redis);
      let releaseResponse!: () => void;
      const responseBarrier = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      let nativeResult!: Awaited<ReturnType<typeof original>>;
      let finishResponse!: () => void;
      const responseDone = new Promise<void>((resolve) => {
        finishResponse = resolve;
      });
      const response = jest
        .spyOn(redis, 'replaceRevisionedSetMembershipsBeforeDeadline')
        .mockImplementationOnce(async (params) => {
          try {
            nativeResult = await original(params);
            await responseBarrier;
            return nativeResult;
          } finally {
            finishResponse();
          }
        });
      const engine = new RuleEngineService(redis);
      const current = input(threshold);
      const detection = engine.detect({
        ...current,
        text: 'тут спаммаркер внутри',
        domainAllowlist: [],
        duplicateStateEventTimestampMs: current.eventTimestampMs,
      });
      try {
        const result = await detection;
        expect(nativeResult).toMatchObject({ kind: 'applied', counts: [threshold + 1] });
        expect(result.violations.map((violation) => violation.ruleCode)).toEqual([
          'MESSAGE_BLOCKED_WORD',
        ]);
        expect(response).toHaveBeenCalledTimes(1);
        const key = response.mock.calls[0]![0].membershipKeys[0]!;
        expect(await inspector.zcard(key)).toBe(threshold + 1);
        releaseResponse();
        await responseDone;
        expect(result.violations.map((violation) => violation.ruleCode)).toEqual([
          'MESSAGE_BLOCKED_WORD',
        ]);
        expect(response).toHaveBeenCalledTimes(1);
      } finally {
        releaseResponse();
        await Promise.allSettled([detection, ...(response.mock.calls.length ? [responseDone] : [])]);
        response.mockRestore();
      }
    },
  );

  it('completes the engine when a committed cooldown response arrives after its deadline', async () => {
    await observe('first', now - 1000);
    const original = redis.claimEventCooldown.bind(redis);
    let releaseResponse!: () => void;
    const responseBarrier = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let nativeResult!: Awaited<ReturnType<typeof original>>;
    let finishResponse!: () => void;
    const responseDone = new Promise<void>((resolve) => {
      finishResponse = resolve;
    });
    const response = jest
      .spyOn(redis, 'claimEventCooldown')
      .mockImplementationOnce(async (params) => {
        try {
          nativeResult = await original(params);
          await responseBarrier;
          return nativeResult;
        } finally {
          finishResponse();
        }
      });
    const detection = new RuleEngineService(redis).detect({
      chatId,
      userId: 'user',
      messageId: 'repeat',
      duplicateStateEventTimestampMs: now,
      text: '',
      domainAllowlist: [],
      hasStickerAttachment: true,
      settings: {
        ...settings,
        messageLimitsBlockedWords: [],
        messageLimitsBlockedDomains: [],
        phoneNumbersEnabled: true,
      },
    });
    try {
      const result = await detection;
      expect(nativeResult).toBe('blocked');
      expect(result.violations).toEqual([]);
      expect(response).toHaveBeenCalledTimes(1);
      releaseResponse();
      await responseDone;
      expect(result.violations).toEqual([]);
      expect(response).toHaveBeenCalledTimes(1);
    } finally {
      releaseResponse();
      await Promise.allSettled([detection, ...(response.mock.calls.length ? [responseDone] : [])]);
      response.mockRestore();
    }
  });

  it('keeps the absolute cooldown write deadline after the local detector returns', async () => {
    const original = redis.claimEventCooldown.bind(redis);
    let releaseCommand!: () => void;
    const commandBarrier = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    let nativeResult!: Awaited<ReturnType<typeof original>>;
    let finishCommand!: () => void;
    const commandDone = new Promise<void>((resolve) => {
      finishCommand = resolve;
    });
    const command = jest
      .spyOn(redis, 'claimEventCooldown')
      .mockImplementationOnce(async (params) => {
        try {
          await commandBarrier;
          nativeResult = await original(params);
          return nativeResult;
        } finally {
          finishCommand();
        }
      });
    try {
      await expect(observe('late-command', now)).resolves.toEqual([]);
      expect(command).toHaveBeenCalledTimes(1);
      releaseCommand();
      await commandDone;
      expect(nativeResult).toBe('deadline_exceeded');
      const params = command.mock.calls[0]![0];
      expect(await inspector.exists(params.key, params.memberKey)).toBe(0);
    } finally {
      releaseCommand();
      await commandDone;
      command.mockRestore();
    }
  });

  it('counts only chronological predecessors for delayed burst deliveries', async () => {
    const config = { ...settings, antiSpamEnabled: true };
    for (let index = 5; index >= 0; index--) {
      const input = {
        chatId,
        userId: 'user',
        messageId: `burst-${index}`,
        settings: config,
        eventTimestampMs: now - 1000 + index,
      };
      expect(await detector.detectAntiSpamBurstLimit(input)).toBeNull();
    }
  });

  it('replays a message-count violation and admits the exact hourly boundary', async () => {
    const config = {
      ...settings,
      messageCountLimitEnabled: true,
      messageCountLimitMessages: 1,
      messageCountLimitWindowHours: 1,
    };
    const input = (messageId: string, eventTimestampMs: number) => ({
      chatId,
      userId: 'user',
      messageId,
      eventTimestampMs,
      settings: config,
    });
    const first = input('first', now - 3_599_000);
    const second = input('second', now - 3_598_000);
    expect(await detector.detectMessageCountLimit(first)).toBeNull();
    expect(await detector.detectMessageCountLimit(second)).toMatchObject({
      ruleCode: 'MESSAGE_COUNT_LIMIT',
    });
    expect(await detector.detectMessageCountLimit(second)).toMatchObject({
      ruleCode: 'MESSAGE_COUNT_LIMIT',
    });
    expect(await detector.detectMessageCountLimit(input('boundary', now + 2000))).toBeNull();
  });
});
