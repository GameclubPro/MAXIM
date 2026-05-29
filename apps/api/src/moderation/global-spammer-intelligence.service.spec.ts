import { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';

function createPrismaMock() {
  const observations: any[] = [];
  const candidates = new Map<string, any>();
  const suppressions: any[] = [];
  const globalSpammer = {
    upsert: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const globalSpammerCandidate = {
    upsert: jest.fn(async (args: any) => {
      const userId = args.where.userId;
      const existing = candidates.get(userId);
      const next = {
        ...(existing ?? {}),
        ...(existing ? args.update : args.create),
        userId,
      };
      candidates.set(userId, next);
      return next;
    }),
    update: jest.fn(async (args: any) => {
      const existing = candidates.get(args.where.userId) ?? { userId: args.where.userId };
      const next = { ...existing, ...args.data };
      candidates.set(args.where.userId, next);
      return next;
    }),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  };
  const globalSpammerCandidateChat = {
    upsert: jest.fn().mockResolvedValue({}),
  };
  const globalSpammerSuppression = {
    findFirst: jest.fn(async ({ where }: any) => {
      const now = where.suppressedUntil.gt as Date;
      return (
        suppressions.find((row) => row.userId === where.userId && row.suppressedUntil > now) ?? null
      );
    }),
    create: jest.fn(async ({ data }: any) => {
      suppressions.push(data);
      return data;
    }),
  };
  const spammerObservation = {
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const key = where.userId_source_evidenceHash;
      const index = observations.findIndex(
        (row) =>
          row.userId === key.userId &&
          row.source === key.source &&
          row.evidenceHash === key.evidenceHash,
      );
      const next = {
        id: observations[index]?.id ?? `obs-${observations.length + 1}`,
        ...(index >= 0 ? observations[index] : {}),
        ...(index >= 0 ? update : create),
        userId: key.userId,
        source: key.source,
        evidenceHash: key.evidenceHash,
      };
      if (index >= 0) {
        observations[index] = next;
      } else {
        observations.push(next);
      }
      return next;
    }),
    findMany: jest.fn(async ({ where }: any) =>
      observations.filter(
        (row) =>
          row.userId === where.userId &&
          row.expiresAt > where.expiresAt.gt &&
          row.suppressedAt === where.suppressedAt,
      ),
    ),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const row of observations) {
        if (
          row.userId === where.userId &&
          row.expiresAt > where.expiresAt.gt &&
          row.suppressedAt === null
        ) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    }),
    groupBy: jest.fn().mockResolvedValue([]),
  };

  return {
    observations,
    candidates,
    prisma: {
      spammerObservation,
      globalSpammer,
      globalSpammerCandidate,
      globalSpammerCandidateChat,
      globalSpammerSuppression,
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    },
  };
}

describe('GlobalSpammerIntelligenceService', () => {
  it('keeps medium-confidence fanout in review instead of the registry', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    const result = await service.recordObservation({
      userId: 'User-1',
      source: 'FANOUT_REPEAT',
      score: 0.68,
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      chatId: 'chat-1',
      evidence: { uniqueChats: 5 },
    });

    expect(result.outcome).toBe('candidate');
    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(prisma.globalSpammerCandidate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'user-1',
          status: 'PENDING',
          confidenceScore: expect.any(Number),
        }),
      }),
    );
  });

  it('promotes high-confidence fanout to the registry', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    const result = await service.recordObservation({
      userId: 'user-2',
      source: 'FANOUT_HIGH',
      score: 0.94,
      reason: 'HIGH_FANOUT_6_CHATS_2M',
      chatId: 'chat-6',
      evidence: { uniqueChats: 6 },
    });

    expect(result.outcome).toBe('registry');
    expect(prisma.globalSpammer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'user-2',
          lastReason: 'HIGH_FANOUT_6_CHATS_2M',
          confidenceScore: expect.any(Number),
          sourceBreakdown: expect.objectContaining({
            FANOUT_HIGH: expect.any(Object),
          }),
        }),
      }),
    );
  });

  it('combines multiple medium sources into a high-confidence aggregate', () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const now = new Date('2026-05-29T12:00:00.000Z');

    const aggregate = service.computeAggregate(
      [
        {
          id: '1',
          userId: 'user-3',
          source: 'COMMERCIAL_CAMPAIGN',
          score: 0.76,
          reason: 'COMMERCIAL_AD_DETECTED',
          chatId: 'chat-1',
          messageId: 'm1',
          evidenceHash: 'a',
          evidence: null,
          observedAt: now,
          expiresAt: new Date(now.getTime() + 10_000),
        },
        {
          id: '2',
          userId: 'user-3',
          source: 'SANCTION_BAN',
          score: 0.74,
          reason: 'SANCTION_BAN',
          chatId: 'chat-1',
          messageId: 'm1',
          evidenceHash: 'b',
          evidence: null,
          observedAt: now,
          expiresAt: new Date(now.getTime() + 10_000),
        },
        {
          id: '3',
          userId: 'user-3',
          source: 'REPEATED_PHONE',
          score: 0.6,
          reason: 'REPEATED_PHONE_CROSS_CHAT',
          chatId: 'chat-2',
          messageId: 'm2',
          evidenceHash: 'c',
          evidence: null,
          observedAt: now,
          expiresAt: new Date(now.getTime() + 10_000),
        },
      ],
      now,
    );

    expect(aggregate.confidenceLevel).toBe('HIGH');
    expect(aggregate.score).toBeGreaterThanOrEqual(0.86);
  });

  it('suppresses active observations after manual unban', async () => {
    const { prisma, observations } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    await service.recordObservation({
      userId: 'user-4',
      source: 'FANOUT_HIGH',
      score: 0.94,
      reason: 'HIGH_FANOUT_6_CHATS_2M',
      chatId: 'chat-1',
    });
    await service.recordSuppression({
      userId: 'user-4',
      source: 'MANUAL_UNBAN',
      reason: 'MANUAL_UNBAN',
      adminUserId: 'admin-1',
      sourceChatId: 'chat-1',
    });

    expect(prisma.globalSpammer.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-4' } });
    expect(observations.every((row) => row.suppressedAt instanceof Date)).toBe(true);
  });

  it('raises source-quality alerts for dominated or suppressed sources', () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    expect(
      service.buildSourceAlerts({
        recentObservations: [
          { source: 'FANOUT_REPEAT', count: 80 },
          { source: 'COMMERCIAL_AD', count: 10 },
        ],
        suppressedObservations: [],
      }),
    ).toContainEqual(
      expect.objectContaining({
        source: 'FANOUT_REPEAT',
        level: 'warning',
      }),
    );

    expect(
      service.buildSourceAlerts({
        recentObservations: [{ source: 'REPEATED_LINK', count: 20 }],
        suppressedObservations: [{ source: 'REPEATED_LINK', count: 9 }],
      }),
    ).toContainEqual(
      expect.objectContaining({
        source: 'REPEATED_LINK',
        reason: expect.stringContaining('suppression rate'),
      }),
    );
  });

  it('reports review and false-positive metrics', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    prisma.globalSpammerCandidate.count
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(2);
    prisma.spammerObservation.groupBy
      .mockResolvedValueOnce([
        {
          source: 'FANOUT_REPEAT',
          _count: {
            _all: 12,
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          source: 'FANOUT_REPEAT',
          _count: {
            _all: 2,
          },
        },
      ]);

    const metrics = await service.getReviewMetrics({ chatId: 'chat-1' });

    expect(metrics).toEqual(
      expect.objectContaining({
        pending: 4,
        approved: 7,
        suppressed: 3,
        reviewed: 5,
        falsePositiveCount: 2,
        falsePositiveRate: 0.4,
      }),
    );
  });
});
