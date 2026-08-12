import {
  COMMERCIAL_OCR_PRODUCER_REDIS_OPTIONS,
  COMMERCIAL_OCR_QUEUE_ADD_TIMEOUT_MS,
  CommercialOcrQueueProducer,
} from './commercial-ocr-queue.producer';
import {
  COMMERCIAL_OCR_JOB_NAME,
  COMMERCIAL_OCR_JOB_OPTIONS,
  type CommercialOcrJob,
} from './commercial-ocr.queue';

const job = {
  webhookEventId: 'event-1',
  chatId: 'chat-1',
  messageId: 'message-1',
  sourceCreatedAt: '2026-08-12T08:00:00.000Z',
  imageCount: 1,
  schemaVersion: 1,
  ocrVersion: 'tesseract-rus-eng-v1',
  actionEligible: false,
  idempotencyKey: `commercial-image-ocr__${'a'.repeat(64)}`,
  sourceTag: 'commercial-image-ocr',
  createdAt: '2026-08-12T08:00:01.000Z',
} satisfies CommercialOcrJob;

describe('CommercialOcrQueueProducer', () => {
  it('uses bounded fail-fast Redis options without an offline queue', () => {
    expect(COMMERCIAL_OCR_PRODUCER_REDIS_OPTIONS).toEqual({
      commandTimeout: 1_000,
      connectTimeout: 1_000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: expect.any(Function),
    });
    expect(COMMERCIAL_OCR_PRODUCER_REDIS_OPTIONS.retryStrategy()).toBeNull();
  });

  it('reuses a healthy producer queue', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      close: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
    const factory = jest.fn().mockReturnValue(queue);
    const producer = new CommercialOcrQueueProducer('redis://example.test:6379', factory);

    await expect(producer.add(COMMERCIAL_OCR_JOB_NAME, job, COMMERCIAL_OCR_JOB_OPTIONS)).resolves.toEqual(
      { id: 'job-1' },
    );
    await expect(producer.add(COMMERCIAL_OCR_JOB_NAME, job, COMMERCIAL_OCR_JOB_OPTIONS)).resolves.toEqual(
      { id: 'job-1' },
    );

    expect(factory).toHaveBeenCalledTimes(1);
    expect(queue.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.close).not.toHaveBeenCalled();
    expect(queue.disconnect).not.toHaveBeenCalled();
  });

  it('closes and recreates the producer queue after an add failure', async () => {
    const failedQueue = {
      add: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      close: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
    const healthyQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-2' }),
      close: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
    const factory = jest
      .fn()
      .mockReturnValueOnce(failedQueue)
      .mockReturnValueOnce(healthyQueue);
    const producer = new CommercialOcrQueueProducer('redis://example.test:6379', factory);

    await expect(
      producer.add(COMMERCIAL_OCR_JOB_NAME, job, COMMERCIAL_OCR_JOB_OPTIONS),
    ).rejects.toThrow('redis unavailable');
    await expect(
      producer.add(COMMERCIAL_OCR_JOB_NAME, job, COMMERCIAL_OCR_JOB_OPTIONS),
    ).resolves.toEqual({ id: 'job-2' });

    expect(failedQueue.disconnect).toHaveBeenCalledTimes(1);
    expect(failedQueue.close).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('bounds a hanging add and closes its connection', async () => {
    jest.useFakeTimers();
    const queue = {
      add: jest.fn().mockReturnValue(new Promise(() => undefined)),
      close: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
    const producer = new CommercialOcrQueueProducer(
      'redis://example.test:6379',
      jest.fn().mockReturnValue(queue),
    );

    try {
      const result = expect(
        producer.add(COMMERCIAL_OCR_JOB_NAME, job, COMMERCIAL_OCR_JOB_OPTIONS),
      ).rejects.toThrow('Commercial OCR Queue.add timed out after 1000ms');
      await jest.advanceTimersByTimeAsync(COMMERCIAL_OCR_QUEUE_ADD_TIMEOUT_MS);

      await result;
      expect(queue.disconnect).toHaveBeenCalledTimes(1);
      expect(queue.close).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('closes the live queue on shutdown and rejects later work', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      close: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
    const producer = new CommercialOcrQueueProducer(
      'redis://example.test:6379',
      jest.fn().mockReturnValue(queue),
    );
    await producer.add(COMMERCIAL_OCR_JOB_NAME, job, COMMERCIAL_OCR_JOB_OPTIONS);

    await producer.onModuleDestroy();

    expect(queue.close).toHaveBeenCalledTimes(1);
    expect(queue.disconnect).not.toHaveBeenCalled();
    await expect(
      producer.add(COMMERCIAL_OCR_JOB_NAME, job, COMMERCIAL_OCR_JOB_OPTIONS),
    ).rejects.toThrow('Commercial OCR queue producer is shutting down');
  });

  it('force-disconnects when graceful shutdown close fails', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      close: jest.fn().mockRejectedValue(new Error('quit failed')),
      disconnect: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
    const producer = new CommercialOcrQueueProducer(
      'redis://example.test:6379',
      jest.fn().mockReturnValue(queue),
    );
    await producer.add(COMMERCIAL_OCR_JOB_NAME, job, COMMERCIAL_OCR_JOB_OPTIONS);

    await producer.onModuleDestroy();

    expect(queue.close).toHaveBeenCalledTimes(1);
    expect(queue.disconnect).toHaveBeenCalledTimes(1);
  });
});
