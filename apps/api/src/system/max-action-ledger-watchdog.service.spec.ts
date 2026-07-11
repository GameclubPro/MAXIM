import { MaxActionLedgerStatus } from '../prisma/prisma-client';
import { MaxActionLedgerWatchdogService } from './max-action-ledger-watchdog.service';

function createCandidate(
  overrides: Partial<{
    id: string;
    jobId: string;
    chatId: string;
    actionType: string;
    status: MaxActionLedgerStatus;
    attemptCount: number;
    firstAttemptAt: Date | null;
    lastAttemptAt: Date | null;
    dispatchToken: string | null;
    dispatchStartedAt: Date | null;
    dispatchBotId: string | null;
    remoteMessageId: string | null;
    updatedAt: Date;
  }> = {},
) {
  return {
    id: 'ledger-1',
    jobId: 'job-1',
    chatId: 'chat-1',
    actionType: 'SEND_MESSAGE',
    status: MaxActionLedgerStatus.ENQUEUED,
    attemptCount: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    dispatchToken: null,
    dispatchStartedAt: null,
    dispatchBotId: null,
    remoteMessageId: null,
    updatedAt: new Date(Date.now() - 10 * 60_000),
    ...overrides,
  };
}

function createHarness(
  options: {
    rows?: ReturnType<typeof createCandidate>[];
    job?: unknown;
    criticalJob?: unknown;
    interactiveJob?: unknown;
    backgroundJob?: unknown;
    lockToken?: string | null;
    mode?: 'default' | 'off' | 'shadow' | 'canary' | 'on';
    canaryPercent?: number;
    canaryEntityIds?: string;
    findMany?: jest.Mock;
    persistedCursor?: { id: string; updatedAt: Date } | null;
  } = {},
) {
  const rows = options.rows ?? [];
  const prisma = {
    maxActionLedgerEntry: {
      findMany: options.findMany ?? jest.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const redis = {
    acquireLock: jest
      .fn()
      .mockResolvedValue(options.lockToken === undefined ? 'lock-1' : options.lockToken),
    renewLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue(undefined),
    getString: jest.fn().mockImplementation(async (key: string) => {
      if (key.endsWith(':cursor:v1') && options.persistedCursor) {
        return JSON.stringify({
          id: options.persistedCursor.id,
          updatedAt: options.persistedCursor.updatedAt.toISOString(),
        });
      }
      return null;
    }),
    setStringWithTtl: jest.fn().mockResolvedValue(undefined),
  };
  const queue = {
    getJob: jest.fn().mockResolvedValue(options.job ?? null),
  };
  const criticalQueue = {
    getJob: jest.fn().mockResolvedValue(options.criticalJob ?? null),
  };
  const interactiveQueue = {
    getJob: jest.fn().mockResolvedValue(options.interactiveJob ?? null),
  };
  const backgroundQueue = {
    getJob: jest.fn().mockResolvedValue(options.backgroundJob ?? null),
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'MAX_ACTION_LEDGER_WATCHDOG_MODE') {
        return options.mode === 'default' ? undefined : (options.mode ?? 'on');
      }
      if (key === 'MAX_ACTION_LEDGER_WATCHDOG_CANARY_PERCENT') {
        return options.canaryPercent ?? 1;
      }
      if (key === 'MAX_ACTION_LEDGER_WATCHDOG_CANARY_ENTITY_IDS') {
        return options.canaryEntityIds ?? '';
      }
      return undefined;
    }),
  };
  return {
    prisma,
    redis,
    queue,
    criticalQueue,
    interactiveQueue,
    backgroundQueue,
    service: new MaxActionLedgerWatchdogService(
      prisma as never,
      redis as never,
      queue as never,
      criticalQueue as never,
      interactiveQueue as never,
      backgroundQueue as never,
      config as never,
    ),
  };
}

describe('MaxActionLedgerWatchdogService', () => {
  const previousRole = process.env.APP_ROLE;

  beforeEach(() => {
    process.env.APP_ROLE = 'action';
  });

  afterAll(() => {
    if (previousRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = previousRole;
    }
  });

  it('terminally fails a proven pre-dispatch orphan without recreating a job', async () => {
    const row = createCandidate();
    const { service, prisma, queue } = createHarness({ rows: [row] });

    await service.runNow();

    expect(queue.getJob).toHaveBeenCalledWith('job-1');
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'ledger-1',
        status: MaxActionLedgerStatus.ENQUEUED,
        terminal: false,
        updatedAt: row.updatedAt,
      },
      data: expect.objectContaining({
        status: MaxActionLedgerStatus.FAILED_TERMINAL,
        ambiguous: false,
        terminal: true,
        lastErrorCode: 'ledger.watchdog.pre_dispatch_orphan',
      }),
    });
    expect(queue).not.toHaveProperty('add');

    const snapshot = await service.getSnapshot();
    expect(snapshot).toEqual(
      expect.objectContaining({
        staleCount: 1,
        staleEnqueuedCount: 1,
        staleInProgressCount: 0,
        lastReconciledCount: 1,
        lastTerminalFailedCount: 1,
        lastQuarantinedCount: 0,
        lastError: null,
      }),
    );
  });

  it('defaults rollout behavior to shadow classification without database mutations', async () => {
    const row = createCandidate({
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 1,
      dispatchToken: 'dispatch-token-1',
      dispatchStartedAt: new Date(Date.now() - 10 * 60_000),
      dispatchBotId: 'bot-1',
    });
    const harness = createHarness({ rows: [row], mode: 'default' });

    await harness.service.runNow();

    expect(harness.prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect(await harness.service.getSnapshot()).toEqual(
      expect.objectContaining({
        enabled: true,
        mode: 'shadow',
        lastReconciledCount: 0,
        lastShadowClassifiedCount: 1,
        lastWouldQuarantineCount: 1,
        lastWouldTerminalFailCount: 0,
      }),
    );
  });

  it('enforces canary mutations only for explicitly allowed ledger or chat ids', async () => {
    const allowed = createHarness({
      rows: [createCandidate()],
      mode: 'canary',
      canaryPercent: 100,
      canaryEntityIds: 'chat-1',
    });
    await allowed.service.runNow();
    expect(allowed.prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledTimes(1);

    const shadowed = createHarness({
      rows: [createCandidate({ id: 'ledger-2', jobId: 'job-2', chatId: 'chat-2' })],
      mode: 'canary',
      canaryPercent: 100,
      canaryEntityIds: 'chat-1',
    });
    await shadowed.service.runNow();
    expect(shadowed.prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect((await shadowed.service.getSnapshot()).lastShadowClassifiedCount).toBe(1);
  });

  it('keeps an empty canary allowlist fully non-mutating', async () => {
    const harness = createHarness({
      rows: [createCandidate()],
      mode: 'canary',
      canaryPercent: 100,
      canaryEntityIds: '',
    });

    await harness.service.runNow();

    expect(harness.prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect(await harness.service.getSnapshot()).toEqual(
      expect.objectContaining({
        lastReconciledCount: 0,
        lastShadowClassifiedCount: 1,
      }),
    );
  });

  it('does no scanning when rollout mode is off', async () => {
    const { service, prisma, redis } = createHarness({
      rows: [createCandidate()],
      mode: 'off',
    });

    await service.runNow();

    expect(redis.acquireLock).not.toHaveBeenCalled();
    expect(prisma.maxActionLedgerEntry.findMany).not.toHaveBeenCalled();
    expect(await service.getSnapshot()).toEqual(
      expect.objectContaining({
        enabled: false,
        mode: 'off',
      }),
    );
  });

  it('quarantines a stale network mutation that may already have executed', async () => {
    const row = createCandidate({
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 1,
      firstAttemptAt: new Date(Date.now() - 11 * 60_000),
      lastAttemptAt: new Date(Date.now() - 10 * 60_000),
      dispatchToken: 'dispatch-token-1',
      dispatchStartedAt: new Date(Date.now() - 10 * 60_000),
      dispatchBotId: 'bot-1',
    });
    const { service, prisma } = createHarness({ rows: [row] });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.AMBIGUOUS,
          ambiguous: true,
          terminal: true,
          lastErrorCode: 'ledger.watchdog.ambiguous',
          lastError: expect.stringContaining('Manual review is required before retry'),
        }),
      }),
    );
    const snapshot = await service.getSnapshot();
    expect(snapshot.lastQuarantinedCount).toBe(1);
    expect(snapshot.staleInProgressCount).toBe(1);
  });

  it('terminally fails stale SEND_MESSAGE work that never acquired a dispatch fence', async () => {
    const row = createCandidate({
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 2,
      firstAttemptAt: new Date(Date.now() - 11 * 60_000),
      lastAttemptAt: new Date(Date.now() - 10 * 60_000),
    });
    const { service, prisma } = createHarness({ rows: [row] });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.FAILED_TERMINAL,
          ambiguous: false,
          lastErrorCode: 'ledger.watchdog.pre_dispatch_orphan',
        }),
      }),
    );
    expect((await service.getSnapshot()).lastQuarantinedCount).toBe(0);
  });

  it('terminally fails an unconfirmed idempotent action without calling it ambiguous', async () => {
    const row = createCandidate({
      actionType: 'DELETE_MESSAGE',
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 1,
    });
    const { service, prisma } = createHarness({ rows: [row] });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.FAILED_TERMINAL,
          ambiguous: false,
          terminal: true,
          lastErrorCode: 'ledger.watchdog.unconfirmed_safe_action',
        }),
      }),
    );
    const snapshot = await service.getSnapshot();
    expect(snapshot.lastTerminalFailedCount).toBe(1);
    expect(snapshot.lastQuarantinedCount).toBe(0);
  });

  it('leaves retained waiting or delayed jobs to BullMQ', async () => {
    const row = createCandidate();
    const job = {
      getState: jest.fn().mockResolvedValue('delayed'),
      processedOn: undefined,
      attemptsMade: 0,
    };
    const { service, prisma } = createHarness({ rows: [row], job });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    const snapshot = await service.getSnapshot();
    expect(snapshot.staleCount).toBe(0);
    expect(snapshot.lastScannedCount).toBe(1);
    expect(snapshot.lastDeferredCount).toBe(1);
    expect(snapshot.lastReconciledCount).toBe(0);
  });

  it('finds retained jobs in a split action lane when legacy is empty', async () => {
    const row = createCandidate();
    const job = {
      getState: jest.fn().mockResolvedValue('waiting'),
      processedOn: undefined,
      attemptsMade: 0,
    };
    const { service, prisma, queue, interactiveQueue } = createHarness({
      rows: [row],
      interactiveJob: job,
    });

    await service.runNow();

    expect(queue.getJob).toHaveBeenCalledWith('job-1');
    expect(interactiveQueue.getJob).toHaveBeenCalledWith('job-1');
    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect((await service.getSnapshot()).lastDeferredCount).toBe(1);
  });

  it('recovers a retained completed non-SEND BullMQ job as succeeded', async () => {
    const row = createCandidate({
      actionType: 'DELETE_MESSAGE',
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 1,
    });
    const job = {
      getState: jest.fn().mockResolvedValue('completed'),
      processedOn: Date.now() - 10 * 60_000,
      attemptsMade: 1,
    };
    const { service, prisma } = createHarness({ rows: [row], job });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.SUCCEEDED,
          ambiguous: false,
          terminal: true,
          lastErrorCode: null,
          lastError: null,
        }),
      }),
    );
    const snapshot = await service.getSnapshot();
    expect(snapshot.lastRecoveredSucceededCount).toBe(1);
  });

  it('does not mark completed SEND_MESSAGE work successful without a remote message id', async () => {
    const row = createCandidate({
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 1,
    });
    const job = {
      getState: jest.fn().mockResolvedValue('completed'),
      processedOn: Date.now() - 10 * 60_000,
      attemptsMade: 1,
    };
    const { service, prisma } = createHarness({ rows: [row], job });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.FAILED_TERMINAL,
          ambiguous: false,
          lastErrorCode: 'ledger.watchdog.send_completed_without_remote_id',
        }),
      }),
    );
    expect((await service.getSnapshot()).lastRecoveredSucceededCount).toBe(0);
  });

  it('recovers stale SEND_MESSAGE only from a durable remote message id', async () => {
    const row = createCandidate({
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 1,
      dispatchToken: 'dispatch-token-1',
      dispatchStartedAt: new Date(Date.now() - 10 * 60_000),
      dispatchBotId: 'bot-2',
      remoteMessageId: 'mid-1',
    });
    const { service, prisma } = createHarness({ rows: [row] });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.SUCCEEDED,
          ambiguous: false,
          lastErrorCode: null,
        }),
      }),
    );
    expect((await service.getSnapshot()).lastRecoveredSucceededCount).toBe(1);
  });

  it('persists a rotating cursor after a truncated shadow scan', async () => {
    const updatedAt = new Date(Date.now() - 10 * 60_000);
    const rows = Array.from({ length: 1_000 }, (_, index) =>
      createCandidate({
        id: `ledger-${String(index + 1).padStart(4, '0')}`,
        jobId: `job-${index + 1}`,
        chatId: `chat-${index + 1}`,
        updatedAt,
      }),
    );
    const findMany = jest.fn().mockImplementation(async (args: any) => {
      const afterId = args.where.OR?.[1]?.id?.gt as string | undefined;
      const start = afterId ? rows.findIndex((row) => row.id === afterId) + 1 : 0;
      return rows.slice(start, start + args.take);
    });
    const { service, redis } = createHarness({ mode: 'shadow', findMany });

    await service.runNow();

    expect((await service.getSnapshot()).lastScanTruncated).toBe(true);
    expect(redis.setStringWithTtl).toHaveBeenCalledWith(
      'system:max-action-ledger:watchdog:cursor:v1',
      JSON.stringify({ id: 'ledger-1000', updatedAt: updatedAt.toISOString() }),
      expect.any(Number),
    );
  });

  it('resumes scanning after the persisted cursor', async () => {
    const cursorUpdatedAt = new Date(Date.now() - 11 * 60_000);
    const row = createCandidate({
      id: 'ledger-after-cursor',
      jobId: 'job-after-cursor',
      chatId: 'chat-after-cursor',
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    const findMany = jest.fn().mockResolvedValueOnce([row]);
    const { service } = createHarness({
      rows: [row],
      findMany,
      persistedCursor: { id: 'ledger-1000', updatedAt: cursorUpdatedAt },
    });

    await service.runNow();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { updatedAt: { gt: cursorUpdatedAt, lte: expect.any(Date) } },
            { updatedAt: cursorUpdatedAt, id: { gt: 'ledger-1000' } },
          ],
        }),
      }),
    );
  });

  it('does no database work when another runtime owns the Redis lock', async () => {
    const { service, prisma, redis } = createHarness({
      rows: [createCandidate()],
      lockToken: null,
    });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.findMany).not.toHaveBeenCalled();
    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect(redis.releaseLock).not.toHaveBeenCalled();
  });

  it('surfaces queue inspection failures without mutating the ledger', async () => {
    const { service, prisma, queue } = createHarness({ rows: [createCandidate()] });
    queue.getJob.mockRejectedValueOnce(new Error('redis unavailable'));

    await service.runNow('scheduled');

    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    const snapshot = await service.getSnapshot();
    expect(snapshot.lastError).toBe('redis unavailable');
    expect(snapshot.lastRunReason).toBe('scheduled');
    expect(snapshot.lastSuccessAt).toBeNull();
  });
});
