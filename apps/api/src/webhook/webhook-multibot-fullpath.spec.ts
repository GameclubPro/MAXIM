import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker, type ConnectionOptions } from 'bullmq';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';
import { AdminService } from '../admin/admin.service';
import { MaxApiInternalRateLimitError, type MaxActionJob } from '../max/max-client.service';
import { MaxActionDispatchService } from '../max/max-action-dispatch.service';
import { MaxActionLedgerService } from '../max/max-action-ledger.service';
import { MaxActionProcessor } from '../max/max-action.processor';
import { Prisma } from '../prisma/prisma-client';
import { MULTIBOT_EXECUTION_AUTHORITY_VERSION } from './webhook-semantic-authority';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeStores('native multibot ingress → outbox → moderation → guarded simulated MAX', () => {
  let h: MultibotHarness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  async function fixture(
    bots: number,
    mode: 'off' | 'shadow' | 'on' = 'shadow',
    recoverDueDeletes = false,
  ) {
    h = await createMultibotHarness({ databaseUrl, redisUrl, bots, mode, recoverDueDeletes });
    return h;
  }

  async function mirrors(
    harness: MultibotHarness,
    chatId: string,
    messageId: string,
    text: string,
    type: 'message_created' | 'message_edited' = 'message_created',
    at = Date.now(),
  ) {
    return Promise.all(
      harness.bots.map((bot) =>
        harness.ingest({ chatId, messageId, text, botId: bot.id, type, at }),
      ),
    );
  }

  async function adminCommandFixture(at = Date.now(), savedDeadlineMs?: number) {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1);
    s.allowAdminUser('fixture-user');
    await s.prisma.chatAdminAllowlist.create({ data: { chatId: chatId!, userId: 'fixture-user' } });
    const admin = Object.create(AdminService.prototype) as AdminService;
    Object.assign(admin, {
      prisma: s.prisma,
      chatContextCache: s.cache,
      superBanDeveloperUserIds: new Set(),
      assertChatAdmin: async () => undefined,
      ensureEntityType: async () => undefined,
      scheduleDestructiveModerationAdminRosterWarmup: () => undefined,
    });
    Object.assign(s.moderation, { injectedManualModerationService: admin });
    await s.pause();
    const receipts = await mirrors(
      s,
      chatId!,
      `silence-${randomUUID()}`,
      'тишина 12',
      'message_created',
      at,
    );
    if (savedDeadlineMs !== undefined) {
      await s.prisma.webhookEvent.updateMany({
        where: { id: { in: receipts } },
        data: { executionDeadlineAt: new Date(Date.now() + savedDeadlineMs) },
      });
    }
    await s.ingress.preparePersistedWebhookEvent(receipts[0]!);
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    const assert = s.groupCommands.assertOwned.bind(s.groupCommands);
    let guards = 0;
    const guardFailure = jest
      .spyOn(s.groupCommands, 'assertOwned')
      .mockImplementation(async (...args) => {
        guards += 1;
        if (guards === 2) throw new Error('Fixture predispatch command lease rejection');
        await assert(...args);
      });
    await expect(s.moderation.processWebhookEvent(receipts[0]!)).rejects.toThrow(
      'notice delivery remains pending',
    );
    guardFailure.mockRestore();
    const started = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: {
        kind: 'EXECUTION',
        webhookEventId: receipts[0],
      },
    });
    expect(started.commandResult).toMatchObject({ kind: 'COMMAND_NOTICE_PENDING' });
    expect(s.effects.filter((effect) => effect.method === 'post')).toEqual([]);
    return { s, chatId: chatId!, receipts, handler, started };
  }

  it.each(
    (['off', 'shadow', 'on'] as const).flatMap((mode) =>
      [1, 3, 4, 6, 9, 12].map((bots) => ({ mode, bots })),
    ),
  )('enforces length once with $bots bots in $mode mode', async ({ bots, mode }) => {
    const s = await fixture(bots, mode);
    const [chatId] = await s.seedCatalog(1);
    const messageId = `length-${randomUUID()}`;
    const receipts = await mirrors(
      s,
      chatId!,
      messageId,
      'A long message that exceeds the configured twenty character limit',
    );
    await s.drain();
    expect(
      await s.prisma.webhookEvent.count({ where: { id: { in: receipts }, status: 'PROCESSED' } }),
    ).toBe(1);
    expect(
      await s.prisma.webhookEvent.count({ where: { id: { in: receipts }, status: 'DUPLICATE' } }),
    ).toBe(bots - 1);
    expect(
      await s.prisma.webhookExecutionClaim.count({
        where: { kind: 'EXECUTION', webhookEventId: { in: receipts }, status: 'COMPLETED' },
      }),
    ).toBe(1);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
    expect(
      await s.prisma.moderationDeleteIntent.count({
        where: { chatId, messageId, status: 'SUCCEEDED' },
      }),
    ).toBe(1);
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
    ).toHaveLength(1);
    expect(s.failures).toEqual([]);
  });

  it.each([1, 3, 4, 6, 9, 12])(
    'does not count %i mirrors as repeated user messages',
    async (bots) => {
      const s = await fixture(bots);
      const [chatId] = await s.seedCatalog(1, {
        maxMessageLengthEnabled: false,
        antiDuplicateEnabled: true,
        duplicateCompareMode: 'TEXT',
        duplicateWarnMaxCount: 1,
      });
      const first = `duplicate-original-${randomUUID()}`;
      await mirrors(s, chatId!, first, 'One repeated text');
      await s.drain();
      expect(s.effects.filter((effect) => effect.method === 'delete')).toEqual([]);
      const repeat = `duplicate-repeat-${randomUUID()}`;
      await mirrors(s, chatId!, repeat, 'One repeated text');
      await s.drain();
      expect(
        s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === first),
      ).toEqual([]);
      expect(
        s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === repeat),
      ).toHaveLength(1);
      expect(
        await s.prisma.moderationDeleteIntent.count({
          where: { chatId, messageId: repeat, reasons: { some: { ruleCode: 'DUPLICATE_DELETE' } } },
        }),
      ).toBe(1);
    },
  );

  it('keeps edit identity separate and length enforcement independent of duplicate lifecycle', async () => {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1, {
      antiDuplicateEnabled: true,
      duplicateCompareMode: 'TEXT',
    });
    const messageId = `edit-${randomUUID()}`;
    const originalAt = Date.now();
    await mirrors(s, chatId!, messageId, 'short', 'message_created', originalAt);
    await s.drain();
    await mirrors(
      s,
      chatId!,
      messageId,
      'Edited text is now longer than the maximum length',
      'message_edited',
      Math.max(Date.now(), originalAt + 1),
    );
    await s.drain();
    expect(
      await s.prisma.webhookExecutionClaim.count({
        where: { kind: 'EXECUTION', webhookEventId: { in: s.receiptIds }, status: 'COMPLETED' },
      }),
    ).toBe(2);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
    ).toHaveLength(1);
  });

  it('adopts the surviving peer before business without replacing receipt or deadline', async () => {
    const s = await fixture(12);
    const [chatId] = await s.seedCatalog(1);
    await s.pause();
    const messageId = `demotion-${randomUUID()}`;
    const receipts = await mirrors(
      s,
      chatId!,
      messageId,
      'The first bot is demoted while this long message waits',
    );
    await s.ingress.preparePersistedWebhookEvent(receipts[0]!);
    const before = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: {
        kind: 'EXECUTION',
        webhookEventId: { in: receipts },
      },
      include: { webhookEvent: true },
    });
    for (const bot of s.bots.slice(0, -1)) await s.demote(chatId!, bot.id);
    await s.resume();
    await s.drain();
    const after = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: before.id },
      include: { webhookEvent: true },
    });
    expect(after.webhookEventId).toBe(before.webhookEventId);
    expect(after.webhookEvent?.executionDeadlineAt).toEqual(
      before.webhookEvent?.executionDeadlineAt,
    );
    expect(after.executionBotId).toBe(s.bots.at(-1)!.id);
    expect(after.status).toBe('COMPLETED');
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
    ).toMatchObject([{ botId: s.bots.at(-1)!.id }]);
  });

  it.each(['successful readiness', 'claim row lock'] as const)(
    'expires the original readiness wait when its deadline crosses during %s',
    async (crossing) => {
      const s = await fixture(4);
      const [chatId] = await s.seedCatalog(1);
      await s.pause();
      const receiptId = await s.ingest({
        chatId: chatId!,
        messageId: `deadline-crossing-${randomUUID()}`,
        text: 'This long message must never enter the engine after its readiness wait expires',
        botId: s.bots[0]!.id,
      });
      // Keep the MAX source genuinely new; exercise the saved narrower SQL deadline.
      await s.prisma.webhookEvent.update({
        where: { id: receiptId },
        data: { executionDeadlineAt: new Date(Date.now() + 1_500) },
      });
      await s.ingress.preparePersistedWebhookEvent(receiptId);
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: receiptId },
        include: { webhookEvent: true },
      });
      const deadline = claim.webhookEvent!.executionDeadlineAt!;
      expect(deadline.getTime()).toBeGreaterThan(Date.now());
      await s.prisma.webhookExecutionClaim.update({
        where: { id: claim.id },
        data: {
          commandResult: {
            kind: 'EXECUTION_WAITING',
            authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
            webhookEventId: receiptId,
            semanticKey: claim.semanticKey,
            deadlineAt: deadline.toISOString(),
          },
        },
      });
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const ensureReady = s.readiness.ensureReady.bind(s.readiness);
      let blocker: Promise<unknown> | undefined;
      let releaseLock: (() => void) | undefined;
      let lockAcquired: (() => void) | undefined;
      const locked = new Promise<void>((resolve) => {
        lockAcquired = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const readiness = jest.spyOn(s.readiness, 'ensureReady').mockImplementation(async (input) => {
        const proof = await ensureReady(input);
        if (crossing === 'claim row lock') {
          blocker = s.prisma.$transaction(
            async (tx) => {
              await tx.$queryRaw(Prisma.sql`
                SELECT "id" FROM "webhook_execution_claims" WHERE "id" = ${claim.id} FOR UPDATE
              `);
              lockAcquired!();
              await released;
            },
            { timeout: 10_000 },
          );
          await locked;
        } else {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now()) + 30),
          );
        }
        return proof;
      });
      try {
        const processing = s.moderation.processWebhookEvent(receiptId);
        if (crossing === 'claim row lock') {
          await locked;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now()) + 30),
          );
          releaseLock!();
          await blocker;
        }
        await processing;
        const expired = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
          where: { id: claim.id },
          include: { webhookEvent: true },
        });
        expect(expired.status).toBe('COMPLETED');
        expect(expired.businessStartedAt).toBeNull();
        expect(expired.webhookEvent?.normalizedPayload).toMatchObject({
          executionOutcome: { code: 'NO_EXECUTABLE_OWNER', deadlineAt: deadline.toISOString() },
        });
        expect(handler).not.toHaveBeenCalled();
        expect(s.effects).toEqual([]);
      } finally {
        releaseLock!();
        await blocker;
        readiness.mockRestore();
      }
    },
  );

  it('expires a pending readiness wait after successful preparation crosses its deadline', async () => {
    const s = await fixture(4);
    const [chatId] = await s.seedCatalog(1);
    await s.pause();
    const receiptId = await s.ingest({
      chatId: chatId!,
      messageId: `preparation-deadline-${randomUUID()}`,
      text: 'This waiting preparation must expire even when the last access check succeeds',
      botId: s.bots[0]!.id,
    });
    const event = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receiptId } });
    const deadline = new Date(Date.now() + 1_500);
    expect(deadline.getTime()).toBeLessThan(event.executionDeadlineAt!.getTime());
    await s.prisma.webhookEvent.update({
      where: { id: receiptId },
      data: { executionDeadlineAt: deadline },
    });
    expect(deadline.getTime()).toBeGreaterThan(Date.now());
    const claim = await s.prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: event.semanticKey!,
        webhookEventId: receiptId,
        enforced: true,
        commandResult: {
          kind: 'EXECUTION_WAITING',
          authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
          webhookEventId: receiptId,
          semanticKey: event.semanticKey!,
          deadlineAt: deadline.toISOString(),
        },
      },
    });
    const ensureReady = s.readiness.ensureReady.bind(s.readiness);
    const readiness = jest.spyOn(s.readiness, 'ensureReady').mockImplementation(async (input) => {
      const proof = await ensureReady(input);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now()) + 30),
      );
      return proof;
    });
    try {
      await expect(s.ingress.preparePersistedWebhookEvent(receiptId)).resolves.toMatchObject({
        canonical: false,
        prepared: true,
        executionBotId: null,
      });
      const expired = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: claim.id },
        include: { webhookEvent: true },
      });
      expect(expired.status).toBe('COMPLETED');
      expect(expired.businessStartedAt).toBeNull();
      expect(expired.webhookEvent?.normalizedPayload).toMatchObject({
        executionOutcome: { code: 'NO_EXECUTABLE_OWNER', deadlineAt: deadline.toISOString() },
      });
      expect(s.effects).toEqual([]);
    } finally {
      readiness.mockRestore();
    }
  });

  it('rejects an expired business lease after a successful executor proof', async () => {
    const s = await fixture(4);
    const [chatId] = await s.seedCatalog(1);
    await s.pause();
    const receiptId = await s.ingest({
      chatId: chatId!,
      messageId: `lease-expired-${randomUUID()}`,
      text: 'An expired lease must never start this long message',
      botId: s.bots[0]!.id,
    });
    await s.ingress.preparePersistedWebhookEvent(receiptId);
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    const ensureReady = s.readiness.ensureReady.bind(s.readiness);
    const readiness = jest.spyOn(s.readiness, 'ensureReady').mockImplementation(async (input) => {
      const proof = await ensureReady(input);
      await s.prisma.webhookExecutionClaim.updateMany({
        where: { kind: 'EXECUTION', webhookEventId: receiptId },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      return proof;
    });
    try {
      await expect(s.moderation.processWebhookEvent(receiptId)).rejects.toThrow(
        'business-start fence changed',
      );
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: receiptId },
      });
      expect(claim.businessStartedAt).toBeNull();
      expect(claim.status).toBe('READY');
      expect(handler).not.toHaveBeenCalled();
      expect(s.effects).toEqual([]);
    } finally {
      readiness.mockRestore();
    }
  });

  it('refuses READY publication when the preparation lease expires during its awaited work', async () => {
    const s = await fixture(4);
    const [chatId] = await s.seedCatalog(1);
    await s.pause();
    const receiptId = await s.ingest({
      chatId: chatId!,
      messageId: `preparation-expired-${randomUUID()}`,
      text: 'A preparation result requires a live lease before it becomes executable',
      botId: s.bots[0]!.id,
    });
    const ensureReady = s.readiness.ensureReady.bind(s.readiness);
    const readiness = jest.spyOn(s.readiness, 'ensureReady').mockImplementation(async (input) => {
      const proof = await ensureReady(input);
      await s.prisma.webhookExecutionClaim.updateMany({
        where: { kind: 'EXECUTION', webhookEventId: receiptId },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      return proof;
    });
    try {
      await expect(s.ingress.preparePersistedWebhookEvent(receiptId)).rejects.toThrow(
        'lease was lost before READY',
      );
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: receiptId },
      });
      expect(claim.preparedAt).toBeNull();
      expect(claim.businessStartedAt).toBeNull();
      expect(claim.status).toBe('PENDING');
      expect(s.effects).toEqual([]);
    } finally {
      readiness.mockRestore();
    }
  });

  it('dispatches a later physical owner through its earlier mirror before the next logical message', async () => {
    const s = await fixture(4);
    const [chatId] = await s.seedCatalog(1);
    await s.pause();
    const firstId = `first-${randomUUID()}`;
    const secondId = `second-${randomUUID()}`;
    const at = Date.now();
    const earlyMirror = await s.ingest({
      chatId: chatId!,
      messageId: firstId,
      text: 'The oldest logical message is longer than the limit',
      botId: s.bots[0]!.id,
      at,
    });
    await s.ingest({
      chatId: chatId!,
      messageId: secondId,
      text: 'The second logical message is longer than the limit',
      botId: s.bots[0]!.id,
      at: at + 1,
    });
    const owner = await s.ingest({
      chatId: chatId!,
      messageId: firstId,
      text: 'The oldest logical message is longer than the limit',
      botId: s.bots[1]!.id,
      at,
    });
    await s.ingress.preparePersistedWebhookEvent(owner);
    await s.resume();
    await s.drain();
    expect(s.processedIds.indexOf(owner)).toBeLessThan(
      s.processedIds.findIndex((id) => id !== owner && id !== earlyMirror),
    );
    expect(
      s.effects.filter((effect) => effect.method === 'delete').map((effect) => effect.messageId),
    ).toEqual([firstId, secondId]);
  });

  it('retains the business replay fence after the worker lease expires', async () => {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1);
    await s.pause();
    const receipts = await mirrors(
      s,
      chatId!,
      `crash-${randomUUID()}`,
      'A long message whose first business worker disappears',
    );
    await s.ingress.preparePersistedWebhookEvent(receipts[0]!);
    const execution = await s.canonical.prepareExecution(receipts[0]!, s.bots[0]!.id);
    expect(execution).not.toBeNull();
    const before = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: {
        kind: 'EXECUTION',
        webhookEventId: receipts[0],
      },
    });
    await s.prisma.webhookExecutionClaim.update({
      where: { id: before.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    await s.moderation.processWebhookEvent(receipts[0]!);
    const after = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: before.id },
    });
    const receipt = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } });
    expect(after.businessStartedAt).toEqual(before.businessStartedAt);
    expect(after.executionBotId).toBe(before.executionBotId);
    expect(receipt.errorMessage).toContain('CANONICAL_BUSINESS_ALREADY_STARTED');
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
    expect(s.effects).toEqual([]);
  });

  it('keeps an ambiguous routed SEND fenced when a peer attempts the same logical key', async () => {
    const s = await fixture(4);
    const [chatId] = await s.seedCatalog(1);
    const idempotencyKey = `unknown-send-${randomUUID()}`;
    s.ambiguousNextSend();
    await expect(
      s.max.sendMessage(chatId!, 'Local ambiguous-send fixture', undefined, {
        immediate: true,
        botId: s.bots[0]!.id,
        idempotencyKey,
        routing: { purpose: 'send_message' },
        candidateBotIds: [s.bots[0]!.id],
      }),
    ).rejects.toThrow();
    await expect(
      s.max.sendMessage(chatId!, 'Local ambiguous-send fixture', undefined, {
        immediate: true,
        botId: s.bots[1]!.id,
        idempotencyKey,
        routing: { purpose: 'send_message' },
        candidateBotIds: [s.bots[1]!.id],
      }),
    ).rejects.toThrow();
    expect(
      s.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
    ).toHaveLength(1);
    expect(await s.prisma.maxActionLedgerEntry.count({ where: { chatId, ambiguous: true } })).toBe(
      1,
    );
  });

  it.each(
    (['BAN_MEMBER', 'KICK_MEMBER'] as const).flatMap((actionType) =>
      (['AMBIGUOUS', 'IN_PROGRESS'] as const).map((journalStatus) => ({
        actionType,
        journalStatus,
      })),
    ),
  )(
    'fences an unknown $actionType after a worker restart with $journalStatus journal',
    async ({ actionType, journalStatus }) => {
      const s = await fixture(4);
      const [chatId] = await s.seedCatalog(1);
      const idempotencyKey = `unknown-member-${randomUUID()}`;
      const data: MaxActionJob = {
        actionType,
        chatId: chatId!,
        userId: 'fixture-user',
        botId: s.bots[0]!.id,
        candidateBotIds: s.bots.map((bot) => bot.id),
        routing: { purpose: 'moderation_action', action: 'moderate_member' },
        idempotencyKey,
        createdAt: new Date().toISOString(),
        attempt: 1,
      };
      const queue = new Queue<MaxActionJob>(`member-action-${randomUUID()}`, {
        connection: s.redis as unknown as ConnectionOptions,
      });
      const eventsRedis = s.redis.duplicate();
      const events = new QueueEvents(queue.name, {
        connection: eventsRedis as unknown as ConnectionOptions,
      });
      let workerRedis = s.redis.duplicate();
      const startWorker = (ledger: MaxActionLedgerService) => {
        const dispatch = new MaxActionDispatchService(s.max, undefined, ledger, s.links, s.config);
        const processor = new MaxActionProcessor(dispatch);
        return new Worker<MaxActionJob>(queue.name, (job) => processor.process(job), {
          connection: workerRedis as unknown as ConnectionOptions,
          concurrency: 1,
        });
      };
      const previousRole = process.env.APP_ROLE;
      process.env.APP_ROLE = 'action';
      let worker = startWorker(s.ledger);
      const lostFinalJournal =
        journalStatus === 'IN_PROGRESS'
          ? jest.spyOn(s.ledger, 'recordFailed').mockRejectedValueOnce(
              // Simulate loss of the final write after MAX received the mutation.
              new Error('Simulated worker loss before final member journal write'),
            )
          : undefined;
      try {
        await Promise.all([
          queue.waitUntilReady(),
          events.waitUntilReady(),
          worker.waitUntilReady(),
        ]);
        await s.ledger.recordEnqueuedIfAbsent(data);
        s.ambiguousNextMemberMutation();
        const first = await queue.add('execute-max-action', data, {
          jobId: idempotencyKey,
          attempts: 5,
          backoff: { type: 'fixed', delay: 10 },
        });
        await expect(first.waitUntilFinished(events, 10_000)).rejects.toThrow(
          `Ambiguous MAX ${actionType} transport failure`,
        );
        expect((await queue.getJob(first.id!))?.attemptsMade).toBe(1);
        expect(await first.getState()).toBe('failed');
        const before = await s.prisma.maxActionLedgerEntry.findUniqueOrThrow({
          where: { jobId: idempotencyKey },
        });
        expect(before).toMatchObject({
          actionType,
          chatId,
          userId: data.userId,
          botId: data.botId,
          status: journalStatus,
          ambiguous: journalStatus === 'AMBIGUOUS',
          terminal: journalStatus === 'AMBIGUOUS',
          attemptCount: 1,
          firstAttemptAt: expect.any(Date),
          lastAttemptAt: expect.any(Date),
          completedAt: journalStatus === 'AMBIGUOUS' ? expect.any(Date) : null,
        });
        if (journalStatus === 'AMBIGUOUS') {
          expect(before).toMatchObject({ lastStatusCode: null, lastErrorCode: 'econnaborted' });
          expect(before.metadata).toMatchObject({ attemptedBotIds: [data.botId] });
        } else {
          expect(lostFinalJournal).toHaveBeenCalledTimes(1);
        }

        await worker.close();
        await workerRedis.quit();
        lostFinalJournal?.mockRestore();
        await s.demote(chatId!, data.botId!);
        const peerRoute = await s.links.resolveBotRoute({
          chatId: chatId!,
          purpose: 'moderation_action',
          action: 'moderate_member',
        });
        expect(peerRoute.candidateBotIds).toContain(s.bots[1]!.id);
        workerRedis = s.redis.duplicate();
        worker = startWorker(new MaxActionLedgerService(s.prisma as never));
        await worker.waitUntilReady();
        const replay = await queue.add(
          'execute-max-action',
          { ...data, botId: s.bots[1]!.id, candidateBotIds: peerRoute.candidateBotIds },
          { jobId: `peer-replay-${randomUUID()}`, attempts: 5 },
        );
        expect(replay.id).not.toBe(first.id);
        await expect(replay.waitUntilFinished(events, 10_000)).rejects.toThrow(
          `is no longer executable (${journalStatus})`,
        );
        expect((await queue.getJob(replay.id!))?.attemptsMade).toBe(1);
        expect(await replay.getState()).toBe('failed');
        expect(
          s.effects.filter(
            (effect) => effect.method === 'delete' && effect.path === `/chats/${chatId}/members`,
          ),
        ).toEqual([
          expect.objectContaining({
            botId: data.botId,
            params: {
              user_id: data.userId,
              ...(actionType === 'BAN_MEMBER' ? { block: true } : {}),
            },
          }),
        ]);
        expect(await s.prisma.maxActionLedgerEntry.count({ where: { chatId } })).toBe(1);
        expect(
          await s.prisma.maxActionLedgerEntry.findUniqueOrThrow({
            where: { jobId: idempotencyKey },
          }),
        ).toEqual(before);
      } finally {
        lostFinalJournal?.mockRestore();
        if (previousRole === undefined) delete process.env.APP_ROLE;
        else process.env.APP_ROLE = previousRole;
        await worker.close();
        await workerRedis.quit();
        await events.close();
        await eventsRedis.quit();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    },
  );

  it('resumes only the immutable command notice after proven predispatch rejection', async () => {
    const { s, chatId, receipts, handler, started } = await adminCommandFixture();
    const deadline = (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } }))
      .executionDeadlineAt;
    await s.prisma.webhookEvent.update({
      where: { id: receipts[0] },
      data: { nextEnqueueAt: new Date() },
    });
    await s.resume();
    await s.drain();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      await s.prisma.auditLog.count({ where: { chatId, action: 'MANUAL_CHAT_SILENCE' } }),
    ).toBe(1);
    const finished = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: started.id },
    });
    expect(finished).toMatchObject({
      status: 'COMPLETED',
      executionBotId: started.executionBotId,
      businessStartedAt: started.businessStartedAt,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(
      (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } }))
        .executionDeadlineAt,
    ).toEqual(deadline);
    expect(s.effects.filter((effect) => effect.method === 'post')).toMatchObject([
      { botId: started.executionBotId },
    ]);
  });

  it('settles the saved command through SQL after successful SEND and a completion crash', async () => {
    const { s, chatId, receipts, handler } = await adminCommandFixture();
    const complete = jest
      .spyOn(s.groupCommands, 'complete')
      .mockRejectedValueOnce(new Error('Fixture crash after successful SEND'));
    await expect(s.moderation.processWebhookEvent(receipts[0]!)).rejects.toThrow(
      'Fixture crash after successful SEND',
    );
    complete.mockRestore();
    const sent = s.effects.filter((effect) => effect.method === 'post');
    expect(sent).toHaveLength(1);
    const deadline = (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } }))
      .executionDeadlineAt!;
    const elapsed = jest.spyOn(Date, 'now').mockReturnValue(deadline.getTime() + 1);
    try {
      await s.moderation.processWebhookEvent(receipts[0]!);
    } finally {
      elapsed.mockRestore();
    }
    await s.resume();
    await s.drain();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      await s.prisma.auditLog.count({ where: { chatId, action: 'MANUAL_CHAT_SILENCE' } }),
    ).toBe(1);
    expect(s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
    expect(
      await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } }),
    ).toMatchObject({ status: 'PROCESSED', errorMessage: null });
  });

  it('keeps an attempted unknown command SEND fenced without whole-engine replay', async () => {
    const { s, receipts, handler } = await adminCommandFixture();
    s.ambiguousNextSend();
    await expect(s.moderation.processWebhookEvent(receipts[0]!)).rejects.toThrow(
      'notice delivery remains pending',
    );
    await s.moderation.processWebhookEvent(receipts[0]!);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
    expect(
      (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } })).errorMessage,
    ).toContain('CANONICAL_BUSINESS_ALREADY_STARTED');
  });

  it('hands off only an unattempted saved notice when the original command executor is demoted', async () => {
    const { s, chatId, receipts, handler, started } = await adminCommandFixture();
    const beforeCommand = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: {
        kind: 'COMMAND',
        webhookEventId: receipts[0],
      },
    });
    await s.demote(chatId, started.executionBotId!);
    await s.moderation.processWebhookEvent(receipts[0]!);
    const afterCommand = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: beforeCommand.id },
    });
    const afterExecution = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: started.id },
    });
    expect(afterCommand.executionBotId).not.toBe(beforeCommand.executionBotId);
    expect(afterCommand.commandResult).toEqual(beforeCommand.commandResult);
    expect(afterCommand.webhookEventId).toBe(beforeCommand.webhookEventId);
    expect(afterExecution.executionBotId).toBe(started.executionBotId);
    expect(afterExecution.businessStartedAt).toEqual(started.businessStartedAt);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      await s.prisma.auditLog.count({ where: { chatId, action: 'MANUAL_CHAT_SILENCE' } }),
    ).toBe(1);
    expect(s.effects.filter((effect) => effect.method === 'post')).toMatchObject([
      { botId: afterCommand.executionBotId },
    ]);
  });

  it('does not send a saved notice beyond its immutable saved deadline', async () => {
    const { s, receipts, handler, started } = await adminCommandFixture(Date.now(), 1_000);
    const journal = started.commandResult as { deadlineAt: string };
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(journal.deadlineAt) - Date.now()) + 30),
    );
    const before = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: {
        kind: 'COMMAND',
        webhookEventId: receipts[0],
      },
    });
    await s.moderation.processWebhookEvent(receipts[0]!);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(s.effects.filter((effect) => effect.method === 'post')).toEqual([]);
    const after = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(after).toMatchObject({
      status: 'COMPLETED',
      commandResult: before.commandResult,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(
      (await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: started.id } }))
        .commandResult,
    ).toMatchObject({ kind: 'COMMAND_NOTICE_EXPIRED' });
    expect(
      await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } }),
    ).toMatchObject({ status: 'PROCESSED', errorMessage: null, nextEnqueueAt: null });
    expect(
      await s.prisma.maxActionLedgerEntry.findMany({
        where: { chatId: h!.chatIds[0], actionType: 'SEND_MESSAGE' },
      }),
    ).toMatchObject([
      {
        status: 'FAILED_TERMINAL',
        ambiguous: false,
        terminal: true,
        lastErrorCode: 'COMMAND_NOTICE_EXPIRED',
        dispatchToken: null,
        dispatchStartedAt: null,
        remoteMessageId: null,
      },
    ]);
    await s.resume();
    await s.drain();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refreshes a changed normalized predispatch code without replaying command mutation', async () => {
    const { s, receipts, handler, started } = await adminCommandFixture();
    const verify = s.links.verifyChatExecutionProof.bind(s.links);
    let checks = 0;
    const rejected = jest
      .spyOn(s.links, 'verifyChatExecutionProof')
      .mockImplementation(async (proof) => {
        checks += 1;
        if (checks === 2)
          throw Object.assign(new Error('Fixture second predispatch rejection'), {
            code: 'TEMP_SECOND_REJECTION',
          });
        return verify(proof);
      });
    await expect(s.moderation.processWebhookEvent(receipts[0]!)).rejects.toThrow(
      'notice delivery remains pending',
    );
    rejected.mockRestore();
    expect(
      (await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: started.id } }))
        .commandResult,
    ).toMatchObject({
      kind: 'COMMAND_NOTICE_PENDING',
      failureCode: 'max_send_pre_dispatch_guard_rejected',
    });
    await s.moderation.processWebhookEvent(receipts[0]!);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
  });

  it('rejects a notice when the final SQL proof crosses its source deadline', async () => {
    const { s, receipts, handler, started } = await adminCommandFixture();
    const deadline = (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } }))
      .executionDeadlineAt!;
    const verify = s.links.verifyChatExecutionProof.bind(s.links);
    let checks = 0;
    let elapsed: jest.SpyInstance | undefined;
    const delayed = jest
      .spyOn(s.links, 'verifyChatExecutionProof')
      .mockImplementation(async (proof) => {
        const result = await verify(proof);
        checks += 1;
        if (checks === 2) elapsed = jest.spyOn(Date, 'now').mockReturnValue(deadline.getTime() + 1);
        return result;
      });
    try {
      await expect(s.moderation.processWebhookEvent(receipts[0]!)).rejects.toThrow(
        'notice delivery remains pending',
      );
      delayed.mockRestore();
      await s.moderation.processWebhookEvent(receipts[0]!);
    } finally {
      delayed.mockRestore();
      elapsed?.mockRestore();
    }
    expect(handler).toHaveBeenCalledTimes(1);
    expect(s.effects.filter((effect) => effect.method === 'post')).toEqual([]);
    expect(
      (await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: started.id } }))
        .commandResult,
    ).toMatchObject({ kind: 'COMMAND_NOTICE_EXPIRED' });
  });

  it.each([3, 6, 9, 12])(
    'retains the capable read owner and uses only the last write-capable peer among %i bots',
    async (bots) => {
      const s = await fixture(bots);
      for (const bot of s.bots) s.setBotPermissions(bot.id, ['read_all_messages']);
      s.setBotPermissions(s.bots.at(-1)!.id, ['write']);
      const [chatId] = await s.seedCatalog(1);
      const messageId = `split-permissions-${randomUUID()}`;
      await mirrors(
        s,
        chatId!,
        messageId,
        'The read owner remains healthy but only the final peer may delete this long message',
      );
      await s.drain();
      expect(await s.prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).toMatchObject({
        primaryBotId: s.bots[0]!.id,
      });
      expect(
        await s.prisma.webhookExecutionClaim.findFirstOrThrow({
          where: {
            kind: 'EXECUTION',
            webhookEventId: { in: s.receiptIds },
          },
        }),
      ).toMatchObject({ executionBotId: s.bots[0]!.id, status: 'COMPLETED' });
      expect(
        s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
      ).toMatchObject([{ botId: s.bots.at(-1)!.id }]);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
    },
  );

  it('finishes the original engine and recovers a future SQL DELETE retry with no BullMQ job', async () => {
    const s = await fixture(9, 'shadow', true);
    const [chatId] = await s.seedCatalog(1);
    await s.pause();
    const wakeup = jest.spyOn(s.intents as any, 'enqueueWakeup').mockResolvedValue(undefined);
    const messageId = `quota-guard-${randomUUID()}`;
    const receipts = await mirrors(
      s,
      chatId!,
      messageId,
      'This long message exceeds the configured text limit',
    );
    await s.ingress.preparePersistedWebhookEvent(receipts[0]!);
    const execution = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: {
        kind: 'EXECUTION',
        webhookEventId: { in: receipts },
      },
    });
    const ownerId = execution.webhookEventId!;
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    const originalExact = s.max.getExactMessageRow.bind(s.max);
    let quotaFailure: unknown;
    const exact = jest
      .spyOn(s.max, 'getExactMessageRow')
      .mockImplementationOnce(async (...args) => {
        const wait = jest
          .spyOn(s.max as any, 'resolveTrafficClassRateLimitWaitMs')
          .mockReturnValue(0);
        const reserve = jest.spyOn(s.max as any, 'tryReserveRateLimitSlot').mockResolvedValueOnce({
          ok: false,
          retryAfterMs: 76,
          reason: 'Fixture native final-guard quota rejection',
        });
        try {
          return await originalExact(...args);
        } catch (error) {
          quotaFailure = error;
          throw error;
        } finally {
          reserve.mockRestore();
          wait.mockRestore();
        }
      });
    try {
      await s.moderation.processWebhookEvent(ownerId);
    } finally {
      exact.mockRestore();
      wakeup.mockRestore();
    }
    expect(quotaFailure).toBeInstanceOf(MaxApiInternalRateLimitError);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } })).toMatchObject(
      { status: 'PROCESSED', errorMessage: null },
    );
    expect(
      await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: {
          kind: 'EXECUTION',
          webhookEventId: ownerId,
        },
      }),
    ).toMatchObject({ status: 'COMPLETED', commandResult: { kind: 'EXECUTION_FINISHED' } });
    const retry = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: {
        chatId_messageId: { chatId: chatId!, messageId },
      },
    });
    expect(retry).toMatchObject({
      status: 'RETRYABLE',
      deleteDispatchStartedAt: null,
      deleteDispatchStartedBotId: null,
      leaseToken: null,
      lastErrorCode: 'MAX_API_INTERNAL_RATE_LIMIT',
    });
    expect(s.effects.filter((effect) => effect.method === 'delete')).toEqual([]);
    for (const receipt of receipts)
      if (receipt !== ownerId) await s.ingress.preparePersistedWebhookEvent(receipt);
    expect(
      await s.prisma.webhookEvent.count({
        where: { id: { in: receipts }, status: { in: ['RECEIVED', 'QUEUED', 'FAILED'] } },
      }),
    ).toBe(0);
    expect(await s.deleteQueue.getJobCounts('waiting', 'active', 'delayed')).toMatchObject({
      waiting: 0,
      active: 0,
      delayed: 0,
    });
    const dueAt = new Date(Date.now() + 250);
    await s.prisma.moderationDeleteIntent.update({
      where: { id: retry.id },
      data: { nextAttemptAt: dueAt },
    });
    const sweeper = jest.spyOn(s.intents, 'sweepDueIntents');
    expect(await s.pumpOnce()).toBe(1);
    expect(sweeper).toHaveBeenCalledTimes(1);
    expect(s.effects.filter((effect) => effect.method === 'delete')).toEqual([]);
    await s.resume();
    await s.drain();
    expect(sweeper.mock.calls.length).toBeGreaterThanOrEqual(2);
    sweeper.mockRestore();
    expect(Date.now()).toBeGreaterThanOrEqual(dueAt.getTime());
    expect(
      await s.prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: retry.id } }),
    ).toMatchObject({
      status: 'SUCCEEDED',
    });
    await s.moderation.processWebhookEvent(ownerId);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
    ).toHaveLength(1);
  });
});
