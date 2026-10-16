import {
  createPublicationExecutionObserver,
  measurePublicationStage,
  recordPublicationDispatchOutcome,
  recordPublicationReceiptTiming,
  recordPublicationWaitTiming,
} from './publication-delivery-timing';

describe('Publication delivery timing', () => {
  const scheduledAt = new Date('2026-09-30T10:00:00Z');

  afterEach(() => jest.useRealTimers());

  it('distinguishes the original first claim clock from a persisted retry due time', () => {
    jest.useFakeTimers().setSystemTime(new Date(scheduledAt.getTime() + 12_000));
    const logger = { log: jest.fn() };
    const observer = createPublicationExecutionObserver(
      logger,
      {
        publicationOccurrenceId: 'private-occurrence',
        mediaType: 'video',
        imageEnabled: false,
      },
      true,
    );
    observer.onOccurrenceScheduledAt(new Date(scheduledAt.getTime() + 60_000), {
      mode: 'NOW',
      intentCreatedAt: scheduledAt,
    });
    observer.observeClaim({ attemptCount: 0, capacityDeferralCount: 0 });
    observer.observeClaim({
      attemptCount: 0,
      capacityDeferralCount: 1,
      nextAttemptAt: new Date(scheduledAt.getTime() + 10_000),
      waitReason: 'local_capacity',
    });
    expect(logger.log.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        stage: 'initial_recipient_claim',
        mode: 'NOW',
        media: 'video',
        durationMs: 12_000,
      }),
      expect.objectContaining({
        stage: 'recipient_retry_lateness',
        reason: 'local_capacity',
        durationMs: 2_000,
      }),
    ]);
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('private');
  });

  it('does not carry a previous recipient acknowledgement into a recovery receipt', () => {
    jest.useFakeTimers().setSystemTime(scheduledAt);
    const logger = { log: jest.fn() };
    const observer = createPublicationExecutionObserver(
      logger,
      {
        publicationOccurrenceId: 'occurrence',
        mediaType: null,
        imageEnabled: true,
      },
      true,
    );
    observer.onOccurrenceScheduledAt(scheduledAt, { mode: 'ONCE', intentCreatedAt: scheduledAt });
    observer.observeClaim({ attemptCount: 0 });
    observer.observeAcknowledgement();
    jest.advanceTimersByTime(250);
    observer.observeReceipt();
    observer.observeClaim({ attemptCount: 1 });
    jest.advanceTimersByTime(1_000);
    observer.observeReceipt();
    const receiptIntervals = logger.log.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stage === 'observed_acknowledgement_to_receipt');
    expect(receiptIntervals).toEqual([
      expect.objectContaining({ durationMs: 250, clock: 'wall', media: 'image' }),
      expect.objectContaining({ durationMs: null, clock: 'unknown' }),
    ]);
  });

  it.each([null, new Date('invalid'), new Date(scheduledAt.getTime() + 1)])(
    'preserves unknown interval evidence for absent, invalid or backwards clocks: %s',
    (from) => {
      const logger = { log: jest.fn() };
      recordPublicationWaitTiming(logger, {
        stage: 'recipient_retry_lateness',
        from,
        to: scheduledAt,
        reason: 'private-user-content',
      });
      expect(logger.log.mock.calls[0]![0]).toMatchObject({
        durationMs: null,
        clock: 'unknown',
        reason: 'unknown',
      });
      expect(JSON.stringify(logger.log.mock.calls)).not.toContain('private');
    },
  );

  it('keeps failing logger and date accessors outside dispatch control flow', () => {
    const logger = {
      get log(): never {
        throw new Error('logger unavailable');
      },
    };
    const invalidClock = new Date();
    invalidClock.getTime = () => {
      throw new Error('clock unavailable');
    };
    expect(() =>
      recordPublicationWaitTiming(logger, {
        stage: 'wakeup_queue',
        from: scheduledAt,
        to: scheduledAt,
      }),
    ).not.toThrow();
    expect(() =>
      recordPublicationWaitTiming(
        { log: jest.fn() },
        {
          stage: 'wakeup_queue',
          from: invalidClock,
          to: scheduledAt,
        },
      ),
    ).not.toThrow();
  });

  it('emits no execution observations for a disabled or non-publication observer', () => {
    const logger = { log: jest.fn() };
    for (const [enabled, publicationOccurrenceId] of [
      [false, 'occurrence'],
      [true, null],
    ] as const) {
      const observer = createPublicationExecutionObserver(
        logger,
        {
          publicationOccurrenceId,
          mediaType: null,
          imageEnabled: false,
        },
        enabled,
      );
      observer.observeClaim({ attemptCount: 0 });
      observer.observeAcknowledgement();
      observer.observeReceipt();
    }
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('observes failures without swallowing the error or leaking its content', async () => {
    const logger = { log: jest.fn() };
    const failure = new Error('private target and content');
    await expect(
      measurePublicationStage(logger, 'target_preparation', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(logger.log.mock.calls[0]![0]).toMatchObject({
      metric: 'publication_stage_v1',
      stage: 'target_preparation',
      outcome: 'threw',
    });
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('private');
  });

  it('keeps the original work pending and preserves its result despite logging failure', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const logger = {
      log: jest.fn(() => {
        throw new Error('logger down');
      }),
    };
    const settled = jest.fn();
    const work = measurePublicationStage(
      logger,
      'dispatch_quantum',
      async () => {
        await gate;
        return 42;
      },
      'deadline',
    );
    void work.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
    release();
    await expect(work).resolves.toBe(42);
  });

  it('measures scheduled delivery through durable receipt persistence with fixed labels', () => {
    const logger = { log: jest.fn() };
    recordPublicationReceiptTiming(logger, {
      mode: 'RECURRENCE',
      media: 'image',
      scheduledAt,
      receiptPersistedAt: new Date(scheduledAt.getTime() + 12_000),
    });
    expect(logger.log).toHaveBeenCalledWith(
      {
        metric: 'publication_delivery_v1',
        scope: 'delivery',
        outcome: 'receipt_persisted',
        mode: 'RECURRENCE',
        media: 'image',
        clock: 'scheduled_at',
        durationMs: 12_000,
        latencyBucket: 'le_15000ms',
      },
      'Publication delivery observation',
    );
  });

  it('keeps NOW on the original intent clock rather than a retried nextSendAt', () => {
    const logger = { log: jest.fn() };
    recordPublicationReceiptTiming(logger, {
      mode: 'NOW',
      media: 'video',
      scheduledAt: new Date(scheduledAt.getTime() + 7_200_000),
      intentCreatedAt: scheduledAt,
      receiptPersistedAt: new Date(scheduledAt.getTime() + 7_201_000),
    });
    expect(logger.log.mock.calls[0]![0]).toMatchObject({
      clock: 'intent_created_at',
      durationMs: 7_201_000,
      latencyBucket: 'over_300000ms',
    });
  });

  it.each([null, new Date('invalid'), new Date(scheduledAt.getTime() + 1_000)])(
    'reports unknown timing rather than zero latency for %s',
    (reference) => {
      const logger = { log: jest.fn() };
      recordPublicationReceiptTiming(logger, {
        mode: 'ONCE',
        media: 'none',
        scheduledAt: reference,
        receiptPersistedAt: scheduledAt,
      });
      expect(logger.log.mock.calls[0]![0]).toMatchObject({
        clock: 'unknown',
        durationMs: null,
        latencyBucket: 'unknown',
      });
    },
  );

  it('normalizes arbitrary blocker details and separates deferrals from occurrence outcomes', () => {
    const logger = { log: jest.fn() };
    recordPublicationDispatchOutcome(logger, {
      scope: 'deferral',
      outcome: 'blocked',
      reason: 'secret-user-123',
    });
    recordPublicationDispatchOutcome(logger, {
      mode: 'ONCE',
      scope: 'occurrence',
      outcome: 'missed_window',
    });
    expect(logger.log.mock.calls[0]![0]).toMatchObject({ scope: 'deferral', reason: 'other' });
    expect(logger.log.mock.calls[1]![0]).toMatchObject({
      scope: 'occurrence',
      outcome: 'missed_window',
      reason: 'window_expired',
    });
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('secret-user');
  });

  it('cannot turn a logging outage into a delivery error after the receipt commit', () => {
    const logger = {
      log: jest.fn(() => {
        throw new Error('logging unavailable');
      }),
    };
    expect(() =>
      recordPublicationReceiptTiming(logger, {
        mode: 'ONCE',
        media: 'none',
        scheduledAt,
        receiptPersistedAt: scheduledAt,
      }),
    ).not.toThrow();
    expect(() =>
      recordPublicationDispatchOutcome(logger, {
        scope: 'deferral',
        outcome: 'blocked',
        reason: 'bot_access_expired',
      }),
    ).not.toThrow();
  });
});
