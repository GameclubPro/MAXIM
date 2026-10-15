import { ChatContextMediaCache, chatContextMediaKey } from './chat-context-media-cache';
import type { ChatContext } from './chat-context-cache.service';

function context(base64 = 'x'.repeat(80_000)): ChatContext {
  return {
    chatId: 'test-chat',
    title: 'Test',
    settings: {
      botSpeechMedia: { greetingBotMessageText: { base64, mimeType: 'image/jpeg' } },
      stopWordsMedia: null,
    },
    adminUserIds: ['admin'],
    domainAllowlist: [],
    rulesPublishedUrl: null,
    rulesPublishedMessageId: null,
  } as unknown as ChatContext;
}
function store() {
  const values = new Map<string, string>();
  return {
    values,
    get: jest.fn(async (key: string) => values.get(key) ?? null),
    set: jest.fn(async (key: string, raw: string) => {
      values.set(key, raw);
      return 'OK';
    }),
    expire: jest.fn(async (key: string) => Number(values.has(key))),
  };
}

describe('ChatContextMediaCache', () => {
  it('round-trips exact content with an isolated compact envelope and small TTL renewals', async () => {
    const redis = store();
    const writer = new ChatContextMediaCache(redis as never);
    const reader = new ChatContextMediaCache(redis as never);
    const source = context();
    const encoded = await writer.encode(source);
    expect(encoded.serialized.length).toBeLessThan(1024);
    expect(encoded.fullBytesEstimate).toBeGreaterThan(JSON.stringify(source).length);
    expect(source.settings.botSpeechMedia).toEqual(context().settings.botSpeechMedia);
    expect((await reader.decode(encoded.serialized)).value).toEqual(source);
    expect((await reader.decode(encoded.serialized)).value).not.toHaveProperty('__maximMedia');
    await writer.encode(source);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.get).toHaveBeenCalledTimes(1);
  });

  it('keeps null, absent and small media inline without extra Redis work', async () => {
    const redis = store();
    const cache = new ChatContextMediaCache(redis as never);
    const source = context('tiny');
    const encoded = await cache.encode(source);
    expect(encoded.blobKeys).toEqual([]);
    expect((await cache.decode(encoded.serialized)).value).toEqual(source);
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('preserves independently bound stop-word media and never shares mutable decoded objects', async () => {
    const redis = store();
    const cache = new ChatContextMediaCache(redis as never);
    const source = context();
    source.settings.stopWordsMedia = { warning: { base64: 's'.repeat(90_000) } };
    const encoded = await cache.encode(source);
    expect(encoded.blobKeys).toHaveLength(2);
    const first = (await cache.decode(encoded.serialized)).value;
    (first.settings.botSpeechMedia as Record<string, unknown>).greetingBotMessageText = null;
    first.settings.stopWordsMedia = null;
    expect((await cache.decode(encoded.serialized)).value).toEqual(source);
  });

  it.each(['missing', 'changed', 'wrong_length'])(
    'rejects %s blob bytes instead of returning a partial context',
    async (mode) => {
      const redis = store();
      const encoded = await new ChatContextMediaCache(redis as never).encode(context());
      const key = encoded.blobKeys[0]!;
      if (mode === 'missing') redis.values.delete(key);
      else if (mode === 'changed')
        redis.values.set(key, redis.values.get(key)!.replace('xxxx', 'yyyy'));
      else redis.values.set(key, '{}');
      await expect(
        new ChatContextMediaCache(redis as never).decode(encoded.serialized),
      ).rejects.toThrow('Chat context media cache miss');
    },
  );

  it.each(['version', 'field', 'digest', 'size', 'inline_conflict'])(
    'rejects a malformed %s reference',
    async (mode) => {
      const redis = store();
      const encoded = await new ChatContextMediaCache(redis as never).encode(context());
      const value = JSON.parse(encoded.serialized);
      if (mode === 'version') value.__maximMedia.version = 2;
      if (mode === 'field')
        value.__maximMedia.fields.adminUserIds = value.__maximMedia.fields.botSpeechMedia;
      if (mode === 'digest') value.__maximMedia.fields.botSpeechMedia.sha256 = '../not-a-digest';
      if (mode === 'size') value.__maximMedia.fields.botSpeechMedia.bytes = 100_000_000;
      if (mode === 'inline_conflict') value.settings.botSpeechMedia = {};
      await expect(
        new ChatContextMediaCache(redis as never).decode(JSON.stringify(value)),
      ).rejects.toThrow();
      expect(redis.get).not.toHaveBeenCalled();
    },
  );

  it('restores an expired remote blob before a later source publication', async () => {
    const redis = store();
    const cache = new ChatContextMediaCache(redis as never);
    const encoded = await cache.encode(context());
    redis.values.delete(encoded.blobKeys[0]!);
    await cache.encode(context());
    expect(redis.set).toHaveBeenCalledTimes(2);
    await expect(
      new ChatContextMediaCache(redis as never).decode(encoded.serialized),
    ).resolves.toMatchObject({ value: context() });
  });

  it('bounds retained media memory across different communities and releases it at shutdown', async () => {
    const redis = store();
    const cache = new ChatContextMediaCache(redis as never);
    const first = await cache.encode(context('a'.repeat(3_000_000)));
    await cache.encode(context('b'.repeat(3_000_000)));
    await cache.encode(context('c'.repeat(3_000_000)));
    const ref = JSON.parse(first.serialized).__maximMedia.fields.botSpeechMedia;
    await cache.decode(first.serialized);
    expect(redis.get).toHaveBeenCalledWith(chatContextMediaKey(ref.sha256));
    cache.clear();
    await cache.decode(first.serialized);
    expect(redis.get).toHaveBeenCalledTimes(2);
  });
});
