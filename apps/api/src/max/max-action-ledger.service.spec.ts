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

  it('recognizes an active delete job that already owns the exact message cleanup', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
    const { service, prisma } = createService({ id: 'delete-job-1' });

    await expect(service.hasActiveOrSucceededDelete(' chat-1 ', ' message-1 ')).resolves.toBe(true);

    expect(prisma.maxActionLedgerEntry.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        actionType: 'DELETE_MESSAGE',
        messageId: 'message-1',
        status: {
          in: [
            MaxActionLedgerStatus.ENQUEUED,
            MaxActionLedgerStatus.IN_PROGRESS,
            MaxActionLedgerStatus.SUCCEEDED,
          ],
        },
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

  it('does not claim delete ownership without an active exact ledger row', async () => {
    const { service } = createService(null);

    await expect(service.hasActiveOrSucceededDelete('chat-1', 'message-1')).resolves.toBe(false);
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

    await service.recordEnqueued(job);

    expect(prisma.maxActionLedgerEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          jobId: 'job-1',
        },
        create: expect.objectContaining({
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
        update: {},
      }),
    );
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          jobId: 'job-1',
          dispatchToken: null,
          remoteMessageId: null,
        }),
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.ENQUEUED,
          ambiguous: false,
          terminal: false,
          enqueuedAt: expect.any(Date),
        }),
      }),
    );
    const create = prisma.maxActionLedgerEntry.upsert.mock.calls[0][0].create;
    expect(JSON.stringify(create.metadata)).not.toContain('hello');
  });

  it('increments attempts when recording worker start', async () => {
    const { service, prisma } = createService();
    const job = createJob({ attempt: 3 });

    await service.recordStarted(job);

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

    expect(prisma.maxActionLedgerEntry.upsert).not.toHaveBeenCalled();
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

    expect(prisma.maxActionLedgerEntry.upsert).not.toHaveBeenCalled();
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

    expect(prisma.maxActionLedgerEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {},
      }),
    );
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          jobId: 'job-1',
          remoteMessageId: null,
        },
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

    expect(prisma.maxActionLedgerEntry.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        create: expect.objectContaining({
          status: MaxActionLedgerStatus.AMBIGUOUS,
          ambiguous: true,
          terminal: true,
        }),
      }),
    );
    expect(prisma.maxActionLedgerEntry.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        create: expect.objectContaining({
          status: MaxActionLedgerStatus.FAILED_RETRYABLE,
          ambiguous: false,
          terminal: false,
          lastStatusCode: 500,
          lastErrorCode: 'server.failure',
        }),
      }),
    );
    expect(prisma.maxActionLedgerEntry.upsert).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        create: expect.objectContaining({
          status: MaxActionLedgerStatus.FAILED_RETRYABLE,
          ambiguous: false,
          terminal: true,
          lastStatusCode: 500,
          lastErrorCode: 'server.failure',
          completedAt: expect.any(Date),
        }),
      }),
    );
  });
});
