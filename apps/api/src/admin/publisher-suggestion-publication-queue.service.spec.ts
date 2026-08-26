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

  function createHarness(dispatchEnabled: boolean, globallyPaused = false) {
    const queue = {
      getJob: jest.fn(),
      add: jest.fn(),
    };
    const prisma = {
      auditLog: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const dispatchHealth = {
      isGloballyPaused: jest.fn().mockResolvedValue(globallyPaused),
    };
    const service = new PublisherSuggestionPublicationQueueService(
      queue as never,
      prisma as never,
      dispatchHealth as never,
      { dispatchEnabled } as never,
    );
    return { dispatchHealth, prisma, queue, service };
  }

  it('does not start suggestion recovery while dispatch is disabled', async () => {
    jest.useFakeTimers();
    const { dispatchHealth, prisma, queue, service } = createHarness(false);

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(120_000);

    expect(dispatchHealth.isGloballyPaused).not.toHaveBeenCalled();
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

  it('keeps enabled recovery timers idle before DB or queue work while globally paused', async () => {
    jest.useFakeTimers();
    const { dispatchHealth, prisma, queue, service } = createHarness(true, true);

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();

    dispatchHealth.isGloballyPaused.mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(60_000);

    expect(dispatchHealth.isGloballyPaused).toHaveBeenCalledTimes(3);
    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('fails recovery closed when the pause lookup fails', async () => {
    const { dispatchHealth, prisma, queue, service } = createHarness(true);
    dispatchHealth.isGloballyPaused.mockRejectedValueOnce(new Error('redis unavailable'));

    service.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();

    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });
});
