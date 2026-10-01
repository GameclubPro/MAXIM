import { MessageRetentionRuntime } from './message-retention-runtime.service';
import { MessageRetentionGuardError } from './message-retention-delete-guard.service';

function setup() {
  const policy = {
    chatId: '-1',
    enabled: true,
    hours: 24,
    revision: 2,
    activationId: 'a',
    pendingCount: 1,
    nextRunAt: new Date(0),
  };
  const candidate = {
    chatId: '-1',
    messageId: 'm',
    activationId: 'a',
    sourceAt: new Date(Date.now() - 25 * 3_600_000),
    shadowOnly: false,
    intentId: 'i' as string | null,
    status: 'pending',
    reconcileAfter: null,
    outcomeCode: null,
  };
  const intent = {
    retentionOwned: true,
    status: 'PENDING',
    nextAttemptAt: new Date(),
    lastErrorCode: null as string | null,
    deleteDispatchStartedAt: null as Date | null,
    deleteDispatchStartedBotId: null as string | null,
    remoteDeleteSucceededAt: null as Date | null,
    remoteDeleteSucceededBotId: null as string | null,
  };
  const prisma = {
    messageRetentionPolicy: {
      findUnique: jest.fn().mockResolvedValue(policy),
      findMany: jest.fn().mockResolvedValue([policy]),
      updateMany: jest.fn(),
    },
    messageRetentionCandidate: { updateMany: jest.fn() },
    moderationDeleteIntent: { findUnique: jest.fn().mockResolvedValue(intent) },
  };
  const store = {
    mode: 'on',
    allows: jest.fn().mockReturnValue(true),
    workSchedulingFilter: () => ({ chatId: { in: ['-1'] } }),
    dueReconciliations: jest.fn().mockResolvedValue([]),
    deferReconciliation: jest.fn(),
    settleReconciliation: jest.fn(),
    discoverLegacyReceipts: jest.fn(),
    updateRunStatus: jest.fn(),
    resumeAdmission: jest.fn(),
    dueCandidates: jest.fn().mockResolvedValue([candidate]),
    cancelInactive: jest.fn(),
    finish: jest.fn(),
    scheduleNext: jest.fn(),
    purge: jest.fn(),
  };
  const deletes = {
    ensureRetentionIntent: jest.fn().mockResolvedValue('i'),
    attemptRetentionIntent: jest.fn().mockResolvedValue({
      retentionOwned: true,
      status: 'SUCCEEDED',
      nextAttemptAt: new Date(),
      lastErrorCode: null,
    }),
    reconcileRetentionIntent: jest.fn().mockResolvedValue({ status: 'ALREADY_ABSENT' }),
  };
  const governor = { decide: jest.fn().mockResolvedValue({ action: 'run', retryAfterMs: 60_000 }) };
  const locks = {
    acquireLock: jest.fn().mockResolvedValue('lease'),
    renewLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn(),
    setStringWithTtl: jest.fn(),
  };
  const queue = {
    setGlobalConcurrency: jest.fn(),
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0 }),
    getJobs: jest.fn().mockResolvedValue([]),
    add: jest.fn(),
  };
  const runtime = new MessageRetentionRuntime(
    prisma as never,
    store as never,
    deletes as never,
    governor as never,
    locks as never,
    queue as never,
  );
  return { runtime, prisma, store, deletes, governor, locks, queue, policy, candidate, intent };
}
describe('retention runtime isolation', () => {
  it('presents expected verification deferrals as delayed work, not a broken module', async () => {
    const { runtime, deletes, store } = setup();
    deletes.attemptRetentionIntent.mockResolvedValue({
      retentionOwned: true,
      status: 'RETRYABLE',
      nextAttemptAt: new Date(),
      lastErrorCode: 'message_retention_guard_rejected',
    });
    await runtime.process('-1');
    expect(store.updateRunStatus).toHaveBeenLastCalledWith('-1', 2, 'delayed');
  });
  afterEach(() => jest.useRealTimers());
  it('resets an obsolete error status after a successful run with revision fencing', async () => {
    const { runtime, store } = setup();
    await runtime.process('-1');
    expect(store.finish).toHaveBeenCalledWith(expect.any(Object), 'deleted');
    expect(store.updateRunStatus).toHaveBeenLastCalledWith('-1', 2, 'running');
  });
  it('never executes an ordinary moderation intent', async () => {
    const { runtime, intent, deletes } = setup();
    intent.retentionOwned = false;
    await runtime.process('-1');
    expect(deletes.attemptRetentionIntent).not.toHaveBeenCalled();
  });
  it('returns age-deferred candidates to indexed pending selection when the period increases', async () => {
    const { runtime, policy, prisma, deletes } = setup();
    policy.hours = 48;
    await runtime.process('-1');
    expect(deletes.attemptRetentionIntent).not.toHaveBeenCalled();
    expect(prisma.messageRetentionCandidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'pending', outcomeCode: null } }),
    );
  });
  it('uses stable bounded queue slots and native chat deduplication', async () => {
    const { runtime, queue, prisma } = setup();
    queue.getJobs.mockResolvedValue([{ id: 'retention-slot-0' }]);
    await runtime.tick();
    expect(queue.add).toHaveBeenCalledWith(
      'chat',
      { chatId: '-1' },
      expect.objectContaining({
        jobId: 'retention-slot-1',
        deduplication: { id: expect.any(String) },
      }),
    );
    expect(prisma.messageRetentionPolicy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [{ chatId: { in: ['-1'] } }, { chatId: { notIn: [] } }],
          nextRunAt: expect.any(Object),
        },
      }),
    );
  });
  it('drains legacy jobs before starting bounded-slot admission', async () => {
    const { runtime, queue } = setup();
    queue.getJobs.mockResolvedValue([{ id: 'legacy-chat-hash' }]);
    await runtime.tick();
    expect(queue.add).not.toHaveBeenCalled();
  });
  it('keeps bounded database maintenance running with MAX dispatch off', async () => {
    jest.useFakeTimers();
    const { runtime, store, governor, queue } = setup();
    store.mode = 'off';
    await runtime.onModuleInit();
    expect(queue.setGlobalConcurrency).toHaveBeenCalledWith(1);
    expect(store.purge).not.toHaveBeenCalled();
    jest.setSystemTime(Date.now() + 3_600_000);
    await runtime.tick();
    expect(store.purge).toHaveBeenCalledTimes(1);
    expect(governor.decide).not.toHaveBeenCalled();
    await runtime.onModuleDestroy();
  });
  it('drains an in-flight scheduler and does not add work after shutdown begins', async () => {
    const { runtime, locks, queue } = setup();
    let resolve!: (token: string) => void;
    locks.acquireLock.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done;
      }),
    );
    const work = runtime.tick();
    let stopped = false;
    const stop = runtime.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolve('lease');
    await work;
    await stop;
    expect(queue.add).not.toHaveBeenCalled();
  });
  it.each(['FAILED_TERMINAL', 'EXPIRED', 'OBSERVED'])(
    'releases a candidate for %s instead of retrying a terminal intent',
    async (status) => {
      const { runtime, deletes, store, prisma, intent } = setup();
      intent.status = status;
      intent.lastErrorCode = 'max_bad_request';
      deletes.attemptRetentionIntent.mockResolvedValue({
        retentionOwned: true,
        status,
        nextAttemptAt: new Date(),
        lastErrorCode: 'max_bad_request',
      });
      await runtime.process('-1');
      expect(store.finish).toHaveBeenCalledWith(expect.any(Object), 'skipped', {
        outcomeCode: 'terminal_review',
      });
      expect(prisma.messageRetentionCandidate.updateMany).not.toHaveBeenCalled();
    },
  );
  it('uses final guard rejection as a protected skip', async () => {
    const { runtime, deletes, store, intent } = setup();
    intent.status = 'FAILED_TERMINAL';
    intent.lastErrorCode = 'message_retention_guard_rejected';
    deletes.attemptRetentionIntent.mockResolvedValue({
      retentionOwned: true,
      status: 'FAILED_TERMINAL',
      nextAttemptAt: new Date(),
      lastErrorCode: 'message_retention_guard_rejected',
    });
    await runtime.process('-1');
    expect(store.finish).toHaveBeenCalledWith(expect.any(Object), 'skipped', {
      outcomeCode: 'protected',
    });
  });
  it('settles cancellation that wins while the producer creates an intent without a worker error', async () => {
    const { runtime, deletes, candidate, policy, store, prisma } = setup();
    candidate.intentId = null;
    deletes.ensureRetentionIntent.mockImplementationOnce(async () => {
      policy.enabled = false;
      throw new MessageRetentionGuardError(
        'skip',
        'Retention activation ended',
        'activation_ended',
      );
    });
    await runtime.process('-1');
    expect(store.finish).toHaveBeenCalledWith(candidate, 'cancelled', { outcomeCode: 'cancelled' });
    expect(prisma.messageRetentionCandidate.updateMany).not.toHaveBeenCalled();
    expect(deletes.attemptRetentionIntent).not.toHaveBeenCalled();
    expect(store.updateRunStatus).toHaveBeenLastCalledWith('-1', 2, 'running');
  });
  it('defers a producer verification guard without classifying it as a worker failure', async () => {
    const { runtime, deletes, candidate, store, prisma } = setup();
    candidate.intentId = null;
    deletes.ensureRetentionIntent.mockRejectedValueOnce(
      new MessageRetentionGuardError('retry', 'Retention policy changed', 'policy_changed'),
    );
    await runtime.process('-1');
    expect(prisma.messageRetentionCandidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'retry', outcomeCode: 'deferred' }),
      }),
    );
    expect(store.updateRunStatus).toHaveBeenLastCalledWith('-1', 2, 'delayed');
  });
  it('finalizes a cancelled receipt with dispatch off using only DB reconciliation', async () => {
    const { runtime, store, governor, deletes, candidate } = setup();
    store.mode = 'off';
    store.allows.mockReturnValue(false);
    store.dueReconciliations.mockResolvedValue([
      { ...candidate, status: 'cancelled', reconcileAfter: new Date() },
    ]);
    await runtime.process('-1');
    expect(deletes.reconcileRetentionIntent).toHaveBeenCalledWith('i', {
      allowRead: false,
      canRead: expect.any(Function),
    });
    expect(store.settleReconciliation).toHaveBeenCalledWith(expect.any(Object), 'deleted');
    expect(deletes.attemptRetentionIntent).not.toHaveBeenCalled();
    expect(governor.decide).not.toHaveBeenCalled();
  });
  it('keeps unknown receipts visible and scheduled when off prohibits reads', async () => {
    const { runtime, store, deletes, candidate, intent } = setup();
    store.mode = 'off';
    store.allows.mockReturnValue(false);
    intent.deleteDispatchStartedAt = new Date();
    store.dueReconciliations.mockResolvedValue([
      { ...candidate, status: 'cancelled', reconcileAfter: new Date() },
    ]);
    deletes.reconcileRetentionIntent.mockResolvedValue({ status: 'AMBIGUOUS' });
    await runtime.process('-1');
    expect(store.deferReconciliation).toHaveBeenCalledWith(expect.any(Object));
    expect(store.settleReconciliation).not.toHaveBeenCalled();
  });
  it('settles an ended pre-dispatch ambiguous failure DB-only when all mutation markers are absent', async () => {
    const { runtime, store, deletes, candidate, intent, governor } = setup();
    store.mode = 'off';
    store.allows.mockReturnValue(false);
    intent.status = 'AMBIGUOUS';
    intent.lastErrorCode = 'delete_intent_execution_failed';
    store.dueReconciliations.mockResolvedValue([
      { ...candidate, status: 'cancelled', reconcileAfter: new Date() },
    ]);
    deletes.reconcileRetentionIntent.mockResolvedValue(null);
    await runtime.process('-1');
    expect(store.settleReconciliation).toHaveBeenCalledWith(expect.any(Object), 'cancelled');
    expect(store.deferReconciliation).not.toHaveBeenCalled();
    expect(deletes.attemptRetentionIntent).not.toHaveBeenCalled();
    expect(governor.decide).not.toHaveBeenCalled();
  });
  it('preserves a dispatch marker that appears after the marker-free recovery snapshot', async () => {
    const { runtime, store, deletes, candidate, intent, prisma } = setup();
    store.dueReconciliations.mockResolvedValue([
      { ...candidate, status: 'cancelled', reconcileAfter: new Date() },
    ]);
    store.dueCandidates.mockResolvedValue([]);
    prisma.moderationDeleteIntent.findUnique
      .mockResolvedValueOnce({ ...intent, status: 'AMBIGUOUS' })
      .mockResolvedValueOnce({
        ...intent,
        status: 'AMBIGUOUS',
        deleteDispatchStartedAt: new Date(),
      });
    deletes.reconcileRetentionIntent.mockResolvedValue(null);
    await runtime.process('-1');
    expect(store.settleReconciliation).not.toHaveBeenCalled();
    expect(store.deferReconciliation).toHaveBeenCalledWith(expect.any(Object));
  });
  it('keeps a marker-free ambiguous intent retryable while its candidate remains active', async () => {
    const { runtime, deletes, intent, store, prisma } = setup();
    intent.status = 'AMBIGUOUS';
    deletes.attemptRetentionIntent.mockResolvedValue({
      retentionOwned: true,
      status: 'AMBIGUOUS',
      nextAttemptAt: new Date(),
      lastErrorCode: 'delete_intent_execution_failed',
    });
    await runtime.process('-1');
    expect(store.finish).not.toHaveBeenCalled();
    expect(prisma.messageRetentionCandidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'retry', outcomeCode: 'deferred' }),
      }),
    );
  });
  it('settles an observed receipt instead of indefinitely deferring a terminal result', async () => {
    const { runtime, store, deletes, candidate, intent } = setup();
    intent.status = 'OBSERVED';
    store.dueReconciliations.mockResolvedValue([
      { ...candidate, status: 'cancelled', reconcileAfter: new Date() },
    ]);
    store.dueCandidates.mockResolvedValue([]);
    deletes.reconcileRetentionIntent.mockResolvedValue({ status: 'OBSERVED' });
    await runtime.process('-1');
    expect(store.settleReconciliation).toHaveBeenCalledWith(expect.any(Object), 'terminal_review');
    expect(store.deferReconciliation).not.toHaveBeenCalled();
  });
  it.each([
    'deleteDispatchStartedAt',
    'deleteDispatchStartedBotId',
    'remoteDeleteSucceededAt',
    'remoteDeleteSucceededBotId',
  ] as const)(
    'preserves a legacy terminal receipt with %s while mode off prevents verification',
    async (field) => {
      const { runtime, store, deletes, candidate, intent, governor } = setup();
      store.mode = 'off';
      store.allows.mockReturnValue(false);
      intent.status = 'FAILED_TERMINAL';
      Object.assign(intent, { [field]: field.endsWith('At') ? new Date() : 'bot' });
      store.dueReconciliations.mockResolvedValue([
        { ...candidate, status: 'cancelled', reconcileAfter: new Date() },
      ]);
      deletes.reconcileRetentionIntent.mockResolvedValue({ status: 'FAILED_TERMINAL' });
      await runtime.process('-1');
      expect(store.settleReconciliation).not.toHaveBeenCalled();
      expect(store.deferReconciliation).toHaveBeenCalledWith(expect.any(Object));
      expect(governor.decide).not.toHaveBeenCalled();
      expect(deletes.attemptRetentionIntent).not.toHaveBeenCalled();
    },
  );
  it('preserves newly persisted dispatch evidence when a recovery claim returns the old terminal status', async () => {
    const { runtime, store, deletes, candidate, intent, prisma } = setup();
    store.dueReconciliations.mockResolvedValue([
      { ...candidate, status: 'cancelled', reconcileAfter: new Date() },
    ]);
    store.dueCandidates.mockResolvedValue([]);
    prisma.moderationDeleteIntent.findUnique
      .mockResolvedValueOnce({ ...intent, status: 'FAILED_TERMINAL' })
      .mockResolvedValueOnce({
        ...intent,
        status: 'FAILED_TERMINAL',
        deleteDispatchStartedAt: new Date(),
      });
    deletes.reconcileRetentionIntent.mockResolvedValue({ status: 'FAILED_TERMINAL' });
    await runtime.process('-1');
    expect(prisma.moderationDeleteIntent.findUnique).toHaveBeenCalledTimes(2);
    expect(store.settleReconciliation).not.toHaveBeenCalled();
    expect(store.deferReconciliation).toHaveBeenCalledWith(expect.any(Object));
  });
  it('settles exact presence only from a fresh terminal receipt whose dispatch markers were cleared', async () => {
    const { runtime, store, deletes, candidate, intent, prisma } = setup();
    store.dueReconciliations.mockResolvedValue([
      { ...candidate, status: 'cancelled', reconcileAfter: new Date() },
    ]);
    store.dueCandidates.mockResolvedValue([]);
    prisma.moderationDeleteIntent.findUnique
      .mockResolvedValueOnce({
        ...intent,
        status: 'FAILED_TERMINAL',
        deleteDispatchStartedAt: new Date(),
        lastErrorCode: 'message_retention_guard_rejected',
      })
      .mockResolvedValueOnce({
        ...intent,
        status: 'FAILED_TERMINAL',
        lastErrorCode: 'retention_reconciliation_present',
      });
    deletes.reconcileRetentionIntent.mockResolvedValue({ status: 'FAILED_TERMINAL' });
    await runtime.process('-1');
    expect(store.settleReconciliation).toHaveBeenCalledWith(expect.any(Object), 'terminal_review');
    expect(store.deferReconciliation).not.toHaveBeenCalled();
  });
  it('releases active credit but keeps a legacy terminal dispatch receipt under reconciliation', async () => {
    const { runtime, deletes, intent, store, prisma } = setup();
    intent.status = 'FAILED_TERMINAL';
    intent.deleteDispatchStartedAt = new Date();
    deletes.attemptRetentionIntent.mockResolvedValue({
      retentionOwned: true,
      status: 'FAILED_TERMINAL',
      nextAttemptAt: new Date(),
      lastErrorCode: 'legacy_error',
    });
    await runtime.process('-1');
    expect(store.finish).toHaveBeenCalledWith(expect.any(Object), 'skipped', {
      outcomeCode: 'reconciliation',
      reconcile: true,
    });
    expect(prisma.messageRetentionCandidate.updateMany).not.toHaveBeenCalled();
  });
  it('backs off idle polling, but a completed visit wakes ready work immediately', async () => {
    jest.useFakeTimers();
    const { runtime, prisma, queue } = setup();
    prisma.messageRetentionPolicy.findMany.mockResolvedValue([]);
    await runtime.tick();
    await runtime.tick();
    expect(queue.getJobCounts).toHaveBeenCalledTimes(1);
    await runtime.process('-1');
    await runtime.tick();
    expect(queue.getJobCounts).toHaveBeenCalledTimes(2);
  });
  it('does not query policies or governor while fixed slots are full', async () => {
    const { runtime, queue, prisma, governor } = setup();
    queue.getJobCounts.mockResolvedValue({ waiting: 99, active: 1 });
    await runtime.tick();
    expect(prisma.messageRetentionPolicy.findMany).not.toHaveBeenCalled();
    expect(governor.decide).not.toHaveBeenCalled();
  });
});
