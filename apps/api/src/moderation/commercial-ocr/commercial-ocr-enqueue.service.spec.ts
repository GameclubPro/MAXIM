import { CommercialOcrEnqueueService } from './commercial-ocr-enqueue.service';

const input = {
  webhookEventId: 'event-1',
  chatId: 'chat-1',
  messageId: 'message-1',
  sourceCreatedAt: '2026-08-12T08:00:00.000Z',
  imageCount: 2,
  actionEligible: true,
};

const admissionLimits = {
  maxGlobalImageUnits: 16,
  maxChatImageUnits: 10,
  maxJobAgeMs: 300_000,
  reservationTtlMs: 600_000,
};

function config(values: Record<string, unknown> = {}) {
  return {
    get: (key: string) =>
      values[key] ??
      (
        {
          COMMERCIAL_OCR_ROLLOUT_MODE: 'on',
          COMMERCIAL_OCR_VERSION: 'tesseract-rus-eng-v1',
        } as Record<string, unknown>
      )[key],
  };
}

function admission(overrides: Record<string, jest.Mock> = {}) {
  return {
    reserve: jest.fn().mockResolvedValue({ kind: 'admitted', state: 'pending' }),
    activate: jest.fn().mockResolvedValue('activated'),
    suppress: jest.fn().mockResolvedValue('suppressed'),
    ...overrides,
  };
}

describe('CommercialOcrEnqueueService', () => {
  it('queues enforce work as non-actionable data and registers activation for webhook commit', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const store = admission();
    const pending: unknown[] = [];
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
    );

    await expect(
      service.enqueue({
        ...input,
        registerPendingActivation: (activation) => {
          pending.push(activation);
        },
      }),
    ).resolves.toBe('queued');

    expect(store.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ imageCount: 2, actionEligible: true, limits: admissionLimits }),
    );
    const [jobName, data, options] = queue.add.mock.calls[0]!;
    expect(jobName).toBe('commercial-image-ocr-analysis');
    expect(data).toMatchObject({
      webhookEventId: 'event-1',
      chatId: 'chat-1',
      messageId: 'message-1',
      imageCount: 2,
      actionEligible: false,
      sourceTag: 'commercial-image-ocr',
    });
    expect(JSON.stringify(data)).not.toMatch(/(?:url|token|bytes|base64)/iu);
    expect(options.jobId).toMatch(/^commercial-image-ocr__[a-f0-9]{64}$/u);
    expect(data.idempotencyKey).toBe(options.jobId);
    expect(store.activate).not.toHaveBeenCalled();
    expect(pending).toEqual([
      {
        jobId: options.jobId,
        chatId: 'chat-1',
        imageCount: 2,
        reservationTtlMs: 600_000,
      },
    ]);
  });

  it('suppresses enforce work when no canonical webhook collector is provided', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const store = admission();
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
    );

    await expect(service.enqueue(input)).resolves.toBe('queued');

    expect(store.activate).not.toHaveBeenCalled();
    expect(store.suppress).toHaveBeenCalledWith({
      jobId: expect.stringMatching(/^commercial-image-ocr__[a-f0-9]{64}$/u),
      chatId: 'chat-1',
      imageCount: 2,
      tombstoneTtlMs: 600_000,
    });
  });

  it('queues a newly admitted shadow observation without trying to activate it', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const store = admission({
      reserve: jest.fn().mockResolvedValue({ kind: 'admitted', state: 'observation' }),
    });
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config({ COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow' }) as never,
      store as never,
    );

    await expect(service.enqueue({ ...input, registerPendingActivation: jest.fn() })).resolves.toBe(
      'queued',
    );
    expect(store.reserve).toHaveBeenCalledWith(expect.objectContaining({ actionEligible: false }));
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(store.activate).not.toHaveBeenCalled();
  });

  it('stores a suppression tombstone before any true replay can reserve capacity', async () => {
    const queue = { add: jest.fn() };
    const store = admission();
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
    );

    await expect(
      service.enqueue({
        ...input,
        actionEligible: false,
        registerPendingActivation: jest.fn(),
      }),
    ).resolves.toBe('skipped');
    expect(store.suppress).toHaveBeenCalledWith({
      jobId: expect.stringMatching(/^commercial-image-ocr__[a-f0-9]{64}$/u),
      chatId: 'chat-1',
      imageCount: 2,
      tombstoneTtlMs: 600_000,
    });
    expect(store.reserve).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not resurrect queued work after a suppression absorbed the identity', async () => {
    const queue = { add: jest.fn() };
    const store = admission({
      reserve: jest.fn().mockResolvedValue({ kind: 'duplicate', state: 'observation' }),
    });
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
    );

    await expect(service.enqueue({ ...input, registerPendingActivation: jest.fn() })).resolves.toBe(
      'skipped',
    );
    expect(queue.add).not.toHaveBeenCalled();
    expect(store.activate).not.toHaveBeenCalled();
  });

  it('skips all Redis and queue work while rollout is off', async () => {
    const queue = { add: jest.fn() };
    const store = admission();
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config({ COMMERCIAL_OCR_ROLLOUT_MODE: 'off' }) as never,
      store as never,
    );

    await expect(service.enqueue({ ...input, registerPendingActivation: jest.fn() })).resolves.toBe(
      'skipped',
    );
    expect(store.reserve).not.toHaveBeenCalled();
    expect(store.suppress).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('leaves the job pending and fails open when webhook-time activation cannot be confirmed', async () => {
    const store = admission({ activate: jest.fn().mockResolvedValue('unavailable') });
    const service = new CommercialOcrEnqueueService(undefined, config() as never, store as never);

    await expect(
      service.activatePending({
        jobId: `commercial-image-ocr__${'a'.repeat(64)}`,
        chatId: 'chat-1',
        imageCount: 2,
        reservationTtlMs: 600_000,
      }),
    ).resolves.toBe(false);
    expect(store.activate).toHaveBeenCalledWith({
      jobId: `commercial-image-ocr__${'a'.repeat(64)}`,
      tombstoneTtlMs: 600_000,
    });
    expect(store.suppress).toHaveBeenCalledWith({
      jobId: `commercial-image-ocr__${'a'.repeat(64)}`,
      chatId: 'chat-1',
      imageCount: 2,
      tombstoneTtlMs: 600_000,
    });
  });

  it('suppresses an expired pending reservation to release its capacity', async () => {
    const store = admission({ activate: jest.fn().mockResolvedValue('expired') });
    const service = new CommercialOcrEnqueueService(undefined, config() as never, store as never);

    await expect(
      service.activatePending({
        jobId: `commercial-image-ocr__${'d'.repeat(64)}`,
        chatId: 'chat-1',
        imageCount: 2,
        reservationTtlMs: 600_000,
      }),
    ).resolves.toBe(false);
    expect(store.suppress).toHaveBeenCalledWith({
      jobId: `commercial-image-ocr__${'d'.repeat(64)}`,
      chatId: 'chat-1',
      imageCount: 2,
      tombstoneTtlMs: 600_000,
    });
  });

  it('settles activation batches independently when one activation throws', async () => {
    const store = admission({
      activate: jest
        .fn()
        .mockRejectedValueOnce(new Error('redis timeout'))
        .mockResolvedValueOnce('activated'),
    });
    const service = new CommercialOcrEnqueueService(undefined, config() as never, store as never);
    const activations = [
      {
        jobId: `commercial-image-ocr__${'e'.repeat(64)}`,
        chatId: 'chat-1',
        imageCount: 1,
        reservationTtlMs: 600_000,
      },
      {
        jobId: `commercial-image-ocr__${'f'.repeat(64)}`,
        chatId: 'chat-1',
        imageCount: 1,
        reservationTtlMs: 600_000,
      },
    ];

    await expect(service.activatePendingBatch(activations)).resolves.toBeUndefined();
    expect(store.activate).toHaveBeenCalledTimes(2);
  });

  it('fails open when Queue.add times out and suppression also fails', async () => {
    const queue = { add: jest.fn().mockRejectedValue(new Error('timeout')) };
    const store = admission({ suppress: jest.fn().mockResolvedValue('unavailable') });
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
    );

    await expect(service.enqueue({ ...input, registerPendingActivation: jest.fn() })).resolves.toBe(
      'failed',
    );
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.suppress).toHaveBeenCalledWith(
      expect.objectContaining({ tombstoneTtlMs: 600_000 }),
    );
  });

  it('bounds a hanging Queue.add and suppresses any late-created job', async () => {
    jest.useFakeTimers();
    let finishAdd: ((value: { id: string }) => void) | undefined;
    const queue = {
      add: jest.fn().mockReturnValue(
        new Promise<{ id: string }>((resolve) => {
          finishAdd = resolve;
        }),
      ),
    };
    const store = admission();
    const registerPendingActivation = jest.fn();
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
    );

    try {
      const result = service.enqueue({ ...input, registerPendingActivation });

      await jest.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe('failed');
      expect(store.suppress).toHaveBeenCalledWith({
        jobId: expect.stringMatching(/^commercial-image-ocr__[a-f0-9]{64}$/u),
        chatId: 'chat-1',
        imageCount: 2,
        tombstoneTtlMs: 600_000,
      });
      expect(registerPendingActivation).not.toHaveBeenCalled();

      finishAdd?.({ id: 'late-job' });
      await Promise.resolve();
      expect(registerPendingActivation).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports a concurrently suppressed commit activation without rearming the identity', async () => {
    const store = admission({ activate: jest.fn().mockResolvedValue('suppressed') });
    const service = new CommercialOcrEnqueueService(undefined, config() as never, store as never);

    await expect(
      service.activatePending({
        jobId: `commercial-image-ocr__${'b'.repeat(64)}`,
        chatId: 'chat-1',
        imageCount: 2,
        reservationTtlMs: 600_000,
      }),
    ).resolves.toBe(false);
    expect(store.activate).toHaveBeenCalledTimes(1);
  });

  it('suppresses a pending admission through the webhook failure path', async () => {
    const store = admission();
    const service = new CommercialOcrEnqueueService(undefined, config() as never, store as never);

    await expect(
      service.suppressPending({
        jobId: `commercial-image-ocr__${'c'.repeat(64)}`,
        chatId: 'chat-1',
        imageCount: 2,
        reservationTtlMs: 600_000,
      }),
    ).resolves.toBe(true);
    expect(store.suppress).toHaveBeenCalledWith({
      jobId: `commercial-image-ocr__${'c'.repeat(64)}`,
      chatId: 'chat-1',
      imageCount: 2,
      tombstoneTtlMs: 600_000,
    });
  });
});
