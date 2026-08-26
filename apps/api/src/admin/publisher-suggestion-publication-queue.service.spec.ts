import { PublisherSuggestionPublicationQueueService } from './publisher-suggestion-publication-queue.service';

describe('PublisherSuggestionPublicationQueueService', () => {
  const originalRole = process.env.APP_ROLE;

  beforeEach(() => {
    process.env.APP_ROLE = 'publisher';
  });

  afterEach(() => {
    if (originalRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalRole;
    }
    jest.useRealTimers();
  });

  function createHarness(dispatchEnabled: boolean) {
    const queue = {
      getJob: jest.fn(),
      add: jest.fn(),
    };
    const prisma = {
      auditLog: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new PublisherSuggestionPublicationQueueService(
      queue as never,
      prisma as never,
      { dispatchEnabled } as never,
    );
    return { prisma, queue, service };
  }

  it('does not start suggestion recovery while dispatch is disabled', async () => {
    jest.useFakeTimers();
    const { prisma, queue, service } = createHarness(false);

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(120_000);

    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('starts bounded suggestion recovery when dispatch is enabled', async () => {
    const { prisma, service } = createHarness(true);

    service.onModuleInit();
    await Promise.resolve();

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    service.onModuleDestroy();
  });
});
