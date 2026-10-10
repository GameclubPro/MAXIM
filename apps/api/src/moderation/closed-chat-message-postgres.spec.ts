import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import {
  ClosedChatMessageModerationService,
  type ClosedChatMessageDependencies,
} from './closed-chat-message-moderation.service';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import {
  MODERATION_DELETE_INTENT_QUEUE,
  type ModerationDeleteIntentJob,
} from './moderation-delete-intent.queue';
import {
  buildModerationMessageViolationProcessingClaimKey,
  claimPersistedModerationMessageViolation,
} from './moderation-message-action-claim';
const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim() || '';
(databaseUrl ? describe : describe.skip)(
  'closed-chat intent and claim recovery with PostgreSQL/Redis',
  () => {
    let prisma: PrismaClient;
    let queue: Queue<ModerationDeleteIntentJob>;
    let intents: ModerationDeleteIntentService;
    const chatId = `closed-chat-${randomUUID()}`;
    const maxClient = { deleteMessage: jest.fn() };
    function makeIntents(mode = 'on') {
      return new ModerationDeleteIntentService(
        prisma as never,
        maxClient as never,
        {} as never,
        queue,
        new ConfigService({ MODERATION_DELETE_INTENT_MODE: mode }),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
    }
    beforeAll(async () => {
      const pg = new URL(databaseUrl),
        redis = new URL(redisUrl);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(pg.hostname) ||
        !pg.pathname.includes('race_test') ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(redis.hostname) ||
        redis.protocol !== 'redis:' ||
        redis.search ||
        redis.hash
      )
        throw Error('Disposable local PostgreSQL race_test and Redis required');
      prisma = createPrismaClient(databaseUrl, { max: 8 });
      await prisma.$connect();
      await prisma.chat.create({ data: { id: chatId, title: 'Closed-chat refactor fixture' } });
      queue = new Queue(MODERATION_DELETE_INTENT_QUEUE, {
        prefix: `closed-chat-test-${randomUUID()}`,
        connection: {
          host: redis.hostname,
          port: Number(redis.port || 6379),
          db: Number(redis.pathname.slice(1) || 0),
          maxRetriesPerRequest: 1,
        },
      });
      await queue.waitUntilReady();
      intents = makeIntents();
    });
    afterAll(async () => {
      // FLAG: This queue has a random local test namespace and no workers or production jobs.
      if (queue) {
        await queue.obliterate();
        await queue.close();
      }
      if (prisma) {
        await prisma.chat.deleteMany({ where: { id: chatId } });
        await prisma.$disconnect();
      }
    });
    function harness(overrides: Partial<ClosedChatMessageDependencies> = {}) {
      const executeDelete = jest.fn(async () => ({
        accepted: true,
        gone: true,
        deleted: true,
        eventPersistedByIntent: false,
        botId: null,
      }));
      const dependencies: ClosedChatMessageDependencies = {
        ensureIntent: async (input) => {
          // FLAG: Production composition adds the active bot route before intent persistence.
          await intents.ensureIntent({
            ...input,
            originBotId: 'fixture-bot',
            routingPolicy: 'origin_only',
          });
        },
        claimAction: async (input) => {
          const persisted = await prisma.moderationDeleteIntent.findUnique({
            where: { chatId_messageId: { chatId: input.chatId, messageId: input.messageId } },
          });
          expect(persisted).not.toBeNull();
          const data = { ...input, updateType: 'message_action' };
          const key = buildModerationMessageViolationProcessingClaimKey(data);
          return (
            (await claimPersistedModerationMessageViolation({
              model: {
                createMany: (args) => prisma.moderationViolationMessageClaim.createMany(args),
              },
              data: { ...data, dedupeKey: key.dedupeKey },
            })) === 'claimed'
          );
        },
        executeDelete,
        createEvent: (input) => prisma.moderationEvent.create(input),
        warn: jest.fn(),
        ...overrides,
      };
      return { service: new ClosedChatMessageModerationService(dependencies), executeDelete };
    }
    const message = (messageId: string) => ({
      chatId,
      userId: 'fixture-user',
      messageId,
      text: 'fixture',
      createdAt: new Date().toISOString(),
      nightModeStartTimeMinutes: 1380,
      nightModeEndTimeMinutes: 480,
      nightModeTimezone: 'Europe/Moscow',
    });
    const row = (messageId: string) =>
      prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId, messageId } },
        include: { reasons: true },
      });
    it('gives concurrent night/manual handlers one action owner and one event', async () => {
      const a = harness(),
        b = harness(),
        input = message('race');
      await Promise.all([
        a.service.handleNightModeMessage(input),
        b.service.handleNightModeForceCloseMessage({
          ...input,
          nightModeForceCloseForever: true,
          nightModeForceCloseUntil: '',
        }),
      ]);
      expect(a.executeDelete.mock.calls.length + b.executeDelete.mock.calls.length).toBe(1);
      expect(await prisma.moderationEvent.count({ where: { chatId, messageId: 'race' } })).toBe(1);
      const intent = await row('race');
      expect(intent.reasons.map((x) => x.ruleCode).sort()).toEqual([
        'MANUAL_GROUP_CLOSE_DELETE',
        'NIGHT_MODE_DELETE',
      ]);
      expect(await queue.getJob(`mdi-${intent.id}`)).not.toBeNull();
      const restarted = harness();
      await restarted.service.handleNightModeMessage(input);
      expect(restarted.executeDelete).not.toHaveBeenCalled();
    });
    it('keeps a recoverable intent if execution stops before the claim', async () => {
      const input = message('before-claim');
      const stopped = harness({
        claimAction: async () => {
          throw Error('simulated stop');
        },
      });
      await expect(stopped.service.handleNightModeMessage(input)).rejects.toThrow('simulated stop');
      const persisted = await row('before-claim');
      expect(persisted.status).toBe('PENDING');
      expect(persisted.reasons).toHaveLength(1);
      expect(await queue.getJob(`mdi-${persisted.id}`)).not.toBeNull();
      const restarted = harness();
      await restarted.service.handleNightModeMessage(input);
      await restarted.service.handleNightModeMessage(input);
      expect(restarted.executeDelete).toHaveBeenCalledTimes(1);
      expect((await row('before-claim')).id).toBe(persisted.id);
    });
    it('leaves the durable wakeup after a claimed execution fails, without duplicate events', async () => {
      const input = message('after-claim');
      const stopped = harness({
        executeDelete: async () => {
          throw Error('simulated stop');
        },
      });
      await stopped.service.handleNightModeMessage(input);
      const persisted = await row('after-claim');
      expect(persisted.status).toBe('PENDING');
      expect(await queue.getJob(`mdi-${persisted.id}`)).not.toBeNull();
      const replay = harness();
      await replay.service.handleNightModeMessage(input);
      expect(replay.executeDelete).not.toHaveBeenCalled();
      expect(
        await prisma.moderationEvent.count({ where: { chatId, messageId: 'after-claim' } }),
      ).toBe(0);
      const outsideBaseRollout = makeIntents('off');
      const outcome = await outsideBaseRollout.attemptIntent(persisted.id);
      expect(outcome).toMatchObject({ kind: 'pending', status: 'RETRYABLE' });
      expect(outcome.confirmed).toBe(false);
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect((await row('after-claim')).attemptCount).toBe(1);
    });
  },
);
