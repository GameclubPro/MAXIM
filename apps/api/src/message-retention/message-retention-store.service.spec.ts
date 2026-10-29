import { ConfigService } from '@nestjs/config';
import { MessageRetentionStore } from './message-retention-store.service';

function setup() {
  const policy = {
    chatId: '-1',
    enabled: true,
    activationId: 'new',
    hours: 48,
    revision: 1,
    quotaShard: 0,
    pausedAt: null as Date | null,
    healthySince: null as Date | null,
    pendingCount: 0,
  };
  const quota = { shard: 0, pendingCount: 0, pausedAt: null, healthySince: null };
  const candidate = {
    chatId: '-1',
    messageId: 'm',
    authorId: 'u',
    intentId: 'i',
    status: 'skipped',
    activationId: 'new',
    shadowOnly: false,
    outcomeCode: 'terminal_review',
    reconcileAfter: null as Date | null,
  };
  const intent = {
    id: 'i',
    chatId: '-1',
    messageId: 'm',
    subjectUserId: 'u',
    retentionOwned: true,
    status: 'FAILED_TERMINAL',
    leaseExpiresAt: null as Date | null,
    attemptCount: 1,
    updatedAt: new Date(),
    reasons: [{ ruleCode: 'MESSAGE_RETENTION_DELETE' }],
    deleteDispatchStartedAt: null as Date | null,
    deleteDispatchStartedBotId: null as string | null,
    remoteDeleteSucceededAt: null as Date | null,
    remoteDeleteSucceededBotId: null as string | null,
  };
  const prisma = {
    messageRetentionPolicy: {
      findUnique: jest.fn().mockResolvedValue(policy),
      findUniqueOrThrow: jest.fn().mockResolvedValue(policy),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    messageRetentionCandidate: {
      findUnique: jest.fn().mockResolvedValue(candidate),
      update: jest
        .fn()
        .mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
          Object.assign(candidate, data),
        ),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    messageRetentionQuota: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(quota),
      update: jest.fn(),
    },
    moderationDeleteIntent: {
      findUnique: jest.fn().mockResolvedValue(intent),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((work: (tx: unknown) => Promise<unknown>) => work(prisma));
  const config = new ConfigService({
    MESSAGE_RETENTION_MODE: 'canary',
    MESSAGE_RETENTION_CANARY_CHAT_IDS: '-1,-2,-1,*',
  });
  return {
    prisma,
    policy,
    quota,
    candidate,
    intent,
    store: new MessageRetentionStore(prisma as never, config),
  };
}

describe('retention state ownership', () => {
  it('does not cancel an active current generation from stale reconciliation', async () => {
    const { store, prisma, candidate } = setup();
    candidate.status = 'pending';
    candidate.reconcileAfter = new Date();
    await store.settleReconciliation(candidate as never, 'cancelled');
    expect(prisma.messageRetentionCandidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reconcileAfter: expect.any(Date) } }),
    );
    expect(prisma.messageRetentionPolicy.update).not.toHaveBeenCalled();
    expect(prisma.messageRetentionQuota.update).not.toHaveBeenCalled();
  });
  it('settles an exact authenticated receipt once and locks intent before quota before policy before candidate', async () => {
    const { store, prisma, candidate } = setup();
    candidate.status = 'pending';
    const message = { chatId: '-1', messageId: 'm' };
    expect(await store.settleRemovedMessage(prisma as never, message)).toBe(true);
    expect(prisma.$queryRaw.mock.calls.map((call) => call[0].join(''))).toEqual([
      expect.stringContaining('moderation_delete_intents'),
      expect.stringContaining('message_retention_quotas'),
      expect.stringContaining('message_retention_policies'),
      expect.stringContaining('message_retention_candidates'),
    ]);
    expect(await store.settleRemovedMessage(prisma as never, message)).toBe(false);
    expect(prisma.messageRetentionQuota.update).toHaveBeenCalledTimes(1);
  });
  it('batch cancellation excludes the current generation and releases only changed rows', async () => {
    const { store, prisma } = setup();
    prisma.messageRetentionCandidate.updateMany.mockResolvedValue({ count: 3 });
    await store.cancelInactive([{ chatId: '-1', messageId: 'm', activationId: 'old' }] as never);
    expect(prisma.messageRetentionCandidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ activationId: { not: 'new' } }) }),
    );
    expect(prisma.messageRetentionQuota.update).toHaveBeenCalledWith({
      where: { shard: 0 },
      data: { pendingCount: { decrement: 3 } },
    });
    await expect(
      store.cancelInactive([{ chatId: '-1' }, { chatId: '-2' }] as never),
    ).rejects.toThrow('single-chat');
  });
  it.each(['off', 'shadow', 'canary', 'on'])(
    'never admits legacy execution with mode %s, regardless of Lastik availability',
    (mode) => {
      const { prisma } = setup();
      for (const eraserEnabled of [false, true]) {
        const store = new MessageRetentionStore(
          prisma as never,
          new ConfigService({
            MESSAGE_RETENTION_MODE: mode,
            MESSAGE_RETENTION_CANARY_CHAT_IDS: '-1',
            ERASER_ENABLED: eraserEnabled,
          }),
        );
        expect(store.allows('-1')).toBe(false);
        expect(store.allows('-1', true)).toBe(false);
        expect(store.workSchedulingFilter()).toEqual({
          OR: [
            { enabled: false, pendingCount: { gt: 0 } },
            { enabled: true, candidates: { some: { status: { in: ['pending', 'retry'] } } } },
            {
              candidates: {
                some: { outcomeCode: 'reconciliation', reconcileAfter: { lte: expect.any(Date) } },
              },
            },
          ],
        });
      }
      expect(prisma.messageRetentionCandidate.updateMany).not.toHaveBeenCalled();
      expect(prisma.messageRetentionQuota.update).not.toHaveBeenCalled();
    },
  );
  it('reports an enabled legacy policy as paused and a disabled policy as off', async () => {
    const { store, policy } = setup();
    expect(await store.summary('-1')).toMatchObject({ enabled: true, status: 'paused' });
    policy.enabled = false;
    expect(await store.summary('-1')).toMatchObject({ enabled: false, status: 'off' });
  });
  it('keeps old-generation receipts scheduled after releasing active credit', async () => {
    const { store, prisma } = setup();
    await store.cancelInactive([
      { chatId: '-1', messageId: 'm', activationId: 'old', intentId: 'i' },
    ] as never);
    expect(prisma.messageRetentionCandidate.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'cancelled', intentId: { not: null } }),
        data: expect.objectContaining({
          outcomeCode: 'reconciliation',
          reconcileAfter: expect.any(Date),
        }),
      }),
    );
    expect(prisma.messageRetentionQuota.update).toHaveBeenCalledTimes(1);
  });
  it('reconciles a cancelled success once without releasing its quota twice', async () => {
    const { store, prisma, candidate } = setup();
    candidate.reconcileAfter = new Date();
    await store.settleReconciliation(
      { chatId: '-1', messageId: 'm', intentId: 'i', status: 'cancelled' } as never,
      'deleted',
    );
    expect(prisma.messageRetentionPolicy.update).toHaveBeenCalledWith({
      where: { chatId: '-1' },
      data: { deletedCount: { increment: 1 }, skippedCount: { decrement: 1 } },
    });
    expect(prisma.messageRetentionQuota.update).not.toHaveBeenCalled();
    prisma.messageRetentionCandidate.updateMany.mockResolvedValue({ count: 0 });
    await store.settleReconciliation(
      { chatId: '-1', messageId: 'm', intentId: 'i', status: 'cancelled' } as never,
      'deleted',
    );
    expect(prisma.messageRetentionPolicy.update).toHaveBeenCalledTimes(1);
  });
  it.each(['pending', 'skipped'])(
    'preserves %s credit and reconciliation when a marker-free execution has a live lease',
    async (status) => {
      const { store, prisma, candidate, intent } = setup();
      candidate.status = status;
      candidate.reconcileAfter = new Date();
      intent.status = 'IN_PROGRESS';
      intent.leaseExpiresAt = new Date(Date.now() + 60_000);
      await store.settleReconciliation(candidate as never, 'cancelled');
      expect(prisma.messageRetentionCandidate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { reconcileAfter: expect.any(Date) } }),
      );
      expect(prisma.messageRetentionPolicy.update).not.toHaveBeenCalled();
      expect(prisma.messageRetentionQuota.update).not.toHaveBeenCalled();
      expect(prisma.$queryRaw.mock.calls.map((call) => call[0].join(''))).toEqual([
        expect.stringContaining('moderation_delete_intents'),
        expect.stringContaining('message_retention_quotas'),
        expect.stringContaining('message_retention_policies'),
        expect.stringContaining('message_retention_candidates'),
      ]);
    },
  );
  it.each([
    'deleteDispatchStartedAt',
    'deleteDispatchStartedBotId',
    'remoteDeleteSucceededAt',
    'remoteDeleteSucceededBotId',
  ] as const)('preserves freshly locked %s evidence during stale cancellation', async (field) => {
    const { store, prisma, candidate, intent } = setup();
    candidate.reconcileAfter = new Date();
    Object.assign(intent, { [field]: field.endsWith('At') ? new Date() : 'bot' });
    await store.settleReconciliation(candidate as never, 'cancelled');
    expect(prisma.messageRetentionCandidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reconcileAfter: expect.any(Date) } }),
    );
    expect(prisma.messageRetentionPolicy.update).not.toHaveBeenCalled();
    expect(prisma.messageRetentionQuota.update).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'terminal_review'] as const)(
    'uses a fresh success to override stale %s settlement',
    async (outcome) => {
      const { store, prisma, candidate, intent } = setup();
      candidate.reconcileAfter = new Date();
      intent.status = 'SUCCEEDED';
      await store.settleReconciliation(candidate as never, outcome);
      expect(prisma.messageRetentionCandidate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'deleted', outcomeCode: 'deleted' }),
        }),
      );
      expect(prisma.messageRetentionPolicy.update).toHaveBeenCalledWith({
        where: { chatId: '-1' },
        data: { deletedCount: { increment: 1 }, skippedCount: { decrement: 1 } },
      });
      expect(prisma.messageRetentionQuota.update).not.toHaveBeenCalled();
    },
  );
  it('uses fresh active status to account a success from an ended snapshot', async () => {
    const { store, prisma, candidate, intent } = setup();
    candidate.status = 'pending';
    candidate.reconcileAfter = new Date();
    intent.status = 'ALREADY_ABSENT';
    await store.settleReconciliation({ ...candidate, status: 'cancelled' } as never, 'cancelled');
    expect(prisma.messageRetentionPolicy.update).toHaveBeenCalledWith({
      where: { chatId: '-1' },
      data: { pendingCount: { decrement: 1 }, deletedCount: { increment: 1 } },
    });
    expect(prisma.messageRetentionQuota.update).toHaveBeenCalledWith({
      where: { shard: 0 },
      data: { pendingCount: { decrement: 1 } },
    });
  });
  it('reads a persisted terminal blocker without rewriting its policy', async () => {
    const { store, prisma } = setup();
    prisma.$queryRaw.mockResolvedValue([{ enabled: true, hours: 48, hasTerminalReview: true }]);
    expect(await store.summary('-1')).toMatchObject({ status: 'error' });
    expect(prisma.messageRetentionPolicy.updateMany).not.toHaveBeenCalled();
    expect(prisma.messageRetentionPolicy.update).not.toHaveBeenCalled();
  });
  it('does not reschedule enabled legacy history after a maintenance visit', async () => {
    const { store, prisma } = setup();
    await store.scheduleNext('-1');
    expect(prisma.messageRetentionPolicy.update).toHaveBeenCalledWith({
      where: { chatId: '-1' },
      data: { nextRunAt: null },
    });
    expect(prisma.messageRetentionCandidate.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.messageRetentionCandidate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { chatId: '-1', reconcileAfter: { not: null } } }),
    );
  });
  it('keeps future receipt settlement scheduled while legacy execution is retired', async () => {
    const { store, prisma } = setup();
    const reconcileAfter = new Date(Date.now() + 60_000);
    prisma.messageRetentionCandidate.findFirst.mockResolvedValue({ reconcileAfter });
    await store.scheduleNext('-1');
    expect(prisma.messageRetentionPolicy.update).toHaveBeenCalledWith({
      where: { chatId: '-1' },
      data: { nextRunAt: reconcileAfter },
    });
  });
  it('never selects the current activation for age-based processing', async () => {
    const { store, prisma, policy } = setup();
    expect(await store.dueInactiveCandidates(policy as never)).toEqual([]);
    expect(prisma.messageRetentionCandidate.findMany).toHaveBeenCalledTimes(4);
    for (const call of prisma.messageRetentionCandidate.findMany.mock.calls) {
      expect(call[0]).toMatchObject({ take: 100, where: { chatId: '-1' } });
      expect(call[0].where.activationId).toEqual(
        expect.objectContaining('lt' in call[0].where.activationId ? { lt: 'new' } : { gt: 'new' }),
      );
    }
  });
  it('selects a bounded batch of disabled candidates for SQL cancellation only', async () => {
    const { store, prisma, policy } = setup();
    policy.enabled = false;
    await store.dueInactiveCandidates(policy as never);
    expect(prisma.messageRetentionCandidate.findMany).toHaveBeenCalledWith({
      where: { chatId: '-1', status: { in: ['pending', 'retry'] } },
      orderBy: [{ messageId: 'asc' }],
      take: 100,
    });
  });
  it('settles an authenticated removal once and protects independently owned intents', async () => {
    const { store, prisma, candidate } = setup();
    candidate.status = 'pending';
    expect(
      await store.settleRemovedMessage(prisma as never, { chatId: '-1', messageId: 'm' }),
    ).toBe(true);
    expect(prisma.messageRetentionQuota.update).toHaveBeenCalledWith({
      where: { shard: 0 },
      data: { pendingCount: { decrement: 1 } },
    });
    expect(prisma.moderationDeleteIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ retentionOwned: true }),
        data: expect.objectContaining({ status: 'ALREADY_ABSENT' }),
      }),
    );
    expect(
      await store.settleRemovedMessage(prisma as never, { chatId: '-1', messageId: 'm' }),
    ).toBe(false);
    expect(prisma.messageRetentionQuota.update).toHaveBeenCalledTimes(1);
  });
  it('corrects a cancelled removal receipt without releasing already released credit', async () => {
    const { store, prisma, candidate } = setup();
    candidate.status = 'cancelled';
    await store.settleRemovedMessage(prisma as never, { chatId: '-1', messageId: 'm' });
    expect(prisma.messageRetentionQuota.update).not.toHaveBeenCalled();
    expect(prisma.messageRetentionPolicy.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { skippedCount: { decrement: 1 }, deletedCount: { increment: 1 } },
      }),
    );
  });
});
