import { PhotoDuplicateEnqueueService } from './photo-duplicate-enqueue.service';

describe('PhotoDuplicateEnqueueService', () => {
  it('enqueues only identifiers and uses a deterministic opaque job id', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const orderingStore = {
      announce: jest.fn().mockResolvedValue('registered'),
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
      }),
    ).resolves.toBe('queued');

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [jobName, data, options] = queue.add.mock.calls[0]!;
    expect(jobName).toBe('photo-duplicate-analysis');
    expect(data).toMatchObject({
      webhookEventId: 'event-1',
      chatId: 'chat-1',
      messageId: 'message-1',
      algorithmVersion: 1,
      retryPolicyName: 'photo-duplicate',
    });
    expect(JSON.stringify(data)).not.toContain('url');
    expect(JSON.stringify(data)).not.toContain('token');
    expect(options.jobId).toMatch(/^photo-duplicate__[a-f0-9]{64}$/u);
    expect(data.idempotencyKey).toBe(options.jobId);
    expect(options.attempts).toBe(5);
    expect(options.delay).toBe(5_000);
    expect(orderingStore.announce).toHaveBeenCalledWith({
      jobId: options.jobId,
      chatId: 'chat-1',
      sourceCreatedAt: '2026-08-05T12:00:00.000Z',
    });
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
      }),
    ).resolves.toBe('skipped');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('fails open when Redis/BullMQ rejects enqueue', async () => {
    const queue = { add: jest.fn().mockRejectedValue(new Error('redis unavailable')) };
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
      }),
    ).resolves.toBe('failed');
  });
});
