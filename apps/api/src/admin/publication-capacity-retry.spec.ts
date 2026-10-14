import { MaxApiCircuitOpenError, MaxApiInternalRateLimitError } from '../max/max-client.service';
import { resolvePublicationCapacityRetry } from './publication-capacity-retry';
import { selectPublisherPublicationAdmissionBatch } from './publisher-publication-recipient-admission';

const now = new Date('2026-10-14T08:00:05Z');
describe('durable publication capacity retry', () => {
  it('backs off 30/60/120/240/300 seconds from the refusal, not a minute boundary', () => {
    const error = { response: { status: 429 } };
    expect(
      [0, 1, 2, 3, 4, 100].map(
        (count) =>
          resolvePublicationCapacityRetry(error, now, count)!.retryAt.getTime() - now.getTime(),
      ),
    ).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });

  it.each([
    [{ response: { status: 429, headers: { 'retry-after': '30' } } }, 30_000],
    [
      { response: { status: 429, headers: { 'Retry-After': 'Wed, 14 Oct 2026 08:00:35 GMT' } } },
      30_000,
    ],
    [{ response: { status: 429, data: { retry_after_ms: 250 } } }, 250],
    [new MaxApiInternalRateLimitError('capacity', 250), 250],
    [new MaxApiCircuitOpenError('publik', 1234), 1234],
  ])('preserves the exact known lower bound, including subsecond permits', (error, delay) => {
    expect(resolvePublicationCapacityRetry(error, now, 10)?.retryAt.getTime()).toBe(+now + delay);
  });

  it.each([
    { code: 'MAX_API_INTERNAL_RATE_LIMIT', managedBroadcastSendStarted: false },
    { code: 'MAX_API_CIRCUIT_OPEN', preDispatch: true, managedBroadcastSendStarted: false },
    { response: { status: 503 }, cause: { response: { status: 429 } } },
    Object.assign(new MaxApiInternalRateLimitError('capacity', 250), {
      managedBroadcastSendStarted: true,
    }),
    {
      cause: Object.assign(new MaxApiInternalRateLimitError('capacity', 250), {
        managedBroadcastSendStarted: true,
      }),
    },
    { response: {}, cause: new MaxApiInternalRateLimitError('capacity', 250) },
    Object.assign(new Error('ambiguous MAX send'), { cause: { response: { status: 429 } } }),
    { code: 'ETIMEDOUT', managedBroadcastSendStarted: true },
  ])('does not turn unknown outcomes or forged local rejections into retries', (error) => {
    expect(resolvePublicationCapacityRetry(error, now)).toBeNull();
  });

  it('jitter never shortens MAX cooldown and remains bounded', () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const error = { response: { status: 429 } };
      const base = +resolvePublicationCapacityRetry(error, now, attempt)!.retryAt;
      for (const fraction of [0, 0.3, 1, Number.NaN, Infinity]) {
        const at = +resolvePublicationCapacityRetry(error, now, attempt, fraction)!.retryAt;
        expect(at).toBeGreaterThanOrEqual(base);
        expect(at - base).toBeLessThanOrEqual(Math.min(5000, (base - +now) / 10));
      }
    }
  });

  it('keeps a deferred target out of a later quantum without blocking an independent target', () => {
    const retryAt = new Date(+now + 30_000);
    const delivery = {
      status: 'PENDING' as const,
      lastErrorCode: null,
      updatedAt: now,
      dispatchBlockerCode: null,
      dispatchBlockedAt: null,
    };
    const waiting = { ...delivery, id: 'waiting', targetChatId: 'one', nextAttemptAt: retryAt };
    const ready = { ...delivery, id: 'ready', targetChatId: 'two', nextAttemptAt: null };
    expect(selectPublisherPublicationAdmissionBatch([waiting, ready], 4, now)).toEqual({
      deliveries: [ready],
      pendingNotBefore: retryAt,
    });
    expect(selectPublisherPublicationAdmissionBatch([waiting], 4, retryAt).deliveries).toEqual([
      waiting,
    ]);
  });
});
