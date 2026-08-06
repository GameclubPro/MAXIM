import { PhotoDuplicateEnqueueService } from './photo-duplicate-enqueue.service';
import { PHOTO_DUPLICATE_ALGORITHM_VERSION } from './photo-duplicate.queue';

describe('PhotoDuplicateEnqueueService', () => {
  it('enqueues only identifiers and uses a deterministic opaque job id', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const orderingStore = {
      announce: jest.fn().mockResolvedValue({ kind: 'registered', actionEligible: false }),
      abandon: jest.fn(),
    };
    const service = new PhotoDuplicateEnqueueService(
      queue as never,
      {
        get: (key: string) => (key === 'PHOTO_DUPLICATE_ROLLOUT_MODE' ? 'shadow' : undefined),
      } as never,
      orderingStore as never,
    );

    await expect(
      service.enqueue({
        webhookEventId: 'event-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        sourceCreatedAt: '2026-08-05T12:00:00.000Z',
        actionEligible: false,
      }),
    ).resolves.toBe('queued');

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [jobName, data, options] = queue.add.mock.calls[0]!;
    expect(jobName).toBe('photo-duplicate-analysis');
    expect(data).toMatchObject({
      webhookEventId: 'event-1',
      chatId: 'chat-1',
      messageId: 'message-1',
      algorithmVersion: PHOTO_DUPLICATE_ALGORITHM_VERSION,
      actionEligible: false,
      retryPolicyName: 'photo-duplicate',
    });
    expect(JSON.stringify(data)).not.toContain('url');
    expect(JSON.stringify(data)).not.toContain('token');
    expect(options.jobId).toMatch(/^photo-duplicate__[a-f0-9]{64}$/u);
    expect(data.idempotencyKey).toBe(options.jobId);
    expect(options.attempts).toBe(5);
    expect(options.delay).toBe(5_000);
    expect(orderingStore.announce).toHaveBeenCalledWith(
      {
        jobId: options.jobId,
        chatId: 'chat-1',
        sourceCreatedAt: '2026-08-05T12:00:00.000Z',
      },
      false,
    );
  });

  it('does not enqueue while the rollout kill switch is off', async () => {
    const queue = { add: jest.fn() };
    const service = new PhotoDuplicateEnqueueService(
      queue as never,
      {
        get: () => 'off',
      } as never,
    );

    await expect(
      service.enqueue({
        webhookEventId: 'event-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        sourceCreatedAt: '2026-08-05T12:00:00.000Z',
        actionEligible: true,
      }),
    ).resolves.toBe('skipped');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('fails open when Redis/BullMQ rejects enqueue', async () => {
    const queue = { add: jest.fn().mockRejectedValue(new Error('redis unavailable')) };
    const orderingStore = {
      announce: jest
        .fn()
        .mockResolvedValueOnce({ kind: 'registered', actionEligible: true })
        .mockResolvedValueOnce({ kind: 'registered', actionEligible: false }),
      abandon: jest.fn(),
    };
    const service = new PhotoDuplicateEnqueueService(
      queue as never,
      {
        get: () => 'shadow',
      } as never,
      orderingStore as never,
    );

    await expect(
      service.enqueue({
        webhookEventId: 'event-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        sourceCreatedAt: '2026-08-05T12:00:00.000Z',
        actionEligible: true,
      }),
    ).resolves.toBe('failed');

    expect(orderingStore.announce).toHaveBeenNthCalledWith(1, expect.any(Object), true);
    expect(orderingStore.announce).toHaveBeenNthCalledWith(2, expect.any(Object), false);
    expect(orderingStore.abandon).not.toHaveBeenCalled();
  });

  it('queues the absorbing observation-only latch returned by ordering', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const orderingStore = {
      announce: jest.fn().mockResolvedValue({ kind: 'registered', actionEligible: false }),
      abandon: jest.fn(),
    };
    const service = new PhotoDuplicateEnqueueService(
      queue as never,
      {
        get: () => 'shadow',
      } as never,
      orderingStore as never,
    );

    await expect(
      service.enqueue({
        webhookEventId: 'event-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        sourceCreatedAt: '2026-08-05T12:00:00.000Z',
        actionEligible: true,
      }),
    ).resolves.toBe('queued');

    expect(orderingStore.announce).toHaveBeenCalledWith(expect.any(Object), true);
    expect(queue.add.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ actionEligible: false }),
    );
  });

  it('queues observation-only work when ordering registration is unavailable', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const orderingStore = {
      announce: jest.fn().mockResolvedValue({ kind: 'unavailable' }),
      abandon: jest.fn(),
    };
    const service = new PhotoDuplicateEnqueueService(
      queue as never,
      {
        get: () => 'shadow',
      } as never,
      orderingStore as never,
    );

    await expect(
      service.enqueue({
        webhookEventId: 'event-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        sourceCreatedAt: '2026-08-05T12:00:00.000Z',
        actionEligible: true,
      }),
    ).resolves.toBe('queued');

    expect(queue.add.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ actionEligible: false }),
    );
  });

  it('queues observation-only work when the optional ordering store is absent', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const service = new PhotoDuplicateEnqueueService(
      queue as never,
      {
        get: () => 'shadow',
      } as never,
    );

    await expect(
      service.enqueue({
        webhookEventId: 'event-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        sourceCreatedAt: '2026-08-05T12:00:00.000Z',
        actionEligible: true,
      }),
    ).resolves.toBe('queued');

    expect(queue.add.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ actionEligible: false }),
    );
  });

  it('does not enqueue a permissive replay after the opaque job identity completed', async () => {
    const queue = { add: jest.fn() };
    const orderingStore = {
      announce: jest.fn().mockResolvedValue({ kind: 'completed' }),
      abandon: jest.fn(),
    };
    const service = new PhotoDuplicateEnqueueService(
      queue as never,
      {
        get: () => 'shadow',
      } as never,
      orderingStore as never,
    );

    await expect(
      service.enqueue({
        webhookEventId: 'event-1-replay',
        chatId: 'chat-1',
        messageId: 'message-1',
        sourceCreatedAt: '2026-08-05T12:00:00.000Z',
        actionEligible: true,
      }),
    ).resolves.toBe('queued');

    expect(queue.add).not.toHaveBeenCalled();
    expect(orderingStore.announce).toHaveBeenCalledWith(
      {
        jobId: expect.stringMatching(/^photo-duplicate__[a-f0-9]{64}$/u),
        chatId: 'chat-1',
        sourceCreatedAt: '2026-08-05T12:00:00.000Z',
      },
      true,
    );
  });
});
