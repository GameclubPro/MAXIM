import type { ConfigService } from '@nestjs/config';
import { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';

function createConfigMock(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function createPrismaMock() {
  const registry = new Map<string, any>();
  const observations: any[] = [];
  const candidates = new Map<string, any>();
  const suppressions: any[] = [];
  const localAdminDecisions: any[] = [];
  const chatAdminAllowlistRows: any[] = [];
  const campaignClusters: any[] = [];
  const campaignMembers: any[] = [];
  const shadowScores: any[] = [];
  const reviewFeedback: any[] = [];
  const applyData = (row: any, data: any) => {
    const next = { ...row };
    for (const [key, value] of Object.entries(data ?? {})) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        'increment' in value
      ) {
        next[key] = (next[key] ?? 0) + Number((value as { increment: number }).increment);
      } else {
        next[key] = value;
      }
    }
    return next;
  };
  const globalSpammer = {
    upsert: jest.fn(async (args: any) => {
      const userId = args.where.userId;
      const existing = registry.get(userId);
      const next = {
        ...(existing ?? {}),
        ...(existing ? applyData(existing, args.update) : args.create),
        userId,
      };
      registry.set(userId, next);
      return next;
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      if (where?.userId?.in) {
        let count = 0;
        for (const userId of where.userId.in) {
          if (registry.delete(userId)) {
            count += 1;
          }
        }
        return { count };
      }
      if (where?.userId) {
        return { count: registry.delete(where.userId) ? 1 : 0 };
      }
      return { count: 0 };
    }),
    findUnique: jest.fn(async ({ where }: any) => registry.get(where.userId) ?? null),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  };
  const globalSpammerArchive = {
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
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
    findUnique: jest.fn(async ({ where }: any) => candidates.get(where.userId) ?? null),
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
  const chatAdminAllowlist = {
    findMany: jest.fn(async ({ where }: any) =>
      chatAdminAllowlistRows
        .filter((row) => !where?.chatId || row.chatId === where.chatId)
        .map((row) => ({ userId: row.userId })),
    ),
  };
  const adminGlobalSpammerExemption = {
    findFirst: jest.fn(async ({ where }: any) => {
      const userId = where?.userId;
      return localAdminDecisions.find((row) => row.userId === userId) ?? null;
    }),
    findMany: jest.fn(async ({ where, orderBy, take }: any) => {
      let rows = localAdminDecisions.filter((row) => {
        if (where?.adminUserId?.in && !where.adminUserId.in.includes(row.adminUserId)) {
          return false;
        }
        if (where?.userId?.in && !where.userId.in.includes(row.userId)) {
          return false;
        }
        return true;
      });
      if (orderBy?.updatedAt === 'desc') {
        rows = rows.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
      }
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    }),
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const key = where.adminUserId_userId;
      const index = localAdminDecisions.findIndex(
        (row) => row.adminUserId === key.adminUserId && row.userId === key.userId,
      );
      const now = new Date();
      const next = {
        ...(index >= 0 ? localAdminDecisions[index] : {}),
        ...(index >= 0 ? update : create),
        adminUserId: key.adminUserId,
        userId: key.userId,
        updatedAt: now,
      };
      if (index >= 0) {
        localAdminDecisions[index] = next;
      } else {
        localAdminDecisions.push(next);
      }
      return next;
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
    findMany: jest.fn(async ({ where, orderBy, take }: any) => {
      let rows = observations.filter((row) => {
        if (where.userId?.in && !where.userId.in.includes(row.userId)) {
          return false;
        }
        if (typeof where.userId === 'string' && row.userId !== where.userId) {
          return false;
        }
        if (where.expiresAt?.gt && !(row.expiresAt > where.expiresAt.gt)) {
          return false;
        }
        if ('suppressedAt' in where && row.suppressedAt !== where.suppressedAt) {
          return false;
        }
        if (
          where.rawEvidenceExpiresAt?.lte &&
          !(row.rawEvidenceExpiresAt && row.rawEvidenceExpiresAt <= where.rawEvidenceExpiresAt.lte)
        ) {
          return false;
        }
        if (where.privacyClass?.not && row.privacyClass === where.privacyClass.not) {
          return false;
        }
        return true;
      });
      if (orderBy?.observedAt === 'desc') {
        rows = rows.sort((left, right) => right.observedAt.getTime() - left.observedAt.getTime());
      }
      if (Array.isArray(orderBy) && orderBy.some((item) => item.rawEvidenceExpiresAt === 'asc')) {
        rows = rows.sort(
          (left, right) =>
            (left.rawEvidenceExpiresAt?.getTime() ?? 0) -
            (right.rawEvidenceExpiresAt?.getTime() ?? 0),
        );
      }
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const index = observations.findIndex((row) => row.id === where.id);
      if (index < 0) {
        throw new Error(`Observation ${where.id} not found`);
      }
      observations[index] = { ...observations[index], ...data };
      return observations[index];
    }),
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
  const spammerCampaignCluster = {
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const index = campaignClusters.findIndex((row) => row.clusterKey === where.clusterKey);
      const now = new Date();
      const next = {
        id: campaignClusters[index]?.id ?? `cluster-${campaignClusters.length + 1}`,
        createdAt: campaignClusters[index]?.createdAt ?? now,
        updatedAt: now,
        ...(index >= 0 ? campaignClusters[index] : {}),
        ...(index >= 0 ? applyData(campaignClusters[index], update) : create),
      };
      if (index >= 0) {
        campaignClusters[index] = next;
      } else {
        campaignClusters.push(next);
      }
      return next;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const index = campaignClusters.findIndex((row) => row.id === where.id);
      if (index < 0) {
        throw new Error(`Campaign cluster ${where.id} not found`);
      }
      campaignClusters[index] = applyData(campaignClusters[index], {
        ...data,
        updatedAt: new Date(),
      });
      return campaignClusters[index];
    }),
    findMany: jest.fn(async ({ where, take }: any) => {
      let rows = campaignClusters.filter((row) => {
        if (where?.lastSeenAt?.gte && !(row.lastSeenAt >= where.lastSeenAt.gte)) {
          return false;
        }
        if (where?.members?.some?.chatId) {
          return campaignMembers.some(
            (member) =>
              member.clusterId === row.id && member.chatId === where.members.some.chatId,
          );
        }
        return true;
      });
      rows = rows.sort(
        (left, right) =>
          (right.confidenceScore ?? 0) - (left.confidenceScore ?? 0) ||
          (right.observationsCount ?? 0) - (left.observationsCount ?? 0) ||
          (right.lastSeenAt?.getTime() ?? 0) - (left.lastSeenAt?.getTime() ?? 0),
      );
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    }),
  };
  const spammerCampaignClusterMember = {
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const key = where.clusterId_userId;
      const index = campaignMembers.findIndex(
        (row) => row.clusterId === key.clusterId && row.userId === key.userId,
      );
      const next = {
        ...(index >= 0 ? campaignMembers[index] : {}),
        ...(index >= 0 ? applyData(campaignMembers[index], update) : create),
      };
      if (index >= 0) {
        campaignMembers[index] = next;
      } else {
        campaignMembers.push(next);
      }
      return next;
    }),
    findMany: jest.fn(async ({ where, select, include, take }: any) => {
      let rows = campaignMembers.filter((row) => {
        if (where.clusterId && row.clusterId !== where.clusterId) {
          return false;
        }
        if (where.userId && row.userId !== where.userId) {
          return false;
        }
        return true;
      });
      rows = rows.sort(
        (left, right) => (right.lastSeenAt?.getTime() ?? 0) - (left.lastSeenAt?.getTime() ?? 0),
      );
      if (include?.cluster) {
        rows = rows.map((row) => ({
          ...row,
          cluster: campaignClusters.find((cluster) => cluster.id === row.clusterId),
        }));
      }
      if (select?.userId || select?.chatId) {
        rows = rows.map((row) => ({
          ...(select.userId ? { userId: row.userId } : {}),
          ...(select.chatId ? { chatId: row.chatId } : {}),
        }));
      }
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    }),
  };
  const globalSpammerShadowScore = {
    create: jest.fn(async ({ data }: any) => {
      const row = {
        id: `shadow-${shadowScores.length + 1}`,
        createdAt: new Date(),
        humanReviewOutcome: null,
        reviewedAt: null,
        reviewedByUserId: null,
        ...data,
      };
      shadowScores.push(row);
      return row;
    }),
    count: jest.fn(async ({ where }: any) =>
      shadowScores.filter(
        (row) =>
          (!where.createdAt?.gte || row.createdAt >= where.createdAt.gte) &&
          (!('wouldPromote' in where) || row.wouldPromote === where.wouldPromote) &&
          (!where.chatId || row.chatId === where.chatId),
      ).length,
    ),
    findFirst: jest.fn(async ({ where }: any) =>
      [...shadowScores]
        .filter((row) => row.userId === where.userId)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null,
    ),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const row of shadowScores) {
        if (
          row.userId === where.userId &&
          (!('humanReviewOutcome' in where) || row.humanReviewOutcome === where.humanReviewOutcome)
        ) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    }),
  };
  const globalSpammerReviewFeedback = {
    create: jest.fn(async ({ data }: any) => {
      const row = {
        id: `feedback-${reviewFeedback.length + 1}`,
        createdAt: new Date(),
        ...data,
      };
      reviewFeedback.push(row);
      return row;
    }),
  };

  return {
    registry,
    observations,
    candidates,
    campaignClusters,
    campaignMembers,
    shadowScores,
    reviewFeedback,
    localAdminDecisions,
    chatAdminAllowlistRows,
    spammerGraphSignalRows,
    prisma: {
      chat,
      chatAdminAllowlist,
      adminGlobalSpammerExemption,
      spammerObservation,
      spammerGraphSignal,
      globalSpammer,
      globalSpammerArchive,
      globalSpammerCandidate,
      globalSpammerCandidateChat,
      globalSpammerSuppression,
      globalSpammerEnforcementDecision,
      spammerCampaignCluster,
      spammerCampaignClusterMember,
      globalSpammerShadowScore,
      globalSpammerReviewFeedback,
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
      reason: 'FANOUT_EPISODE_CONFIRMED',
      chatId: 'chat-6',
      evidence: { uniqueChats: 6 },
      forceRegistry: true,
    });

    expect(result.outcome).toBe('registry');
    expect(prisma.globalSpammer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'user-2',
          lastReason: 'FANOUT_EPISODE_CONFIRMED',
          confidenceScore: expect.any(Number),
          sourceBreakdown: expect.objectContaining({
            FANOUT_HIGH: expect.any(Object),
          }),
        }),
      }),
    );
  });

  it('keeps first high-fanout bursts out of the registry until confirmed', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    const result = await service.recordObservation({
      userId: 'user-first-fanout',
      source: 'FANOUT_HIGH',
      score: 0.94,
      reason: 'HIGH_FANOUT_6_CHATS_2M',
      chatId: 'chat-6',
      evidence: { uniqueChats: 6 },
    });

    expect(result.outcome).toBe('candidate');
    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(prisma.globalSpammerCandidate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'user-first-fanout',
          status: 'PENDING',
        }),
      }),
    );
  });

  it('stores risk-ledger metadata and prunes raw evidence after retention', async () => {
    const { observations, prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const observedAt = new Date('2026-05-29T12:00:00.000Z');

    await service.recordObservation({
      userId: 'user-ledger',
      source: 'COMMERCIAL_AD',
      score: 0.74,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-ledger',
      observedAt,
      evidence: {
        excerpt:
          'Продам рекламный доступ сегодня: https://Bad.Example/order?utm=spam +7 (999) 123-45-67',
        mediaFileId: 'photo-cdn-123456789',
      },
    });

    expect(observations).toContainEqual(
      expect.objectContaining({
        userId: 'user-ledger',
        normalizedFeatures: expect.objectContaining({
          source: 'COMMERCIAL_AD',
          ttlDays: 10,
          domains: expect.arrayContaining(['bad.example']),
          urls: expect.arrayContaining(['https://bad.example/order?utm=spam']),
          phoneHashes: expect.arrayContaining([expect.any(String)]),
          mediaSignatures: expect.arrayContaining([expect.any(String)]),
        }),
        ttlDays: 10,
        explainReason: expect.stringContaining('COMMERCIAL_AD'),
        privacyClass: 'HIGH_SENSITIVITY',
        rawEvidenceExpiresAt: expect.any(Date),
      }),
    );

    await expect(
      service.pruneExpiredRawEvidence({
        now: new Date('2026-06-20T12:00:00.000Z'),
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        scanned: 1,
        pruned: 1,
      }),
    );

    expect(prisma.spammerObservation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          privacyClass: 'MINIMIZED',
          rawEvidenceExpiresAt: null,
          evidence: expect.objectContaining({
            rawEvidencePruned: true,
            domains: expect.arrayContaining(['bad.example']),
            phoneHashes: expect.arrayContaining([expect.any(String)]),
          }),
        }),
      }),
    );
    expect(observations[0]).toEqual(
      expect.objectContaining({
        privacyClass: 'MINIMIZED',
        rawEvidenceExpiresAt: null,
        evidence: expect.objectContaining({
          rawEvidencePruned: true,
        }),
      }),
    );
  });

  it('combines behavior and reputation signals without over-promoting the aggregate', () => {
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

    expect(aggregate.confidenceLevel).toBe('MEDIUM');
    expect(aggregate.score).toBeGreaterThanOrEqual(0.62);
    expect(aggregate.score).toBeLessThan(0.7);
    expect(aggregate.sourceBreakdown).toEqual(
      expect.objectContaining({
        SANCTION_BAN: expect.objectContaining({
          effect: 'risk',
          score: expect.any(Number),
        }),
      }),
    );
  });

  it('caps reputation-only bans below global registry promotion', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    for (let index = 1; index <= 6; index += 1) {
      await service.recordObservation({
        userId: 'user-reputation-only',
        source: 'MANUAL_BAN',
        score: 1,
        reason: 'MANUAL_BAN',
        chatId: `chat-${index}`,
        evidenceHash: `manual-ban-${index}`,
        evidence: {
          actorUserId: `admin-${index}`,
        },
      });
    }

    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(prisma.globalSpammerCandidate.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: 'AUTO_APPROVED',
        }),
      }),
    );

    const diagnostics = await service.getUserDiagnostics({
      chatId: 'chat-1',
      userId: 'user-reputation-only',
      deleteSpammersEnabled: true,
    });
    expect(diagnostics.policy.registryStatus).not.toBe('ACTIVE_CONFIRMED');
    expect(diagnostics.reputationSummary).toEqual(
      expect.objectContaining({
        naturalBanSignals: 6,
        onlyReputationSignals: true,
      }),
    );
  });

  it('treats local admin allow as a mitigating local decision', async () => {
    const { chatAdminAllowlistRows, localAdminDecisions, prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    chatAdminAllowlistRows.push({ chatId: 'chat-local', userId: 'admin-allow' });
    await service.recordLocalAdminDecision({
      chatId: 'chat-local',
      userId: 'user-local-allow',
      reviewerUserId: 'admin-allow',
      decision: 'ALLOW',
      reason: 'MANUAL_UNBAN',
    });

    expect(localAdminDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adminUserId: 'admin-allow',
          userId: 'user-local-allow',
          sourceChatId: 'chat-local',
          decision: 'ALLOW',
          reason: 'MANUAL_UNBAN',
        }),
      ]),
    );

    const diagnostics = await service.getUserDiagnostics({
      chatId: 'chat-local',
      userId: 'user-local-allow',
      deleteSpammersEnabled: true,
    });
    expect(diagnostics.policy).toEqual(
      expect.objectContaining({
        registryStatus: 'ADMIN_EXEMPT',
        action: 'NONE',
        adminExempt: true,
      }),
    );
    expect(diagnostics.localAdminDecision).toEqual(
      expect.objectContaining({
        decision: 'ALLOW',
        decidedByUserIds: ['admin-allow'],
      }),
    );
    expect(diagnostics.reputationSummary).toEqual(
      expect.objectContaining({
        localAllowSignals: 1,
        onlyReputationSignals: true,
      }),
    );
  });

  it('treats local admin block as local enforcement instead of global registry promotion', async () => {
    const { chatAdminAllowlistRows, localAdminDecisions, prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    chatAdminAllowlistRows.push({ chatId: 'chat-local', userId: 'admin-block' });
    await service.recordLocalAdminDecision({
      chatId: 'chat-local',
      userId: 'user-local-block',
      reviewerUserId: 'admin-block',
      decision: 'BLOCK',
      reason: 'LOCAL_ADMIN_BLOCK',
    });

    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(localAdminDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adminUserId: 'admin-block',
          userId: 'user-local-block',
          decision: 'BLOCK',
        }),
      ]),
    );

    const diagnostics = await service.getUserDiagnostics({
      chatId: 'chat-local',
      userId: 'user-local-block',
      deleteSpammersEnabled: true,
    });
    expect(diagnostics.policy).toEqual(
      expect.objectContaining({
        registryStatus: 'LOCAL_BLOCKED',
        action: 'DELETE_AND_KICK',
        wouldEnforce: false,
      }),
    );
    expect(diagnostics.localAdminDecision).toEqual(
      expect.objectContaining({
        decision: 'BLOCK',
        decidedByUserIds: ['admin-block'],
      }),
    );
    expect(diagnostics.reputationSummary).toEqual(
      expect.objectContaining({
        localBlockSignals: 1,
        onlyReputationSignals: true,
      }),
    );
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
    prisma.globalSpammer.count.mockResolvedValueOnce(9).mockResolvedValueOnce(1);
    prisma.globalSpammerArchive.count.mockResolvedValueOnce(8);
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
        activeRegistry: 9,
        expiredRegistry: 1,
        archivedExpired: 8,
        falsePositiveCount: 2,
        falsePositiveRate: 0.4,
      }),
    );
  });

  it('archives expired registry rows before deleting them from the active registry', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const now = new Date('2026-05-29T12:00:00.000Z');
    const expiredAt = new Date('2026-05-28T12:00:00.000Z');
    prisma.globalSpammer.findMany.mockResolvedValueOnce([
      {
        userId: 'user-expired-1',
        firstDetectedAt: new Date('2026-05-20T12:00:00.000Z'),
        lastDetectedAt: new Date('2026-05-22T12:00:00.000Z'),
        detectionsCount: 3,
        lastReason: 'HIGH_FANOUT_6_CHATS_2M',
        lastChatId: 'chat-1',
        lastEvidence: { uniqueChats: 6 },
        confidenceScore: 0.96,
        confirmedAt: new Date('2026-05-22T12:00:00.000Z'),
        expiresAt: expiredAt,
        sourceBreakdown: { FANOUT_HIGH: { score: 0.96 } },
      },
    ]);
    prisma.globalSpammerArchive.createMany.mockResolvedValueOnce({ count: 1 });
    prisma.globalSpammer.deleteMany.mockResolvedValueOnce({ count: 1 });
    prisma.globalSpammer.count.mockResolvedValueOnce(0);

    await expect(
      service.archiveExpiredRegistryEntries({ now, limit: 25 }),
    ).resolves.toEqual(
      expect.objectContaining({
        dryRun: false,
        scanned: 1,
        archived: 1,
        deleted: 1,
        remainingExpired: 0,
      }),
    );
    expect(prisma.globalSpammerArchive.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            userId: 'user-expired-1',
            expiredAt,
            archiveReason: 'EXPIRED',
          }),
        ],
        skipDuplicates: true,
      }),
    );
    expect(prisma.globalSpammer.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: {
          in: ['user-expired-1'],
        },
        OR: [
          {
            expiresAt: null,
          },
          {
            expiresAt: {
              lte: now,
            },
          },
        ],
      },
    });
  });

  it('archives nullable legacy registry rows as expired', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const now = new Date('2026-05-29T12:00:00.000Z');
    prisma.globalSpammer.findMany.mockResolvedValueOnce([
      {
        userId: 'user-legacy-null-expiry',
        firstDetectedAt: new Date('2026-05-20T12:00:00.000Z'),
        lastDetectedAt: new Date('2026-05-22T12:00:00.000Z'),
        detectionsCount: 1,
        lastReason: 'legacy row',
        lastChatId: null,
        lastEvidence: null,
        confidenceScore: 1,
        confirmedAt: new Date('2026-05-22T12:00:00.000Z'),
        expiresAt: null,
        sourceBreakdown: {},
      },
    ]);
    prisma.globalSpammerArchive.createMany.mockResolvedValueOnce({ count: 1 });
    prisma.globalSpammer.deleteMany.mockResolvedValueOnce({ count: 1 });
    prisma.globalSpammer.count.mockResolvedValueOnce(0);

    await expect(service.archiveExpiredRegistryEntries({ now })).resolves.toEqual(
      expect.objectContaining({
        scanned: 1,
        archived: 1,
        deleted: 1,
        remainingExpired: 0,
      }),
    );

    expect(prisma.globalSpammer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            {
              expiresAt: null,
            },
            {
              expiresAt: {
                lte: now,
              },
            },
          ],
        },
      }),
    );
    expect(prisma.globalSpammerArchive.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            userId: 'user-legacy-null-expiry',
            expiredAt: null,
          }),
        ],
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

    expect(aggregate.score).toBe(0.45);
    expect(aggregate.sourceBreakdown).toEqual(
      expect.objectContaining({
        COMMERCIAL_AD: expect.objectContaining({
          reputationWeight: 0.45,
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
      observations.find((row) => row.userId === 'user-graph-2' && row.source === 'GRAPH_DOMAIN'),
    ).toEqual(
      expect.objectContaining({
        normalizedFeatures: expect.objectContaining({
          domains: expect.arrayContaining(['bad.example']),
        }),
        explainReason: expect.stringContaining('GRAPH_DOMAIN'),
        privacyClass: 'STANDARD',
      }),
    );
  });

  it('links campaign clusters into shadow scoring and diagnostics', async () => {
    const { campaignClusters, campaignMembers, prisma, shadowScores } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    await service.recordObservation({
      userId: 'user-campaign-1',
      source: 'COMMERCIAL_AD',
      score: 0.72,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-1',
      evidence: { excerpt: 'Промо https://network.example/order общий текст кампании сегодня' },
    });
    await service.recordObservation({
      userId: 'user-campaign-2',
      source: 'COMMERCIAL_AD',
      score: 0.72,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-2',
      evidence: { excerpt: 'Промо https://network.example/order общий текст кампании сегодня' },
    });

    expect(campaignClusters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'ACTIVE',
          distinctUsersCount: 2,
          distinctChatsCount: 2,
        }),
      ]),
    );
    expect(campaignMembers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'user-campaign-1' }),
        expect.objectContaining({ userId: 'user-campaign-2' }),
      ]),
    );
    const latestShadowScore = shadowScores.at(-1);
    expect(latestShadowScore).toEqual(
      expect.objectContaining({
        userId: 'user-campaign-2',
        currentScore: expect.any(Number),
        v2Score: expect.any(Number),
        campaignBreakdown: expect.any(Object),
      }),
    );
    expect(latestShadowScore.v2Score).toBeGreaterThan(latestShadowScore.currentScore);

    await expect(
      service.getUserDiagnostics({
        chatId: 'chat-2',
        userId: 'user-campaign-2',
        deleteSpammersEnabled: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        campaigns: expect.arrayContaining([
          expect.objectContaining({
            distinctUsersCount: 2,
          }),
        ]),
        latestShadowScore: expect.objectContaining({
          v2Score: latestShadowScore.v2Score,
        }),
        policy: expect.objectContaining({
          shadowScore: latestShadowScore.v2Score,
          campaignBreakdown: expect.any(Object),
        }),
      }),
    );
  });

  it('suppresses graph observations created during an active suppression window', async () => {
    const { prisma, observations } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    await service.recordObservation({
      userId: 'user-graph-seed',
      source: 'COMMERCIAL_AD',
      score: 0.58,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-1',
      evidence: { excerpt: 'Реклама услуги на https://bad.example/order сегодня' },
    });
    await service.recordSuppression({
      userId: 'user-graph-suppressed',
      source: 'MANUAL_UNBAN',
      reason: 'manual false positive',
    });
    const result = await service.recordObservation({
      userId: 'user-graph-suppressed',
      source: 'COMMERCIAL_AD',
      score: 0.58,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-2',
      evidence: { excerpt: 'Реклама услуги на https://bad.example/order сегодня' },
    });

    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'suppressed',
        aggregateScore: 0,
      }),
    );
    expect(
      observations.filter(
        (row) => row.userId === 'user-graph-suppressed' && row.source.startsWith('GRAPH_'),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          suppressedAt: expect.any(Date),
          suppressionReason: 'manual false positive',
        }),
      ]),
    );
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
          policyBand: 'CONFIRMED',
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
          policyBand: 'CONFIRMED',
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

  it('records shadow and campaign context with policy decisions', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    await service.recordObservation({
      userId: 'user-policy-context',
      source: 'FANOUT_HIGH',
      score: 0.94,
      reason: 'FANOUT_EPISODE_CONFIRMED',
      chatId: 'chat-policy',
      evidence: {
        uniqueChats: 6,
        windowSec: 120,
        excerpt: 'Одинаковая рассылка https://context.example/join сегодня',
      },
      forceRegistry: true,
    });

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-policy',
        userId: 'user-policy-context',
        trigger: 'message',
        deleteSpammersEnabled: true,
        recordDecision: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'ACTIVE_CONFIRMED',
        policyBand: 'CONFIRMED',
        shadowScore: expect.any(Number),
        campaignBreakdown: expect.any(Object),
      }),
    );

    expect(prisma.globalSpammerEnforcementDecision.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          policyBand: 'CONFIRMED',
          shadowScore: expect.any(Number),
          campaignBreakdown: expect.any(Object),
        }),
      }),
    );
  });

  it('records review feedback and marks shadow scores with human outcomes', async () => {
    const { candidates, prisma, reviewFeedback, shadowScores } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    await service.recordObservation({
      userId: 'user-review-feedback',
      source: 'FANOUT_REPEAT',
      score: 0.68,
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      chatId: 'chat-review',
      evidence: {
        uniqueChats: 5,
        windowSec: 120,
        excerpt: 'Повторная рассылка https://feedback.example/order сегодня',
      },
    });

    await expect(
      service.reviewCandidate({
        chatId: 'chat-review',
        userId: 'user-review-feedback',
        reviewerUserId: 'admin-reviewer',
        action: 'SUPPRESS',
        reason: 'false positive from local context',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'SUPPRESSED',
      }),
    );

    expect(reviewFeedback).toEqual([
      expect.objectContaining({
        userId: 'user-review-feedback',
        reviewerUserId: 'admin-reviewer',
        action: 'SUPPRESS',
        candidateStatusBefore: 'PENDING',
        confidenceScoreBefore: expect.any(Number),
        campaignBreakdown: expect.any(Object),
      }),
    ]);
    expect(candidates.get('user-review-feedback')).toEqual(
      expect.objectContaining({
        status: 'SUPPRESSED',
        falsePositive: true,
        reviewReason: 'false positive from local context',
      }),
    );
    expect(shadowScores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          humanReviewOutcome: 'SUPPRESS',
          reviewedByUserId: 'admin-reviewer',
        }),
      ]),
    );
    expect(prisma.globalSpammerShadowScore.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          humanReviewOutcome: 'SUPPRESS',
        }),
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
