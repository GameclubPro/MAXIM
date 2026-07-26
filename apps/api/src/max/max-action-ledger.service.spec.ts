import { UnrecoverableError } from 'bullmq';
import {
  markMaxSendDispatchLedgerFinalized,
  MAX_SEND_LEDGER_PREPARATION_ERROR_CODES,
  MaxActionLedgerService,
} from './max-action-ledger.service';
import { MaxActionLedgerStatus } from '../prisma/prisma-client';
import type { MaxActionJob } from './max-client.service';

function createJob(overrides: Partial<MaxActionJob> = {}): MaxActionJob {
  return {
    actionType: 'SEND_MESSAGE',
    chatId: 'chat-1',
    botId: 'bot-1',
    text: 'hello',
    attempt: 1,
    idempotencyKey: 'job-1',
    createdAt: '2026-07-06T20:00:00.000Z',
    ...overrides,
  } as MaxActionJob;
}

function createService(row: unknown = null) {
  const prisma = {
    maxActionLedgerEntry: {
      findFirst: jest.fn().mockResolvedValue(row),
      findUnique: jest.fn().mockResolvedValue(row),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return {
    prisma,
    service: new MaxActionLedgerService(prisma as never),
  };
}

describe('MaxActionLedgerService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('recognizes only a succeeded delete as confirmed exact message cleanup', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
    const { service, prisma } = createService({ id: 'delete-job-1' });

    await expect(service.hasSucceededDelete(' chat-1 ', ' message-1 ')).resolves.toBe(true);

    expect(prisma.maxActionLedgerEntry.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        actionType: 'DELETE_MESSAGE',
        messageId: 'message-1',
        status: MaxActionLedgerStatus.SUCCEEDED,
        updatedAt: {
          gte: new Date('2026-07-16T10:00:00.000Z'),
        },
      },
      select: {
        id: true,
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });
  });

  it('does not claim delete ownership without a succeeded exact ledger row', async () => {
    const { service } = createService(null);

    await expect(service.hasSucceededDelete('chat-1', 'message-1')).resolves.toBe(false);
  });

  it('clears only terminal ban state after a confirmed unban', async () => {
    const { service, prisma } = createService();

    await service.clearTerminalBanStateAfterUnban(' chat-1 ', ' user-1 ');

    expect(prisma.maxActionLedgerEntry.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        userId: 'user-1',
        actionType: 'BAN_MEMBER',
        terminal: true,
      },
    });
  });

  it('clears only the exact legacy pre-dispatch no-route send failure', async () => {
    const job = createJob({
      chatId: 'chat-1',
      idempotencyKey: 'night-mode:open:chat-1:session:session-1',
    });
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.FAILED_TERMINAL,
      ambiguous: false,
      terminal: true,
      attemptCount: 1,
      firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastStatusCode: null,
      lastErrorCode: null,
      lastError: 'MAX SEND_MESSAGE has no executable routed bot candidate for chat chat-1',
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: null,
    });

    await expect(service.assertCanExecute(job)).resolves.toBeUndefined();

    expect(prisma.maxActionLedgerEntry.deleteMany).toHaveBeenCalledWith({
      where: {
        jobId: 'night-mode:open:chat-1:session:session-1',
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        status: MaxActionLedgerStatus.FAILED_TERMINAL,
        ambiguous: false,
        terminal: true,
        lastStatusCode: null,
        lastErrorCode: null,
        lastError: 'MAX SEND_MESSAGE has no executable routed bot candidate for chat chat-1',
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      },
    });
  });

  it('does not clear a terminal send with dispatch evidence even when its message resembles no-route', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.FAILED_TERMINAL,
      ambiguous: false,
      terminal: true,
      attemptCount: 1,
      firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastStatusCode: null,
      lastErrorCode: null,
      lastError: 'MAX SEND_MESSAGE has no executable routed bot candidate for chat chat-1',
      dispatchToken: 'retained-dispatch-token',
      dispatchStartedAt: new Date('2026-07-06T20:00:01.000Z'),
      dispatchBotId: 'bot-1',
      remoteMessageId: null,
    });

    await expect(service.assertCanExecute(createJob())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(prisma.maxActionLedgerEntry.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'Не удалось загрузить видео: MAX upload payload is missing'],
    [
      'ledger.watchdog.pre_dispatch_orphan',
      'Pre-dispatch MAX SEND_MESSAGE ledger entry has no retained dispatch fence; BullMQ states missing. The action was not requeued.',
    ],
  ])(
    'clears an exact historical managed-broadcast pre-dispatch video failure',
    async (lastErrorCode, lastError) => {
      const job = createJob({
        idempotencyKey:
          'managed-broadcast:send:broadcast-1:occurrence:1:target:chat-1:content:revision-1',
      });
      const { service, prisma } = createService({
        status: MaxActionLedgerStatus.FAILED_TERMINAL,
        ambiguous: false,
        terminal: true,
        attemptCount: 1,
        firstAttemptAt: new Date('2026-05-01T10:00:00.000Z'),
        lastAttemptAt: new Date('2026-05-01T10:00:00.000Z'),
        lastStatusCode: null,
        lastErrorCode,
        lastError,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      });

      await expect(service.assertCanEnqueue(job)).resolves.toBeUndefined();
      expect(prisma.maxActionLedgerEntry.deleteMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          jobId: job.idempotencyKey,
          actionType: 'SEND_MESSAGE',
          chatId: 'chat-1',
          status: MaxActionLedgerStatus.FAILED_TERMINAL,
          ambiguous: false,
          terminal: true,
          lastStatusCode: null,
          dispatchToken: null,
          dispatchStartedAt: null,
          dispatchBotId: null,
          remoteMessageId: null,
          OR: expect.any(Array),
        }),
      });
    },
  );

  it('does not clear the historical upload error for an unrelated send job', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.FAILED_TERMINAL,
      ambiguous: false,
      terminal: true,
      attemptCount: 1,
      firstAttemptAt: new Date('2026-05-01T10:00:00.000Z'),
      lastAttemptAt: new Date('2026-05-01T10:00:00.000Z'),
      lastStatusCode: null,
      lastErrorCode: null,
      lastError: 'не удалось загрузить видео: max upload payload is missing',
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: null,
    });

    await expect(service.assertCanExecute(createJob())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(prisma.maxActionLedgerEntry.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    { dispatchToken: 'dispatch-token-1' },
    { dispatchStartedAt: new Date('2026-05-01T10:00:01.000Z') },
    { dispatchBotId: 'bot-1' },
  ])(
    'does not clear a managed-broadcast upload failure with dispatch evidence',
    async (evidence) => {
      const { service, prisma } = createService({
        status: MaxActionLedgerStatus.FAILED_TERMINAL,
        ambiguous: false,
        terminal: true,
        attemptCount: 1,
        firstAttemptAt: new Date('2026-05-01T10:00:00.000Z'),
        lastAttemptAt: new Date('2026-05-01T10:00:00.000Z'),
        lastStatusCode: null,
        lastErrorCode: null,
        lastError: 'не удалось загрузить видео: max upload payload is missing',
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
        ...evidence,
      });
      const job = createJob({
        idempotencyKey:
          'managed-broadcast:send:broadcast-1:occurrence:1:target:chat-1:content:revision-1',
      });

      await expect(service.assertCanExecute(job)).rejects.toBeInstanceOf(UnrecoverableError);
      expect(prisma.maxActionLedgerEntry.deleteMany).not.toHaveBeenCalled();
    },
  );

  it('keeps a recovered managed-broadcast remote message id without clearing its ledger row', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.FAILED_TERMINAL,
      ambiguous: false,
      terminal: true,
      lastStatusCode: null,
      lastErrorCode: null,
      lastError: 'не удалось загрузить видео: max upload payload is missing',
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: 'mid-1',
    });
    const job = createJob({
      idempotencyKey:
        'managed-broadcast:send:broadcast-1:occurrence:1:target:chat-1:content:revision-1',
    });

    await expect(service.assertCanExecute(job)).resolves.toBeUndefined();
    expect(prisma.maxActionLedgerEntry.deleteMany).not.toHaveBeenCalled();
  });

  it('blocks enqueue when an irreversible job is already quarantined as ambiguous', async () => {
    const { service } = createService({
      status: MaxActionLedgerStatus.AMBIGUOUS,
      ambiguous: true,
      terminal: true,
      lastError: 'ambiguous max send_message transport failure',
    });

    await expect(service.assertCanEnqueue(createJob())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('does not block retryable or non-irreversible ledger rows', async () => {
    const { service: retryableService } = createService({
      status: MaxActionLedgerStatus.FAILED_RETRYABLE,
      ambiguous: false,
      terminal: false,
      lastError: 'server failure',
    });

    await expect(retryableService.assertCanEnqueue(createJob())).resolves.toBeUndefined();

    const { service: deleteService, prisma } = createService({
      status: MaxActionLedgerStatus.AMBIGUOUS,
      ambiguous: true,
      terminal: true,
      lastError: 'ambiguous max delete_message transport failure',
    });

    await expect(
      deleteService.assertCanEnqueue(
        createJob({
          actionType: 'DELETE_MESSAGE',
          messageId: 'mid-1',
          text: undefined,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(prisma.maxActionLedgerEntry.findUnique).not.toHaveBeenCalled();
  });

  it('blocks terminal SEND_MESSAGE rows that have no recoverable remote message id', async () => {
    const { service } = createService({
      status: MaxActionLedgerStatus.FAILED_TERMINAL,
      ambiguous: false,
      terminal: true,
      dispatchToken: null,
      dispatchStartedAt: null,
      remoteMessageId: null,
    });

    await expect(service.assertCanEnqueue(createJob())).rejects.toThrow(
      'has no recoverable remote message id',
    );
  });

  it('blocks execution when a recovered BullMQ job races with terminal ledger state', async () => {
    const { service } = createService({
      status: MaxActionLedgerStatus.FAILED_TERMINAL,
      ambiguous: false,
      terminal: true,
      dispatchToken: null,
      dispatchStartedAt: null,
      remoteMessageId: null,
    });

    await expect(
      service.assertCanExecute(
        createJob({
          actionType: 'KICK_MEMBER',
          userId: 'user-1',
          text: undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it.each([
    ['BAN_MEMBER', 'max_api_internal_rate_limit'],
    ['KICK_MEMBER', 'max_api_circuit_open'],
  ] as const)(
    'allows %s execution after a proven pre-dispatch %s failure',
    async (actionType, lastErrorCode) => {
      const { service } = createService({
        status: MaxActionLedgerStatus.FAILED_RETRYABLE,
        ambiguous: false,
        terminal: false,
        attemptCount: 1,
        firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
        lastAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
        lastErrorCode,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      });

      await expect(
        service.assertCanExecute(
          createJob({
            actionType,
            userId: 'user-1',
            text: undefined,
          }),
        ),
      ).resolves.toBeUndefined();
    },
  );

  it.each(['KICK_MEMBER', 'BAN_MEMBER'] as const)(
    'blocks a stalled %s ledger row from executing or being enqueued again',
    async (actionType) => {
      const row = {
        status: MaxActionLedgerStatus.IN_PROGRESS,
        ambiguous: false,
        terminal: false,
        attemptCount: 1,
        firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
        lastAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
        lastErrorCode: null,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      };
      const job = createJob({ actionType, userId: 'user-1', text: undefined });

      await expect(createService(row).service.assertCanExecute(job)).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      await expect(createService(row).service.assertCanEnqueue(job)).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    },
  );

  it('blocks a generic post-dispatch retryable member failure', async () => {
    const { service } = createService({
      status: MaxActionLedgerStatus.FAILED_RETRYABLE,
      ambiguous: false,
      terminal: false,
      attemptCount: 1,
      firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastAttemptAt: new Date('2026-07-06T20:00:01.000Z'),
      lastErrorCode: 'server.failure',
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: null,
    });

    await expect(
      service.assertCanExecute(
        createJob({ actionType: 'KICK_MEMBER', userId: 'user-1', text: undefined }),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('allows one worker to claim a completely unattempted retryable member enqueue row', async () => {
    const { service } = createService({
      status: MaxActionLedgerStatus.FAILED_RETRYABLE,
      ambiguous: false,
      terminal: false,
      attemptCount: 0,
      firstAttemptAt: null,
      lastAttemptAt: null,
      lastErrorCode: 'econnreset',
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: null,
    });

    await expect(
      service.assertCanExecute(
        createJob({ actionType: 'BAN_MEMBER', userId: 'user-1', text: undefined }),
      ),
    ).resolves.toBeUndefined();
  });

  it('preserves ordinary in-progress SEND_MESSAGE retry behavior before its dispatch fence exists', async () => {
    const { service } = createService({
      status: MaxActionLedgerStatus.IN_PROGRESS,
      ambiguous: false,
      terminal: false,
      attemptCount: 1,
      firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastErrorCode: null,
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: null,
    });

    await expect(service.assertCanExecute(createJob())).resolves.toBeUndefined();
  });

  it('records enqueue metadata without storing message text', async () => {
    const { service, prisma } = createService();
    const job = createJob({
      sourceTag: 'interactive',
      trafficClass: 'critical',
      actionHealthLane: 'background',
      autoDeleteDelayMs: 60_000,
      candidateBotIds: ['bot-1', 'bot-2'],
      attemptedBotIds: ['bot-1'],
      routing: {
        purpose: 'send_message',
        primaryBotId: 'bot-1',
        reason: 'primary_confirmed',
        routingVersion: 3,
      },
    });

    await service.recordEnqueuedIfAbsent(job);

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          jobId: 'job-1',
          actionType: 'SEND_MESSAGE',
          chatId: 'chat-1',
          botId: 'bot-1',
          sourceTag: 'interactive',
          metadata: expect.objectContaining({
            hasText: true,
            textLength: 5,
            autoDeleteDelayMs: 60_000,
            candidateBotIds: ['bot-1', 'bot-2'],
            attemptedBotIds: ['bot-1'],
            routing: expect.objectContaining({
              purpose: 'send_message',
              routingVersion: 3,
            }),
          }),
        }),
      ],
      skipDuplicates: true,
    });
    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    const create = prisma.maxActionLedgerEntry.createMany.mock.calls[0][0].data[0];
    expect(create).toEqual(
      expect.objectContaining({
        status: MaxActionLedgerStatus.ENQUEUED,
        ambiguous: false,
        terminal: false,
        enqueuedAt: expect.any(Date),
      }),
    );
    expect(JSON.stringify(create.metadata)).not.toContain('hello');
  });

  it('treats a concurrent ledger insert as an idempotent enqueue success', async () => {
    const { service, prisma } = createService();
    prisma.maxActionLedgerEntry.createMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.recordEnqueuedIfAbsent(createJob())).resolves.toBeUndefined();

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        status: { in: [MaxActionLedgerStatus.FAILED_RETRYABLE] },
        ambiguous: false,
        terminal: false,
        attemptCount: 0,
        firstAttemptAt: null,
        lastAttemptAt: null,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
        completedAt: null,
      },
      data: expect.objectContaining({
        status: MaxActionLedgerStatus.ENQUEUED,
        ambiguous: false,
        terminal: false,
      }),
    });
  });

  it('records enqueue failure only when the worker has not created the ledger row', async () => {
    const { service, prisma } = createService();
    const error = Object.assign(new Error('redis unavailable'), { code: 'ECONNRESET' });

    await service.recordEnqueueFailedIfAbsent(createJob(), error);

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            status: MaxActionLedgerStatus.FAILED_RETRYABLE,
            terminal: false,
            lastErrorCode: 'econnreset',
            lastError: 'redis unavailable',
          }),
        ],
      }),
    );
  });

  it('quarantines ambiguous SEND_MESSAGE queue ownership without overwriting worker state', async () => {
    const { service, prisma } = createService();

    await service.recordEnqueueAmbiguousIfAbsent(
      createJob(),
      new Error('queue ownership is unknown'),
    );

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            status: MaxActionLedgerStatus.AMBIGUOUS,
            ambiguous: true,
            terminal: true,
            lastErrorCode: 'queue.enqueue_ambiguous',
          }),
        ],
      }),
    );
  });

  it('quarantines an existing unattempted enqueue after BullMQ ownership becomes unknown', async () => {
    const { service, prisma } = createService();
    prisma.maxActionLedgerEntry.createMany.mockResolvedValueOnce({ count: 0 });

    await service.recordEnqueueAmbiguousIfAbsent(
      createJob(),
      new Error('queue ownership is unknown'),
    );

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        status: {
          in: [MaxActionLedgerStatus.ENQUEUED, MaxActionLedgerStatus.FAILED_RETRYABLE],
        },
        ambiguous: false,
        terminal: false,
        attemptCount: 0,
        firstAttemptAt: null,
        lastAttemptAt: null,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
        completedAt: null,
      },
      data: expect.objectContaining({
        status: MaxActionLedgerStatus.AMBIGUOUS,
        ambiguous: true,
        terminal: true,
        lastErrorCode: 'queue.enqueue_ambiguous',
      }),
    });
  });

  it('finds execution evidence produced after an ambiguous queue add', async () => {
    const { service, prisma } = createService({ id: 'ledger-1' });
    const since = new Date('2026-07-16T12:00:00.000Z');

    await expect(service.hasExecutionEvidenceSince(' job-1 ', since)).resolves.toBe(true);

    expect(prisma.maxActionLedgerEntry.findFirst).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        OR: [
          { firstAttemptAt: { gte: since } },
          { lastAttemptAt: { gte: since } },
          { dispatchStartedAt: { gte: since } },
        ],
      },
      select: { id: true },
    });
  });

  it('increments attempts when recording worker start after a concurrent ledger insert', async () => {
    const { service, prisma } = createService();
    const job = createJob({ attempt: 3 });
    prisma.maxActionLedgerEntry.createMany.mockResolvedValueOnce({ count: 0 });

    await service.recordStarted(job);

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          jobId: 'job-1',
          dispatchToken: null,
          remoteMessageId: null,
        }),
        data: expect.objectContaining({
          attemptCount: {
            increment: 1,
          },
          status: MaxActionLedgerStatus.IN_PROGRESS,
        }),
      }),
    );
  });

  it.each([
    ['stalled', MaxActionLedgerStatus.IN_PROGRESS, null],
    ['terminal', MaxActionLedgerStatus.FAILED_TERMINAL, null],
    ['post-dispatch retryable', MaxActionLedgerStatus.FAILED_RETRYABLE, 'server.failure'],
  ] as const)(
    'does not revive a %s member action when recording worker start loses the CAS race',
    async (_label, status, lastErrorCode) => {
      const retainedRow = {
        status,
        ambiguous: false,
        terminal: status === MaxActionLedgerStatus.FAILED_TERMINAL,
        attemptCount: 1,
        firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
        lastAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
        lastErrorCode,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      };
      const { service, prisma } = createService(retainedRow);
      prisma.maxActionLedgerEntry.updateMany.mockResolvedValue({ count: 0 });
      prisma.maxActionLedgerEntry.createMany.mockResolvedValue({ count: 0 });

      await expect(
        service.recordStarted(
          createJob({
            actionType: 'KICK_MEMBER',
            userId: 'user-1',
            text: undefined,
          }),
        ),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      expect(prisma.maxActionLedgerEntry.upsert).not.toHaveBeenCalled();
      expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            terminal: false,
            ambiguous: false,
            OR: [
              { status: MaxActionLedgerStatus.ENQUEUED },
              expect.objectContaining({
                status: MaxActionLedgerStatus.FAILED_RETRYABLE,
              }),
            ],
          }),
        }),
      );
    },
  );

  it('atomically claims a retry after a proven pre-dispatch member failure', async () => {
    const { service, prisma } = createService();
    const job = createJob({
      actionType: 'BAN_MEMBER',
      userId: 'user-1',
      text: undefined,
    });

    await service.recordStarted(job);

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          jobId: 'job-1',
          OR: [
            { status: MaxActionLedgerStatus.ENQUEUED },
            expect.objectContaining({
              status: MaxActionLedgerStatus.FAILED_RETRYABLE,
              OR: expect.arrayContaining([
                expect.objectContaining({
                  lastErrorCode: {
                    in: ['max_api_circuit_open', 'max_api_internal_rate_limit'],
                  },
                }),
              ]),
            }),
          ],
        }),
      }),
    );
  });

  it('persists prepared domain context before the SEND dispatch fence is claimed', async () => {
    const { service, prisma } = createService();
    const job = createJob({
      ledgerContext: {
        managedBroadcast: {
          commentDialogReference: {
            entityType: 'channel',
            threadId: 'thread-1',
            includeCommentsButton: true,
          },
        },
      },
    });

    await service.recordPrepared(job);

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        jobId: 'job-1',
        dispatchToken: null,
        dispatchStartedAt: null,
        remoteMessageId: null,
        terminal: false,
      }),
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          ledgerContext: job.ledgerContext,
        }),
      }),
    });
  });

  it.each([
    ['the ledger row is missing', null, MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.MISSING_ROW, false],
    [
      'the ledger row is terminal',
      {
        status: MaxActionLedgerStatus.FAILED_TERMINAL,
        ambiguous: false,
        terminal: true,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      },
      MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.TERMINAL_OR_AMBIGUOUS,
      true,
    ],
    [
      'the ledger row is ambiguous',
      {
        status: MaxActionLedgerStatus.AMBIGUOUS,
        ambiguous: true,
        terminal: true,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      },
      MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.TERMINAL_OR_AMBIGUOUS,
      true,
    ],
    [
      'an existing dispatch fence is retained',
      {
        status: MaxActionLedgerStatus.IN_PROGRESS,
        ambiguous: false,
        terminal: false,
        dispatchToken: 'prior-token',
        dispatchStartedAt: new Date('2026-07-13T12:00:00.000Z'),
        dispatchBotId: 'bot-1',
        remoteMessageId: null,
      },
      MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.DISPATCH_FENCE_EXISTS,
      true,
    ],
    [
      'the remote message is already completed',
      {
        status: MaxActionLedgerStatus.SUCCEEDED,
        ambiguous: false,
        terminal: true,
        dispatchToken: 'completed-token',
        dispatchStartedAt: new Date('2026-07-13T12:00:00.000Z'),
        dispatchBotId: 'bot-1',
        remoteMessageId: 'remote-message-1',
      },
      MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.ALREADY_COMPLETED,
      true,
    ],
    [
      'the retained ledger state is otherwise unexpected',
      {
        status: MaxActionLedgerStatus.ENQUEUED,
        ambiguous: false,
        terminal: false,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      },
      MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.UNEXPECTED_STATE,
      false,
    ],
  ])(
    'fails closed with a classified error when %s',
    async (_description, row, code, preserveExistingLedger) => {
      const { service, prisma } = createService(row);
      prisma.maxActionLedgerEntry.updateMany.mockResolvedValueOnce({ count: 0 });

      const error = await service.recordPrepared(createJob()).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(error).toMatchObject({ code });
      if (preserveExistingLedger) {
        expect(error).toMatchObject({ maxSendDispatchLedgerFinalized: true });
      } else {
        expect(error).not.toHaveProperty('maxSendDispatchLedgerFinalized');
      }
      expect(prisma.maxActionLedgerEntry.findUnique).toHaveBeenCalledWith({
        where: {
          jobId: 'job-1',
        },
        select: {
          status: true,
          ambiguous: true,
          terminal: true,
          dispatchToken: true,
          dispatchStartedAt: true,
          dispatchBotId: true,
          remoteMessageId: true,
        },
      });
    },
  );

  it('does not overwrite a retained SEND_MESSAGE dispatch fence after preparation is blocked', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.IN_PROGRESS,
      ambiguous: false,
      terminal: false,
      dispatchToken: 'prior-token',
      dispatchStartedAt: new Date('2026-07-13T12:00:00.000Z'),
      dispatchBotId: 'bot-1',
      remoteMessageId: null,
    });
    prisma.maxActionLedgerEntry.updateMany.mockResolvedValueOnce({ count: 0 });

    const error = await service.recordPrepared(createJob()).catch((caught: unknown) => caught);
    await service.recordFailed(createJob(), error);

    expect(prisma.maxActionLedgerEntry.createMany).not.toHaveBeenCalled();
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledTimes(1);
  });

  it('claims the first SEND_MESSAGE dispatch with an atomic token fence', async () => {
    const { service, prisma } = createService();

    const claim = await service.claimSendDispatch(createJob(), 'bot-1');

    expect(claim).toEqual({
      kind: 'claimed',
      dispatchToken: expect.any(String),
    });
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
        ambiguous: false,
        terminal: false,
      },
      data: {
        dispatchToken: expect.any(String),
        dispatchStartedAt: expect.any(Date),
        dispatchBotId: 'bot-1',
      },
    });
  });

  it('quarantines an unresolved prior SEND_MESSAGE dispatch instead of claiming again', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.IN_PROGRESS,
      ambiguous: false,
      terminal: false,
      dispatchToken: 'prior-token',
      dispatchStartedAt: new Date('2026-07-11T09:00:00.000Z'),
      dispatchBotId: 'bot-1',
      remoteMessageId: null,
    });
    prisma.maxActionLedgerEntry.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(service.claimSendDispatch(createJob(), 'bot-2')).rejects.toMatchObject({
      name: 'UnrecoverableError',
      maxSendDispatchLedgerFinalized: true,
    });
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          jobId: 'job-1',
          dispatchToken: 'prior-token',
          remoteMessageId: null,
        },
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.AMBIGUOUS,
          ambiguous: true,
          terminal: true,
        }),
      }),
    );
  });

  it('recovers a persisted remote message id without taking another dispatch claim', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      dispatchToken: 'completed-token',
      dispatchStartedAt: new Date('2026-07-11T09:00:00.000Z'),
      dispatchBotId: 'bot-1',
      remoteMessageId: 'mid-remote-1',
    });
    prisma.maxActionLedgerEntry.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.claimSendDispatch(createJob(), 'bot-2')).resolves.toEqual({
      kind: 'recovered',
      remoteMessageId: 'mid-remote-1',
    });
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledTimes(1);
  });

  it('recovers the bot that actually authored a completed survivor dispatch', async () => {
    const { service } = createService({
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      dispatchToken: 'completed-token',
      dispatchStartedAt: new Date('2026-07-11T09:00:00.000Z'),
      dispatchBotId: 'bot-2',
      remoteMessageId: 'mid-survivor-1',
    });

    await expect(service.getCompletedSendDispatchResult(createJob())).resolves.toEqual({
      remoteMessageId: 'mid-survivor-1',
      dispatchBotId: 'bot-2',
    });
  });

  it('persists the remote message id and terminal success using token CAS', async () => {
    const { service, prisma } = createService();

    await service.completeSendDispatch(createJob(), 'dispatch-token', 'mid-remote-1');

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        dispatchToken: 'dispatch-token',
        remoteMessageId: null,
      },
      data: expect.objectContaining({
        remoteMessageId: 'mid-remote-1',
        status: MaxActionLedgerStatus.SUCCEEDED,
        ambiguous: false,
        terminal: true,
        completedAt: expect.any(Date),
      }),
    });
  });

  it('recovers success when the completion write committed but its database acknowledgement was lost', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      dispatchToken: 'dispatch-token',
      dispatchStartedAt: new Date('2026-07-11T09:00:00.000Z'),
      dispatchBotId: 'bot-1',
      remoteMessageId: 'mid-remote-1',
    });
    prisma.maxActionLedgerEntry.updateMany.mockRejectedValueOnce(
      new Error('database response lost after commit'),
    );

    await expect(
      service.completeSendDispatch(createJob(), 'dispatch-token', 'mid-remote-1'),
    ).resolves.toBeUndefined();
  });

  it('releases only the matching unresolved dispatch token after a definitive rejection', async () => {
    const { service, prisma } = createService();

    await service.releaseSendDispatch(createJob(), 'dispatch-token');

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        dispatchToken: 'dispatch-token',
        remoteMessageId: null,
      },
      data: expect.objectContaining({
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        status: MaxActionLedgerStatus.IN_PROGRESS,
        ambiguous: false,
        terminal: false,
      }),
    });
  });

  it('does not overwrite a SEND_MESSAGE outcome already finalized by the dispatch fence', async () => {
    const { service, prisma } = createService();
    const error = markMaxSendDispatchLedgerFinalized(
      new UnrecoverableError('Ambiguous MAX SEND_MESSAGE transport failure'),
    );

    await service.recordFailed(createJob(), error);

    expect(prisma.maxActionLedgerEntry.createMany).not.toHaveBeenCalled();
    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
  });

  it('keeps a persisted SEND_MESSAGE success monotonic when a later failure is recorded', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      remoteMessageId: 'mid-remote-1',
    });
    prisma.maxActionLedgerEntry.updateMany.mockResolvedValueOnce({ count: 0 });

    await service.recordFailed(
      createJob(),
      new UnrecoverableError('Ambiguous MAX SEND_MESSAGE transport failure'),
    );

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          jobId: 'job-1',
          remoteMessageId: null,
          ambiguous: false,
          terminal: false,
        }),
      }),
    );
  });

  it('keeps terminal queue ambiguity monotonic when a later SEND_MESSAGE failure is recorded', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.AMBIGUOUS,
      ambiguous: true,
      terminal: true,
      remoteMessageId: null,
    });
    prisma.maxActionLedgerEntry.createMany.mockResolvedValueOnce({ count: 0 });
    prisma.maxActionLedgerEntry.updateMany.mockResolvedValueOnce({ count: 0 });

    await service.recordFailed(createJob(), new Error('later worker failure'));

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          jobId: 'job-1',
          remoteMessageId: null,
          ambiguous: false,
          terminal: false,
        }),
      }),
    );
  });

  it('classifies ambiguous and retryable failures', async () => {
    const { service, prisma } = createService();

    await service.recordFailed(
      createJob({ idempotencyKey: 'job-ambiguous' }),
      new UnrecoverableError('Ambiguous MAX SEND_MESSAGE transport failure for chat chat-1'),
    );
    await service.recordFailed(createJob({ idempotencyKey: 'job-retryable' }), {
      response: {
        status: 500,
        data: {
          code: 'server.failure',
          message: 'server failure',
        },
      },
    });
    await service.recordFailed(
      createJob({ idempotencyKey: 'job-retryable-exhausted' }),
      {
        response: {
          status: 500,
          data: {
            code: 'server.failure',
            message: 'server failure',
          },
        },
      },
      { exhausted: true },
    );

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: [
          expect.objectContaining({
            status: MaxActionLedgerStatus.AMBIGUOUS,
            ambiguous: true,
            terminal: true,
          }),
        ],
      }),
    );
    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: [
          expect.objectContaining({
            status: MaxActionLedgerStatus.FAILED_RETRYABLE,
            ambiguous: false,
            terminal: false,
            lastStatusCode: 500,
            lastErrorCode: 'server.failure',
          }),
        ],
      }),
    );
    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        data: [
          expect.objectContaining({
            status: MaxActionLedgerStatus.FAILED_RETRYABLE,
            ambiguous: false,
            terminal: true,
            lastStatusCode: 500,
            lastErrorCode: 'server.failure',
            completedAt: expect.any(Date),
          }),
        ],
      }),
    );
  });

  it('terminally classifies deterministic local payload and definitive member failures', async () => {
    const { service, prisma } = createService();

    await service.recordFailed(
      createJob({ idempotencyKey: 'job-upload' }),
      new Error('MAX upload payload is missing'),
    );
    await service.recordFailed(
      createJob({
        idempotencyKey: 'job-member-absent',
        actionType: 'KICK_MEMBER',
        userId: 'user-1',
        text: undefined,
      }),
      {
        response: {
          status: 200,
          data: {
            message: 'User already deleted or bot has insufficient rights',
          },
        },
      },
    );
    await service.recordFailed(
      createJob({
        idempotencyKey: 'job-chat-missing',
        actionType: 'BAN_MEMBER',
        userId: 'user-1',
        text: undefined,
      }),
      {
        response: {
          status: 404,
          data: {
            code: 'chat.not.found',
            message: 'Chat not found',
          },
        },
      },
    );

    for (const call of prisma.maxActionLedgerEntry.createMany.mock.calls.slice(-3)) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              status: MaxActionLedgerStatus.FAILED_TERMINAL,
              ambiguous: false,
              terminal: true,
              completedAt: expect.any(Date),
            }),
          ],
        }),
      );
    }
  });
});
