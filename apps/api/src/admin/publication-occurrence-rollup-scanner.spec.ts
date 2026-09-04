import { PublicationOccurrenceStatus } from '../prisma/prisma-client';
import { PublicationOccurrenceRollupScanner } from './publication-occurrence-rollup-scanner';

describe('PublicationOccurrenceRollupScanner', () => {
  it('selects active and ambiguous occurrences that have execution deliveries', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const scanner = new PublicationOccurrenceRollupScanner();

    await scanner.scan({
      prisma: { publicationOccurrence: { findMany } } as never,
      rollup: jest.fn(),
      onError: jest.fn(),
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: {
          in: [
            PublicationOccurrenceStatus.SCHEDULED,
            PublicationOccurrenceStatus.IN_PROGRESS,
            PublicationOccurrenceStatus.AMBIGUOUS,
          ],
        },
        legacyBroadcasts: { some: { deliveries: { some: {} } } },
      },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: 200,
      select: { id: true, scheduledAt: true },
    });
  });

  it('reconciles an ambiguous occurrence left behind by an interrupted manual resolution', async () => {
    const scheduledAt = new Date('2026-07-10T10:00:00.000Z');
    const findMany = jest.fn().mockResolvedValue([{ id: 'occurrence-ambiguous', scheduledAt }]);
    const rollup = jest.fn().mockResolvedValue(undefined);
    const scanner = new PublicationOccurrenceRollupScanner();

    await scanner.scan({
      prisma: { publicationOccurrence: { findMany } } as never,
      rollup,
      onError: jest.fn(),
    });

    expect(rollup).toHaveBeenCalledWith('occurrence-ambiguous');
  });

  it('advances a stable cursor past unchanged active occurrences', async () => {
    const firstScheduledAt = new Date('2026-07-10T10:00:00.000Z');
    const nextScheduledAt = new Date('2026-07-11T10:00:00.000Z');
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      id: `legacy-${String(index).padStart(3, '0')}`,
      scheduledAt: firstScheduledAt,
    }));
    const findMany = jest
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([{ id: 'publik-next', scheduledAt: nextScheduledAt }]);
    const rollup = jest.fn().mockResolvedValue(undefined);
    const scanner = new PublicationOccurrenceRollupScanner();

    await scanner.scan({
      prisma: { publicationOccurrence: { findMany } } as never,
      rollup,
      onError: jest.fn(),
    });
    await scanner.scan({
      prisma: { publicationOccurrence: { findMany } } as never,
      rollup,
      onError: jest.fn(),
    });

    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { scheduledAt: { gt: firstScheduledAt } },
            { scheduledAt: firstScheduledAt, id: { gt: 'legacy-199' } },
          ],
        }),
      }),
    );
    expect(rollup).toHaveBeenCalledTimes(201);
    expect(rollup).toHaveBeenLastCalledWith('publik-next');
  });

  it('continues the page and retries one failed occurrence once on the next scan', async () => {
    const scheduledAt = new Date('2026-07-10T10:00:00.000Z');
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([
        { id: 'occurrence-broken', scheduledAt },
        { id: 'occurrence-healthy', scheduledAt },
      ])
      .mockResolvedValueOnce([]);
    const failure = new Error('broken snapshot');
    const rollup = jest.fn(async (occurrenceId: string) => {
      if (occurrenceId === 'occurrence-broken') {
        throw failure;
      }
    });
    const onError = jest.fn();
    const scanner = new PublicationOccurrenceRollupScanner();

    await expect(
      scanner.scan({
        prisma: { publicationOccurrence: { findMany } } as never,
        rollup,
        onError,
      }),
    ).resolves.toBeUndefined();

    expect(rollup).toHaveBeenNthCalledWith(1, 'occurrence-broken');
    expect(rollup).toHaveBeenNthCalledWith(2, 'occurrence-healthy');
    expect(onError).toHaveBeenCalledWith('occurrence-broken', failure);

    await scanner.scan({
      prisma: { publicationOccurrence: { findMany } } as never,
      rollup,
      onError,
    });

    expect(rollup.mock.calls.filter(([id]) => id === 'occurrence-broken')).toHaveLength(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('retries a bounded failed subset on the next scan without starving cursor progress', async () => {
    const firstScheduledAt = new Date('2026-07-10T10:00:00.000Z');
    const nextScheduledAt = new Date('2026-07-11T10:00:00.000Z');
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      id: `broken-${String(index).padStart(3, '0')}`,
      scheduledAt: firstScheduledAt,
    }));
    const findMany = jest
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([{ id: 'publik-next', scheduledAt: nextScheduledAt }]);
    const rollup = jest.fn(async (occurrenceId: string) => {
      if (occurrenceId.startsWith('broken-')) {
        throw new Error('transient rollup failure');
      }
    });
    const scanner = new PublicationOccurrenceRollupScanner();

    await scanner.scan({
      prisma: { publicationOccurrence: { findMany } } as never,
      rollup,
      onError: jest.fn(),
    });
    await scanner.scan({
      prisma: { publicationOccurrence: { findMany } } as never,
      rollup,
      onError: jest.fn(),
    });

    expect(rollup.mock.calls.filter(([id]) => id === 'broken-000')).toHaveLength(2);
    expect(rollup.mock.calls.filter(([id]) => id === 'broken-019')).toHaveLength(2);
    expect(rollup.mock.calls.filter(([id]) => id === 'broken-020')).toHaveLength(1);
    expect(rollup).toHaveBeenCalledWith('publik-next');
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { scheduledAt: { gt: firstScheduledAt } },
            { scheduledAt: firstScheduledAt, id: { gt: 'broken-199' } },
          ],
        }),
      }),
    );
  });
});
