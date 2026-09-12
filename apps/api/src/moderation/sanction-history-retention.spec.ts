import { SanctionHistoryRetention } from './sanction-history-retention';

describe('sanction history retention', () => {
  it('uses only the budget left by ordinary moderation cleanup', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const cleanup = new SanctionHistoryRetention();
    expect(await cleanup.cleanup(prisma as never, new Date(), 0)).toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    await cleanup.cleanup(prisma as never, new Date(), 3);
    expect(prisma.$queryRaw.mock.calls[0]![0].values).toContain(3);
  });
  it('retains last state and fences and bounds the scan before successor checks', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ scanned: 0n, removed: 0n, lastAt: null, lastId: null }]),
    };
    await new SanctionHistoryRetention().cleanup(prisma as never, new Date('2026-09-12T12:00:00Z'));
    const query = prisma.$queryRaw.mock.calls[0]![0];
    expect(query.sql).toContain('WITH candidates AS MATERIALIZED');
    expect(query.sql.indexOf('LIMIT')).toBeLessThan(query.sql.indexOf('WHERE EXISTS'));
    expect(query.sql).toContain("'SANCTION_STATE_FENCE'");
    expect(query.sql).toContain(
      '(later.created_at, later.id) > (candidate.created_at, candidate.id)',
    );
    expect(query.values).toContainEqual(new Date('2025-09-12T12:00:00Z'));
  });
  it('advances past protected rows and wraps only at the end of a bounded pass', async () => {
    const lastAt = new Date('2025-01-01T12:00:00Z');
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ scanned: 250n, removed: 0n, lastAt, lastId: 'last' }])
        .mockResolvedValue([{ scanned: 0n, removed: 0n, lastAt: null, lastId: null }]),
    };
    const cleanup = new SanctionHistoryRetention();
    for (let i = 0; i < 3; i += 1) await cleanup.cleanup(prisma as never, new Date());
    expect(prisma.$queryRaw.mock.calls[1]![0].values).toContain('last');
    expect(prisma.$queryRaw.mock.calls[2]![0].values).not.toContain('last');
  });
});
