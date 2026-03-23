import { WebhookStatus } from '@prisma/client';
import { WebhookOutboxService } from './webhook-outbox.service';

type JobMock = {
  getState: jest.Mock<Promise<string>, []>;
  retry: jest.Mock<Promise<void>, []>;
};

function createService(params?: {
  findManyResult?: Array<{ id: string; enqueueAttempts: number }>;
  addError?: Error | null;
  job?: JobMock | null;
}) {
  const prisma = {
    webhookEvent: {
      findMany: jest.fn().mockResolvedValue(params?.findManyResult ?? []),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    moderationEvent: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    violation: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };

  const queue = {
    add: params?.addError
      ? jest.fn().mockRejectedValue(params.addError)
      : jest.fn().mockResolvedValue(undefined),
    getJob: jest.fn().mockResolvedValue(params?.job ?? null),
  };

  const configValues: Record<string, number> = {
    ENQUEUE_POLL_INTERVAL_MS: 500,
    ENQUEUE_BATCH_SIZE: 200,
    ENQUEUE_MAX_ATTEMPTS: 120,
    WEBHOOK_RETENTION_DAYS: 7,
    MODERATION_RETENTION_DAYS: 90,
  };
  const config = {
    get: jest.fn((key: string, fallback?: number) =>
      key in configValues ? configValues[key] : fallback,
    ),
  };

  const service = new WebhookOutboxService(prisma as never, config as never, queue as never);
  return { service, prisma, queue };
}

describe('WebhookOutboxService', () => {
  it('requests FAILED candidates only when nextEnqueueAt is due', async () => {
    const { service, prisma } = createService();

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(prisma.webhookEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: WebhookStatus.FAILED,
              nextEnqueueAt: { lte: expect.any(Date) },
            }),
          ]),
        }),
      }),
    );
  });

  it('does not increment attempts when existing job is already waiting', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('waiting'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma } = createService({
      findManyResult: [{ id: 'evt-1', enqueueAttempts: 5 }],
      addError: new Error('Job evt-1 already exists'),
      job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.data.status).toBe(WebhookStatus.QUEUED);
    expect(updateArg.data.queuedAt).toBeInstanceOf(Date);
    expect(updateArg.data.enqueueAttempts).toBeUndefined();
    expect(job.retry).not.toHaveBeenCalled();
  });

  it('retries existing failed job and increments attempts once', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma } = createService({
      findManyResult: [{ id: 'evt-2', enqueueAttempts: 5 }],
      addError: new Error('Job evt-2 already exists'),
      job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(job.retry).toHaveBeenCalledTimes(1);
    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.data.status).toBe(WebhookStatus.QUEUED);
    expect(updateArg.data.enqueueAttempts).toEqual({ increment: 1 });
  });

  it('retries an existing failed job before attempting duplicate add', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma, queue } = createService({
      findManyResult: [{ id: 'evt-2b', enqueueAttempts: 5 }],
      job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queue.getJob).toHaveBeenCalledWith('evt-2b');
    expect(queue.add).not.toHaveBeenCalled();
    expect(job.retry).toHaveBeenCalledTimes(1);
    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.data.status).toBe(WebhookStatus.QUEUED);
    expect(updateArg.data.enqueueAttempts).toEqual({ increment: 1 });
  });

  it('marks event as FAILED without re-enqueue when max attempts is reached', async () => {
    const { service, prisma, queue } = createService();

    await (service as unknown as { enqueueOne: (id: string, attempts: number) => Promise<void> }).enqueueOne(
      'evt-3',
      120,
    );

    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.FAILED,
          nextEnqueueAt: null,
        }),
      }),
    );
  });
});
