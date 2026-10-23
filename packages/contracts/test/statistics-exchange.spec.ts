import { describe, expect, it } from 'vitest';
import {
  exchangeMeasurementKey,
  exchangeMeasurementIdentity,
  validateExchangePage,
  type ExchangeMeasurement,
  type ExchangeStatisticsPage,
} from '../src/statistics-exchange.js';

const bucket = '2026-10-20T00:00:00.000Z';
function observation(at = bucket): ExchangeMeasurement {
  return {
    origin: 'EXCHANGE',
    method: 'utc-buckets-v1',
    revision: 1,
    data: { metric: 'AUDIENCE', bucket: at, observedAt: bucket, value: 100 },
  };
}
function page(rows: ExchangeMeasurement[]): ExchangeStatisticsPage {
  return {
    manifest: {
      version: 2,
      grantId: '00000000-0000-4000-8000-000000000001',
      grantRevision: 1,
      generationId: '00000000-0000-4000-8000-000000000002',
      bindingId: '00000000-0000-4000-8000-000000000003',
      entityId: '-123',
      kind: 'CHANNEL',
      origin: 'EXCHANGE',
      producerRevision: 1,
      method: 'utc-buckets-v1',
      from: bucket,
      to: '2026-10-21T00:00:00.000Z',
      asOf: '2026-10-21T00:00:00.000Z',
      rowCount: rows.length,
      sha256: '0'.repeat(64),
      complete: false,
      horizonToleranceSeconds: 900,
      metrics: [
        {
          metric: 'AUDIENCE',
          complete: false,
          checkedAt: bucket,
          nextExpectedAt: null,
          error: false,
        },
      ],
    },
    rows,
    nextCursor: null,
  };
}

describe('statistics exchange measurement identity', () => {
  it.each(['2026-10-20T00:00:00Z', '2026-10-20T00:00:00.0Z'])(
    'rejects duplicate UTC buckets with the alternative representation %s',
    (alias) => {
      expect(exchangeMeasurementIdentity(observation(alias))).toBe(
        exchangeMeasurementIdentity(observation()),
      );
      expect(() => validateExchangePage(page([observation(), observation(alias)]))).toThrow(
        'Invalid exchange measurement identity or interval',
      );
    },
  );

  it('preserves the producer bucket representation and existing wire ordering key', () => {
    const row = observation('2026-10-20T00:00:00Z');
    expect(validateExchangePage(page([row])).rows).toEqual([row]);
    expect(exchangeMeasurementKey(row)).toBe('AUDIENCE:2026-10-20T00:00:00Z:');
  });

  it('keeps different observation days independent', () => {
    const later = observation('2026-10-21T00:00:00Z');
    later.data.observedAt = later.data.bucket;
    const value = page([observation(), later]);
    value.manifest.to = value.manifest.asOf = '2026-10-22T00:00:00.000Z';
    expect(validateExchangePage(value).rows).toHaveLength(2);
  });

  it('keeps timed-view horizons independent for the same bucket', () => {
    const reach = (horizon: 24 | 48): ExchangeMeasurement => ({
      ...observation(),
      data: {
        metric: 'REACH',
        bucket,
        horizon,
        posts: 1,
        samples: 1,
        views: 100,
        observedAt: '2026-10-21T00:00:00.000Z',
        incomplete: false,
        maxDelaySeconds: 0,
      },
    });
    const value = page([reach(24), reach(48)]);
    value.manifest.metrics[0]!.metric = 'REACH';
    expect(exchangeMeasurementIdentity(reach(24))).not.toBe(exchangeMeasurementIdentity(reach(48)));
    expect(validateExchangePage(value).rows).toHaveLength(2);
  });
});
