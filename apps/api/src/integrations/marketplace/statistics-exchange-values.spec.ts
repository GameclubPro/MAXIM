import { type ExchangeMeasurement, validateExchangePage } from '@maxim/contracts';
import {
  canonicalExchangeMeasurements,
  exchangeMeasurementsHash,
  selectExchangeMeasurements,
} from './statistics-exchange-values';

const bucket = '2026-10-20T00:00:00.000Z';
const audience = (
  origin: 'MAXIM' | 'EXCHANGE',
  value: number,
  observedAt = bucket,
): ExchangeMeasurement => ({
  origin,
  method: 'utc-buckets-v1',
  revision: 1,
  data: { metric: 'AUDIENCE', bucket, value, observedAt },
});
describe('statistics exchange native and imported selection', () => {
  it('selects one complete source per interval without summing overlapping aggregates', () => {
    const native: ExchangeMeasurement = {
      origin: 'MAXIM',
      method: 'utc-buckets-v1',
      revision: 1,
      data: {
        metric: 'REACH',
        bucket,
        horizon: 24,
        posts: 2,
        samples: 1,
        views: 100,
        incomplete: true,
        maxDelaySeconds: 300,
        observedAt: bucket,
      },
    };
    const imported: ExchangeMeasurement = {
      ...native,
      origin: 'EXCHANGE',
      data: {
        ...native.data,
        metric: 'REACH',
        horizon: 24,
        posts: 2,
        samples: 2,
        views: 150,
        incomplete: false,
        maxDelaySeconds: 300,
      },
    };
    expect(selectExchangeMeasurements([native], [imported])).toEqual([imported]);
    expect(selectExchangeMeasurements([imported], [native])).toEqual([imported]);
  });
  it('uses the actual most recent audience observation and preserves its origin', () => {
    const own = audience('MAXIM', 100),
      other = audience('EXCHANGE', 120, '2026-10-20T01:00:00.000Z');
    expect(selectExchangeMeasurements([own], [other])).toEqual([other]);
    expect(selectExchangeMeasurements([other], [own])).toEqual([other]);
  });
  it('canonicalizes property order and row order before hashing', () => {
    const rows = [
      audience('MAXIM', 10),
      {
        ...audience('MAXIM', 20),
        data: {
          ...audience('MAXIM', 20).data,
          bucket: '2026-10-21T00:00:00.000Z',
          observedAt: '2026-10-21T00:00:00.000Z',
        },
      },
    ];
    expect(exchangeMeasurementsHash(rows)).toBe(exchangeMeasurementsHash([...rows].reverse()));
    expect(canonicalExchangeMeasurements(rows)).toHaveLength(2);
  });
  it('exports the shared strict validator', () =>
    expect(typeof validateExchangePage).toBe('function'));
});
