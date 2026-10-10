import type { MaxUpdate } from '@maxim/contracts';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { WebhookStatus } from '../prisma/prisma-client';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import { WebhookCanonicalExecutionService } from './webhook-canonical-execution.service';

function fixture(type: 'user_removed' | 'message_created', mirrorIsEarlier: boolean) {
  const update = {
    updateId: 'mirror-update',
    type,
    eventTimestampSource: 'payload',
    botId: 'bot-mirror',
    timestamp: 1_788_336_000_000,
    message: {
      chatId: '-100-mirror',
      messageId: 'message-1',
      senderId: 'user-1',
      text: 'hello',
      createdAt: '2026-09-02T08:00:00.000Z',
    },
    ...(type === 'user_removed'
      ? { membership: { action: 'removed', memberUserIds: ['user-1'] } }
      : {}),
  } as MaxUpdate;
  const semanticKey = buildWebhookSemanticEventKey(update)!;
  const event = {
    id: 'mirror',
    botId: 'bot-mirror',
    status: WebhookStatus.QUEUED,
    normalizedPayload: update,
    semanticKey,
    executionDeadlineAt: new Date('2026-09-02T08:05:00Z'),
    errorMessage: null,
    queuedAt: new Date('2026-09-02T08:00:01Z'),
    enqueueAttempts: 1,
    nextEnqueueAt: null,
    timeoutQuarantineExpiresAt: null,
    createdAt: new Date(mirrorIsEarlier ? '2026-09-02T08:00:00Z' : '2026-09-02T08:00:02Z'),
    processedAt: null,
    sourceIp: null,
    rawPayload: {},
    dedupKey: 'mirror-dedup',
    queueName: 'moderation-background',
  };
  const owner = {
    ...event,
    id: 'owner',
    botId: 'bot-owner',
    normalizedPayload: { ...update, botId: 'bot-owner' },
    createdAt: new Date('2026-09-02T08:00:01Z'),
  };
  const claim = {
    id: 'claim',
    createdAt: new Date(),
    kind: 'EXECUTION',
    semanticKey,
    webhookEventId: owner.id,
    executionBotId: 'bot-owner',
    enforced: true,
    status: 'PENDING',
    preparedAt: null as Date | null,
    completedAt: null,
    businessStartedAt: null,
    leaseToken: 'preparation-lease',
    leaseExpiresAt: new Date(Date.now() + 30_000),
  };
  const prisma = {
    webhookEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'owner' ? owner : event,
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    webhookExecutionClaim: {
      findUnique: jest.fn(async () => claim),
      findFirst: jest.fn(),
      updateMany: jest.fn(async ({ data }: { data: object }) => {
        Object.assign(claim, data);
        return { count: 1 };
      }),
    },
    $queryRaw: jest.fn(async (query: { strings?: readonly string[] }) =>
      query.strings?.join(' ').includes('WITH authority_ids AS MATERIALIZED') ||
      query.strings?.join(' ').includes('SELECT claim.id, claim.webhook_event_id AS "ownerId"')
        ? []
        : [{ finishedAt: new Date('2020-01-01T00:00:00Z') }],
    ),
  };
  Object.assign(prisma, {
    $transaction: jest.fn(async (work: (tx: object) => unknown) => work(prisma)),
  });
  return { claim, prisma, service: new WebhookCanonicalExecutionService(prisma as never) };
}

describe('WebhookCanonicalExecutionService preparation fence', () => {
  it('defers when the prior semantic execution proof reader is unavailable', async () => {
    const f = fixture('message_created', false);
    const event = await f.prisma.webhookEvent.findUnique({ where: { id: 'mirror' } });
    f.prisma.webhookEvent.findFirst.mockResolvedValue(event);
    Object.assign(f.prisma, { $queryRaw: undefined });
    const guard = f.service as unknown as {
      assertNoOutstandingOrderedPredecessor(event: unknown, update: MaxUpdate): Promise<void>;
    };
    await expect(
      guard.assertNoOutstandingOrderedPredecessor(event, event.normalizedPayload),
    ).rejects.toThrow('Prior semantic execution proof unavailable');
  });

  it('defers a queued shadow membership mirror while its owner is unprepared', async () => {
    const f = fixture('user_removed', false);
    await expect(f.service.prepareExecution('mirror', 'bot-default')).rejects.toBeInstanceOf(
      WebhookPreparationDeferredError,
    );
    expect(f.claim.enforced).toBe(true);
    expect(f.prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    expect(f.prisma.webhookExecutionClaim.updateMany).not.toHaveBeenCalled();
  });

  it('keeps an earlier ordered mirror fenced while its later foreign owner is READY', async () => {
    const f = fixture('message_created', true);
    Object.assign(f.claim, {
      status: 'READY',
      preparedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    });
    await expect(f.service.prepareExecution('mirror', 'bot-default')).rejects.toBeInstanceOf(
      WebhookPreparationDeferredError,
    );
    expect(f.claim.enforced).toBe(true);
    expect(f.prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    expect(f.prisma.webhookExecutionClaim.updateMany).not.toHaveBeenCalled();
  });
});

function finishedExecutionFixture() {
  const preparedAt = new Date('2026-09-02T08:00:01.000Z');
  const businessStartedAt = new Date('2026-09-02T08:00:02.000Z');
  const finishedAt = new Date('2026-09-02T08:00:03.000Z');
  const update = {
    updateId: 'finished-update',
    type: 'message_created',
    eventTimestampSource: 'payload',
    botId: 'original-bot',
    message: {
      chatId: '-100-finished',
      messageId: 'finished-message',
      senderId: 'fixture-author',
      text: 'fixture content',
      createdAt: '2026-09-02T08:00:00.000Z',
    },
  } as MaxUpdate;
  const semanticKey = buildWebhookSemanticEventKey(update)!;
  const event = {
    id: 'finished-owner',
    botId: 'original-bot',
    status: WebhookStatus.FAILED as WebhookStatus,
    normalizedPayload: update,
    semanticKey: semanticKey as string | null,
    executionDeadlineAt: new Date('2026-09-02T08:05:00.000Z'),
    errorMessage: 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:fixture: retained',
    queuedAt: preparedAt,
    enqueueAttempts: 1,
    nextEnqueueAt: null,
    timeoutQuarantineExpiresAt: new Date('2026-09-02T08:10:00.000Z'),
    createdAt: new Date('2026-09-02T08:00:00.000Z'),
    processedAt: null as Date | null,
    sourceIp: null,
    rawPayload: {},
    dedupKey: 'finished-owner-dedup',
    queueName: 'moderation-background',
  };
  const journal: Record<string, unknown> = {
    kind: 'EXECUTION_FINISHED',
    authorityVersion: 'semantic-owner-lease-v1',
    webhookEventId: event.id,
    semanticKey,
    executionBotId: 'original-bot',
    businessStartedAt: businessStartedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
  const claim = {
    id: 'finished-claim',
    kind: 'EXECUTION',
    semanticKey,
    webhookEventId: event.id as string | null,
    executionBotId: 'original-bot' as string | null,
    enforced: true,
    status: 'READY',
    createdAt: preparedAt,
    preparedAt: preparedAt as Date | null,
    completedAt: null as Date | null,
    businessStartedAt: businessStartedAt as Date | null,
    commandResult: journal as unknown,
    leaseToken: 'original-business-lease' as string | null,
    leaseExpiresAt: new Date(Date.now() + 30_000) as Date | null,
  };
  const client = {
    webhookEvent: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    webhookExecutionClaim: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return { event, claim, journal, client, finishedAt };
}

type FinishedExecutionFixture = ReturnType<typeof finishedExecutionFixture>;

describe('WebhookCanonicalExecutionService finished-handler recovery', () => {
  it.each(['live', 'expired', 'released'] as const)(
    'settles only the original finished handler with its %s lease snapshot',
    async (leaseState) => {
      const f = finishedExecutionFixture();
      if (leaseState === 'expired') f.claim.leaseExpiresAt = new Date(Date.now() - 1_000);
      if (leaseState === 'released') {
        f.claim.leaseToken = null;
        f.claim.leaseExpiresAt = null;
      }

      await expect(
        WebhookCanonicalExecutionService.tryRecoverFinishedExecutionWithClient(
          f.client as never,
          f.event as never,
          f.claim,
        ),
      ).resolves.toBe(true);

      expect(f.client.webhookExecutionClaim.updateMany).toHaveBeenCalledTimes(1);
      expect(f.client.webhookExecutionClaim.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: f.claim.id,
          kind: 'EXECUTION',
          semanticKey: f.claim.semanticKey,
          webhookEventId: f.event.id,
          executionBotId: 'original-bot',
          enforced: true,
          status: 'READY',
          preparedAt: f.claim.preparedAt,
          completedAt: null,
          businessStartedAt: f.claim.businessStartedAt,
          leaseToken: f.claim.leaseToken,
          leaseExpiresAt: f.claim.leaseExpiresAt,
          commandResult: { equals: f.journal },
        }),
        data: {
          status: 'COMPLETED',
          completedAt: f.finishedAt,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      expect(f.client.webhookEvent.updateMany).toHaveBeenCalledTimes(1);
      expect(f.client.webhookEvent.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: f.event.id,
          status: f.event.status,
          semanticKey: f.event.semanticKey,
          executionDeadlineAt: f.event.executionDeadlineAt,
          rawPayload: { equals: f.event.rawPayload },
          normalizedPayload: { equals: f.event.normalizedPayload },
          errorMessage: f.event.errorMessage,
          timeoutQuarantineExpiresAt: f.event.timeoutQuarantineExpiresAt,
          nextEnqueueAt: f.event.nextEnqueueAt,
          queueName: f.event.queueName,
          enqueueAttempts: f.event.enqueueAttempts,
          queuedAt: f.event.queuedAt,
          processedAt: f.event.processedAt,
        }),
        data: {
          status: WebhookStatus.PROCESSED,
          processedAt: f.finishedAt,
          errorMessage: null,
          queueName: null,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
        },
      });
    },
  );

  const invalidProofs: Array<[string, (f: FinishedExecutionFixture) => void]> = [
    ['processed receipt', (f) => (f.event.status = WebhookStatus.PROCESSED)],
    ['duplicate receipt', (f) => (f.event.status = WebhookStatus.DUPLICATE)],
    ['existing receipt completion date', (f) => (f.event.processedAt = f.finishedAt)],
    ['wrong stored receipt semantic key', (f) => (f.event.semanticKey = 'another-semantic-key')],
    ['missing stored receipt semantic key', (f) => (f.event.semanticKey = null)],
    ['missing claim identity', (f) => (f.claim.id = '')],
    ['non-execution claim', (f) => (f.claim.kind = 'COMMAND')],
    ['unfinished claim', (f) => (f.claim.status = 'PENDING')],
    ['already completed claim', (f) => (f.claim.status = 'COMPLETED')],
    ['unenforced claim', (f) => (f.claim.enforced = false)],
    ['missing owner', (f) => (f.claim.webhookEventId = null)],
    ['wrong owner', (f) => (f.claim.webhookEventId = 'another-owner')],
    ['wrong claim semantic key', (f) => (f.claim.semanticKey = 'another-semantic-key')],
    ['missing preparation', (f) => (f.claim.preparedAt = null)],
    ['invalid preparation', (f) => (f.claim.preparedAt = new Date(Number.NaN))],
    ['existing completion date', (f) => (f.claim.completedAt = f.finishedAt)],
    ['missing business start', (f) => (f.claim.businessStartedAt = null)],
    ['invalid business start', (f) => (f.claim.businessStartedAt = new Date(Number.NaN))],
    ['lease deadline without token', (f) => (f.claim.leaseToken = null)],
    ['lease token without deadline', (f) => (f.claim.leaseExpiresAt = null)],
    ['invalid lease deadline', (f) => (f.claim.leaseExpiresAt = new Date(Number.NaN))],
    ['missing journal', (f) => (f.claim.commandResult = null)],
    ['non-object journal', (f) => (f.claim.commandResult = 'EXECUTION_FINISHED')],
    ['unfinished journal', (f) => (f.journal.kind = 'EXECUTION_WAITING')],
    ['unsupported authority', (f) => (f.journal.authorityVersion = 'older-authority')],
    ['wrong journal owner', (f) => (f.journal.webhookEventId = 'another-owner')],
    ['wrong journal semantic key', (f) => (f.journal.semanticKey = 'another-semantic-key')],
    ['wrong original executor', (f) => (f.journal.executionBotId = 'replacement-bot')],
    ['missing journal executor', (f) => delete f.journal.executionBotId],
    [
      'omitted original attribution',
      (f) => {
        delete (f.claim as { executionBotId?: string | null }).executionBotId;
        delete f.journal.executionBotId;
      },
    ],
    [
      'blank original attribution',
      (f) => {
        f.claim.executionBotId = ' ';
        f.journal.executionBotId = ' ';
      },
    ],
    ['wrong business start', (f) => (f.journal.businessStartedAt = f.finishedAt.toISOString())],
    ['missing finish date', (f) => delete f.journal.finishedAt],
    ['invalid finish date', (f) => (f.journal.finishedAt = 'invalid-date')],
    ['non-string finish date', (f) => (f.journal.finishedAt = f.finishedAt.getTime())],
    ['finish before business', (f) => (f.journal.finishedAt = f.claim.preparedAt!.toISOString())],
    [
      'changed owner payload identity',
      (f) => {
        f.event.normalizedPayload = {
          ...f.event.normalizedPayload,
          message: { ...f.event.normalizedPayload.message!, messageId: 'another-message' },
        };
      },
    ],
  ];

  it.each(invalidProofs)(
    'retains an execution with %s without SQL completion',
    async (_, change) => {
      const f = finishedExecutionFixture();
      change(f);
      await expect(
        WebhookCanonicalExecutionService.tryRecoverFinishedExecutionWithClient(
          f.client as never,
          f.event as never,
          f.claim,
        ),
      ).resolves.toBe(false);
      expect(f.client.webhookExecutionClaim.updateMany).not.toHaveBeenCalled();
      expect(f.client.webhookEvent.updateMany).not.toHaveBeenCalled();
    },
  );

  it('preserves explicitly nullable original attribution during SQL-only settlement', async () => {
    const f = finishedExecutionFixture();
    f.claim.executionBotId = null;
    f.journal.executionBotId = null;

    await expect(
      WebhookCanonicalExecutionService.tryRecoverFinishedExecutionWithClient(
        f.client as never,
        f.event as never,
        f.claim,
      ),
    ).resolves.toBe(true);

    expect(f.client.webhookExecutionClaim.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        executionBotId: null,
        commandResult: { equals: f.journal },
      }),
      data: {
        status: 'COMPLETED',
        completedAt: f.finishedAt,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    expect(f.client.webhookEvent.updateMany).toHaveBeenCalledTimes(1);
  });

  const claimCasFields = [
    'executionBotId',
    'preparedAt',
    'completedAt',
    'leaseToken',
    'leaseExpiresAt',
    'businessStartedAt',
  ] as const;

  it.each(claimCasFields)(
    'refuses a changed persisted %s before receipt settlement',
    async (field) => {
      const f = finishedExecutionFixture();
      f.client.webhookExecutionClaim.updateMany.mockImplementationOnce(async ({ where }) => {
        expect(where).toHaveProperty(field, f.claim[field]);
        // The database rejected the exact saved snapshot after a concurrent writer changed it.
        return { count: 0 };
      });
      await expect(
        WebhookCanonicalExecutionService.tryRecoverFinishedExecutionWithClient(
          f.client as never,
          f.event as never,
          f.claim,
        ),
      ).resolves.toBe(false);
      expect(f.client.webhookEvent.updateMany).not.toHaveBeenCalled();
    },
  );

  it('throws on a changed receipt so its enclosing transaction rolls back completion', async () => {
    const f = finishedExecutionFixture();
    f.client.webhookEvent.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      WebhookCanonicalExecutionService.tryRecoverFinishedExecutionWithClient(
        f.client as never,
        f.event as never,
        f.claim,
      ),
    ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
    expect(f.client.webhookExecutionClaim.updateMany).toHaveBeenCalledTimes(1);
    expect(f.client.webhookEvent.updateMany).toHaveBeenCalledTimes(1);
  });
});
