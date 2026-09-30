import {
  recordPublicationDispatchOutcome,
  recordPublicationReceiptTiming,
} from './publication-delivery-timing';

describe('Publication delivery timing', () => {
  const scheduledAt = new Date('2026-09-30T10:00:00Z');

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
