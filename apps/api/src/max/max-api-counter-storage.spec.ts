import {
  appendMaxApiCounterIncrement,
  MAX_API_METRICS_MINUTE_READER_VERSION,
  maxApiLegacyCounterMinute,
  maxApiMinuteCounterAddress,
  readMaxApiMetricCounts,
} from './max-api-counter-storage';

describe('exact-second MAX diagnostic minute storage', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date(1790877599 * 1000));
  });
  afterEach(() => jest.useRealTimers());
  it.each([
    'maxapi:rps:global:bot-a:critical',
    'maxapi:rps:global:bot-a',
    'maxapi:rps:stack:background',
    'maxapi:rps:stack',
    'maxapi:rps:service:v1:api-action:bot:bot-a:critical',
    'maxapi:rps:service:v1:api-action:stack:critical',
    'maxapi:rps:source:v1:bot-a:background:managed_refresh',
    'maxapi:rate-limit:v1:internal_limiter:stack:critical',
    'maxapi:rate-limit:v1:external_429:bot-a:interactive',
  ])('round-trips every observational counter family: %s', (stem) => {
    const address = maxApiMinuteCounterAddress(`${stem}:1790877599`);
    expect(address.field).toBe('59');
    expect(maxApiLegacyCounterMinute(address.key)).toEqual({
      legacyStem: stem,
      minuteStartSec: 1790877540,
    });
    expect(maxApiMinuteCounterAddress(`${stem}:1790877600`)).toMatchObject({
      field: '0',
      minuteStartSec: 1790877600,
    });
  });

  it('rejects limiter/fence keys and malformed minute boundaries', () => {
    expect(() => maxApiMinuteCounterAddress('maxapi:gcra:v1:bot-a:1790877599')).toThrow();
    expect(() => maxApiMinuteCounterAddress('maxapi:rps:stack:12tail')).toThrow();
    expect(maxApiLegacyCounterMinute('maxapi:rps:stack:v2:1790877599')).toBeNull();
  });

  it.each([6 * 60 * 60])('keeps one layout and a fixed full-minute expiry for TTL %i', (ttlSec) => {
    const transaction = {
      incr: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      hincrby: jest.fn().mockReturnThis(),
      expireat: jest.fn().mockReturnThis(),
    };
    const key = 'maxapi:rps:stack:1790877541';
    appendMaxApiCounterIncrement(transaction as never, { key, ttlSec }, 'legacy');
    expect(transaction.incr).toHaveBeenCalledWith(key);
    expect(transaction.expire).toHaveBeenCalledWith(key, ttlSec);
    expect(transaction.hincrby).not.toHaveBeenCalled();
    jest.clearAllMocks();
    appendMaxApiCounterIncrement(transaction as never, { key, ttlSec }, 'minute');
    appendMaxApiCounterIncrement(
      transaction as never,
      { key: 'maxapi:rps:stack:1790877599', ttlSec },
      'minute',
    );
    expect(transaction.incr).not.toHaveBeenCalled();
    expect(transaction.expire).not.toHaveBeenCalled();
    expect(transaction.hincrby.mock.calls).toEqual([
      ['maxapi:rps:stack:v2:1790877540', '1', 1],
      ['maxapi:rps:stack:v2:1790877540', '59', 1],
    ]);
    expect(transaction.expireat.mock.calls).toEqual([
      ['maxapi:rps:stack:v2:1790877540', 1790877600 + ttlSec],
      ['maxapi:rps:stack:v2:1790877540', 1790877600 + ttlSec],
    ]);
  });

  it.each(['legacy', 'minute'] as const)(
    'retains last-write expiry for short-lived service counters with %s layout',
    (layout) => {
      const transaction = {
        incr: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        hincrby: jest.fn().mockReturnThis(),
        expireat: jest.fn().mockReturnThis(),
      };
      const key = 'maxapi:rps:service:v1:api-action:stack:critical:1790877541';
      appendMaxApiCounterIncrement(transaction as never, { key, ttlSec: 120 }, layout);
      expect(transaction.incr).toHaveBeenCalledWith(key);
      expect(transaction.expire).toHaveBeenCalledWith(key, 120);
      expect(transaction.hincrby).not.toHaveBeenCalled();
      expect(transaction.expireat).not.toHaveBeenCalled();
    },
  );

  it('sums disjoint legacy/minute events and batches only requested second fields', async () => {
    expect(MAX_API_METRICS_MINUTE_READER_VERSION).toBe(1);
    const keys = Array.from(
      { length: 60 },
      (_, offset) => `maxapi:rps:stack:${1790877540 + offset}`,
    );
    const hmget = jest.fn().mockReturnThis();
    const redis = {
      mget: jest.fn(async (...chunk: string[]) =>
        chunk.map((key) => (key === keys[59] ? '3' : null)),
      ),
      pipeline: jest.fn(() => ({
        hmget,
        exec: jest.fn(async () =>
          hmget.mock.calls
            .splice(0)
            .map(([, ...fields]) => [
              null,
              fields.map((field: string) => (field === '59' ? '5' : null)),
            ]),
        ),
      })),
    };
    const counts = await readMaxApiMetricCounts(redis as never, keys, 20);
    expect(counts).toEqual(new Map([[keys[59], 8]]));
    expect(redis.mget).toHaveBeenCalledTimes(3);
    expect(redis.mget.mock.calls.every((call) => call.length <= 20)).toBe(true);
    expect(redis.pipeline).toHaveBeenCalledTimes(3);
  });

  it('clips physically retained service and six-hour fields to their exact logical TTL edges', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const keys = [
      `maxapi:rps:service:v1:api-action:stack:critical:${nowSec - 120}`,
      `maxapi:rps:service:v1:api-action:stack:critical:${nowSec - 119}`,
      `maxapi:rps:stack:${nowSec - 21600}`,
      `maxapi:rps:stack:${nowSec - 21599}`,
    ];
    const requestedFields: string[][] = [];
    const redis = {
      mget: jest.fn(async (...chunk: string[]) => chunk.map(() => null)),
      pipeline: jest.fn(() => ({
        hmget: jest.fn(function (this: unknown, _key: string, ...fields: string[]) {
          requestedFields.push(fields);
          return this;
        }),
        exec: jest.fn(async () => requestedFields.map((fields) => [null, fields.map(() => '5')])),
      })),
    };
    const counts = await readMaxApiMetricCounts(redis as never, keys);
    expect(counts).toEqual(
      new Map([
        [keys[1], 5],
        [keys[3], 5],
      ]),
    );
    expect(requestedFields).toHaveLength(2);
    expect(requestedFields.every((fields) => fields.length === 1)).toBe(true);
  });

  it('fails an incomplete or failed read instead of silently understating governor load', async () => {
    const redis = {
      mget: jest.fn(async () => ['3']),
      pipeline: jest.fn(() => ({
        hmget: jest.fn().mockReturnThis(),
        exec: jest.fn(async () => [[new Error('read unavailable'), null]]),
      })),
    };
    await expect(
      readMaxApiMetricCounts(redis as never, ['maxapi:rps:stack:1790877540']),
    ).rejects.toThrow('read unavailable');
  });
});
