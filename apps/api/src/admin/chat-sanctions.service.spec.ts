import { ChatSanctionsService } from './chat-sanctions.service';
import type { SanctionFeedRow } from './chat-sanction-state';

const row = (id: string, overrides: Partial<SanctionFeedRow> = {}): SanctionFeedRow => ({
  id,
  userId: id,
  userDisplayName: id,
  action: 'BAN',
  ruleCode: 'MANUAL_BAN',
  operator: 'ADMIN',
  metadata: {},
  createdAt: new Date('2025-01-01T12:00:00Z'),
  nextEventAt: null,
  nextRuleCode: null,
  sourceExists: true,
  ...overrides,
});
const fixture = () => {
  const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
  const fence = { isSanctionEventInvalidated: jest.fn().mockResolvedValue(false) };
  const service = new ChatSanctionsService(prisma as never, fence as never);
  return { service, prisma, fence };
};
describe('chat sanctions feed', () => {
  it('includes old active records and binds continuation to the exact query and actor', async () => {
    const { service, prisma } = fixture();
    prisma.$queryRaw.mockResolvedValue([row('a'), row('b')]);
    const page = await service.getPage('chat', 'admin', { limit: 1 });
    expect(page.items[0]).toMatchObject({ id: 'a', status: 'active', releaseAction: 'UNBAN' });
    expect(page.hasMore).toBe(true);
    prisma.$queryRaw.mockClear();
    await expect(service.getPage('other', 'admin', { cursor: page.nextCursor })).rejects.toThrow(
      'Обновите',
    );
    await expect(service.getPage('chat', 'other', { cursor: page.nextCursor })).rejects.toThrow(
      'Обновите',
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  it('uses bounded candidate materialization before per-user state lookups', async () => {
    const { service, prisma } = fixture();
    await service.getPage('chat', 'admin', {});
    const sql = prisma.$queryRaw.mock.calls[0]![0].sql as string;
    expect(sql).toContain('WITH candidates AS MATERIALIZED');
    expect(sql.indexOf('LIMIT')).toBeLessThan(sql.indexOf('LEFT JOIN LATERAL'));
  });
  it('does not offer release while a newer transition has fenced the sanction', async () => {
    const { service, prisma, fence } = fixture();
    prisma.$queryRaw.mockResolvedValue([row('a')]);
    fence.isSanctionEventInvalidated.mockResolvedValue(true);
    const page = await service.getPage('chat', 'admin', { status: 'review' });
    expect(page.items[0]).toMatchObject({ status: 'review', releaseAction: null });
  });
  it('returns continuation after the bounded sparse search budget', async () => {
    const { service, prisma } = fixture();
    prisma.$queryRaw.mockResolvedValue(Array.from({ length: 51 }, (_, i) => row(`row-${i}`)));
    const page = await service.getPage('chat', 'admin', { search: 'absent' });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(true);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
  });
});
