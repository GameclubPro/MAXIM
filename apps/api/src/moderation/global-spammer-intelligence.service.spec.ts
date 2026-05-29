import type { ConfigService } from '@nestjs/config';
import { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';

function createConfigMock(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function createPrismaMock() {
  const observations: any[] = [];
  const candidates = new Map<string, any>();
  const suppressions: any[] = [];
  const globalSpammer = {
    upsert: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    findUnique: jest.fn().mockResolvedValue(null),
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
    findUnique: jest.fn().mockResolvedValue(null),
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
  const spammerGraphSignalRows: any[] = [];
  const spammerGraphSignal = {
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const index = spammerGraphSignalRows.findIndex((row) => row.signalKey === where.signalKey);
      const next = {
        id: spammerGraphSignalRows[index]?.id ?? `graph-${spammerGraphSignalRows.length + 1}`,
        ...(index >= 0 ? spammerGraphSignalRows[index] : {}),
        ...(index >= 0 ? update : create),
      };
      if (index >= 0) {
        spammerGraphSignalRows[index] = next;
      } else {
        spammerGraphSignalRows.push(next);
      }
      return next;
    }),
    findMany: jest.fn(async ({ where }: any) =>
      spammerGraphSignalRows
        .filter(
          (row) =>
            (!where.userId || row.userId === where.userId) &&
            (!where.signalType || row.signalType === where.signalType) &&
            (!where.signalHash || row.signalHash === where.signalHash) &&
            (!where.expiresAt?.gt || row.expiresAt > where.expiresAt.gt),
        )
        .slice(0, 200),
    ),
  };
  const globalSpammerEnforcementDecision = {
    create: jest.fn().mockResolvedValue({}),
  };
  const chat = {
    findUnique: jest.fn().mockResolvedValue(null),
  };
  const adminGlobalSpammerExemption = {
    findFirst: jest.fn().mockResolvedValue(null),
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
    spammerGraphSignalRows,
    prisma: {
      chat,
      adminGlobalSpammerExemption,
      spammerObservation,
      spammerGraphSignal,
      globalSpammer,
      globalSpammerCandidate,
      globalSpammerCandidateChat,
      globalSpammerSuppression,
      globalSpammerEnforcementDecision,
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

  it('down-weights noisy sources with recent false positives', () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const now = new Date('2026-05-29T12:00:00.000Z');

    const aggregate = service.computeAggregate(
      [
        {
          id: '1',
          userId: 'user-source-noise',
          source: 'FANOUT_HIGH',
          score: 0.94,
          reason: 'HIGH_FANOUT_6_CHATS_2M',
          chatId: 'chat-1',
          messageId: 'm1',
          evidenceHash: 'noise',
          evidence: null,
          observedAt: now,
          expiresAt: new Date(now.getTime() + 10_000),
        },
      ],
      now,
      new Map([
        [
          'FANOUT_HIGH',
          {
            source: 'FANOUT_HIGH',
            weight: 0.5,
            falsePositiveRate: 0.7,
            observations: 20,
            suppressed: 14,
          },
        ],
      ]) as never,
    );

    expect(aggregate.score).toBeLessThan(0.55);
    expect(aggregate.sourceBreakdown).toEqual(
      expect.objectContaining({
        FANOUT_HIGH: expect.objectContaining({
          reputationWeight: 0.5,
          falsePositiveRate: 0.7,
        }),
      }),
    );
  });

  it('applies source weights before false-positive penalties', () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const now = new Date('2026-05-29T12:00:00.000Z');

    const aggregate = service.computeAggregate(
      [
        {
          id: '1',
          userId: 'user-source-weight',
          source: 'COMMERCIAL_AD',
          score: 1,
          reason: 'COMMERCIAL_AD_DETECTED',
          chatId: 'chat-1',
          messageId: 'm1',
          evidenceHash: 'weight',
          evidence: null,
          observedAt: now,
          expiresAt: new Date(now.getTime() + 10_000),
        },
      ],
      now,
    );

    expect(aggregate.score).toBe(0.74);
    expect(aggregate.sourceBreakdown).toEqual(
      expect.objectContaining({
        COMMERCIAL_AD: expect.objectContaining({
          reputationWeight: 0.74,
          falsePositiveRate: 0,
        }),
      }),
    );
  });

  it('turns repeated graph signals into separate observations', async () => {
    const { prisma, observations, spammerGraphSignalRows } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    await service.recordObservation({
      userId: 'user-graph-1',
      source: 'COMMERCIAL_AD',
      score: 0.58,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-1',
      evidence: { excerpt: 'Реклама услуги на https://bad.example/order сегодня' },
    });
    await service.recordObservation({
      userId: 'user-graph-2',
      source: 'COMMERCIAL_AD',
      score: 0.58,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-2',
      evidence: { excerpt: 'Реклама услуги на https://bad.example/order сегодня' },
    });

    expect(spammerGraphSignalRows).toHaveLength(4);
    expect(
      observations.some((row) => row.userId === 'user-graph-2' && row.source === 'GRAPH_DOMAIN'),
    ).toBe(true);
  });

  it('evaluates the spammer toggle through an explicit policy decision', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const expiresAt = new Date(Date.now() + 60_000);
    prisma.globalSpammer.findUnique.mockResolvedValue({
      userId: 'user-policy-1',
      confidenceScore: 0.94,
      lastReason: 'HIGH_FANOUT_6_CHATS_2M',
      expiresAt,
      sourceBreakdown: { FANOUT_HIGH: { score: 0.94 } },
    });

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-policy-1',
        trigger: 'message',
        deleteSpammersEnabled: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'ACTIVE_CONFIRMED',
        action: 'DELETE_AND_KICK',
        wouldEnforce: true,
      }),
    );

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-policy-1',
        trigger: 'message',
        deleteSpammersEnabled: true,
        enforcementMode: 'shadow',
        recordDecision: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        action: 'SHADOW_DELETE_AND_KICK',
        shadow: true,
        enforced: false,
      }),
    );
    expect(prisma.globalSpammerEnforcementDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: 'SHADOW_DELETE_AND_KICK',
          enforced: false,
          shadow: true,
        }),
      }),
    );

    await service.evaluatePolicy({
      chatId: 'chat-1',
      userId: 'user-policy-1',
      trigger: 'message',
      deleteSpammersEnabled: true,
      recordDecision: true,
    });
    expect(prisma.globalSpammerEnforcementDecision.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: 'DELETE_AND_KICK',
          enforced: true,
          shadow: false,
        }),
      }),
    );

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-policy-1',
        trigger: 'message',
        deleteSpammersEnabled: true,
        adminExempt: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'ADMIN_EXEMPT',
        action: 'NONE',
      }),
    );
  });

  it('keeps suppressed and expired users out of enforcement', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    await service.recordSuppression({
      userId: 'user-policy-2',
      source: 'MANUAL_UNBAN',
      reason: 'manual false positive',
    });

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-policy-2',
        trigger: 'message',
        deleteSpammersEnabled: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'SUPPRESSED',
        action: 'NONE',
      }),
    );

    prisma.globalSpammerSuppression.findFirst.mockResolvedValueOnce(null);
    prisma.globalSpammer.findUnique.mockResolvedValueOnce({
      userId: 'user-policy-3',
      confidenceScore: 0.9,
      lastReason: 'old legacy row',
      expiresAt: new Date(Date.now() - 60_000),
      sourceBreakdown: {},
    });
    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-policy-3',
        trigger: 'message',
        deleteSpammersEnabled: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'EXPIRED',
        action: 'NONE',
      }),
    );
  });

  it('can default policy decisions to shadow mode from runtime config', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({ GLOBAL_SPAMMER_ENFORCEMENT_MODE: 'shadow' }),
    );
    prisma.globalSpammer.findUnique.mockResolvedValue({
      userId: 'user-policy-shadow',
      confidenceScore: 0.96,
      lastReason: 'REVIEW_APPROVED',
      expiresAt: new Date(Date.now() + 60_000),
      sourceBreakdown: { REVIEW_APPROVED: { score: 1 } },
    });

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-policy-shadow',
        trigger: 'message',
        deleteSpammersEnabled: true,
        recordDecision: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        action: 'SHADOW_DELETE_AND_KICK',
        enforcementMode: 'shadow',
        enforced: false,
        shadow: true,
      }),
    );
  });
});
