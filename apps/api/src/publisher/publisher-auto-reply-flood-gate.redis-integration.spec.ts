import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { PublisherAutoReplyFloodGateService } from './publisher-auto-reply-flood-gate.service';

const redisIntegrationUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const isLocalRedisUrl = (() => {
  try {
    const hostname = new URL(redisIntegrationUrl).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
})();
const describeLocalRedis = isLocalRedisUrl ? describe : describe.skip;

type FloodIdentity = Parameters<PublisherAutoReplyFloodGateService['replay']>[0];

describeLocalRedis('PublisherAutoReplyFloodGateService Redis integration', () => {
  const originalRole = process.env.APP_ROLE;

  beforeAll(() => {
    process.env.APP_ROLE = 'enqueue';
  });

  afterAll(() => {
    process.env.APP_ROLE = originalRole;
  });

  it('enforces exact burst boundaries and keeps replay-only decisions read-only', async () => {
    const suffix = randomUUID();
    const publisherBotId = `publisher-bot-${suffix}`;
    const ownedKeys = new Set<string>();
    const identity = (chatId: string, senderUserId: string, sourceMessageId: string) => {
      const value = { publisherBotId, chatId, senderUserId, sourceMessageId };
      for (const key of buildFloodGateKeys(value)) {
        ownedKeys.add(key);
      }
      return value;
    };
    const service = new PublisherAutoReplyFloodGateService({
      get: (_key: string, fallback?: unknown) => fallback,
      getOrThrow: () => redisIntegrationUrl,
    } as never);
    const inspector = new Redis(redisIntegrationUrl);

    try {
      await waitForServiceRedis(service);

      const userChatId = `user-burst-chat-${suffix}`;
      const userId = `user-burst-${suffix}`;
      const allowedUserMessages = Array.from({ length: 3 }, (_, index) =>
        identity(userChatId, userId, `user-message-${index}-${suffix}`),
      );
      for (const message of allowedUserMessages) {
        await expect(service.reserve(message)).resolves.toEqual({
          allowed: true,
          replayed: false,
        });
      }
      const deniedUserMessage = identity(userChatId, userId, `user-message-denied-${suffix}`);
      await expect(service.reserve(deniedUserMessage)).resolves.toEqual({
        allowed: false,
        reason: 'user_burst',
      });
      await expect(service.replay(allowedUserMessages[0]!)).resolves.toEqual({
        allowed: true,
        replayed: true,
      });
      await expect(service.replay(deniedUserMessage)).resolves.toEqual({
        allowed: false,
        reason: 'user_burst',
      });

      const chatBurstId = `chat-burst-${suffix}`;
      for (let index = 0; index < 30; index += 1) {
        await expect(
          service.reserve(
            identity(
              chatBurstId,
              `chat-user-${index}-${suffix}`,
              `chat-message-${index}-${suffix}`,
            ),
          ),
        ).resolves.toEqual({ allowed: true, replayed: false });
      }
      await expect(
        service.reserve(
          identity(chatBurstId, `chat-user-denied-${suffix}`, `chat-message-denied-${suffix}`),
        ),
      ).resolves.toEqual({ allowed: false, reason: 'chat_burst' });

      const missing = identity(
        `missing-chat-${suffix}`,
        `missing-user-${suffix}`,
        `missing-message-${suffix}`,
      );
      await expect(service.replay(missing)).resolves.toEqual({
        allowed: false,
        reason: 'decision_missing',
      });
      await expect(service.reserve(missing)).resolves.toEqual({
        allowed: true,
        replayed: false,
      });
    } finally {
      const keys = [...ownedKeys];
      if (keys.length > 0) {
        await inspector.del(...keys);
      }
      await inspector.quit();
      service.onModuleDestroy();
    }
  });
});

function buildFloodGateKeys(identity: FloodIdentity): string[] {
  const chatDigest = digestIdentity('chat', identity.publisherBotId, identity.chatId);
  const userDigest = digestIdentity(
    'user',
    identity.publisherBotId,
    identity.chatId,
    identity.senderUserId,
  );
  const decisionDigest = digestIdentity(
    'decision',
    identity.publisherBotId,
    identity.chatId,
    identity.sourceMessageId,
  );
  const prefix = `publisher:auto-reply:flood:v1:{${chatDigest}}`;
  return [`${prefix}:decision:${decisionDigest}`, `${prefix}:user:${userDigest}`, `${prefix}:chat`];
}

function digestIdentity(domain: string, ...parts: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([domain, ...parts]))
    .digest('hex')
    .slice(0, 32);
}

async function waitForServiceRedis(service: PublisherAutoReplyFloodGateService): Promise<void> {
  const redis = (service as unknown as { redis: Redis }).redis;
  if (redis.status === 'ready') {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for flood-gate Redis integration client'));
    }, 5_000);
    timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      redis.off('ready', onReady);
      redis.off('end', onEnd);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('Flood-gate Redis integration client closed before becoming ready'));
    };
    redis.once('ready', onReady);
    redis.once('end', onEnd);
  });
}
