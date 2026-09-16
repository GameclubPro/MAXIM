import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { RedisCounterService } from './redis-counter.service';
import { TrafficProtectionDetector } from './traffic-protection.detector';
import type { TrafficProtectionSettings } from './traffic-protection';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
const local = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

(local ? describe : describe.skip)('traffic protection Redis integration', () => {
  let redis: RedisCounterService;
  let inspector: Redis;
  let detector: TrafficProtectionDetector;
  let chatId: string;
  let now: number;
  let settings: TrafficProtectionSettings;

  beforeEach(() => {
    redis = new RedisCounterService(new ConfigService({ REDIS_URL: url }));
    inspector = new Redis(url);
    detector = new TrafficProtectionDetector(redis);
    chatId = randomUUID();
    now = Date.now();
    settings = {
      slowModeEnabled: true,
      slowModeIntervalSeconds: 30,
      mediaMessageCooldownEnabled: false,
      mediaMessageCooldownSeconds: 30,
      stickerMessagesEnabled: true,
      trafficPolicyRevision: 1,
      trafficPolicyEffectiveAt: new Date(now - 100_000),
    };
  });

  afterEach(async () => {
    let cursor = '0';
    do {
      const [next, keys] = await inspector.scan(
        cursor,
        'MATCH',
        `traffic:v1:${chatId}:*`,
        'COUNT',
        100,
      );
      cursor = next;
      if (keys.length) await inspector.del(...keys);
    } while (cursor !== '0');
    await inspector.quit();
    await redis.onModuleDestroy();
  });

  const observe = (
    messageId: string,
    timestamp = now,
    overrides: Partial<Parameters<TrafficProtectionDetector['detect']>[0]> = {},
  ) =>
    detector.detect({
      chatId,
      userId: 'user',
      messageId,
      eventTimestampMs: timestamp,
      eventType: 'message_created',
      text: 'Hello',
      media: {},
      settings,
      ...overrides,
    });

  it('admits one simultaneous send and replays every original decision', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => observe(`message-${i}`)),
    );
    expect(results.filter((result) => result === null)).toHaveLength(1);
    for (let i = 0; i < 12; i++) expect(await observe(`message-${i}`)).toEqual(results[i]);
    expect(await observe('other', now, { userId: 'other' })).toBeNull();
  });
  it('does not extend the interval on a rejected attempt', async () => {
    expect(await observe('first', now - 20_000)).toBeNull();
    expect(await observe('blocked')).toMatchObject({ ruleCode: 'SLOW_MODE' });
    expect(await observe('boundary', now + 10_000)).toBeNull();
    expect(await observe('first', now - 20_000)).toBeNull();
    expect(await observe('blocked')).toMatchObject({ ruleCode: 'SLOW_MODE' });
  });
  it('does not charge edits or late originals as new sends', async () => {
    expect(await observe('first', now - 1000)).toBeNull();
    expect(await observe('old', now - 2000)).toBeNull();
    expect(await observe('edit', now, { eventType: 'message_edited' })).toBeNull();
    expect(await observe('next')).toMatchObject({ ruleCode: 'SLOW_MODE' });
  });
  it('counts an accepted album once, even across mirrored and out-of-order parts', async () => {
    const album = {
      mediaGroupId: 'album-a',
      media: { hasPhotoAttachment: true, hasMediaBatch: true },
    };
    expect(await observe('middle', now - 500, album)).toBeNull();
    expect(await observe('first', now - 1000, album)).toBeNull();
    expect(await observe('last', now, album)).toBeNull();
    expect(await observe('last', now, album)).toBeNull();
    expect(await observe('other-album', now, { ...album, mediaGroupId: 'album-b' })).toMatchObject({
      ruleCode: 'SLOW_MODE',
    });
  });
  it('replays a rejected album decision for all of its bounded parts', async () => {
    await observe('first', now - 1000);
    const album = {
      mediaGroupId: 'album',
      media: { hasVideoAttachment: true, hasMediaBatch: true },
    };
    expect(await observe('part-1', now, album)).toMatchObject({ ruleCode: 'SLOW_MODE' });
    expect(await observe('part-2', now + 1000, album)).toMatchObject({ ruleCode: 'SLOW_MODE' });
  });
  it('resets only on a policy revision and ignores pre-activation events', async () => {
    await observe('first', now - 1000);
    expect(await observe('second')).not.toBeNull();
    settings = { ...settings, trafficPolicyRevision: 2, trafficPolicyEffectiveAt: new Date(now) };
    expect(await observe('old-policy', now - 500)).toBeNull();
    expect(await observe('new-policy')).toBeNull();
  });
  it('retains the decision after a service restart or lost response', async () => {
    await observe('first', now - 1000);
    const original = redis.claimEventCooldown.bind(redis);
    jest.spyOn(redis, 'claimEventCooldown').mockImplementationOnce(async (params) => {
      await original(params);
      throw new Error('lost response');
    });
    await expect(observe('second')).rejects.toThrow('lost response');
    detector = new TrafficProtectionDetector(redis);
    expect(await observe('second')).toMatchObject({ ruleCode: 'SLOW_MODE' });
  });
  it('isolates media counters from text and accepts a late command only before its deadline', async () => {
    settings.slowModeEnabled = false;
    settings.mediaMessageCooldownEnabled = true;
    expect(await observe('text')).toBeNull();
    expect(await observe('file', now - 1000, { media: { hasFileAttachment: true } })).toBeNull();
    expect(await observe('voice', now, { media: { hasVoiceAttachment: true } })).toMatchObject({
      ruleCode: 'MEDIA_RATE_LIMIT',
    });
    const key = `traffic:v1:${chatId}:deadline`;
    expect(
      await redis.claimEventCooldown({
        key,
        memberKey: `${key}:member`,
        eventTimestampMs: now,
        windowSeconds: 30,
        deadlineAtMs: now - 1,
      }),
    ).toBe('deadline_exceeded');
    expect(await inspector.mget(key, `${key}:member`)).toEqual([null, null]);
  });
});
