import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { RedisCounterService } from '../redis-counter.service';
import { extractDuplicateMessageContent } from './message-duplicate-content';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import { MessageDuplicatePolicyService } from './message-duplicate-policy.service';
import { duplicateSettings } from './message-duplicate-test-fixtures';

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
});
