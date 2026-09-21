import { MessageRetentionRuntime } from './message-retention-runtime.service';

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
    intentId: 'i',
  };
  const intent = {
    retentionOwned: true,
    status: 'PENDING',
    nextAttemptAt: new Date(),
    lastErrorCode: null,
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
    schedulingFilter: () => ({ chatId: { in: ['-1'] } }),
    resumeAdmission: jest.fn(),
    dueCandidates: jest.fn().mockResolvedValue([candidate]),
    cancelInactive: jest.fn(),
    finish: jest.fn(),
    scheduleNext: jest.fn(),
    purge: jest.fn(),
  };
  const deletes = {
    ensureRetentionIntent: jest.fn().mockResolvedValue('i'),
    attemptIntent: jest.fn().mockResolvedValue({ status: 'SUCCEEDED' }),
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
  afterEach(() => jest.useRealTimers());
  it('resets an obsolete error status after a successful run with revision fencing', async () => {
    const { runtime, prisma, store } = setup();
    await runtime.process('-1');
    expect(store.finish).toHaveBeenCalledWith(expect.any(Object), 'deleted');
    expect(prisma.messageRetentionPolicy.updateMany).toHaveBeenLastCalledWith({
      where: { chatId: '-1', revision: 2 },
      data: { lastStatus: 'running' },
    });
  });
  it('never executes an ordinary moderation intent', async () => {
    const { runtime, intent, deletes } = setup();
    intent.retentionOwned = false;
    await runtime.process('-1');
    expect(deletes.attemptIntent).not.toHaveBeenCalled();
  });
  it('returns age-deferred candidates to indexed pending selection when the period increases', async () => {
    const { runtime, policy, prisma, deletes } = setup();
    policy.hours = 48;
    await runtime.process('-1');
    expect(deletes.attemptIntent).not.toHaveBeenCalled();
    expect(prisma.messageRetentionCandidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'pending' } }),
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
      expect.objectContaining({ where: { chatId: { in: ['-1'] }, nextRunAt: expect.any(Object) } }),
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
    await jest.advanceTimersByTimeAsync(3_600_000);
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
});
