import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { MaxActionDispatchService } from '../max/max-action-dispatch.service';
import { MaxActionProcessor } from '../max/max-action.processor';
import type { MaxActionJob } from '../max/max-client.service';
import type { MaxActionDispatchOptions, MaxSendMessageOptions } from '../max/max-client.service';
import {
  buildMessageDuplicateNoticeContext,
  messageDuplicateNoticeSettingsDigest,
  readMessageDuplicateNoticeProof,
} from '../moderation/message-duplicate/message-duplicate-notice-proof';
import { extractDuplicateMessageContent } from '../moderation/message-duplicate/message-duplicate-content';
import { MESSAGE_DUPLICATE_CONTROL_KEY } from '../moderation/message-duplicate/message-duplicate-policy.service';
import { bindMessageLimitEvidence } from '../moderation/message-limits-delete-guard.service';
import type { EnsureModerationDeleteIntentInput } from '../moderation/moderation-delete-intent.types';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeStores(
  'native mirrored duplicate DELETE → durable Bull notice → actual final authority',
  () => {
    let h: MultibotHarness | undefined;
    let queue: Queue | undefined;
    let events: QueueEvents | undefined;
    let worker: Worker | undefined;
    let connection: Redis | undefined;
    let previousRole: string | undefined;
    beforeEach(() => {
      previousRole = process.env.APP_ROLE;
    });
    afterEach(async () => {
      await worker?.close();
      await events?.close();
      await queue?.obliterate({ force: true });
      await queue?.close();
      await connection?.quit();
      await h?.dispose();
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
      h = undefined;
      queue = undefined;
      events = undefined;
      worker = undefined;
      connection = undefined;
      previousRole = undefined;
    });

    async function harness(
      bots = 9,
      settings: Parameters<MultibotHarness['seedCatalog']>[1] = {},
      beforeImmediateSend?: () => Promise<void>,
    ) {
      h = await createMultibotHarness({ databaseUrl, redisUrl, bots, mode: 'on' });
      const s = h;
      await s.redis.set(
        MESSAGE_DUPLICATE_CONTROL_KEY,
        JSON.stringify({
          version: 2,
          revision: 1,
          mode: 'full',
          scope: 'all_enabled_chats',
          chatIds: [],
          effectiveAt: new Date(Date.now() - 1_000).toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      );
      const [chatId] = await s.seedCatalog(1, {
        maxMessageLengthEnabled: false,
        antiDuplicateEnabled: true,
        duplicateCompareMode: 'TEXT',
        duplicateBotMessageEnabled: true,
        duplicateWarnEnabled: false,
        duplicateMuteEnabled: false,
        duplicateBanEnabled: false,
        duplicateWarnMaxCount: 2,
        ...settings,
      });
      if (!chatId) throw new Error('Expected native chat fixture');
      connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
      const queueName = `duplicate-notice-native-${randomUUID()}`;
      queue = new Queue(queueName, { connection: connection as unknown as ConnectionOptions });
      events = new QueueEvents(queueName, {
        connection: connection as unknown as ConnectionOptions,
      });
      await events.waitUntilReady();
      const currentQueue = queue;
      const jobs: MaxActionJob[] = [];
      const immediateSends: {
        chat: string;
        text: string;
        options?: MaxSendMessageOptions;
        dispatch?: MaxActionDispatchOptions;
      }[] = [];
      const originalSend = s.max.sendMessage.bind(s.max);
      jest.spyOn(s.max, 'sendMessage').mockImplementation(async (chat, text, options, dispatch) => {
        if (dispatch?.immediate === true) {
          immediateSends.push({ chat, text, options, dispatch });
          await beforeImmediateSend?.();
          return originalSend(chat, text, options, dispatch);
        }
        const action: MaxActionJob = {
          actionType: 'SEND_MESSAGE',
          chatId: chat,
          botId: s.bots.at(-1)!.id,
          text,
          options,
          ledgerContext: dispatch?.ledgerContext,
          sourceTag: dispatch?.sourceTag,
          trafficClass: dispatch?.trafficClass,
          actionHealthLane: dispatch?.actionHealthLane,
          idempotencyKey: dispatch?.idempotencyKey ?? 'missing-notice-identity',
          createdAt: new Date().toISOString(),
          attempt: 1,
        };
        if (!readMessageDuplicateNoticeProof(action.ledgerContext?.duplicateNotice))
          throw new Error('Expected production duplicate producer original v3 proof');
        jobs.push(action);
        await s.ledger.recordEnqueuedIfAbsent(action);
        await currentQueue.add('guarded-notice', action, { jobId: randomUUID(), attempts: 1 });
      });
      const startWorker = () => {
        process.env.APP_ROLE = 'action';
        const dispatch = new MaxActionDispatchService(
          s.max,
          undefined,
          s.ledger,
          s.links,
          s.config,
        );
        const processor = new MaxActionProcessor(dispatch);
        worker = new Worker<MaxActionJob>(
          queueName,
          async (queuedJob) => processor.process(queuedJob),
          { connection: connection as unknown as ConnectionOptions, concurrency: 1 },
        );
        worker.on('error', () => undefined);
      };
      const deliver = async (jobIndex = 0) => {
        const queued = await currentQueue.getWaiting();
        const job = queued[jobIndex];
        if (!job) throw new Error('Expected durable Bull notice job');
        startWorker();
        return job.waitUntilFinished(events!, 20_000);
      };
      return { s, chatId, jobs, deliver, currentQueue, startWorker, immediateSends, originalSend };
    }

    async function realDuplicate(bots = 9) {
      const f = await harness(bots);
      const originalId = `original-${randomUUID()}`;
      const duplicateId = `duplicate-${randomUUID()}`;
      const text = 'One repeated participant message for native queued notice authority';
      for (const messageId of [originalId, duplicateId]) {
        const at = Date.now();
        await Promise.all(
          f.s.bots.map((bot) =>
            f.s.ingest({
              chatId: f.chatId,
              messageId,
              text,
              at,
              botId: bot.id,
            }),
          ),
        );
        await f.s.drain();
      }
      expect(f.jobs).toHaveLength(1);
      const proof = readMessageDuplicateNoticeProof(f.jobs[0]!.ledgerContext?.duplicateNotice)!;
      const intent = await f.s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: proof.intentId },
        include: { reasons: true },
      });
      expect(intent.status).toBe('SUCCEEDED');
      expect(intent.reasons[0]!.metadata).toMatchObject({ moderationDeleteVerified: true });
      expect(f.s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
      expect(f.s.effects.filter((effect) => effect.method === 'post')).toHaveLength(0);
      return { ...f, originalId, duplicateId, proof, intent };
    }

    it.each([1, 4, 9])(
      'publishes one explanation through the selected surviving peer with %i mirrored bots',
      async (bots) => {
        const f = await realDuplicate(bots);
        const selectedBot = f.s.bots.at(-1)!.id;
        if (bots > 1) await f.s.demote(f.chatId, f.s.bots[0]!.id);
        await expect(f.deliver()).resolves.toBeNull();
        const notices = f.s.effects.filter((effect) => effect.method === 'post');
        expect(notices).toHaveLength(1);
        expect(notices[0]!.botId).toBe(selectedBot);
        const authorReads = f.s.requests.filter(
          (request) => request.method === 'get' && request.path.endsWith('/members'),
        );
        expect(authorReads.some((request) => request.botId === selectedBot)).toBe(true);
        expect(
          await f.s.prisma.maxActionLedgerEntry.count({
            where: {
              chatId: f.chatId,
              actionType: 'SEND_MESSAGE',
              status: 'SUCCEEDED',
            },
          }),
        ).toBe(1);
        expect(f.s.failures).toEqual([]);
      },
    );

    it.each(['disabled', 'history-reset', 'original-edit'])(
      'rejects a queued explanation after %s without another HTTP SEND',
      async (change) => {
        const f = await realDuplicate();
        if (change === 'disabled')
          await f.s.prisma.chatSettings.update({
            where: { chatId: f.chatId },
            data: { duplicateBotMessageEnabled: false },
          });
        if (change === 'history-reset') {
          await f.s.prisma.chatSettings.update({
            where: { chatId: f.chatId },
            data: { antiDuplicateEnabled: false },
          });
          await f.s.prisma.chatSettings.update({
            where: { chatId: f.chatId },
            data: { antiDuplicateEnabled: true },
          });
        }
        if (change === 'original-edit') {
          const original = f.s.messages.get(f.originalId)!;
          original.body = {
            ...(original.body as Record<string, unknown>),
            text: 'A changed original',
          };
        }
        await expect(f.deliver()).rejects.toThrow('message_duplicate_notice_no_longer_authorized');
        expect(f.s.effects.filter((effect) => effect.method === 'post')).toEqual([]);
      },
    );

    it('keeps an unknown SEND durable across retry and peer replacement without sending again', async () => {
      const f = await realDuplicate();
      f.s.ambiguousNextSend();
      await expect(f.deliver()).rejects.toThrow();
      expect(f.s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
      const row = await f.s.prisma.maxActionLedgerEntry.findFirstOrThrow({
        where: { chatId: f.chatId, actionType: 'SEND_MESSAGE' },
      });
      expect(row.status).toBe('AMBIGUOUS');
      await worker!.close();
      worker = undefined;
      await f.s.demote(f.chatId, f.s.bots.at(-1)!.id);
      const retry = {
        ...f.jobs[0]!,
        botId: f.s.bots[0]!.id,
        idempotencyKey: row.jobId,
        attempt: 2,
      };
      const job = await f.currentQueue.add('guarded-notice-retry', retry, {
        jobId: randomUUID(),
        attempts: 1,
      });
      f.startWorker();
      await expect(job.waitUntilFinished(events!, 20_000)).rejects.toThrow(
        /ambiguous|no longer executable/iu,
      );
      expect(f.s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
      expect(
        await f.s.prisma.maxActionLedgerEntry.findUnique({ where: { id: row.id } }),
      ).toMatchObject({
        status: 'AMBIGUOUS',
        ambiguous: true,
        attemptCount: 1,
      });
    });

    it('expires the original notice deadline after the real final Redis permit without SEND', async () => {
      const f = await realDuplicate();
      const actualAuthorization = f.s.authorization.isAllowed.bind(f.s.authorization);
      let authorityReads = 0;
      let deadlineClock: jest.SpyInstance | undefined;
      const permit = jest
        .spyOn(f.s.authorization, 'isAllowed')
        .mockImplementation(async (...args) => {
          const allowed = await actualAuthorization(...args);
          authorityReads += 1;
          if (authorityReads === 2) {
            expect(allowed).toBe(true);
            // FLAG: Preserve the genuine SQL/Redis grant, then expire only the synchronous
            // transport boundary. No authority, qualification or receipt is fabricated.
            deadlineClock = jest.spyOn(Date, 'now').mockReturnValueOnce(f.proof.deadlineAtMs);
          }
          return allowed;
        });
      try {
        await expect(f.deliver()).rejects.toThrow('message_duplicate_notice_no_longer_authorized');
        expect(authorityReads).toBe(2);
        expect(f.s.effects.filter((effect) => effect.method === 'post')).toEqual([]);
      } finally {
        deadlineClock?.mockRestore();
        permit.mockRestore();
      }
    });

    it('does not borrow a length DELETE receipt for a revoked duplicate reason on the same absent source', async () => {
      const f = await harness();
      const settings = await f.s.prisma.chatSettings.findUniqueOrThrow({
        where: { chatId: f.chatId },
      });
      const at = Date.now();
      const text = 'Native mixed-rule original and copy long enough for length deletion';
      const originalId = `mixed-original-${randomUUID()}`;
      const duplicateId = `mixed-copy-${randomUUID()}`;
      const source = (messageId: string, timestamp: number) => ({
        sender: { user_id: 'fixture-user', is_bot: false },
        recipient: { chat_id: f.chatId, chat_type: 'chat' },
        timestamp,
        body: { mid: messageId, text },
      });
      const original = source(originalId, at - 1);
      const current = source(duplicateId, at);
      f.s.messages.set(originalId, original);
      f.s.messages.set(duplicateId, current);
      await f.s.history.observe({
        chatId: f.chatId,
        userId: 'fixture-user',
        messageId: originalId,
        content: extractDuplicateMessageContent(original, false),
        eventTimestampMs: at - 1,
        publishedAtMs: at - 1,
        controlRevision: 1,
        settings,
      });
      const matched = await f.s.history.observe({
        chatId: f.chatId,
        userId: 'fixture-user',
        messageId: duplicateId,
        content: extractDuplicateMessageContent(current, false),
        eventTimestampMs: at,
        publishedAtMs: at,
        controlRevision: 1,
        settings,
      });
      if (!matched) throw new Error('Expected real native Redis duplicate history match');
      const binding = {
        ...matched.binding,
        enforcementScope: 'full' as const,
        authorization: { eventTimestampMs: at, deadlineAtMs: at + 600_000 },
      };
      const count = await f.s.history.qualify(f.chatId, binding);
      expect(count).toBe(1);
      const input: EnsureModerationDeleteIntentInput = {
        chatId: f.chatId,
        messageId: duplicateId,
        subjectUserId: 'fixture-user',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        sourceMessageAt: new Date(at),
        originBotId: f.s.bots[0]!.id,
        ruleCode: 'DUPLICATE_DELETE',
        reasonKey: `MESSAGE_DUPLICATE:v1:${at}`,
        retryUntilAt: new Date(at + 600_000),
        executeAt: new Date(at + 60_000),
        event: {
          userId: 'fixture-user',
          metadata: {
            duplicateSource: 'message_v1',
            messageDuplicate: binding,
            count,
            enforcementScope: 'full',
          },
        },
      };
      const owned = await f.s.intents.ensureIntent(input, { enqueue: false });
      if (!owned.intentId) throw new Error('Expected durable original duplicate reason');
      expect(f.s.effects).toEqual([]);
      const ledgerContext = await buildMessageDuplicateNoticeContext(
        f.s.prisma as never,
        input,
        messageDuplicateNoticeSettingsDigest(settings),
        { count: 1 },
      );
      const changed = await f.s.prisma.chatSettings.update({
        where: { chatId: f.chatId },
        data: {
          maxMessageLengthEnabled: true,
          maxMessageLength: 20,
          duplicateWarnMaxCount: 3,
        },
      });
      expect(changed.duplicatePolicyRevision).not.toBe(binding.policyRevision);
      await expect(
        f.s.duplicateGuard.assertIntentStillActionable({
          intentId: owned.intentId,
          chatId: f.chatId,
          messageId: duplicateId,
          subjectUserId: 'fixture-user',
          botId: f.s.bots[0]!.id,
        }),
      ).rejects.toThrow('message_duplicate_settings_changed');
      await f.s.intents.ensureIntent(
        {
          ...input,
          executeAt: new Date(at),
          ruleCode: 'MESSAGE_TOO_LONG_DELETE',
          reasonKey: 'MESSAGE_TOO_LONG:violation-delete',
          retryUntilAt: new Date(at + 300_000),
          event: {
            userId: 'fixture-user',
            metadata: bindMessageLimitEvidence(changed, at, 'MESSAGE_TOO_LONG'),
          },
        },
        { enqueue: false },
      );
      await f.s.prisma.moderationDeleteIntent.update({
        where: { id: owned.intentId },
        data: {
          executeAt: new Date(at),
          nextAttemptAt: new Date(at),
        },
      });
      await expect(f.s.intents.attemptIntent(owned.intentId)).resolves.toMatchObject({
        kind: 'confirmed',
      });
      const reason = await f.s.prisma.moderationDeleteIntentReason.findUniqueOrThrow({
        where: {
          intentId_reasonKey: { intentId: owned.intentId, reasonKey: input.reasonKey },
        },
      });
      expect((reason.metadata as Record<string, unknown>).moderationDeleteVerified).not.toBe(true);
      expect(f.s.messages.has(duplicateId)).toBe(false);
      const action: MaxActionJob = {
        actionType: 'SEND_MESSAGE',
        chatId: f.chatId,
        botId: f.s.bots.at(-1)!.id,
        text: 'Queued duplicate explanation',
        ledgerContext,
        idempotencyKey: `message_v1-duplicate:${f.chatId}:${duplicateId}:explanation`,
        createdAt: new Date().toISOString(),
        attempt: 1,
      };
      await f.s.ledger.recordEnqueuedIfAbsent(action);
      await f.currentQueue.add('mixed-notice', action, { jobId: randomUUID(), attempts: 1 });
      await expect(f.deliver()).rejects.toThrow('message_duplicate_notice_no_longer_authorized');
      expect(f.s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
      expect(f.s.effects.filter((effect) => effect.method === 'post')).toEqual([]);
    });

    it.each(['peer-demoted', 'policy-revoked', 'unknown-send'])(
      'guards the actual immediate MUTE notice with original authority after %s across nine mirrors',
      async (change) => {
        const f: Awaited<ReturnType<typeof harness>> = await harness(
          9,
          { duplicateMuteEnabled: true, duplicateMuteMaxCount: 2 },
          async () => {
            if (change === 'peer-demoted')
              for (const bot of f.s.bots.slice(0, -1)) await f.s.demote(f.chatId, bot.id);
            if (change === 'policy-revoked')
              await f.s.prisma.chatSettings.update({
                where: { chatId: f.chatId },
                data: { duplicateMuteEnabled: false },
              });
            if (change === 'unknown-send') f.s.ambiguousNextSend();
          },
        );
        const text = 'Native duplicate mute and guarded successful sanction notification';
        for (let index = 0; index < 3; index += 1) {
          const messageId = `duplicate-mute-${index}-${randomUUID()}`;
          const at = Date.now();
          await Promise.all(
            f.s.bots.map((bot) =>
              f.s.ingest({
                chatId: f.chatId,
                messageId,
                text,
                at,
                botId: bot.id,
              }),
            ),
          );
          await f.s.drain();
        }
        expect(f.immediateSends).toHaveLength(1);
        const send = f.immediateSends[0]!;
        expect(send.dispatch!.idempotencyKey).toMatch(/message_v1-duplicate:.*:sanction:mute$/u);
        expect(send.dispatch!.beforeImmediateSendMutation).toEqual(expect.any(Function));
        const posts = f.s.effects.filter((effect) => effect.method === 'post');
        expect(posts).toHaveLength(change === 'policy-revoked' ? 0 : 1);
        if (change === 'peer-demoted') expect(posts[0]!.botId).toBe(f.s.bots.at(-1)!.id);
        if (change === 'unknown-send') {
          await expect(
            f.originalSend(send.chat, send.text, send.options, send.dispatch),
          ).rejects.toThrow(/ambiguous|unresolved/iu);
          expect(f.s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
          expect(
            await f.s.prisma.maxActionLedgerEntry.count({
              where: { chatId: f.chatId, actionType: 'SEND_MESSAGE', status: 'AMBIGUOUS' },
            }),
          ).toBe(1);
        }
      },
    );
  },
);
