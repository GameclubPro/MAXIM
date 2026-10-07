import { randomUUID } from 'node:crypto';
import type {
  ModerationDeleteIntent,
  ModerationViolationMessageClaim,
} from '../../prisma/prisma-client';
import {
  createMultibotHarness,
  type MultibotHarness,
} from '../../webhook/webhook-multibot-fullpath.spec-support';
import { MESSAGE_DUPLICATE_CONTROL_KEY } from './message-duplicate-policy.service';
import type { ModerationDeletePreDispatchPhase } from '../moderation-delete-intent.types';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeStores('native duplicate source unavailability at the exact dispatch boundary', () => {
  let h: MultibotHarness | undefined;

  afterEach(async () => {
    jest.restoreAllMocks();
    await h?.dispose();
    h = undefined;
  });

  async function fixture(bots: number) {
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
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
      duplicateWarnMaxCount: 1,
    });
    if (!chatId) throw new Error('Expected native duplicate chat');
    const originalId = `original-${randomUUID()}`;
    const duplicateId = `duplicate-${randomUUID()}`;
    const text = 'Repeated native participant source keeps its durable deletion authority';
    const originalAt = Date.now();
    await Promise.all(
      s.bots.map((bot) =>
        s.ingest({ chatId, messageId: originalId, text, at: originalAt, botId: bot.id }),
      ),
    );
    await s.drain();
    // FLAG: Keep the real Bull job and SQL retry intact while the inline attempt wins.
    // The test observes webhook completion separately from this intentionally pending work.
    await s.deleteQueue.pause();
    return { s, chatId, originalId, duplicateId, text };
  }

  async function waitForReceipts(s: MultibotHarness, ids: string[]) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await s.pumpOnce();
      const receipts = await s.prisma.webhookEvent.findMany({ where: { id: { in: ids } } });
      if (
        receipts.length === ids.length &&
        receipts.every((row) => row.status === 'PROCESSED' || row.status === 'DUPLICATE')
      )
        return receipts;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Native webhook receipts did not settle');
  }

  async function waitForFailedReceipt(s: MultibotHarness, id: string, error: string) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await s.pumpOnce();
      } catch (cause) {
        expect(cause).toEqual(expect.objectContaining({ message: expect.stringContaining(error) }));
      }
      const receipt = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
      if (receipt.status === 'FAILED') return receipt;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const receipt = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    throw new Error(`Native failure did not persist: ${receipt.status}; ${receipt.errorMessage}`);
  }

  function injectSourceFailure(
    f: Awaited<ReturnType<typeof fixture>>,
    source: 'current' | 'original',
    boundary: 'initial' | 'after-dispatch-marker',
    beforeUnavailable?: (intent: ModerationDeleteIntent) => Promise<void>,
  ) {
    const { s, chatId, duplicateId, originalId } = f;
    let accepted:
      | { intent: ModerationDeleteIntent; claims: ModerationViolationMessageClaim[] }
      | undefined;
    const observedMarkers: boolean[] = [];
    const ensure = s.intents.ensureIntentWithMessageActionClaim.bind(s.intents);
    jest
      .spyOn(s.intents, 'ensureIntentWithMessageActionClaim')
      .mockImplementation(async (input) => {
        const result = await ensure(input);
        if (input.intent.messageId === duplicateId && result.intent?.intentId) {
          accepted = {
            intent: await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
              where: { id: result.intent.intentId },
            }),
            claims: await s.prisma.moderationViolationMessageClaim.findMany({
              where: { chatId, messageId: duplicateId },
              orderBy: { id: 'asc' },
            }),
          };
          expect(accepted.intent.attemptCount).toBe(0);
          expect(accepted.intent.deleteDispatchStartedAt).toBeNull();
          expect(accepted.claims).toHaveLength(1);
        }
        return result;
      });
    const read = s.max.getExactMessageRow.bind(s.max);
    const missingId = source === 'current' ? duplicateId : originalId;
    jest.spyOn(s.max, 'getExactMessageRow').mockImplementation(async (...args) => {
      if (accepted && args[1] === missingId) {
        const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
          where: { id: accepted.intent.id },
        });
        const started = intent.deleteDispatchStartedAt !== null;
        if (boundary === 'initial' || started) {
          observedMarkers.push(started);
          await beforeUnavailable?.(intent);
          throw Object.assign(new Error('Native duplicate source unavailable'), {
            response: { status: 404, data: {} },
          });
        }
      }
      return read(...args);
    });
    return {
      observedMarkers,
      accepted: () => {
        if (!accepted) throw new Error('Expected a real accepted duplicate intent and claim');
        return accepted;
      },
    };
  }

  async function assertRetainedWork(
    f: Awaited<ReturnType<typeof fixture>>,
    before: ReturnType<ReturnType<typeof injectSourceFailure>['accepted']>,
  ) {
    const { s, chatId, duplicateId } = f;
    const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { id: before.intent.id },
      include: { reasons: true },
    });
    expect(['WAITING_CAPABILITY', 'RETRYABLE', 'AMBIGUOUS']).toContain(intent.status);
    expect(intent.attemptCount).toBe(1);
    expect(intent.nextAttemptAt.getTime()).toBeGreaterThan(before.intent.nextAttemptAt.getTime());
    expect(intent.retryUntilAt).toEqual(before.intent.retryUntilAt);
    expect(intent.sourceMessageAt).toEqual(before.intent.sourceMessageAt);
    expect(intent.completedAt).toBeNull();
    expect(intent.remoteDeleteSucceededAt).toBeNull();
    expect(intent.absenceVerifiedAt).toBeNull();
    expect(intent.leaseToken).toBeNull();
    expect(intent.leaseExpiresAt).toBeNull();
    expect(intent.reasons).toHaveLength(1);
    expect(intent.reasons[0]!.ruleCode).toBe('DUPLICATE_DELETE');
    expect(intent.reasons[0]!.metadata).not.toMatchObject({ moderationDeleteVerified: true });
    expect(
      await s.prisma.moderationViolationMessageClaim.findMany({
        where: { chatId, messageId: duplicateId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before.claims);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
    expect(await s.prisma.moderationEvent.count({ where: { chatId } })).toBe(0);
    expect(await s.prisma.maxActionLedgerEntry.count({ where: { chatId } })).toBe(0);
    expect(s.effects).toEqual([]);
    return intent;
  }

  it.each(['current', 'original'] as const)(
    'completes the canonical handler after initial %s GET 404 and preserves durable retry',
    async (source) => {
      const f = await fixture(4);
      const { s, chatId, duplicateId, text } = f;
      const failure = injectSourceFailure(f, source, 'initial');
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const send = jest.spyOn(s.max, 'sendMessage');
      const at = Date.now();
      const ids = await Promise.all(
        s.bots.map((bot) => s.ingest({ chatId, messageId: duplicateId, text, at, botId: bot.id })),
      );
      const receipts = await waitForReceipts(s, ids);
      expect(receipts.map((row) => row.status).sort()).toEqual([
        'DUPLICATE',
        'DUPLICATE',
        'DUPLICATE',
        'PROCESSED',
      ]);
      expect(failure.observedMarkers).toEqual([false]);
      const intent = await assertRetainedWork(f, failure.accepted());
      expect(intent.deleteDispatchStartedAt).toBeNull();
      expect(intent.deleteDispatchStartedBotId).toBeNull();
      const execution = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: { in: ids } },
      });
      expect(execution).toMatchObject({
        status: 'COMPLETED',
        enforced: true,
        businessStartedAt: expect.any(Date),
        completedAt: expect.any(Date),
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
        leaseToken: null,
        leaseExpiresAt: null,
      });
      for (const id of ids) await s.moderation.processWebhookEvent(id);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      expect(s.failures).toEqual([]);
      const nextId = await s.ingest({
        chatId,
        messageId: `independent-${randomUUID()}`,
        text: 'Unrelated new content continues through the same chat',
        at: Date.now(),
      });
      expect((await waitForReceipts(s, [nextId]))[0]!.status).toBe('PROCESSED');
      expect(s.effects).toEqual([]);
      expect(send).not.toHaveBeenCalled();
      if (source === 'current') {
        const delay = Math.max(1, intent.nextAttemptAt.getTime() - Date.now() + 10);
        expect(delay).toBeLessThan(10_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        const phases: Array<ModerationDeletePreDispatchPhase | undefined> = [];
        await expect(
          s.intents.attemptIntent(intent.id, {
            beforeDeleteMutation: async (phase) => {
              phases.push(phase);
            },
          }),
        ).rejects.toThrow('Native duplicate source unavailable');
        expect(phases.length).toBeGreaterThan(0);
        expect(phases.every((phase) => phase === 'recheck')).toBe(true);
        const retried = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
          where: { id: intent.id },
        });
        expect(retried).toMatchObject({
          attemptCount: 2,
          status: 'RETRYABLE',
          retryUntilAt: intent.retryUntilAt,
          sourceMessageAt: intent.sourceMessageAt,
          completedAt: null,
          remoteDeleteSucceededAt: null,
          absenceVerifiedAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
        });
        expect(retried.nextAttemptAt.getTime()).toBeGreaterThan(intent.nextAttemptAt.getTime());
        expect(
          await s.prisma.moderationViolationMessageClaim.findMany({
            where: { chatId, messageId: duplicateId },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(failure.accepted().claims);
        expect(
          await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: execution.id } }),
        ).toEqual(execution);
        expect(s.effects).toEqual([]);
        expect(send).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['current', 'original'] as const)(
    'retains the canonical failure fence after %s GET 404 with a dispatch marker',
    async (source) => {
      const f = await fixture(1);
      const { s, chatId, duplicateId, text } = f;
      const failure = injectSourceFailure(f, source, 'after-dispatch-marker');
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const send = jest.spyOn(s.max, 'sendMessage');
      const id = await s.ingest({ chatId, messageId: duplicateId, text, at: Date.now() });
      await expect(waitForReceipts(s, [id])).rejects.toThrow('Native duplicate source unavailable');
      expect(failure.observedMarkers.length).toBeGreaterThan(0);
      expect(failure.observedMarkers.every(Boolean)).toBe(true);
      await assertRetainedWork(f, failure.accepted());
      const receipt = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
      expect(receipt.status).toBe('FAILED');
      const execution = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: id },
      });
      expect(execution.status).not.toBe('COMPLETED');
      expect(execution.businessStartedAt).not.toBeNull();
      expect(execution.completedAt).toBeNull();
      expect(execution.commandResult).not.toEqual(
        expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
      );
      await s.moderation.processWebhookEvent(id);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      expect(s.effects).toEqual([]);
    },
  );

  it.each(['lease-cas', 'storage-error'] as const)(
    'keeps the canonical owner fenced when initial retry persistence fails: %s',
    async (mode) => {
      const f = await fixture(1);
      const { s, chatId, duplicateId, text } = f;
      let racedMarker: Date | undefined;
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const send = jest.spyOn(s.max, 'sendMessage');
      const execute = s.prisma.$executeRaw.bind(s.prisma);
      let refusedTransitions = 0;
      let retryTransition: jest.SpyInstance | undefined;
      const failure = injectSourceFailure(f, 'current', 'initial', async (intent) => {
        // FLAG: Install the fault only after real preparation and intent acceptance;
        // Prisma transaction clients must retain their own raw-query binding.
        if (mode === 'storage-error')
          retryTransition = jest.spyOn(s.prisma, '$executeRaw').mockImplementation((...args) => {
            const query = args[0];
            if (
              'sql' in query &&
              query.sql.includes('UPDATE "moderation_delete_intents"') &&
              query.sql.includes('"last_error_code" =') &&
              query.sql.includes('"attempt_count" = 1') &&
              query.sql.includes('"delete_dispatch_started_at" IS NULL') &&
              query.values.includes('message_duplicate_initial_source_unavailable') &&
              query.values.includes(intent.id)
            ) {
              refusedTransitions += 1;
              retryTransition!.mockRestore();
              throw new Error('Native retry persistence unavailable');
            }
            return execute(...args);
          });
        if (mode === 'lease-cas') {
          // FLAG: Competing evidence appears after the guard read and before its retry CAS.
          // The production SQL must preserve this marker and refuse inline declination.
          racedMarker = new Date();
          await s.prisma.moderationDeleteIntent.update({
            where: { id: intent.id },
            data: {
              deleteDispatchStartedAt: racedMarker,
              deleteDispatchStartedBotId: s.bots[0]!.id,
            },
          });
        }
      });
      const id = await s.ingest({ chatId, messageId: duplicateId, text, at: Date.now() });
      const failedReceipt = await waitForFailedReceipt(
        s,
        id,
        mode === 'lease-cas'
          ? 'lost unattempted ownership'
          : 'Native retry persistence unavailable',
      );
      retryTransition?.mockRestore();
      expect(failedReceipt.errorMessage).toContain(
        mode === 'lease-cas'
          ? 'lost unattempted ownership'
          : 'Native retry persistence unavailable',
      );
      expect(refusedTransitions).toBe(mode === 'storage-error' ? 1 : 0);
      expect(failure.observedMarkers).toEqual([false]);
      const before = failure.accepted();
      const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: before.intent.id },
      });
      expect(intent).toMatchObject({
        status: 'IN_PROGRESS',
        attemptCount: 1,
        retryUntilAt: before.intent.retryUntilAt,
        sourceMessageAt: before.intent.sourceMessageAt,
        deleteDispatchStartedAt: racedMarker ?? null,
        deleteDispatchStartedBotId: racedMarker ? s.bots[0]!.id : null,
        remoteDeleteSucceededAt: null,
        absenceVerifiedAt: null,
        completedAt: null,
        leaseToken: expect.any(String),
        leaseExpiresAt: expect.any(Date),
      });
      expect(
        await s.prisma.moderationViolationMessageClaim.findMany({
          where: { chatId, messageId: duplicateId },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(before.claims);
      expect(failedReceipt).toMatchObject({
        status: 'FAILED',
        processedAt: null,
      });
      const execution = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: id },
      });
      expect(execution.status).not.toBe('COMPLETED');
      expect(execution.businessStartedAt).not.toBeNull();
      expect(execution.completedAt).toBeNull();
      expect(execution.commandResult).not.toEqual(
        expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
      );
      await s.moderation.processWebhookEvent(id);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
      expect(await s.prisma.moderationEvent.count({ where: { chatId } })).toBe(0);
      expect(await s.prisma.maxActionLedgerEntry.count({ where: { chatId } })).toBe(0);
      expect(s.effects).toEqual([]);
    },
  );
});
