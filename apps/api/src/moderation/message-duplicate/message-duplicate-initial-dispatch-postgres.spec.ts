import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';
import {
  MessageDuplicateEnqueueService,
  type MessageDuplicateJob,
} from './message-duplicate.queue';
import { MessageDuplicateAdmissionService } from './message-duplicate-admission.service';
import { MessageDuplicateEnforcementService } from './message-duplicate-enforcement.service';
import { MessageDuplicateMediaService } from './message-duplicate-media.service';
import { MessageDuplicateProcessor } from './message-duplicate.processor';
import type { ModerationExecutionService } from '../moderation-execution.service';
import { MaxApiInternalRateLimitError } from '../../max/max-client.service';
import type {
  ChatSettings,
  ModerationDeleteIntent,
  ModerationViolationMessageClaim,
} from '../../prisma/prisma-client';
import {
  createMultibotHarness,
  type MultibotHarness,
} from '../../webhook/webhook-multibot-fullpath.spec-support';
import { MESSAGE_DUPLICATE_CONTROL_KEY } from './message-duplicate-policy.service';
import type { ModerationDeletePreDispatchPhase } from '../moderation-delete-intent.types';
import {
  DEFAULT_WEBHOOK_USER_FACING_TIMEOUT_MS,
  type WebhookHotPathProfile,
} from '../moderation.service.support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeStores('native duplicate source unavailability at the exact dispatch boundary', () => {
  let h: MultibotHarness | undefined;
  let disposeRecovery: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await disposeRecovery?.();
    disposeRecovery = undefined;
    jest.restoreAllMocks();
    await h?.dispose();
    h = undefined;
  });

  async function fixture(
    bots: number,
    duplicateBotMessageEnabled = true,
    settingsOverrides: Partial<
      Pick<
        ChatSettings,
        | 'duplicateWarnEnabled'
        | 'duplicateMuteEnabled'
        | 'duplicateBanEnabled'
        | 'duplicateCompareMode'
      >
    > = {},
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
      duplicateBotMessageEnabled,
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
      duplicateWarnMaxCount: 1,
      ...settingsOverrides,
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

  async function qualificationRecovery(s: MultibotHarness) {
    const queue = new Queue<MessageDuplicateJob>(`qualification-${randomUUID()}`, {
      connection: { url: redisUrl },
    });
    const events = new QueueEvents(queue.name, { connection: { url: redisUrl } });
    await events.waitUntilReady();
    Object.assign(s.duplicateService, {
      queue: new MessageDuplicateEnqueueService(
        queue,
        s.duplicateOrdering,
        new MessageDuplicateAdmissionService(s.prisma as never),
      ),
    });
    const media = new MessageDuplicateMediaService(
      s.prisma as never,
      s.counters,
      {} as never,
      s.duplicatePolicy,
      s.history,
      new MessageDuplicateEnforcementService(s.intents, s.duplicatePolicy, s.duplicateGuard),
      s.links,
      {} as never,
      s.config,
      s.max,
      s.botContext,
      undefined,
      s.readiness,
      s.legacyHolds,
    );
    const execution = {
      processMessageDuplicateJob: (job, lease) =>
        media
          .process(job, lease, (request) => s.moderation.executeDuplicateAction(request))
          .then(() => undefined),
    } satisfies Pick<ModerationExecutionService, 'processMessageDuplicateJob'>;
    const processor = new MessageDuplicateProcessor(
      execution as never,
      s.duplicateOrdering,
      undefined,
      queue,
      s.intents,
    );
    const worker = new Worker<MessageDuplicateJob>(
      queue.name,
      (job, token) => processor.process(job, token),
      { connection: { url: redisUrl }, autorun: false },
    );
    disposeRecovery = async () => {
      await worker.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
    };
    return {
      queue,
      run: async () => {
        const jobs = await queue.getJobs(['delayed', 'waiting']);
        expect(jobs).toHaveLength(1);
        const job = jobs[0]!;
        const done = job.waitUntilFinished(events, 20_000);
        const running = worker.run();
        if ((await job.getState()) === 'delayed') await job.promote();
        try {
          await done;
        } finally {
          await worker.close();
          await running;
        }
      },
    };
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
    failureKind: 'http404' | 'local_limit' = 'http404',
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
          if (failureKind === 'local_limit')
            throw new MaxApiInternalRateLimitError('Native duplicate source unavailable', 7);
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

  it('completes mirrored duplicate receipts and following work while its optional explanation is pending after deletion', async () => {
    const { s, chatId, duplicateId, text } = await fixture(4, true, {
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
    });
    let profile: WebhookHotPathProfile | undefined;
    const handle = s.moderation.handleUpdate.bind(s.moderation);
    const handler = jest.spyOn(s.moderation, 'handleUpdate').mockImplementation((...args) => {
      if (args[0].message?.messageId === duplicateId) profile = args[1];
      return handle(...args);
    });
    const execute = s.moderation.executeDuplicateAction.bind(s.moderation);
    jest.spyOn(s.moderation, 'executeDuplicateAction').mockImplementation((...args) => {
      if (args[0].messageId === duplicateId && profile) {
        // FLAG: Model consumed handler time only; database/Redis clocks and immutable
        // source deadlines stay real, as do every qualification and dispatch guard.
        profile.startedAtMs = Date.now() - (DEFAULT_WEBHOOK_USER_FACING_TIMEOUT_MS - 500);
      }
      return execute(...args);
    });
    const scheduler = s.moderation as unknown as {
      scheduleDetachedWebhookFollowUp(params: { stage: string; task: () => Promise<void> }): void;
    };
    const scheduleFollowUp = scheduler.scheduleDetachedWebhookFollowUp.bind(scheduler);
    let finishFollowUp!: () => void;
    const followUpFinished = new Promise<void>((resolve) => {
      finishFollowUp = resolve;
    });
    const schedule = jest
      .spyOn(scheduler, 'scheduleDetachedWebhookFollowUp')
      .mockImplementation((params) =>
        scheduleFollowUp({
          ...params,
          task: async () => {
            try {
              await params.task();
            } finally {
              finishFollowUp();
            }
          },
        }),
      );
    let releaseExplanation!: () => void;
    const explanationGate = new Promise<void>((resolve) => {
      releaseExplanation = resolve;
    });
    let explanationTask: ReturnType<typeof s.max.sendMessage> | undefined;
    const send = s.max.sendMessage.bind(s.max);
    jest.spyOn(s.max, 'sendMessage').mockImplementation((...args) => {
      if (args[3]?.idempotencyKey === `message_v1-duplicate:${chatId}:${duplicateId}:explanation`) {
        explanationTask = (async () => {
          await explanationGate;
          return send(...args);
        })();
        return explanationTask;
      }
      return send(...args);
    });
    try {
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
      expect(profile).toMatchObject({
        successBoundaryReached: true,
        successBoundaryStage: 'duplicate-delete',
      });
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(schedule).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'duplicate-follow-up' }),
      );
      expect(explanationTask).toBeDefined();
      const intent = await s.prisma.moderationDeleteIntent.findFirstOrThrow({
        where: { chatId, messageId: duplicateId },
      });
      expect(intent).toMatchObject({
        status: 'SUCCEEDED',
        remoteDeleteSucceededAt: expect.any(Date),
        remoteDeleteSucceededBotId: expect.any(String),
      });
      const execution = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: { in: ids } },
      });
      expect(execution).toMatchObject({
        status: 'COMPLETED',
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
      });
      expect(
        s.effects.filter(
          (effect) => effect.method === 'delete' && effect.messageId === duplicateId,
        ),
      ).toHaveLength(1);
      expect(s.effects.filter((effect) => effect.method === 'post')).toHaveLength(0);
      const next = await s.ingest({
        chatId,
        messageId: `following-${randomUUID()}`,
        text: 'Independent new content progresses while an explanation is pending',
        at: Date.now(),
      });
      expect((await waitForReceipts(s, [next]))[0]!.status).toBe('PROCESSED');
      for (const id of ids) await s.moderation.processWebhookEvent(id);
      expect(
        handler.mock.calls.filter(([update]) => update.message?.messageId === duplicateId),
      ).toHaveLength(1);
      expect(s.failures).toEqual([]);
    } finally {
      releaseExplanation();
      // FLAG: Await the scheduled task even if an assertion failed before its
      // setImmediate reached the SEND spy; no late store access may outlive disposal.
      if (schedule.mock.calls.length) await followUpFinished;
    }
    expect(s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === duplicateId),
    ).toHaveLength(1);
  });

  it('declines sanction before state changes while a competing DELETE owner is unfinished and the source is still visible', async () => {
    const f = await fixture(4, false);
    const { s, chatId, duplicateId, text } = f;
    const token = randomUUID();
    let intentId = '';
    let deadline: Date | undefined;
    const ensure = s.intents.ensureIntentWithMessageActionClaim.bind(s.intents);
    jest
      .spyOn(s.intents, 'ensureIntentWithMessageActionClaim')
      .mockImplementation(async (input) => {
        const result = await ensure(input);
        if (input.intent.messageId === duplicateId && result.intent?.intentId) {
          intentId = result.intent.intentId;
          // FLAG: Model a different durable worker holding this exact row. The inline
          // caller must not invent its receipt or begin sanctions while it is unfinished.
          const owned = await s.prisma.moderationDeleteIntent.update({
            where: { id: intentId },
            data: {
              status: 'IN_PROGRESS',
              leaseToken: token,
              leaseExpiresAt: new Date(Date.now() + 30_000),
              leasedFromStatus: 'PENDING',
              attemptCount: 1,
            },
          });
          deadline = owned.retryUntilAt;
        }
        return result;
      });
    const guard = s.duplicateGuard.assertMessageStillActionable.bind(s.duplicateGuard);
    let initialRead = false;
    let finalRead = false;
    jest
      .spyOn(s.duplicateGuard, 'assertMessageStillActionable')
      .mockImplementation(async (input) => {
        if (input.sanctionIntentId) {
          if (input.sanctionPhase === 'initial_unattempted') {
            initialRead = true;
            expect(s.messages.has(duplicateId)).toBe(true);
          } else {
            finalRead = true;
            throw Object.assign(new Error('Source disappeared before final sanction'), {
              response: { status: 404, data: { code: 'not.found' } },
            });
          }
        }
        return guard(input);
      });
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    const at = Date.now();
    const ids = await Promise.all(
      s.bots.map((bot) => s.ingest({ chatId, messageId: duplicateId, text, at, botId: bot.id })),
    );
    expect((await waitForReceipts(s, ids)).map((row) => row.status).sort()).toEqual([
      'DUPLICATE',
      'DUPLICATE',
      'DUPLICATE',
      'PROCESSED',
    ]);
    expect(initialRead).toBe(true);
    expect(finalRead).toBe(false);
    expect(s.effects).toEqual([]);
    expect(await s.prisma.moderationEvent.count({ where: { chatId } })).toBe(0);
    expect(await s.prisma.maxActionLedgerEntry.count({ where: { chatId } })).toBe(0);
    const retained = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { id: intentId },
    });
    expect(retained).toMatchObject({
      status: 'IN_PROGRESS',
      leaseToken: token,
      retryUntilAt: deadline,
      remoteDeleteSucceededAt: null,
      completedAt: null,
    });
    for (const id of ids) await s.moderation.processWebhookEvent(id);
    expect(handler).toHaveBeenCalledTimes(1);
    const next = await s.ingest({
      chatId,
      messageId: `following-${randomUUID()}`,
      text: 'Independent later message progresses without waiting for the duplicate deletion',
      at: Date.now(),
    });
    expect((await waitForReceipts(s, [next]))[0]!.status).toBe('PROCESSED');
    // FLAG: Only the simulated worker releases its own test lease. Production recovery
    // and source deadlines are unchanged; the real DELETE still obtains fresh authority.
    expect(
      await s.prisma.moderationDeleteIntent.updateMany({
        where: { id: intentId, status: 'IN_PROGRESS', leaseToken: token },
        data: {
          status: 'RETRYABLE',
          leaseToken: null,
          leaseExpiresAt: null,
          leasedFromStatus: null,
        },
      }),
    ).toEqual({ count: 1 });
    await expect(s.intents.attemptIntent(intentId)).resolves.toMatchObject({ kind: 'confirmed' });
    expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
    expect(s.effects.filter((effect) => effect.method !== 'delete')).toEqual([]);
    expect(s.failures).toEqual([]);
  });

  it.each(
    (['current', 'original'] as const).flatMap((source) =>
      (['http404', 'local_limit'] as const).map((failureKind) => ({ source, failureKind })),
    ),
  )(
    'completes the canonical handler after initial $source refusal ($failureKind) and preserves durable retry',
    async ({ source, failureKind }) => {
      const f = await fixture(4);
      const { s, chatId, duplicateId, text } = f;
      const failure = injectSourceFailure(f, source, 'initial', undefined, failureKind);
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
        const retry = s.intents.attemptIntent(intent.id, {
          beforeDeleteMutation: async (phase) => {
            phases.push(phase);
          },
        });
        if (failureKind === 'local_limit')
          await expect(retry).resolves.toMatchObject({
            kind: 'pending',
            status: 'RETRYABLE',
            confirmed: false,
          });
        else await expect(retry).rejects.toThrow('Native duplicate source unavailable');
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

  it.each(
    (['TEXT', 'MESSAGE'] as const).flatMap((mode) =>
      (['current', 'original'] as const).map((source) => ({ mode, source })),
    ),
  )(
    'recovers $mode qualification after temporary $source refusal without replaying the webhook',
    async ({ mode, source }) => {
      const { s, chatId, originalId, duplicateId, text } = await fixture(3, true, {
        duplicateCompareMode: mode,
      });
      const recovery = await qualificationRecovery(s);
      const unavailableId = source === 'current' ? duplicateId : originalId;
      const read = s.max.getExactMessageRow.bind(s.max);
      jest.spyOn(s.max, 'getExactMessageRow').mockImplementation(async (...args) => {
        if (args[1] === unavailableId) {
          if (mode === 'TEXT')
            throw new MaxApiInternalRateLimitError('Native qualification quota', 7);
          throw Object.assign(new Error('Native source GET unavailable'), {
            response: { status: 404, data: {} },
          });
        }
        return read(...args);
      });
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const at = Date.now();
      const ids = await Promise.all(
        s.bots.map((bot) => s.ingest({ chatId, messageId: duplicateId, text, at, botId: bot.id })),
      );
      const receipts = await waitForReceipts(s, ids);
      expect(receipts.map((row) => row.status).sort()).toEqual([
        'DUPLICATE',
        'DUPLICATE',
        'PROCESSED',
      ]);
      const claims = await s.prisma.moderationViolationMessageClaim.findMany({
        where: { chatId, messageId: duplicateId, ruleCode: 'DUPLICATE_MESSAGE_ACTION' },
      });
      expect(claims).toHaveLength(1);
      expect(claims[0]!.messageActionKey).not.toBeNull();
      const [job] = await recovery.queue.getJobs(['delayed', 'waiting']);
      expect(job).toBeDefined();
      expect(job!.data.deadlineAtMs).toBe(at + 600_000);
      const cleanup = await s.prisma.messageDuplicateClaimCleanup.findUniqueOrThrow({
        where: { claimId: claims[0]!.id },
      });
      expect(cleanup.deadlineAt.getTime()).toBe(job!.data.deadlineAtMs);
      expect(
        await s.prisma.moderationDeleteIntent.count({ where: { chatId, messageId: duplicateId } }),
      ).toBe(0);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
      for (const id of ids) await s.moderation.processWebhookEvent(id);
      expect(handler).toHaveBeenCalledTimes(1);
      const next = await s.ingest({
        chatId,
        messageId: randomUUID(),
        text: 'Independent fresh text keeps moving in this chat',
      });
      expect((await waitForReceipts(s, [next]))[0]!.status).toBe('PROCESSED');
      expect(s.failures).toEqual([]);
      expect(s.effects).toEqual([]);
      let queuedRefusals = mode === 'TEXT' && source === 'current' ? 1 : 0;
      jest.spyOn(s.max, 'getExactMessageRow').mockImplementation(async (...args) => {
        if (args[1] === unavailableId && queuedRefusals > 0) {
          queuedRefusals -= 1;
          throw new MaxApiInternalRateLimitError('Temporary queued qualification quota', 7);
        }
        return read(...args);
      });
      await recovery.run();
      const completedJob = await recovery.queue.getJob(job!.id!);
      expect(completedJob!.attemptsMade).toBe(mode === 'TEXT' && source === 'current' ? 2 : 1);
      const retainedClaim = await s.prisma.moderationViolationMessageClaim.findUniqueOrThrow({
        where: { id: claims[0]!.id },
      });
      expect(retainedClaim.messageActionKey).toBe(claims[0]!.messageActionKey);
      const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId, messageId: duplicateId } },
      });
      expect(intent.status).toBe('SUCCEEDED');
      expect(intent.remoteDeleteSucceededAt).not.toBeNull();
      expect(
        s.effects.filter((effect) => effect.method === 'delete' && effect.path === '/messages'),
      ).toHaveLength(1);
      expect(handler).toHaveBeenCalledTimes(2);
      for (const id of ids) await s.moderation.processWebhookEvent(id);
      expect(handler).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['disabled', 'current-edited', 'original-edited', 'revoked', 'expired'] as const)(
    'refuses deferred qualification when its authority is %s',
    async (reason) => {
      const { s, chatId, originalId, duplicateId, text } = await fixture(1);
      const recovery = await qualificationRecovery(s);
      const read = s.max.getExactMessageRow.bind(s.max);
      jest.spyOn(s.max, 'getExactMessageRow').mockImplementation(async (...args) => {
        if (args[1] === duplicateId) throw new MaxApiInternalRateLimitError('Temporary quota', 7);
        return read(...args);
      });
      const at = Date.now();
      const id = await s.ingest({ chatId, messageId: duplicateId, text, at });
      await waitForReceipts(s, [id]);
      jest.spyOn(s.max, 'getExactMessageRow').mockImplementation(read);
      const [job] = await recovery.queue.getJobs(['delayed', 'waiting']);
      expect(job).toBeDefined();
      if (reason === 'disabled') {
        await s.prisma.chatSettings.update({
          where: { chatId },
          data: { antiDuplicateEnabled: false },
        });
      } else if (reason === 'current-edited' || reason === 'original-edited') {
        const messageId = reason === 'current-edited' ? duplicateId : originalId;
        const raw = s.messages.get(messageId)!;
        s.messages.set(messageId, {
          ...raw,
          body: { ...(raw.body as object), text: 'New content must survive' },
        });
      } else if (reason === 'revoked') {
        const claim = await s.prisma.moderationViolationMessageClaim.findFirstOrThrow({
          where: { chatId, messageId: duplicateId, ruleCode: 'DUPLICATE_MESSAGE_ACTION' },
        });
        await s.authorization.revoke({
          chatId,
          messageId: duplicateId,
          senderId: claim.userId,
          eventTimestampMs: at,
        });
      } else {
        await job!.updateData({ ...job!.data, deadlineAtMs: Date.now() - 1 });
      }
      await recovery.run();
      expect(s.effects).toEqual([]);
      expect(
        await s.prisma.moderationDeleteIntent.count({ where: { chatId, messageId: duplicateId } }),
      ).toBe(0);
      const claim = await s.prisma.moderationViolationMessageClaim.findFirstOrThrow({
        where: { chatId, messageId: duplicateId, ruleCode: 'DUPLICATE_MESSAGE_ACTION' },
      });
      expect(claim.messageActionKey).toBeNull();
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
