import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  COMMERCIAL_CAMPAIGN_WINDOW_SEC,
  type CommercialCampaignContext,
} from './commercial-campaign.util';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { type RuleViolation } from './rule-engine.contract';
import { maskText } from './text-mask.util';

export const GLOBAL_SPAMMER_OBSERVATION_SOURCES = [
  'FANOUT_HIGH',
  'FANOUT_REPEAT',
  'COMMERCIAL_AD',
  'COMMERCIAL_CAMPAIGN',
  'REPEATED_LINK',
  'REPEATED_PHONE',
  'SANCTION_BAN',
  'MANUAL_BAN',
  'REVIEW_APPROVED',
] as const;

export type GlobalSpammerObservationSource = (typeof GLOBAL_SPAMMER_OBSERVATION_SOURCES)[number];
export type GlobalSpammerConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type GlobalSpammerCandidateStatus = 'PENDING' | 'AUTO_APPROVED' | 'APPROVED' | 'SUPPRESSED';

export type GlobalSpammerObservationInput = {
  userId: string;
  source: GlobalSpammerObservationSource;
  score: number;
  reason: string;
  chatId?: string | null;
  messageId?: string | null;
  userLabel?: string | null;
  evidence?: Prisma.InputJsonValue;
  evidenceHash?: string | null;
  observedAt?: Date;
  ttlDays?: number;
  forceRegistry?: boolean;
};

export type GlobalSpammerSuppressionInput = {
  userId: string;
  source: 'MANUAL_UNBAN' | 'ADMIN_EXEMPTION' | 'REVIEW_SUPPRESSION';
  reason: string;
  adminUserId?: string | null;
  sourceChatId?: string | null;
  ttlDays?: number;
  evidence?: Prisma.InputJsonValue;
  falsePositive?: boolean;
};

export type GlobalSpammerObservationDecision = {
  outcome: 'ignored' | 'observed' | 'candidate' | 'registry' | 'suppressed';
  userId: string;
  aggregateScore: number;
  confidenceLevel: GlobalSpammerConfidenceLevel;
  sourceBreakdown: Prisma.InputJsonValue;
  evidenceHash?: string;
  suppressedUntil?: string | null;
};

type ActiveObservationRow = {
  id: string;
  userId: string;
  source: string;
  score: number;
  reason: string;
  chatId: string | null;
  messageId: string | null;
  evidenceHash: string;
  evidence: Prisma.JsonValue | null;
  observedAt: Date;
  expiresAt: Date;
};

type AggregateSource = {
  source: string;
  score: number;
  rawScore: number;
  count: number;
  latestAt: string;
  reasons: string[];
};

type AggregateResult = {
  score: number;
  confidenceLevel: GlobalSpammerConfidenceLevel;
  sources: AggregateSource[];
  sourceBreakdown: Prisma.InputJsonObject;
};

type CandidateReviewAction = 'APPROVE' | 'SUPPRESS';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OBSERVATION_TTL_DAYS = 14;
const DEFAULT_SUPPRESSION_TTL_DAYS = 30;
const OBSERVATION_HALF_LIFE_DAYS = 7;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.55;
const HIGH_CONFIDENCE_THRESHOLD = 0.86;

const SOURCE_DEFAULT_TTL_DAYS: Partial<Record<GlobalSpammerObservationSource, number>> = {
  FANOUT_HIGH: 21,
  FANOUT_REPEAT: 14,
  COMMERCIAL_AD: 10,
  COMMERCIAL_CAMPAIGN: 14,
  REPEATED_LINK: 10,
  REPEATED_PHONE: 14,
  SANCTION_BAN: 21,
  MANUAL_BAN: 30,
  REVIEW_APPROVED: 90,
};

@Injectable()
export class GlobalSpammerIntelligenceService {
  private readonly logger = new Logger(GlobalSpammerIntelligenceService.name);

  constructor(private readonly prisma: PrismaService) {}

  async recordCommercialObservations(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    topViolation: RuleViolation;
    commercialCampaignContext: CommercialCampaignContext | null;
  }): Promise<GlobalSpammerObservationDecision[]> {
    const { chatId, userId, messageId, text, topViolation, commercialCampaignContext } = params;
    const metadata = this.asRecord(topViolation.metadata);
    const metadataCampaignContext = this.asRecord(metadata?.campaignContext);
    const repeatedLinkDistinctChatCount =
      this.readNumber(metadataCampaignContext?.repeatedLinkDistinctChatCount) ??
      commercialCampaignContext?.repeatedLinkDistinctChatCount ??
      0;
    const repeatedPhoneDistinctChatCount =
      this.readNumber(metadataCampaignContext?.repeatedPhoneDistinctChatCount) ??
      commercialCampaignContext?.repeatedPhoneDistinctChatCount ??
      0;
    const observations: Array<{
      source: GlobalSpammerObservationSource;
      score: number;
      reason: string;
      evidence: Prisma.InputJsonValue;
      ttlDays?: number;
    }> = [];

    if (topViolation.ruleCode === 'COMMERCIAL_AD') {
      const confidenceScore =
        typeof metadata?.confidenceScore === 'number'
          ? Math.max(0, Math.min(1, metadata.confidenceScore / 100))
          : topViolation.score;
      const actionBand = this.normalizeText(
        typeof metadata?.actionBand === 'string' ? metadata.actionBand : null,
      );
      const campaignContext = metadataCampaignContext ?? commercialCampaignContext;
      const source: GlobalSpammerObservationSource = campaignContext
        ? 'COMMERCIAL_CAMPAIGN'
        : 'COMMERCIAL_AD';
      const score =
        actionBand === 'DELETE_AND_ESCALATE'
          ? Math.max(confidenceScore, 0.82)
          : campaignContext
            ? Math.max(confidenceScore, 0.72)
            : Math.max(confidenceScore, 0.58);
      observations.push({
        source,
        score,
        reason: 'COMMERCIAL_AD_DETECTED',
        evidence: {
          ruleCode: topViolation.ruleCode,
          violationScore: topViolation.score,
          actionBand: actionBand || null,
          campaignContext: campaignContext ? JSON.parse(JSON.stringify(campaignContext)) : null,
          metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : null,
          excerpt: maskText(text),
        } as Prisma.InputJsonValue,
      });
    }

    if (metadataCampaignContext || commercialCampaignContext) {
      if (repeatedLinkDistinctChatCount >= 2) {
        observations.push({
          source: 'REPEATED_LINK',
          score: repeatedLinkDistinctChatCount >= 3 ? 0.68 : 0.58,
          reason: 'REPEATED_LINK_CROSS_CHAT',
          evidence: {
            repeatedLinkDistinctChatCount,
            windowSec: COMMERCIAL_CAMPAIGN_WINDOW_SEC,
            excerpt: maskText(text),
          },
        });
      }
      if (repeatedPhoneDistinctChatCount >= 2) {
        observations.push({
          source: 'REPEATED_PHONE',
          score: repeatedPhoneDistinctChatCount >= 3 ? 0.7 : 0.6,
          reason: 'REPEATED_PHONE_CROSS_CHAT',
          evidence: {
            repeatedPhoneDistinctChatCount,
            windowSec: COMMERCIAL_CAMPAIGN_WINDOW_SEC,
            excerpt: maskText(text),
          },
        });
      }
    }

    const decisions: GlobalSpammerObservationDecision[] = [];
    for (const observation of observations) {
      decisions.push(
        await this.recordObservation({
          userId,
          chatId,
          messageId,
          source: observation.source,
          score: observation.score,
          reason: observation.reason,
          evidence: observation.evidence,
          ttlDays: observation.ttlDays,
        }),
      );
    }
    return decisions;
  }

  async recordManualBanObservation(params: {
    chatId: string;
    targetUserId: string;
    actorUserId: string;
    source: string;
    executionMode: string;
  }): Promise<GlobalSpammerObservationDecision> {
    return this.recordObservation({
      userId: params.targetUserId,
      source: 'MANUAL_BAN',
      score: params.source === 'miniapp' ? 0.62 : 0.7,
      reason: 'MANUAL_BAN',
      chatId: params.chatId,
      evidence: {
        actorUserId: params.actorUserId,
        source: params.source,
        executionMode: params.executionMode,
      },
      ttlDays: 30,
    });
  }

  async recordObservation(
    input: GlobalSpammerObservationInput,
  ): Promise<GlobalSpammerObservationDecision> {
    const userId = this.normalizeUserId(input.userId);
    if (!userId) {
      return this.emptyDecision('ignored', '');
    }

    const now = input.observedAt ?? new Date();
    const score = this.clampScore(input.score);
    const ttlDays =
      input.ttlDays ?? SOURCE_DEFAULT_TTL_DAYS[input.source] ?? DEFAULT_OBSERVATION_TTL_DAYS;
    const expiresAt = new Date(now.getTime() + Math.max(1, ttlDays) * DAY_MS);
    const evidenceHash =
      this.normalizeText(input.evidenceHash) ||
      this.buildEvidenceHash({
        userId,
        source: input.source,
        chatId: input.chatId ?? null,
        messageId: input.messageId ?? null,
        evidence: input.evidence ?? Prisma.JsonNull,
      });
    const activeSuppression = await this.findActiveSuppression(userId, now);
    const confidenceLevel = this.resolveConfidenceLevel(score);

    await this.prisma.spammerObservation.upsert({
      where: {
        userId_source_evidenceHash: {
          userId,
          source: input.source,
          evidenceHash,
        },
      },
      create: {
        userId,
        source: input.source,
        score,
        confidenceLevel,
        reason: input.reason,
        chatId: input.chatId ?? null,
        messageId: input.messageId ?? null,
        evidenceHash,
        evidence: input.evidence ?? Prisma.JsonNull,
        observedAt: now,
        expiresAt,
        suppressedAt: activeSuppression ? now : null,
        suppressionReason: activeSuppression?.reason ?? null,
      },
      update: {
        score,
        confidenceLevel,
        reason: input.reason,
        chatId: input.chatId ?? null,
        messageId: input.messageId ?? null,
        evidence: input.evidence ?? Prisma.JsonNull,
        observedAt: now,
        expiresAt,
        suppressedAt: activeSuppression ? now : null,
        suppressionReason: activeSuppression?.reason ?? null,
      },
    });

    const aggregate = await this.computeAggregateForUser(userId, now);
    const sourceBreakdown = aggregate.sourceBreakdown;

    if (activeSuppression) {
      await this.upsertCandidate({
        userId,
        status: 'SUPPRESSED',
        reason: input.reason,
        chatId: input.chatId ?? null,
        messageId: input.messageId ?? null,
        userLabel: input.userLabel ?? null,
        evidence: this.buildCandidateEvidence(input, aggregate, evidenceHash),
        aggregate,
        suppressedUntil: activeSuppression.suppressedUntil,
        reviewedByUserId: activeSuppression.adminUserId ?? null,
        reviewReason: activeSuppression.reason,
        falsePositive: true,
      });

      return {
        outcome: 'suppressed',
        userId,
        aggregateScore: aggregate.score,
        confidenceLevel: aggregate.confidenceLevel,
        sourceBreakdown,
        evidenceHash,
        suppressedUntil: activeSuppression.suppressedUntil.toISOString(),
      };
    }

    if (input.forceRegistry || aggregate.score >= HIGH_CONFIDENCE_THRESHOLD) {
      await this.promoteToRegistry({
        userId,
        sourceChatId: input.chatId ?? null,
        reason: input.reason,
        evidence: this.buildCandidateEvidence(input, aggregate, evidenceHash),
        aggregate,
        status: input.source === 'REVIEW_APPROVED' ? 'APPROVED' : 'AUTO_APPROVED',
        reviewedByUserId: null,
        reviewReason: null,
      });
      return {
        outcome: 'registry',
        userId,
        aggregateScore: aggregate.score,
        confidenceLevel: aggregate.confidenceLevel,
        sourceBreakdown,
        evidenceHash,
      };
    }

    if (aggregate.score >= MEDIUM_CONFIDENCE_THRESHOLD) {
      await this.upsertCandidate({
        userId,
        status: 'PENDING',
        reason: input.reason,
        chatId: input.chatId ?? null,
        messageId: input.messageId ?? null,
        userLabel: input.userLabel ?? null,
        evidence: this.buildCandidateEvidence(input, aggregate, evidenceHash),
        aggregate,
        suppressedUntil: null,
        reviewedByUserId: null,
        reviewReason: null,
        falsePositive: false,
      });
      return {
        outcome: 'candidate',
        userId,
        aggregateScore: aggregate.score,
        confidenceLevel: aggregate.confidenceLevel,
        sourceBreakdown,
        evidenceHash,
      };
    }

    return {
      outcome: 'observed',
      userId,
      aggregateScore: aggregate.score,
      confidenceLevel: aggregate.confidenceLevel,
      sourceBreakdown,
      evidenceHash,
    };
  }

  async recordSuppression(input: GlobalSpammerSuppressionInput): Promise<{ ok: true }> {
    const userId = this.normalizeUserId(input.userId);
    if (!userId) {
      return { ok: true };
    }

    const now = new Date();
    const suppressedUntil = new Date(
      now.getTime() + Math.max(1, input.ttlDays ?? DEFAULT_SUPPRESSION_TTL_DAYS) * DAY_MS,
    );
    await this.prisma.$transaction([
      this.prisma.globalSpammerSuppression.create({
        data: {
          userId,
          source: input.source,
          reason: input.reason,
          adminUserId: this.normalizeUserId(input.adminUserId ?? '') || null,
          sourceChatId: input.sourceChatId ?? null,
          suppressedUntil,
          evidence: input.evidence ?? Prisma.JsonNull,
        },
      }),
      this.prisma.globalSpammer.deleteMany({
        where: {
          userId,
        },
      }),
      this.prisma.globalSpammerCandidate.upsert({
        where: {
          userId,
        },
        create: {
          userId,
          status: 'SUPPRESSED',
          lastReason: input.reason,
          lastChatId: input.sourceChatId ?? null,
          lastEvidence: input.evidence ?? Prisma.JsonNull,
          confidenceScore: 0,
          sourceBreakdown: {},
          suppressedUntil,
          reviewedAt: now,
          reviewedByUserId: this.normalizeUserId(input.adminUserId ?? '') || null,
          reviewReason: input.reason,
          falsePositive: input.falsePositive ?? true,
        },
        update: {
          status: 'SUPPRESSED',
          lastReason: input.reason,
          lastChatId: input.sourceChatId ?? null,
          lastEvidence: input.evidence ?? Prisma.JsonNull,
          confidenceScore: 0,
          suppressedUntil,
          reviewedAt: now,
          reviewedByUserId: this.normalizeUserId(input.adminUserId ?? '') || null,
          reviewReason: input.reason,
          falsePositive: input.falsePositive ?? true,
        },
      }),
      this.prisma.spammerObservation.updateMany({
        where: {
          userId,
          expiresAt: {
            gt: now,
          },
          suppressedAt: null,
        },
        data: {
          suppressedAt: now,
          suppressionReason: input.reason,
        },
      }),
    ]);

    return { ok: true };
  }

  async reviewCandidate(params: {
    chatId: string;
    userId: string;
    reviewerUserId: string;
    action: CandidateReviewAction;
    reason?: string | null;
  }): Promise<{ ok: true; status: GlobalSpammerCandidateStatus; userId: string }> {
    const userId = this.normalizeUserId(params.userId);
    if (!userId) {
      throw new Error('User ID is required');
    }

    const reason =
      this.normalizeText(params.reason) ||
      (params.action === 'APPROVE' ? 'REVIEW_APPROVED' : 'REVIEW_SUPPRESSED');

    if (params.action === 'SUPPRESS') {
      await this.recordSuppression({
        userId,
        source: 'REVIEW_SUPPRESSION',
        reason,
        adminUserId: params.reviewerUserId,
        sourceChatId: params.chatId,
        falsePositive: true,
      });
      return { ok: true, status: 'SUPPRESSED', userId };
    }

    const aggregate = await this.computeAggregateForUser(userId, new Date());
    await this.recordObservation({
      userId,
      source: 'REVIEW_APPROVED',
      score: 1,
      reason,
      chatId: params.chatId,
      evidence: {
        reviewerUserId: params.reviewerUserId,
        aggregateScoreBeforeReview: aggregate.score,
      },
      forceRegistry: true,
      ttlDays: SOURCE_DEFAULT_TTL_DAYS.REVIEW_APPROVED,
    });
    await this.prisma.globalSpammerCandidate.update({
      where: {
        userId,
      },
      data: {
        status: 'APPROVED',
        reviewedAt: new Date(),
        reviewedByUserId: params.reviewerUserId,
        reviewReason: reason,
        falsePositive: false,
      },
    });

    return { ok: true, status: 'APPROVED', userId };
  }

  async listReviewQueue(params: {
    chatId: string;
    status?: GlobalSpammerCandidateStatus | 'ALL';
    limit?: number;
  }) {
    const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
    const status = params.status && params.status !== 'ALL' ? params.status : undefined;
    const candidates = await this.prisma.globalSpammerCandidate.findMany({
      where: {
        ...(status ? { status } : {}),
        OR: [
          { lastChatId: params.chatId },
          {
            chats: {
              some: {
                chatId: params.chatId,
              },
            },
          },
        ],
      },
      orderBy: [{ confidenceScore: 'desc' }, { lastDetectedAt: 'desc' }],
      take: limit,
      include: {
        chats: {
          orderBy: {
            lastDetectedAt: 'desc',
          },
          take: 10,
        },
      },
    });
    const userIds = candidates.map((candidate) => candidate.userId);
    const observations =
      userIds.length === 0
        ? []
        : await this.prisma.spammerObservation.findMany({
            where: {
              userId: {
                in: userIds,
              },
            },
            orderBy: {
              observedAt: 'desc',
            },
            take: limit * 6,
          });
    const observationsByUserId = new Map<string, typeof observations>();
    for (const observation of observations) {
      const rows = observationsByUserId.get(observation.userId) ?? [];
      rows.push(observation);
      observationsByUserId.set(observation.userId, rows);
    }

    return {
      items: candidates.map((candidate) => ({
        userId: candidate.userId,
        status: candidate.status,
        confidenceScore: candidate.confidenceScore,
        sourceBreakdown: candidate.sourceBreakdown,
        lastReason: candidate.lastReason,
        lastChatId: candidate.lastChatId,
        lastEvidence: candidate.lastEvidence,
        lastUserLabel: candidate.lastUserLabel,
        suppressedUntil: candidate.suppressedUntil?.toISOString() ?? null,
        reviewedAt: candidate.reviewedAt?.toISOString() ?? null,
        reviewedByUserId: candidate.reviewedByUserId,
        reviewReason: candidate.reviewReason,
        falsePositive: candidate.falsePositive,
        chats: candidate.chats.map((chat) => ({
          chatId: chat.chatId,
          detectionsCount: chat.detectionsCount,
          lastMessageId: chat.lastMessageId,
          lastExcerpt: chat.lastExcerpt,
          lastUserLabel: chat.lastUserLabel,
          lastDetectedAt: chat.lastDetectedAt.toISOString(),
        })),
        observations: (observationsByUserId.get(candidate.userId) ?? []).slice(0, 6).map((row) => ({
          id: row.id,
          source: row.source,
          score: row.score,
          confidenceLevel: row.confidenceLevel,
          reason: row.reason,
          chatId: row.chatId,
          messageId: row.messageId,
          evidenceHash: row.evidenceHash,
          evidence: row.evidence,
          observedAt: row.observedAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          suppressedAt: row.suppressedAt?.toISOString() ?? null,
          suppressionReason: row.suppressionReason,
        })),
      })),
      limit,
    };
  }

  async getReviewMetrics(params: { chatId?: string | null } = {}) {
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const candidateWhere = params.chatId
      ? {
          OR: [
            { lastChatId: params.chatId },
            {
              chats: {
                some: {
                  chatId: params.chatId,
                },
              },
            },
          ],
        }
      : {};

    const [
      pending,
      approved,
      suppressed,
      reviewed,
      falsePositiveCount,
      recentObservations,
      suppressedObservations,
    ] = await Promise.all([
      this.prisma.globalSpammerCandidate.count({
        where: {
          ...candidateWhere,
          status: 'PENDING',
        },
      }),
      this.prisma.globalSpammerCandidate.count({
        where: {
          ...candidateWhere,
          status: {
            in: ['APPROVED', 'AUTO_APPROVED'],
          },
        },
      }),
      this.prisma.globalSpammerCandidate.count({
        where: {
          ...candidateWhere,
          status: 'SUPPRESSED',
        },
      }),
      this.prisma.globalSpammerCandidate.count({
        where: {
          ...candidateWhere,
          status: {
            in: ['APPROVED', 'SUPPRESSED'],
          },
        },
      }),
      this.prisma.globalSpammerCandidate.count({
        where: {
          ...candidateWhere,
          falsePositive: true,
        },
      }),
      this.prisma.spammerObservation.groupBy({
        by: ['source'],
        where: {
          observedAt: {
            gte: since,
          },
          ...(params.chatId ? { chatId: params.chatId } : {}),
        },
        _count: {
          _all: true,
        },
      }),
      this.prisma.spammerObservation.groupBy({
        by: ['source'],
        where: {
          suppressedAt: {
            gte: since,
          },
          ...(params.chatId ? { chatId: params.chatId } : {}),
        },
        _count: {
          _all: true,
        },
      }),
    ]);

    const sourceAlerts = this.buildSourceAlerts({
      recentObservations: recentObservations.map((row) => ({
        source: row.source,
        count: row._count._all,
      })),
      suppressedObservations: suppressedObservations.map((row) => ({
        source: row.source,
        count: row._count._all,
      })),
    });

    return {
      pending,
      approved,
      suppressed,
      reviewed,
      falsePositiveCount,
      falsePositiveRate: reviewed > 0 ? this.roundScore(falsePositiveCount / reviewed) : 0,
      recentObservations: recentObservations.map((row) => ({
        source: row.source,
        count: row._count._all,
      })),
      suppressedObservations: suppressedObservations.map((row) => ({
        source: row.source,
        count: row._count._all,
      })),
      sourceAlerts,
    };
  }

  buildSourceAlerts(params: {
    recentObservations: Array<{ source: string; count: number }>;
    suppressedObservations: Array<{ source: string; count: number }>;
  }): Array<{ source: string; level: 'warning' | 'critical'; reason: string }> {
    const totalRecent = params.recentObservations.reduce((sum, row) => sum + row.count, 0);
    const suppressedBySource = new Map(
      params.suppressedObservations.map((row) => [row.source, row.count]),
    );
    const alerts: Array<{ source: string; level: 'warning' | 'critical'; reason: string }> = [];

    for (const row of params.recentObservations) {
      const share = totalRecent > 0 ? row.count / totalRecent : 0;
      const suppressed = suppressedBySource.get(row.source) ?? 0;
      const suppressedRate = row.count > 0 ? suppressed / row.count : 0;
      if (row.count >= 50 && share >= 0.75) {
        alerts.push({
          source: row.source,
          level: share >= 0.9 ? 'critical' : 'warning',
          reason: `source dominates recent observations (${Math.round(share * 100)}%)`,
        });
      } else if (row.count >= 10 && suppressedRate >= 0.35) {
        alerts.push({
          source: row.source,
          level: suppressedRate >= 0.6 ? 'critical' : 'warning',
          reason: `source has high suppression rate (${Math.round(suppressedRate * 100)}%)`,
        });
      }
    }

    return alerts;
  }

  private async findActiveSuppression(userId: string, now: Date) {
    return this.prisma.globalSpammerSuppression.findFirst({
      where: {
        userId,
        suppressedUntil: {
          gt: now,
        },
      },
      orderBy: {
        suppressedUntil: 'desc',
      },
    });
  }

  private async computeAggregateForUser(userId: string, now: Date): Promise<AggregateResult> {
    const rows = await this.prisma.spammerObservation.findMany({
      where: {
        userId,
        expiresAt: {
          gt: now,
        },
        suppressedAt: null,
      },
      orderBy: {
        observedAt: 'desc',
      },
      take: 100,
    });

    return this.computeAggregate(rows, now);
  }

  computeAggregate(rows: readonly ActiveObservationRow[], now: Date): AggregateResult {
    const sourceMap = new Map<string, AggregateSource>();
    for (const row of rows) {
      if (row.expiresAt <= now) {
        continue;
      }
      const decayedScore = this.calculateDecayedScore(row.score, row.observedAt, now);
      const existing = sourceMap.get(row.source);
      const latestAt =
        existing && Date.parse(existing.latestAt) > row.observedAt.getTime()
          ? existing.latestAt
          : row.observedAt.toISOString();
      const reasons = new Set(existing?.reasons ?? []);
      reasons.add(row.reason);
      sourceMap.set(row.source, {
        source: row.source,
        score: Math.max(existing?.score ?? 0, decayedScore),
        rawScore: Math.max(existing?.rawScore ?? 0, row.score),
        count: (existing?.count ?? 0) + 1,
        latestAt,
        reasons: [...reasons].slice(0, 5),
      });
    }

    const sources = [...sourceMap.values()].sort((a, b) => b.score - a.score);
    const sourceWeights = [1, 0.22, 0.12, 0.08, 0.05];
    const weightedScore = sources.reduce(
      (sum, source, index) => sum + source.score * (sourceWeights[index] ?? 0.03),
      0,
    );
    const multiSourceBonus = sources.length >= 3 ? 0.07 : sources.length >= 2 ? 0.04 : 0;
    const score = this.clampScore(weightedScore + multiSourceBonus);
    const sourceBreakdown: Record<string, Prisma.InputJsonValue> = {};
    for (const source of sources) {
      sourceBreakdown[source.source] = {
        score: this.roundScore(source.score),
        rawScore: this.roundScore(source.rawScore),
        count: source.count,
        latestAt: source.latestAt,
        reasons: source.reasons,
      };
    }

    return {
      score: this.roundScore(score),
      confidenceLevel: this.resolveConfidenceLevel(score),
      sources,
      sourceBreakdown: sourceBreakdown as Prisma.InputJsonObject,
    };
  }

  private calculateDecayedScore(score: number, observedAt: Date, now: Date): number {
    const ageDays = Math.max(0, now.getTime() - observedAt.getTime()) / DAY_MS;
    const decay = Math.pow(0.5, ageDays / OBSERVATION_HALF_LIFE_DAYS);
    return this.clampScore(score * decay);
  }

  private async promoteToRegistry(params: {
    userId: string;
    sourceChatId: string | null;
    reason: string;
    evidence: Prisma.InputJsonValue;
    aggregate: AggregateResult;
    status: GlobalSpammerCandidateStatus;
    reviewedByUserId: string | null;
    reviewReason: string | null;
  }): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * DAY_MS);
    await this.prisma.$transaction([
      this.prisma.globalSpammer.upsert({
        where: {
          userId: params.userId,
        },
        create: {
          userId: params.userId,
          lastReason: params.reason,
          lastChatId: params.sourceChatId,
          lastEvidence: params.evidence,
          confidenceScore: params.aggregate.score,
          confirmedAt: now,
          expiresAt,
          sourceBreakdown: params.aggregate.sourceBreakdown,
        },
        update: {
          detectionsCount: {
            increment: 1,
          },
          lastReason: params.reason,
          lastChatId: params.sourceChatId,
          lastEvidence: params.evidence,
          confidenceScore: params.aggregate.score,
          confirmedAt: now,
          expiresAt,
          sourceBreakdown: params.aggregate.sourceBreakdown,
        },
      }),
      this.prisma.globalSpammerCandidate.upsert({
        where: {
          userId: params.userId,
        },
        create: {
          userId: params.userId,
          status: params.status,
          lastReason: params.reason,
          lastChatId: params.sourceChatId,
          lastEvidence: params.evidence,
          confidenceScore: params.aggregate.score,
          sourceBreakdown: params.aggregate.sourceBreakdown,
          reviewedAt: now,
          reviewedByUserId: params.reviewedByUserId,
          reviewReason: params.reviewReason,
          falsePositive: false,
        },
        update: {
          status: params.status,
          detectionsCount: {
            increment: 1,
          },
          lastReason: params.reason,
          lastChatId: params.sourceChatId,
          lastEvidence: params.evidence,
          confidenceScore: params.aggregate.score,
          sourceBreakdown: params.aggregate.sourceBreakdown,
          reviewedAt: now,
          reviewedByUserId: params.reviewedByUserId,
          reviewReason: params.reviewReason,
          falsePositive: false,
        },
      }),
    ]);
  }

  private async upsertCandidate(params: {
    userId: string;
    status: GlobalSpammerCandidateStatus;
    reason: string;
    chatId: string | null;
    messageId: string | null;
    userLabel: string | null;
    evidence: Prisma.InputJsonValue;
    aggregate: AggregateResult;
    suppressedUntil: Date | null;
    reviewedByUserId: string | null;
    reviewReason: string | null;
    falsePositive: boolean;
  }): Promise<void> {
    const now = new Date();
    await this.prisma.globalSpammerCandidate.upsert({
      where: {
        userId: params.userId,
      },
      create: {
        userId: params.userId,
        status: params.status,
        lastReason: params.reason,
        lastChatId: params.chatId,
        lastEvidence: params.evidence,
        lastUserLabel: params.userLabel,
        confidenceScore: params.aggregate.score,
        sourceBreakdown: params.aggregate.sourceBreakdown,
        suppressedUntil: params.suppressedUntil,
        reviewedAt: params.status === 'PENDING' ? null : now,
        reviewedByUserId: params.reviewedByUserId,
        reviewReason: params.reviewReason,
        falsePositive: params.falsePositive,
      },
      update: {
        status: params.status,
        detectionsCount: {
          increment: 1,
        },
        lastReason: params.reason,
        lastChatId: params.chatId,
        lastEvidence: params.evidence,
        lastUserLabel: params.userLabel,
        confidenceScore: params.aggregate.score,
        sourceBreakdown: params.aggregate.sourceBreakdown,
        suppressedUntil: params.suppressedUntil,
        reviewedAt: params.status === 'PENDING' ? null : now,
        reviewedByUserId: params.reviewedByUserId,
        reviewReason: params.reviewReason,
        falsePositive: params.falsePositive,
      },
    });

    if (!params.chatId) {
      return;
    }

    await this.prisma.globalSpammerCandidateChat.upsert({
      where: {
        candidateUserId_chatId: {
          candidateUserId: params.userId,
          chatId: params.chatId,
        },
      },
      create: {
        candidateUserId: params.userId,
        chatId: params.chatId,
        lastMessageId: params.messageId,
        lastExcerpt: this.extractEvidenceExcerpt(params.evidence),
        lastUserLabel: params.userLabel,
        lastEvidence: params.evidence,
      },
      update: {
        detectionsCount: {
          increment: 1,
        },
        lastMessageId: params.messageId,
        lastExcerpt: this.extractEvidenceExcerpt(params.evidence),
        lastUserLabel: params.userLabel,
        lastEvidence: params.evidence,
      },
    });
  }

  private buildCandidateEvidence(
    input: GlobalSpammerObservationInput,
    aggregate: AggregateResult,
    evidenceHash: string,
  ): Prisma.InputJsonValue {
    return {
      source: input.source,
      reason: input.reason,
      evidenceHash,
      score: this.roundScore(input.score),
      aggregateScore: aggregate.score,
      confidenceLevel: aggregate.confidenceLevel,
      sourceBreakdown: aggregate.sourceBreakdown,
      evidence: input.evidence ?? null,
    };
  }

  private buildEvidenceHash(value: unknown): string {
    return createHash('sha256').update(this.stableStringify(value)).digest('hex').slice(0, 32);
  }

  private stableStringify(value: unknown): string {
    if (value === null || value === undefined) {
      return 'null';
    }
    if (typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${this.stableStringify(item)}`)
      .join(',')}}`;
  }

  private extractEvidenceExcerpt(evidence: Prisma.InputJsonValue): string | null {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      return null;
    }
    const direct = (evidence as Record<string, unknown>).excerpt;
    if (typeof direct === 'string' && direct.trim()) {
      return direct.trim().slice(0, 240);
    }
    const nested = (evidence as Record<string, unknown>).evidence;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const nestedExcerpt = (nested as Record<string, unknown>).excerpt;
      if (typeof nestedExcerpt === 'string' && nestedExcerpt.trim()) {
        return nestedExcerpt.trim().slice(0, 240);
      }
    }
    return null;
  }

  private resolveConfidenceLevel(score: number): GlobalSpammerConfidenceLevel {
    if (score >= HIGH_CONFIDENCE_THRESHOLD) {
      return 'HIGH';
    }
    if (score >= MEDIUM_CONFIDENCE_THRESHOLD) {
      return 'MEDIUM';
    }
    return 'LOW';
  }

  private emptyDecision(
    outcome: GlobalSpammerObservationDecision['outcome'],
    userId: string,
  ): GlobalSpammerObservationDecision {
    return {
      outcome,
      userId,
      aggregateScore: 0,
      confidenceLevel: 'LOW',
      sourceBreakdown: {},
    };
  }

  private clampScore(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.min(1, value));
  }

  private roundScore(value: number): number {
    return Math.round(this.clampScore(value) * 1000) / 1000;
  }

  private normalizeUserId(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  private normalizeText(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
}
