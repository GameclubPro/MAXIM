import { ConfigService } from '@nestjs/config';
import { stopWordsPolicySchema, type StopWordsPolicy } from '@maxim/contracts/settings';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import {
  readStopWordsPolicy,
  stopWordsPolicyStorage,
} from '../moderation/stop-words/stop-words.policy';
import { createPrismaAdapter, PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AdminSettingsBotCapabilityService } from './admin-settings-bot-capability.service';
import type { AdminSettingsService } from './admin-settings.service';
import { AdminStopWordsService } from './admin-stop-words.service';
import type { ManagedEntitiesService } from './managed-entities.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const integration = databaseUrl && redisUrl ? describe : describe.skip;

integration('stop-word admin atomic writes and retry with PostgreSQL and Redis', () => {
  let db: PrismaClient;
  let redis: Redis;
  let cache: ChatContextCacheService;
  let service: AdminStopWordsService;
  let chatId: string;
  const user: AuthUser = { userId: 'stop-words-native-admin', username: null, displayName: null };
  const access = jest.fn<
    ReturnType<ManagedEntitiesService['assertChatAdminAccess']>,
    Parameters<ManagedEntitiesService['assertChatAdminAccess']>
  >();
  const capabilities = jest.fn<
    ReturnType<AdminSettingsBotCapabilityService['assertChatSettingsBotCapabilities']>,
    Parameters<AdminSettingsBotCapabilityService['assertChatSettingsBotCapabilities']>
  >();

  beforeAll(async () => {
    const database = new URL(databaseUrl);
    const store = new URL(redisUrl);
    if (
      !['localhost', '127.0.0.1'].includes(database.hostname) ||
      !database.pathname.includes('race_test') ||
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(store.hostname)
    )
      throw new Error('Disposable localhost PostgreSQL and Redis required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 4, statement_timeout: 10_000 }),
    });
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.ping();
  });

  beforeEach(async () => {
    chatId = `stop-words-native-${randomUUID()}`;
    access.mockReset().mockResolvedValue(undefined);
    capabilities.mockReset().mockResolvedValue(undefined);
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Stop-word native write fixture',
        settings: {
          create: {
            ...stopWordsPolicyStorage(stopWordsPolicySchema.parse({})),
            antiSpamEnabled: true,
          },
        },
      },
    });
    const config = new ConfigService({
      REDIS_URL: redisUrl,
      IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: 'off',
    });
    const routing = { forgetChatBotBinding: jest.fn() } satisfies Pick<
      MaxBotLinkService,
      'forgetChatBotBinding'
    >;
    cache = new ChatContextCacheService(
      db as PrismaService,
      config,
      routing as unknown as MaxBotLinkService,
    );
    const admin = { assertChatAdminAccess: access } satisfies Pick<
      ManagedEntitiesService,
      'assertChatAdminAccess'
    >;
    const settings = {
      getSettings: jest
        .fn<
          ReturnType<AdminSettingsService['getSettings']>,
          Parameters<AdminSettingsService['getSettings']>
        >()
        .mockRejectedValue(new Error('Existing settings must not be recreated')),
    } satisfies Pick<AdminSettingsService, 'getSettings'>;
    const capabilityService = {
      assertChatSettingsBotCapabilities: capabilities,
    } satisfies Pick<AdminSettingsBotCapabilityService, 'assertChatSettingsBotCapabilities'>;
    service = new AdminStopWordsService(
      db as PrismaService,
      admin as unknown as ManagedEntitiesService,
      settings as unknown as AdminSettingsService,
      capabilityService as unknown as AdminSettingsBotCapabilityService,
      cache,
      config,
    );
  });

  afterEach(async () => {
    await cache.onModuleDestroy();
    // FLAG: Cleanup is exact-chat and disposable-store-only; no database or Redis-wide reset.
    await redis.del(
      ChatContextCacheService.cacheKey(chatId),
      ChatContextCacheService.legacyCacheKey(chatId),
      ChatContextCacheService.chatContextRevisionKey(chatId),
    );
    await db.chat.delete({ where: { id: chatId } });
  });
  afterAll(async () => {
    await redis?.quit();
    await db?.$disconnect();
  });

  function policy(value = 'casino', mediaBase64?: string): StopWordsPolicy {
    return stopWordsPolicySchema.parse({
      enabled: true,
      rules: [{ id: 'native-rule', kind: 'WORD', value }],
      domains: ['blocked.example'],
      sanctions: {
        botMessageText: 'Private native fixture explanation',
        media: mediaBase64
          ? {
              explanation: { base64: mediaBase64, mimeType: 'image/png', fileName: 'fixture.png' },
            }
          : {},
      },
    });
  }

  it('commits one of two concurrent different policies and rolls back the competing audit', async () => {
    let arrivals = 0;
    let release!: () => void;
    const bothReadOriginalRevision = new Promise<void>((resolve) => {
      release = resolve;
    });
    capabilities.mockImplementation(async () => {
      if (++arrivals === 2) release();
      await bothReadOriginalRevision;
    });
    const requests = [policy('casino'), policy('other')];
    const results = await Promise.allSettled(
      requests.map((requestedPolicy) =>
        service.update(chatId, user, { expectedRevision: 0, policy: requestedPolicy }),
      ),
    );
    const successful = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ status: 409 });
    const winner = successful[0]!.value;
    const stored = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
    expect(stored.stopWordsRevision).toBe(1);
    expect(winner.settingsRevision).toBe(stored.updatedAt.toISOString());
    expect(readStopWordsPolicy(stored)).toEqual(winner.policy);
    expect(stored.antiSpamEnabled).toBe(true);
    expect(await db.auditLog.count({ where: { chatId, action: 'UPDATE_STOP_WORDS' } })).toBe(1);
    expect(await redis.get(ChatContextCacheService.chatContextRevisionKey(chatId))).toBe('1');
    expect(access).toHaveBeenCalledTimes(2);
  });

  it('repairs an identical committed save after real Redis failure without another SQL write or audit', async () => {
    const original = policy('casino', Buffer.from('native original media').toString('base64'));
    const body = { expectedRevision: 0, policy: original };
    const revisionKey = ChatContextCacheService.chatContextRevisionKey(chatId);
    const currentKey = ChatContextCacheService.cacheKey(chatId);
    const legacyKey = ChatContextCacheService.legacyCacheKey(chatId);
    await redis.mset(
      revisionKey,
      'not-an-integer',
      currentKey,
      'stale-current',
      legacyKey,
      'stale-legacy',
    );
    await expect(service.update(chatId, user, body)).rejects.toThrow('integer');
    const committed = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
    expect(committed.stopWordsRevision).toBe(1);
    expect(readStopWordsPolicy(committed)).toEqual(original);
    expect(await db.auditLog.count({ where: { chatId, action: 'UPDATE_STOP_WORDS' } })).toBe(1);
    expect(await redis.get(currentKey)).toBe('stale-current');

    await redis.del(revisionKey);
    await expect(service.update(chatId, user, body)).resolves.toMatchObject({
      revision: 1,
      policy: original,
      storageStatus: 'valid',
      imageScanStatus: 'off',
      settingsRevision: committed.updatedAt.toISOString(),
    });
    expect(await db.chatSettings.findUniqueOrThrow({ where: { chatId } })).toEqual(committed);
    expect(await redis.mget(currentKey, legacyKey, revisionKey)).toEqual([null, null, '1']);
    const audits = await db.auditLog.findMany({ where: { chatId, action: 'UPDATE_STOP_WORDS' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toMatchObject({ revision: 1, ruleCount: 1, domainCount: 1 });
    expect(JSON.stringify(audits[0]!.payload)).not.toContain(original.sanctions.botMessageText);
    expect(JSON.stringify(audits[0]!.payload)).not.toContain(
      original.sanctions.media.explanation!.base64,
    );
    expect(capabilities).toHaveBeenCalledTimes(1);
    expect(access).toHaveBeenCalledTimes(2);
  });

  it('rejects a stale retry whose only difference is image bytes', async () => {
    const original = policy('casino', Buffer.from('original bytes').toString('base64'));
    await service.update(chatId, user, { expectedRevision: 0, policy: original });
    const altered = policy('casino', Buffer.from('different bytes').toString('base64'));
    await expect(
      service.update(chatId, user, { expectedRevision: 0, policy: altered }),
    ).rejects.toMatchObject({ status: 409 });
    const stored = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
    expect(readStopWordsPolicy(stored)).toEqual(original);
    expect(stored.stopWordsRevision).toBe(1);
    expect(await db.auditLog.count({ where: { chatId, action: 'UPDATE_STOP_WORDS' } })).toBe(1);
    expect(await redis.get(ChatContextCacheService.chatContextRevisionKey(chatId))).toBe('1');
  });
});
