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
  it('cannot cancel the active generation using an old worker snapshot', async () => {
    const { store, prisma } = setup();
    expect(
      await store.finish(
        { chatId: '-1', messageId: 'm', activationId: 'new' } as never,
        'cancelled',
      ),
    ).toBe(false);
    expect(prisma.messageRetentionCandidate.updateMany).not.toHaveBeenCalled();
  });
  it('settles once and locks quota before policy before candidate', async () => {
    const { store, prisma } = setup();
    const message = { chatId: '-1', messageId: 'm', activationId: 'old' };
    expect(await store.finish(message as never, 'deleted')).toBe(true);
    expect(prisma.$queryRaw.mock.calls[0][0].join('')).toContain('message_retention_quotas');
    expect(prisma.$queryRaw.mock.calls[1][0].join('')).toContain('message_retention_policies');
    expect(prisma.messageRetentionCandidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ activationId: 'old' }) }),
    );
    prisma.messageRetentionCandidate.updateMany.mockResolvedValue({ count: 0 });
    expect(await store.finish(message as never, 'deleted')).toBe(false);
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
  it('filters the cohort before scheduling and refuses wildcard expansion', () => {
    expect(setup().store.schedulingFilter()).toEqual({ chatId: { in: ['-1', '-2'] } });
  });
  it('does no resume work for a chat that is not capacity-paused', async () => {
    const { store, prisma } = setup();
    await store.resumeAdmission('-1');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  it('resumes a stable low-watermark policy with a new capture baseline', async () => {
    const { store, prisma, policy } = setup();
    policy.pausedAt = new Date(Date.now() - 700_000);
    policy.healthySince = new Date(Date.now() - 601_000);
    await store.resumeAdmission('-1');
    expect(prisma.messageRetentionPolicy.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pausedAt: null, captureAfter: expect.any(Date) }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
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
  it('does not overwrite a persisted terminal blocker during an empty successful visit', async () => {
    const { store, prisma } = setup();
    prisma.$queryRaw.mockResolvedValue([{ enabled: true, hours: 48, hasTerminalReview: true }]);
    await store.updateRunStatus('-1', 1, 'running');
    expect(prisma.messageRetentionPolicy.updateMany).toHaveBeenCalledWith({
      where: { chatId: '-1', revision: 1 },
      data: { lastStatus: 'error' },
    });
  });
  it('makes overdue backlog immediately ready instead of adding a 30-second cooldown', async () => {
    const { store, prisma } = setup();
    const now = Date.now();
    prisma.messageRetentionCandidate.findFirst.mockResolvedValueOnce({
      sourceAt: new Date(now - 49 * 3_600_000),
    });
    await store.scheduleNext('-1');
    const next = prisma.messageRetentionPolicy.update.mock.calls[0][0].data.nextRunAt as Date;
    expect(next.getTime()).toBeLessThan(now + 1_000);
  });
  it('selects shadow rows separately from an older executable backlog', async () => {
    const { store, prisma } = setup();
    jest.spyOn(store, 'mode', 'get').mockReturnValue('shadow');
    await store.dueCandidates({
      chatId: '-1',
      hours: 24,
      enabled: true,
      activationId: 'a',
    } as never);
    expect(prisma.messageRetentionCandidate.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ shadowOnly: true }) }),
    );
  });
  it('reopens an exact reviewed candidate once with credit and audit in the same transaction', async () => {
    const { store, prisma, intent } = setup();
    const input = {
      chatId: '-1',
      messageId: 'm',
      intentId: 'i',
      activationId: 'new',
      expectedRevision: 1,
      expectedIntentUpdatedAt: intent.updatedAt,
      expectedAttemptCount: 1,
      actorUserId: 'operator',
    };
    expect(await store.reopenTerminalCandidate(input)).toBe(true);
    expect(prisma.messageRetentionQuota.update).toHaveBeenCalledWith({
      where: { shard: 0 },
      data: { pendingCount: { increment: 1 } },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorUserId: 'operator',
          action: 'SAFETY_DESK_RETRY_MESSAGE_RETENTION',
        }),
      }),
    );
    expect(await store.reopenTerminalCandidate(input)).toBe(false);
    expect(prisma.messageRetentionQuota.update).toHaveBeenCalledTimes(1);
  });
  it.each(['old_activation', 'capacity', 'dispatch_evidence'])(
    'refuses unsafe operator reopen for %s',
    async (reason) => {
      const { store, prisma, intent, policy, candidate } = setup();
      if (reason === 'old_activation') candidate.activationId = 'old';
      if (reason === 'capacity') policy.pendingCount = 40_000;
      if (reason === 'dispatch_evidence') intent.deleteDispatchStartedAt = new Date();
      expect(
        await store.reopenTerminalCandidate({
          chatId: '-1',
          messageId: 'm',
          intentId: 'i',
          activationId: 'new',
          expectedRevision: 1,
          expectedIntentUpdatedAt: intent.updatedAt,
          expectedAttemptCount: 1,
          actorUserId: 'operator',
        }),
      ).toBe(false);
      expect(prisma.messageRetentionQuota.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    },
  );
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
