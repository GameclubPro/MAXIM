import { ReportRetentionService } from './report-retention.service';

describe('bounded report detail archival', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  function fixture(
    options: {
      enabled?: boolean;
      live?: boolean;
      archived?: boolean;
      votes?: number;
      redis?: boolean;
      slot?: boolean;
    } = {},
  ) {
    const old = new Date('2026-01-01T00:00:00Z');
    const report = {
      id: 'case',
      chatId: 'chat',
      status: 'COMPLETED',
      expiresAt: old,
      updatedAt: old,
      decidedAt: old,
      leaseExpiresAt: null,
      counterMessageId: 'counter',
      counterSendStartedAt: old,
      detailsArchivedAt: options.archived ? old : null,
      detailsArchiveCompletedAt: null,
    };
    const db = {
      $queryRaw: jest.fn(async (query) =>
        Array.isArray(query) ? [] : [{ live: options.live ?? false }],
      ),
      chatReportCase: { findUnique: jest.fn().mockResolvedValue(report), update: jest.fn() },
      chatReportVote: {
        findMany: jest.fn().mockImplementation(({ take }) =>
          Array.from({ length: Math.min(take, options.votes ?? 3) }, (_, n) => ({
            id: `v-${n}`,
          })),
        ),
        deleteMany: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      chatReportAction: {
        findMany: jest.fn().mockResolvedValue([{ id: 'action' }]),
        deleteMany: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ id: report.id, chatId: report.chatId, expiresAt: old }]),
    };
    const state = { transaction: jest.fn(async (_chatId, fn) => fn(db)) };
    const views = {
      summary: jest.fn().mockResolvedValue({
        votes: 3,
        candidates: 1,
        deleted: 1,
        absent: 0,
        failed: 0,
        pending: 0,
      }),
    };
    const config = {
      get: (key: string) => (key.endsWith('ENABLED') ? (options.enabled ?? true) : 90),
    };
    const telemetry = { record: jest.fn() };
    const redis = {
      setStringIfAbsentWithTtl: jest.fn().mockResolvedValue(options.slot ?? true),
    };
    const service = new ReportRetentionService(
      prisma as never,
      state as never,
      views as never,
      config as never,
      telemetry as never,
      options.redis ? (redis as never) : undefined,
    );
    return { service, db, report, prisma, views, telemetry, redis };
  }
  it('leaves detail data intact while disabled, with a read-only preview available', async () => {
    const { service, prisma, db } = fixture({ enabled: false });
    expect(await service.archivePage(now)).toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(await service.previewPage(now)).toBe(4);
    expect(db.chatReportCase.update).not.toHaveBeenCalled();
    expect(db.chatReportVote.deleteMany).not.toHaveBeenCalled();
    expect(db.chatReportAction.deleteMany).not.toHaveBeenCalled();
  });
  it('skips live deletion/cleanup bindings and active execution windows', async () => {
    const { service, db, report } = fixture({ live: true });
    expect(await service.archivePage(now)).toBe(0);
    expect(db.chatReportCase.update).not.toHaveBeenCalled();
    report.decidedAt = now;
    expect(await service.archivePage(now)).toBe(0);
  });
  it('freezes totals before removing details and preserves the case tombstone', async () => {
    const { service, db } = fixture();
    expect(await service.archivePage(now)).toBe(4);
    expect(db.chatReportCase.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'case' },
      data: {
        detailsArchivedAt: now,
        retainedVotes: 3,
        retainedCandidates: 1,
        retainedDeleted: 1,
        retainedAbsent: 0,
        retainedFailed: 0,
      },
    });
    expect(db.chatReportCase.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'case' },
      data: { detailsArchiveCompletedAt: now },
    });
  });
  it('deletes at most 200 details per page and resumes without overwriting frozen totals', async () => {
    const { service, db, views } = fixture({ archived: true, votes: 500 });
    expect(await service.archivePage(now)).toBe(200);
    expect(views.summary).not.toHaveBeenCalled();
    expect(db.chatReportVote.deleteMany.mock.calls[0]![0].where.id.in).toHaveLength(200);
    expect(db.chatReportAction.deleteMany).not.toHaveBeenCalled();
    expect(
      db.chatReportCase.update.mock.calls.every(([arg]) => !('retainedVotes' in arg.data)),
    ).toBe(true);
  });
  it('advances past five blocked candidates and keeps previews independent of the runtime cursor', async () => {
    const { service, prisma, db, report } = fixture();
    report.status = 'PENDING';
    const candidates = Array.from({ length: 5 }, (_, n) => ({
      id: `blocked-${n}`,
      chatId: report.chatId,
      expiresAt: report.expiresAt,
    }));
    prisma.$queryRaw.mockResolvedValue(candidates);
    expect(await service.archivePage(now)).toBe(0);
    expect(db.chatReportCase.findUnique).toHaveBeenCalledTimes(5);
    expect(await service.previewPage(now)).toBe(0);
    expect(await service.archivePage(now)).toBe(0);
    const [first, preview, resumed] = prisma.$queryRaw.mock.calls.map(([query]) => query);
    expect(first.sql).toContain('ORDER BY expires_at, id LIMIT 5');
    expect(first.sql).not.toContain('status');
    expect(preview.sql).not.toContain('(expires_at, id) >');
    expect(resumed.sql).toContain('(expires_at, id) >');
    expect(resumed.values).toContain('blocked-4');
    expect(db.chatReportCase.update).not.toHaveBeenCalled();
  });
  it('does not run without Redis or while another replica owns the shared page budget', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    try {
      const missing = fixture();
      const denied = fixture({ redis: true, slot: false });
      clock.mockReturnValue(now.getTime() + 60_001);
      expect(await missing.service.purgeDue()).toBe(0);
      expect(missing.prisma.$queryRaw).not.toHaveBeenCalled();
      expect(await denied.service.purgeDue()).toBe(0);
      expect(denied.prisma.$queryRaw).not.toHaveBeenCalled();
      expect(denied.redis.setStringIfAbsentWithTtl).toHaveBeenCalledWith(
        'reports:detail-archive-budget:v1',
        '1',
        60,
      );
    } finally {
      clock.mockRestore();
    }
  });
  it('defers the first runtime page and processes one page after obtaining the shared budget', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    try {
      const { service, prisma, redis } = fixture({ redis: true });
      expect(await service.purgeDue()).toBe(0);
      expect(redis.setStringIfAbsentWithTtl).not.toHaveBeenCalled();
      clock.mockReturnValue(now.getTime() + 60_001);
      expect(await service.purgeDue()).toBe(4);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(await service.purgeDue()).toBe(0);
      expect(redis.setStringIfAbsentWithTtl).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });
});
