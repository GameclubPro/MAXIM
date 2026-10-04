import { randomUUID } from 'node:crypto';
import { profileStatisticsSummary } from './marketplace-profile-statistics';

const generation = (rows: unknown[], complete = true) => ({
  manifest: {
    generationId: randomUUID(),
    bindingId: randomUUID(),
    entityId: '-100',
    kind: 'CHANNEL',
    source: 'MAXIM',
    method: 'utc-buckets-v1',
    from: '2026-07-07T00:00:00.000Z',
    to: '2026-10-04T14:00:00.000Z',
    asOf: '2026-10-04T14:00:00.000Z',
    rowCount: rows.length,
    sha256: 'a'.repeat(64),
    complete,
    horizonToleranceSeconds: 900,
  },
  rows,
});
const audience = (day: string, value: number | null, observedAt: string | null) => ({
  metric: 'AUDIENCE',
  bucket: `${day}T00:00:00.000Z`,
  value,
  observedAt,
});

describe('marketplace owner audience summary', () => {
  it('distinguishes no consent, pending collection and an observed empty period', () => {
    expect(profileStatisticsSummary(false).state).toBe('DISABLED');
    expect(profileStatisticsSummary(true).state).toBe('PENDING');
    expect(profileStatisticsSummary(true, generation([], false)).state).toBe('PENDING');
    expect(profileStatisticsSummary(true, generation([])).state).toBe('EMPTY');
  });
  it('counts actual dates including measured zero but excludes missing observations and other metrics', () => {
    const summary = profileStatisticsSummary(
      true,
      generation([
        audience('2026-10-01', 0, '2026-10-01T21:01:00.000Z'),
        audience('2026-10-03', 100, '2026-10-03T22:00:00.000Z'),
        audience('2026-10-02', null, null),
        audience('2026-10-04', 101, null),
        {
          metric: 'PUBLICATION_HOUR',
          bucket: '2026-10-04T01:00:00.000Z',
          observedAt: '2026-10-04T13:00:00.000Z',
          posts: 5,
          complete: true,
        },
      ]),
    );
    expect(summary).toMatchObject({
      state: 'AVAILABLE',
      observedDays: 2,
      lastObservedAt: '2026-10-03T22:00:00.000Z',
    });
  });
  it('uses UTC bucket dates without inventing continuity or substituting collection time', () => {
    const summary = profileStatisticsSummary(
      true,
      generation([
        audience('2026-10-01', 30, '2026-10-02T00:03:00.000Z'),
        audience('2026-10-01', 31, '2026-10-02T00:04:00.000Z'),
        audience('2026-10-04', 34, '2026-10-04T00:01:00.000Z'),
        audience('2026-07-06', 29, '2026-07-06T00:00:00.000Z'),
      ]),
    );
    expect(summary.observedDays).toBe(2);
    expect(summary.lastObservedAt).toBe('2026-10-04T00:01:00.000Z');
  });
  it('does not expose old measurements after consent is revoked', () => {
    expect(
      profileStatisticsSummary(
        false,
        generation([audience('2026-10-04', 100, '2026-10-04T00:01:00.000Z')]),
      ),
    ).toEqual({ state: 'DISABLED', observedDays: 0, lastObservedAt: null, from: null, to: null });
  });
});
