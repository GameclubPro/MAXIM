import { networkStatisticsPeriodStart } from './network-statistics.service';

describe('network statistics calendar period', () => {
  it('includes today and six preceding Moscow days for the seven-day overview', () => {
    expect(networkStatisticsPeriodStart(new Date('2026-10-22T12:30:00Z'), '7d').toISOString()).toBe(
      '2026-10-15T21:00:00.000Z',
    );
  });

  it('advances at Moscow midnight rather than UTC midnight', () => {
    expect(
      networkStatisticsPeriodStart(new Date('2026-10-21T20:59:59.999Z'), '7d').toISOString(),
    ).toBe('2026-10-14T21:00:00.000Z');
    expect(networkStatisticsPeriodStart(new Date('2026-10-21T21:00:00Z'), '7d').toISOString()).toBe(
      '2026-10-15T21:00:00.000Z',
    );
  });

  it('keeps a thirty-day period at the month and year boundary', () => {
    expect(
      networkStatisticsPeriodStart(new Date('2027-01-01T00:30:00Z'), '30d').toISOString(),
    ).toBe('2026-12-02T21:00:00.000Z');
  });
});
