import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { RedisCounterService } from '../redis-counter.service';
import { extractDuplicateMessageContent } from './message-duplicate-content';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import {
  MessageDuplicatePolicyService,
  MESSAGE_DUPLICATE_CONTROL_KEY,
} from './message-duplicate-policy.service';
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

  it('isolates author escalation while sharing exact-image matching and replay snapshots', async () => {
    const input = imageInput();
    expect(await observe('a1', 0, '', input)).toBeNull();
    expect((await observe('a2', 100, '', input))?.hit.count).toBe(1);
    expect((await observe('a3', 200, '', input))?.hit.count).toBe(2);
    const b = await observe('b1', 300, '', { ...input, userId: '456' });
    expect(b?.hit.count).toBe(1);
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
