import type { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { MaximNativeStatsAdapter } from './maxim-native-stats.adapter';

describe('analytics native publication coverage interval union', () => {
  const adapter = new MaximNativeStatsAdapter({} as PrismaService);
  const entity = { kind: 'CHANNEL' as const, maxId: '-123' };
  const scope = {
    metric: 'PUBLICATION_HOUR' as const,
    horizon: 0 as const,
    method: { id: 'PUBLICATION_DAY_HOURS' as const, version: 1 as const },
  };
  const snapshot = { asOf: new Date('2026-10-30T12:00:00Z'), retentionFloor: '2026-08-02' };
  function transaction(gapMs: number, conflicting = false) {
    return {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ present: conflicting }])
        .mockResolvedValueOnce(
          conflicting
            ? []
            : [
                {
                  from_at: new Date('2026-10-29T00:00:00Z'),
                  to_at: new Date('2026-10-29T12:00:00Z'),
                },
                {
                  from_at: new Date(Date.parse('2026-10-29T12:00:00Z') + gapMs),
                  to_at: new Date('2026-10-30T00:00:00Z'),
                },
              ],
        )
        .mockResolvedValueOnce([]),
    } as unknown as Prisma.TransactionClient;
  }
  it('proves an empty day from adjacent complete discovery intervals', async () => {
    const rows = await adapter.readInSnapshot(
      transaction(0),
      entity,
      [scope],
      '2026-10-29',
      '2026-10-29',
      snapshot,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.coverage).toEqual({
      state: 'COMPLETE',
      populationComplete: true,
      intervals: [{ from: '2026-10-29T00:00:00.000Z', to: '2026-10-30T00:00:00.000Z' }],
    });
    expect(rows[0]!.value).toMatchObject({ hours: Array(24).fill(0) });
  });
  it('does not manufacture empty population across a one millisecond gap', async () => {
    expect(
      await adapter.readInSnapshot(
        transaction(1),
        entity,
        [scope],
        '2026-10-29',
        '2026-10-29',
        snapshot,
      ),
    ).toEqual([]);
  });
  it('does not infer emptiness after a conflicting publication identity', async () => {
    expect(
      await adapter.readInSnapshot(
        transaction(0, true),
        entity,
        [scope],
        '2026-10-29',
        '2026-10-29',
        snapshot,
      ),
    ).toEqual([]);
  });
});
