import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomInt, randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient, type Prisma } from '../../prisma/prisma-client';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { MaxBotRegistryService } from '../../max/max-bot-registry.service';
import { MaxBotContextService } from '../../max/max-bot-context.service';
import { WebhookParser } from '../../webhook/webhook.parser';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { RedisCounterService } from '../redis-counter.service';
import { MessageDuplicateMediaService } from './message-duplicate-media.service';
import { MessageDuplicateEnforcementService } from './message-duplicate-enforcement.service';
import { MessageDuplicateDeleteGuardService } from './message-duplicate-delete-guard.service';
import {
  MessageDuplicateAuthorizationService,
  duplicateRevocationKey,
} from './message-duplicate-authorization.service';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import {
  MessageDuplicateOrderingStore,
  buildMessageDuplicateJobId,
  type MessageDuplicateJob,
} from './message-duplicate.queue';
import {
  MessageDuplicatePolicyService,
  MESSAGE_DUPLICATE_CONTROL_KEY,
} from './message-duplicate-policy.service';
import { exactImageSettingsDigest, parseMessageDuplicateBinding } from './message-duplicate-state';
import type { ExecuteDuplicateModerationAction } from '../duplicate-moderation.actions';
import type { LogicalPhotoAlbum } from '../photo-duplicate/photo-attachment-extractor';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
(databaseUrl && redisUrl ? describe : describe.skip)(
  'duplicate media execution owner through durable handoff',
  () => {
    let prisma: PrismaClient;
    let redis: RedisCounterService;
    let ordering: MessageDuplicateOrderingStore;
    let policy: MessageDuplicatePolicyService;
    let inspector: Redis;
    let previousControl: string | null = null;
    let previousControlExpiry = -1;
    const context = new MaxBotContextService();
    const chats: string[] = [];
    const receipts: string[] = [];
    const config = new ConfigService({ REDIS_URL: redisUrl, MESSAGE_DUPLICATE_ENABLED: true });

    beforeAll(async () => {
      const url = new URL(databaseUrl);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !url.pathname.includes('race_test') ||
        !/^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/u.test(redisUrl)
      )
        throw new Error('Execution-owner checks require disposable local PostgreSQL and Redis');
      prisma = createPrismaClient(databaseUrl, { max: 8 });
      await prisma.$connect();
      inspector = new Redis(redisUrl);
      previousControl = await inspector.get(MESSAGE_DUPLICATE_CONTROL_KEY);
      previousControlExpiry = await inspector.pexpiretime(MESSAGE_DUPLICATE_CONTROL_KEY);
      redis = new RedisCounterService(config);
      ordering = new MessageDuplicateOrderingStore(config);
      policy = new MessageDuplicatePolicyService(redis, config);
      await redis.setStringWithTtl(
        MESSAGE_DUPLICATE_CONTROL_KEY,
        JSON.stringify({
          version: 2,
          revision: 1,
          mode: 'full',
          scope: 'all_enabled_chats',
          chatIds: [],
          effectiveAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: null,
        }),
        600,
      );
    });

    afterAll(async () => {
      if (prisma) {
        await prisma.webhookEvent.deleteMany({ where: { id: { in: receipts } } });
        await prisma.chat.deleteMany({ where: { id: { in: chats } } });
        await prisma.$disconnect();
      }
      if (inspector) {
        if (
          previousControl === null ||
          (previousControlExpiry > 0 && previousControlExpiry <= Date.now())
        )
          await inspector.del(MESSAGE_DUPLICATE_CONTROL_KEY);
        else if (previousControlExpiry > 0)
          await inspector.set(
            MESSAGE_DUPLICATE_CONTROL_KEY,
            previousControl,
            'PXAT',
            previousControlExpiry,
          );
        else await inspector.set(MESSAGE_DUPLICATE_CONTROL_KEY, previousControl);
        await inspector.quit();
      }
      await ordering?.onModuleDestroy();
      await redis?.onModuleDestroy();
    });

    async function fixture(owner = 'executor-b') {
      const chatId = `-98${randomInt(10000000, 99999999)}`;
      chats.push(chatId);
      await prisma.chat.create({ data: { id: chatId, title: 'Isolated execution-owner fixture' } });
      const settings = await prisma.chatSettings.create({
        data: {
          chatId,
          antiDuplicateEnabled: true,
          duplicateDetectionPreset: 'STANDARD',
          duplicateWarnMaxCount: 1,
          duplicateCompareMode: 'MESSAGE',
          duplicatePhotoEnabled: true,
          duplicateBotMessageEnabled: false,
          duplicateWarnEnabled: false,
          duplicateMuteEnabled: false,
          duplicateBanEnabled: false,
        },
      });
      const authorization = new MessageDuplicateAuthorizationService(prisma as never, ordering);
      const history = new MessageDuplicateHistoryService(redis);
      const guardMetrics = { record: jest.fn(), recordGuardRejection: jest.fn() };
      const trace: string[] = [];
      const remote = new Map<string, unknown>();
      let denied = false;
      let revokeOnAccess = false;
      const forbidden = Object.assign(new Error('fixture MAX access denied'), {
        response: { status: 403 },
      });
      const max = {
        getExactMessageRow: jest.fn(
          async (_chatId: string, messageId: string, options: { botId: string }) => {
            trace.push(`read:${options.botId}:${messageId}`);
            if (options.botId === 'receiver-a') throw forbidden;
            return remote.get(messageId) ?? null;
          },
        ),
        getChatMemberAccess: jest.fn(
          async (_chatId: string, userId: string, options: { botId: string }) => {
            trace.push(`access:${options.botId}`);
            if (denied || options.botId === 'receiver-a') throw forbidden;
            if (revokeOnAccess) {
              revokeOnAccess = false;
              await authorization.revoke({
                chatId,
                messageId: repeated.messageId,
                senderId: userId,
                eventTimestampMs: repeated.eventTimestampMs,
              });
            }
            return { userId, isAdmin: false, isOwner: false };
          },
        ),
        deleteMessage: jest.fn(async () => {
          trace.push(`fake-delete:${context.getActiveBotId()}`);
        }),
      };
      const registry = new MaxBotRegistryService(
        new ConfigService({
          APP_ROLE: 'moderation',
          APP_BASE_URL: 'https://example.invalid',
          MAX_BOT_ID: 'receiver-a',
          MAX_BOT_TOKEN: 'fixture-no-network-token-a',
          MAX_WEBHOOK_SECRET_PATH: 'fixture-path-a',
          MAX_WEBHOOK_HEADER_SECRET: 'fixture-header-a',
          MAX_PUBLISHER_BOT_ID: 'publisher',
          MAX_BOTS_JSON: JSON.stringify(
            ['executor-b', 'executor-c'].map((id) => ({
              id,
              token: `fixture-no-network-token-${id}`,
              webhookSecretPath: `fixture-${id}`,
              webhookHeaderSecret: `fixture-header-${id}`,
              state: 'active',
            })),
          ),
        }),
      );
      const bots = Object.create(MaxBotLinkService.prototype) as MaxBotLinkService;
      Object.assign(bots, { botRegistry: registry, botContext: context });
      jest.spyOn(bots, 'getDefaultBotId');
      // FLAG: Only MAX, native decoding and queue notification are simulated. The
      // registry, qualification, SQL intent/claim writer and Redis history are real.
      const guard = new MessageDuplicateDeleteGuardService(
        prisma as never,
        max as never,
        bots as never,
        { consumeForMessage: async () => 'not_granted' } as never,
        policy,
        history,
        config,
        authorization,
        guardMetrics as never,
      );
      const queue = {
        add: jest.fn(async () => {
          trace.push('queue');
        }),
      };
      const intents = Object.create(
        ModerationDeleteIntentService.prototype,
      ) as ModerationDeleteIntentService;
      Object.assign(intents, {
        prisma,
        queue,
        configService: config,
        logger: { warn: jest.fn() },
        retryHorizonMs: 600_000,
        mode: 'on',
        canaryChatIds: new Set(['*']),
        crossBotCanaryChatIds: new Set<string>(),
      });
      const enforcement = new MessageDuplicateEnforcementService(intents, policy, guard);
      const photos = {
        fingerprintAlbum: jest.fn(async (album: LogicalPhotoAlbum) =>
          album.images.some((image) => !image.downloadUrl)
            ? { kind: 'incomplete', reason: 'missing_download_url' }
            : {
                kind: 'complete',
                fingerprint: {
                  images: album.images.map(() => ({ canonicalHash: 'a'.repeat(64) })),
                },
              },
        ),
      };
      const media = new MessageDuplicateMediaService(
        prisma as never,
        redis,
        photos as never,
        policy,
        history,
        enforcement,
        bots as never,
        { decide: async () => ({ action: 'allow' }) } as never,
        config,
        max as never,
        context,
      );
      const start = Date.now() - 10_000;
      async function job(messageId: string, timestamp: number, missingUrl: boolean) {
        const raw = {
          update_type: 'message_created',
          timestamp,
          message: {
            sender: { user_id: 123, name: 'Test' },
            recipient: { chat_id: chatId, chat_type: 'chat' },
            timestamp,
            body: {
              mid: messageId,
              text: '',
              attachments: [
                {
                  type: 'image',
                  payload: {
                    photo_id: messageId,
                    ...(missingUrl ? {} : { url: `https://i.oneme.ru/${messageId}` }),
                  },
                },
              ],
            },
          },
        };
        const update = new WebhookParser().parse(raw);
        const receiptId = randomUUID();
        receipts.push(receiptId);
        await prisma.webhookEvent.create({
          data: {
            id: receiptId,
            dedupKey: receiptId,
            botId: 'receiver-a',
            status: 'PROCESSED',
            rawPayload: raw as Prisma.InputJsonValue,
            normalizedPayload: update as unknown as Prisma.InputJsonValue,
            executionClaims: {
              create: {
                kind: 'EXECUTION',
                semanticKey: receiptId,
                executionBotId: owner,
                status: 'COMPLETED',
              },
            },
          },
        });
        remote.set(messageId, {
          ...raw.message,
          body: {
            ...raw.message.body,
            attachments: [
              {
                type: 'image',
                payload: { photo_id: messageId, url: `https://i.oneme.ru/${messageId}` },
              },
            ],
          },
        });
        const value: MessageDuplicateJob = {
          version: 2,
          comparison: 'IMAGE',
          webhookEventId: receiptId,
          chatId,
          messageId,
          eventTimestampMs: timestamp,
          sourceCreatedAt: new Date(timestamp).toISOString(),
          createdAt: new Date().toISOString(),
          controlRevision: 1,
          policyRevision: settings.duplicatePolicyRevision,
          deadlineAtMs: timestamp + 600_000,
          settingsDigest: exactImageSettingsDigest(settings),
          actionEligible: true,
          idempotencyKey: buildMessageDuplicateJobId(chatId, messageId, timestamp, 'IMAGE'),
        };
        await ordering.announce(
          {
            chatId,
            jobId: value.idempotencyKey,
            sourceCreatedAt: value.sourceCreatedAt,
            deadlineAtMs: value.deadlineAtMs,
          },
          true,
        );
        return value;
      }
      const first = await job('original', start, false);
      const repeated = await job('repeat', start + 1000, true);
      const lease = { assertOwned: jest.fn(), resolveActionEligibility: async () => true };
      await media.process(first, lease);
      const execute = jest.fn<
        ReturnType<ExecuteDuplicateModerationAction>,
        Parameters<ExecuteDuplicateModerationAction>
      >(async (request) => {
        trace.push(`execute:${context.getActiveBotId()}`);
        expect(await prisma.moderationDeleteIntent.count({ where: { chatId } })).toBe(1);
        if (await request.authorizeDelete?.()) await max.deleteMessage();
      });
      return {
        chatId,
        media,
        lease,
        repeated,
        execute,
        intents,
        max,
        trace,
        history,
        queue,
        bots,
        guardMetrics,
        authorization,
        deny: () => {
          denied = true;
        },
        revokeDuringAccess: () => {
          revokeOnAccess = true;
        },
        forbidden,
      };
    }

    it('uses executor B for source refresh, qualification and the durable intent when receiver A returns 403', async () => {
      const s = await fixture();
      await expect(
        s.max.getExactMessageRow(s.chatId, 'repeat', { botId: 'receiver-a' }),
      ).rejects.toBe(s.forbidden);
      s.max.getExactMessageRow.mockClear();
      s.trace.length = 0;
      await s.media.process(s.repeated, s.lease, s.execute);
      expect(s.execute).toHaveBeenCalledTimes(1);
      expect(s.max.deleteMessage).toHaveBeenCalledTimes(1);
      expect(
        s.max.getExactMessageRow.mock.calls.every(
          ([, , options]) => options.botId === 'executor-b',
        ),
      ).toBe(true);
      expect(
        s.max.getChatMemberAccess.mock.calls.every(
          ([, , options]) => options.botId === 'executor-b',
        ),
      ).toBe(true);
      const stored = await prisma.moderationDeleteIntent.findFirstOrThrow({
        where: { chatId: s.chatId },
        include: { reasons: true },
      });
      expect(stored.originBotId).toBe('executor-b');
      const binding = parseMessageDuplicateBinding(stored.reasons[0]!.metadata)!;
      expect(binding.authorization?.jobId).toBe(s.repeated.idempotencyKey);
      expect(await s.history.qualified(s.chatId, binding)).toBe(1);
      expect(
        await prisma.messageDuplicateClaimCleanup.count({ where: { claim: { chatId: s.chatId } } }),
      ).toBe(0);
      expect(s.trace.indexOf('queue')).toBeLessThan(s.trace.indexOf('execute:executor-b'));
      expect(context.getActiveBotId()).toBeNull();
    });

    it('keeps denied executor access retryable without falling back to the receiving token or creating an intent', async () => {
      const s = await fixture();
      s.deny();
      await expect(s.media.process(s.repeated, s.lease, s.execute)).rejects.toBe(s.forbidden);
      expect(await prisma.moderationDeleteIntent.count({ where: { chatId: s.chatId } })).toBe(0);
      expect(
        await prisma.messageDuplicateClaimCleanup.count({ where: { claim: { chatId: s.chatId } } }),
      ).toBe(1);
      expect(s.bots.getDefaultBotId).not.toHaveBeenCalled();
      expect(s.execute).not.toHaveBeenCalled();
      expect(s.max.deleteMessage).not.toHaveBeenCalled();
      expect(context.getActiveBotId()).toBeNull();
    });

    it('honors durable revocation during qualification before intent persistence or action', async () => {
      const s = await fixture();
      s.revokeDuringAccess();
      await s.media.process(s.repeated, s.lease, s.execute);
      expect(s.guardMetrics.recordGuardRejection).toHaveBeenCalledWith(
        'message_duplicate_action_revoked',
      );
      expect(
        await prisma.moderationViolationMessageClaim.findUnique({
          where: {
            dedupeKey: duplicateRevocationKey(s.chatId, 'repeat', s.repeated.eventTimestampMs),
          },
        }),
      ).not.toBeNull();
      expect(await prisma.moderationDeleteIntent.count({ where: { chatId: s.chatId } })).toBe(0);
      expect(
        await prisma.messageDuplicateClaimCleanup.count({ where: { claim: { chatId: s.chatId } } }),
      ).toBe(0);
      expect(s.execute).not.toHaveBeenCalled();
      expect(s.max.deleteMessage).not.toHaveBeenCalled();
      expect(context.getActiveBotId()).toBeNull();
    });

    it('rejects a persisted Publisher-only executor before MAX or durable moderation work', async () => {
      const s = await fixture('publisher');
      expect(await s.media.process(s.repeated, s.lease, s.execute)).toBe('SOURCE_UNAVAILABLE');
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
      expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
      expect(s.bots.getDefaultBotId).not.toHaveBeenCalled();
      expect(
        await prisma.moderationViolationMessageClaim.count({ where: { chatId: s.chatId } }),
      ).toBe(0);
      expect(await prisma.moderationDeleteIntent.count({ where: { chatId: s.chatId } })).toBe(0);
      expect(s.execute).not.toHaveBeenCalled();
    });

    it('isolates concurrent executor contexts and restores the caller after an action error', async () => {
      const [b, c] = await Promise.all([fixture('executor-b'), fixture('executor-c')]);
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const continued = new Promise<void>((resolve) => {
        release = resolve;
      });
      const actionError = new Error('fixture action failure');
      b.execute.mockImplementation(async () => {
        expect(context.getActiveBotId()).toBe('executor-b');
        entered();
        await continued;
        expect(context.getActiveBotId()).toBe('executor-b');
        throw actionError;
      });
      const pending = context.runWithBot('caller', async () => {
        try {
          return await b.media.process(b.repeated, b.lease, b.execute);
        } finally {
          expect(context.getActiveBotId()).toBe('caller');
        }
      });
      const observed = Promise.resolve(pending).then(
        () => null,
        (error: unknown) => error,
      );
      await Promise.race([
        reached,
        observed.then((error) => {
          throw error ?? new Error('Action callback was not reached');
        }),
      ]);
      try {
        await context.runWithBot('other-caller', async () => {
          await c.media.process(c.repeated, c.lease, c.execute);
          expect(context.getActiveBotId()).toBe('other-caller');
        });
        expect(c.trace).toContain('execute:executor-c');
        expect(c.trace).toContain('fake-delete:executor-c');
        expect(context.getActiveBotId()).toBeNull();
      } finally {
        release();
      }
      expect(await observed).toBe(actionError);
      expect(context.getActiveBotId()).toBeNull();
    });
  },
);
