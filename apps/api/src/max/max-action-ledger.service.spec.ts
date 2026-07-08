import { UnrecoverableError } from 'bullmq';
import { MaxActionLedgerService } from './max-action-ledger.service';
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
      findUnique: jest.fn().mockResolvedValue(row),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
  };
  return {
    prisma,
    service: new MaxActionLedgerService(prisma as never),
  };
}

describe('MaxActionLedgerService', () => {
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

  it('records enqueue metadata without storing message text', async () => {
    const { service, prisma } = createService();
    const job = createJob({
      sourceTag: 'interactive',
      trafficClass: 'critical',
      actionHealthLane: 'background',
      autoDeleteDelayMs: 60_000,
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
          status: MaxActionLedgerStatus.ENQUEUED,
          ambiguous: false,
          terminal: false,
          metadata: expect.objectContaining({
            hasText: true,
            textLength: 5,
            autoDeleteDelayMs: 60_000,
          }),
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

    expect(prisma.maxActionLedgerEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          attemptCount: 3,
          status: MaxActionLedgerStatus.IN_PROGRESS,
        }),
        update: expect.objectContaining({
          attemptCount: {
            increment: 1,
          },
          status: MaxActionLedgerStatus.IN_PROGRESS,
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
