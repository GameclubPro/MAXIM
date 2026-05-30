import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
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
  'GRAPH_DOMAIN',
  'GRAPH_PHONE',
  'GRAPH_TEXT',
  'GRAPH_CAMPAIGN',
  'GRAPH_FANOUT_PATTERN',
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

export type GlobalSpammerArchiveExpiredResult = {
  ok: true;
  dryRun: boolean;
  cutoff: string;
  scanned: number;
  archived: number;
  deleted: number;
  remainingExpired: number;
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
  reputationWeight: number;
  falsePositiveRate: number;
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
type GlobalSpammerRegistryStatus =
  | 'NONE'
  | 'ACTIVE_CONFIRMED'
  | 'MEDIUM_REVIEW'
  | 'SUPPRESSED'
  | 'EXPIRED'
  | 'ADMIN_EXEMPT';
type GlobalSpammerPolicyAction = 'NONE' | 'DELETE_AND_KICK' | 'SHADOW_DELETE_AND_KICK';
type GlobalSpammerEnforcementMode = 'enforce' | 'shadow';
type SpammerGraphSignalType = 'DOMAIN' | 'PHONE' | 'TEXT' | 'CAMPAIGN' | 'FANOUT_PATTERN';

export type GlobalSpammerPolicyDecision = {
  userId: string;
  chatId: string | null;
  trigger: string;
  registryStatus: GlobalSpammerRegistryStatus;
  action: GlobalSpammerPolicyAction;
  enforcementMode: GlobalSpammerEnforcementMode;
  deleteSpammersEnabled: boolean;
  adminExempt: boolean;
  shadow: boolean;
  wouldEnforce: boolean;
  enforced: boolean;
  confidenceScore: number | null;
  reason: string;
  expiresAt: string | null;
  sourceBreakdown: Prisma.InputJsonValue | null;
};

export type GlobalSpammerUserDiagnostics = {
  userId: string;
  chatId: string | null;
  policy: GlobalSpammerPolicyDecision;
  registry: {
    active: boolean;
    expired: boolean;
    confidenceScore: number | null;
    confirmedAt: string | null;
    confirmedByUserId: string | null;
    reason: string | null;
    expiresAt: string | null;
    sourceBreakdown: Prisma.JsonValue | null;
  };
  candidate: {
    status: string;
    confidenceScore: number;
    lastReason: string;
    reviewedAt: string | null;
    reviewedByUserId: string | null;
    reviewReason: string | null;
    falsePositive: boolean;
  } | null;
  activeSuppression: {
    source: string;
    reason: string;
    adminUserId: string | null;
    suppressedUntil: string;
  } | null;
  observations: Array<{
    id: string;
    source: string;
    score: number;
    confidenceLevel: string;
    reason: string;
    chatId: string | null;
    observedAt: string;
    expiresAt: string;
    suppressedAt: string | null;
  }>;
  graphSignals: Array<{
    signalType: string;
    source: string;
    score: number;
    chatId: string | null;
    observedAt: string;
    expiresAt: string;
  }>;
  sourceReputation: Array<{
    source: string;
    weight: number;
    falsePositiveRate: number;
    observations: number;
    suppressed: number;
  }>;
};

type SourceReputation = {
  source: string;
  weight: number;
  falsePositiveRate: number;
  observations: number;
  suppressed: number;
};

type ExtractedGraphSignal = {
  signalType: SpammerGraphSignalType;
  source: GlobalSpammerObservationSource;
  value: string;
  reason: string;
  score: number;
  evidence: Prisma.InputJsonObject;
};

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
  GRAPH_DOMAIN: 14,
  GRAPH_PHONE: 14,
  GRAPH_TEXT: 10,
  GRAPH_CAMPAIGN: 21,
  GRAPH_FANOUT_PATTERN: 7,
  SANCTION_BAN: 21,
  MANUAL_BAN: 30,
  REVIEW_APPROVED: 90,
};

const SOURCE_BASE_REPUTATION_WEIGHTS: Record<GlobalSpammerObservationSource, number> = {
  FANOUT_HIGH: 1,
  FANOUT_REPEAT: 0.82,
  COMMERCIAL_AD: 0.74,
  COMMERCIAL_CAMPAIGN: 0.9,
  REPEATED_LINK: 0.78,
  REPEATED_PHONE: 0.82,
  GRAPH_DOMAIN: 0.72,
  GRAPH_PHONE: 0.78,
  GRAPH_TEXT: 0.68,
  GRAPH_CAMPAIGN: 0.86,
  GRAPH_FANOUT_PATTERN: 0.65,
  SANCTION_BAN: 0.84,
  MANUAL_BAN: 0.88,
  REVIEW_APPROVED: 1,
};

const SOURCE_REPUTATION_WINDOW_DAYS = 30;
const RECENT_SUPPRESSION_MEMORY_DAYS = 30;
const GRAPH_SIGNAL_TTL_DAYS = 14;
const GRAPH_OBSERVATION_TTL_DAYS = 14;

@Injectable()
export class GlobalSpammerIntelligenceService {
  private readonly logger = new Logger(GlobalSpammerIntelligenceService.name);
  private readonly defaultEnforcementMode: GlobalSpammerEnforcementMode;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() configService?: ConfigService,
  ) {
    this.defaultEnforcementMode = this.resolveDefaultEnforcementMode(configService);
  }

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

    if (!this.isGraphObservationSource(input.source)) {
      await this.recordGraphSignalsForObservation({
        userId,
        input,
        observedAt: now,
        activeSuppression,
      });
    }

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

    const thresholdAdjustment = await this.resolveRecentSuppressionThresholdAdjustment(userId, now);
    const highConfidenceThreshold = HIGH_CONFIDENCE_THRESHOLD + thresholdAdjustment;
    const mediumConfidenceThreshold = MEDIUM_CONFIDENCE_THRESHOLD + thresholdAdjustment;

    if (input.forceRegistry || aggregate.score >= highConfidenceThreshold) {
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

    if (aggregate.score >= mediumConfidenceThreshold) {
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
      sourceReputation,
      activeRegistry,
      expiredRegistry,
      archivedExpired,
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
      this.getSourceReputation(now),
      this.prisma.globalSpammer.count({
        where: {
          expiresAt: {
            gt: now,
          },
        },
      }),
      this.prisma.globalSpammer.count({
        where: this.buildExpiredRegistryWhere(now),
      }),
      this.prisma.globalSpammerArchive.count(),
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
      activeRegistry,
      expiredRegistry,
      archivedExpired,
      enforcementMode: this.defaultEnforcementMode,
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
      sourceReputation,
    };
  }

  async archiveExpiredRegistryEntries(
    params: { limit?: number; dryRun?: boolean; now?: Date } = {},
  ): Promise<GlobalSpammerArchiveExpiredResult> {
    const now = params.now ?? new Date();
    const limit = Math.max(1, Math.min(params.limit ?? 1000, 5000));
    const expiredWhere = this.buildExpiredRegistryWhere(now);
    const expiredRows = await this.prisma.globalSpammer.findMany({
      where: expiredWhere,
      orderBy: [{ expiresAt: 'asc' }, { lastDetectedAt: 'asc' }],
      take: limit,
    });

    if (params.dryRun || expiredRows.length === 0) {
      const remainingExpired = await this.prisma.globalSpammer.count({
        where: expiredWhere,
      });
      return {
        ok: true,
        dryRun: Boolean(params.dryRun),
        cutoff: now.toISOString(),
        scanned: expiredRows.length,
        archived: 0,
        deleted: 0,
        remainingExpired,
      };
    }

    const userIds = expiredRows.map((row) => row.userId);
    const [archiveResult, deleteResult] = await this.prisma.$transaction([
      this.prisma.globalSpammerArchive.createMany({
        data: expiredRows.map((row) => ({
          id: randomUUID(),
          userId: row.userId,
          firstDetectedAt: row.firstDetectedAt,
          lastDetectedAt: row.lastDetectedAt,
          detectionsCount: row.detectionsCount,
          lastReason: row.lastReason,
          lastChatId: row.lastChatId,
          lastEvidence: row.lastEvidence ?? Prisma.JsonNull,
          confidenceScore: row.confidenceScore,
          confirmedAt: row.confirmedAt,
          expiredAt: row.expiresAt,
          sourceBreakdown: row.sourceBreakdown ?? {},
          archiveReason: 'EXPIRED',
        })),
        skipDuplicates: true,
      }),
      this.prisma.globalSpammer.deleteMany({
        where: {
          userId: {
            in: userIds,
          },
          ...expiredWhere,
        },
      }),
    ]);
    const remainingExpired = await this.prisma.globalSpammer.count({
      where: expiredWhere,
    });

    return {
      ok: true,
      dryRun: false,
      cutoff: now.toISOString(),
      scanned: expiredRows.length,
      archived: archiveResult.count,
      deleted: deleteResult.count,
      remainingExpired,
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

  async evaluatePolicy(params: {
    chatId?: string | null;
    userId: string;
    messageId?: string | null;
    trigger: string;
    deleteSpammersEnabled: boolean;
    adminExempt?: boolean;
    enforcementMode?: GlobalSpammerEnforcementMode;
    recordDecision?: boolean;
    enforced?: boolean;
  }): Promise<GlobalSpammerPolicyDecision> {
    const userId = this.normalizeUserId(params.userId);
    const chatId = this.normalizeText(params.chatId ?? '') || null;
    const now = new Date();
    const enforcementMode = params.enforcementMode ?? this.defaultEnforcementMode;
    const activeSuppression = userId ? await this.findActiveSuppression(userId, now) : null;
    const adminExempt = Boolean(params.adminExempt);

    let decision: GlobalSpammerPolicyDecision;
    if (!userId) {
      decision = this.buildPolicyDecision({
        userId,
        chatId,
        trigger: params.trigger,
        registryStatus: 'NONE',
        action: 'NONE',
        enforcementMode,
        deleteSpammersEnabled: params.deleteSpammersEnabled,
        adminExempt,
        confidenceScore: null,
        reason: 'USER_ID_REQUIRED',
        expiresAt: null,
        sourceBreakdown: null,
        enforced: false,
      });
    } else if (adminExempt) {
      decision = this.buildPolicyDecision({
        userId,
        chatId,
        trigger: params.trigger,
        registryStatus: 'ADMIN_EXEMPT',
        action: 'NONE',
        enforcementMode,
        deleteSpammersEnabled: params.deleteSpammersEnabled,
        adminExempt,
        confidenceScore: null,
        reason: 'ADMIN_EXEMPT',
        expiresAt: null,
        sourceBreakdown: null,
        enforced: false,
      });
    } else if (activeSuppression) {
      decision = this.buildPolicyDecision({
        userId,
        chatId,
        trigger: params.trigger,
        registryStatus: 'SUPPRESSED',
        action: 'NONE',
        enforcementMode,
        deleteSpammersEnabled: params.deleteSpammersEnabled,
        adminExempt,
        confidenceScore: null,
        reason: activeSuppression.reason,
        expiresAt: activeSuppression.suppressedUntil.toISOString(),
        sourceBreakdown: null,
        enforced: false,
      });
    } else {
      const registry = await this.prisma.globalSpammer.findUnique({
        where: {
          userId,
        },
      });
      if (registry?.expiresAt && registry.expiresAt > now) {
        const action = !params.deleteSpammersEnabled
          ? 'NONE'
          : enforcementMode === 'shadow'
            ? 'SHADOW_DELETE_AND_KICK'
            : 'DELETE_AND_KICK';
        decision = this.buildPolicyDecision({
          userId,
          chatId,
          trigger: params.trigger,
          registryStatus: 'ACTIVE_CONFIRMED',
          action,
          enforcementMode,
          deleteSpammersEnabled: params.deleteSpammersEnabled,
          adminExempt,
          confidenceScore: registry.confidenceScore,
          reason: registry.lastReason,
          expiresAt: registry.expiresAt.toISOString(),
          sourceBreakdown: registry.sourceBreakdown,
          enforced: Boolean(
            (params.enforced ?? params.recordDecision) && action === 'DELETE_AND_KICK',
          ),
        });
      } else if (registry) {
        decision = this.buildPolicyDecision({
          userId,
          chatId,
          trigger: params.trigger,
          registryStatus: 'EXPIRED',
          action: 'NONE',
          enforcementMode,
          deleteSpammersEnabled: params.deleteSpammersEnabled,
          adminExempt,
          confidenceScore: registry.confidenceScore,
          reason: registry.lastReason,
          expiresAt: registry.expiresAt?.toISOString() ?? null,
          sourceBreakdown: registry.sourceBreakdown,
          enforced: false,
        });
      } else {
        const candidate = await this.prisma.globalSpammerCandidate.findUnique({
          where: {
            userId,
          },
        });
        decision = this.buildPolicyDecision({
          userId,
          chatId,
          trigger: params.trigger,
          registryStatus:
            candidate?.status === 'PENDING' &&
            candidate.confidenceScore >= MEDIUM_CONFIDENCE_THRESHOLD
              ? 'MEDIUM_REVIEW'
              : 'NONE',
          action: 'NONE',
          enforcementMode,
          deleteSpammersEnabled: params.deleteSpammersEnabled,
          adminExempt,
          confidenceScore: candidate?.confidenceScore ?? null,
          reason: candidate?.lastReason ?? 'NO_ACTIVE_REGISTRY_ENTRY',
          expiresAt: candidate?.suppressedUntil?.toISOString() ?? null,
          sourceBreakdown: candidate?.sourceBreakdown ?? null,
          enforced: false,
        });
      }
    }

    if (params.recordDecision) {
      await this.recordPolicyDecision({
        decision,
        messageId: params.messageId ?? null,
      });
    }
    return decision;
  }

  async getUserDiagnostics(params: {
    chatId?: string | null;
    userId: string;
    deleteSpammersEnabled?: boolean;
    adminExempt?: boolean;
    enforcementMode?: GlobalSpammerEnforcementMode;
  }): Promise<GlobalSpammerUserDiagnostics> {
    const userId = this.normalizeUserId(params.userId);
    if (!userId) {
      throw new Error('User ID is required');
    }
    const chatId = this.normalizeText(params.chatId ?? '') || null;
    const now = new Date();
    const [resolvedDeleteSpammersEnabled, resolvedAdminExempt] = await Promise.all([
      params.deleteSpammersEnabled ?? this.resolveDeleteSpammersEnabled(chatId),
      params.adminExempt ?? this.resolveAnyAdminExemption(userId, chatId),
    ]);
    const [registry, candidate, activeSuppression, observations, graphSignals, reputation] =
      await Promise.all([
        this.prisma.globalSpammer.findUnique({ where: { userId } }),
        this.prisma.globalSpammerCandidate.findUnique({ where: { userId } }),
        this.findActiveSuppression(userId, now),
        this.prisma.spammerObservation.findMany({
          where: { userId },
          orderBy: { observedAt: 'desc' },
          take: 20,
        }),
        this.prisma.spammerGraphSignal.findMany({
          where: {
            userId,
            expiresAt: { gt: now },
          },
          orderBy: { observedAt: 'desc' },
          take: 20,
        }),
        this.getSourceReputation(now),
      ]);
    const policy = await this.evaluatePolicy({
      chatId,
      userId,
      trigger: 'diagnostics',
      deleteSpammersEnabled: resolvedDeleteSpammersEnabled,
      adminExempt: resolvedAdminExempt,
      enforcementMode: params.enforcementMode ?? this.defaultEnforcementMode,
    });

    return {
      userId,
      chatId,
      policy,
      registry: {
        active: Boolean(registry?.expiresAt && registry.expiresAt > now),
        expired: Boolean(registry && (!registry.expiresAt || registry.expiresAt <= now)),
        confidenceScore: registry?.confidenceScore ?? null,
        confirmedAt: registry?.confirmedAt?.toISOString() ?? null,
        confirmedByUserId: candidate?.reviewedByUserId ?? null,
        reason: registry?.lastReason ?? null,
        expiresAt: registry?.expiresAt?.toISOString() ?? null,
        sourceBreakdown: registry?.sourceBreakdown ?? null,
      },
      candidate: candidate
        ? {
            status: candidate.status,
            confidenceScore: candidate.confidenceScore,
            lastReason: candidate.lastReason,
            reviewedAt: candidate.reviewedAt?.toISOString() ?? null,
            reviewedByUserId: candidate.reviewedByUserId,
            reviewReason: candidate.reviewReason,
            falsePositive: candidate.falsePositive,
          }
        : null,
      activeSuppression: activeSuppression
        ? {
            source: activeSuppression.source,
            reason: activeSuppression.reason,
            adminUserId: activeSuppression.adminUserId,
            suppressedUntil: activeSuppression.suppressedUntil.toISOString(),
          }
        : null,
      observations: observations.map((row) => ({
        id: row.id,
        source: row.source,
        score: row.score,
        confidenceLevel: row.confidenceLevel,
        reason: row.reason,
        chatId: row.chatId,
        observedAt: row.observedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        suppressedAt: row.suppressedAt?.toISOString() ?? null,
      })),
      graphSignals: graphSignals.map((row) => ({
        signalType: row.signalType,
        source: row.source,
        score: row.score,
        chatId: row.chatId,
        observedAt: row.observedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
      sourceReputation: reputation,
    };
  }

  private async resolveDeleteSpammersEnabled(chatId: string | null): Promise<boolean> {
    if (!chatId) {
      return false;
    }
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        settings: {
          select: {
            deleteSpammersEnabled: true,
          },
        },
      },
    });
    return Boolean(chat?.settings?.deleteSpammersEnabled);
  }

  private buildExpiredRegistryWhere(now: Date): Prisma.GlobalSpammerWhereInput {
    return {
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
    };
  }

  private async resolveAnyAdminExemption(userId: string, chatId: string | null): Promise<boolean> {
    const row = await this.prisma.adminGlobalSpammerExemption.findFirst({
      where: {
        userId,
        OR: [{ sourceChatId: null }, ...(chatId ? [{ sourceChatId: chatId }] : [])],
      },
      select: {
        userId: true,
      },
    });
    return Boolean(row);
  }

  async getSourceReputation(now = new Date()): Promise<SourceReputation[]> {
    const since = new Date(now.getTime() - SOURCE_REPUTATION_WINDOW_DAYS * DAY_MS);
    const [observed, suppressed] = await Promise.all([
      this.prisma.spammerObservation.groupBy({
        by: ['source'],
        where: {
          observedAt: {
            gte: since,
          },
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
        },
        _count: {
          _all: true,
        },
      }),
    ]);
    const suppressedBySource = new Map(suppressed.map((row) => [row.source, row._count._all]));
    return observed
      .map((row) => {
        const observations = row._count._all;
        const suppressedCount = suppressedBySource.get(row.source) ?? 0;
        const falsePositiveRate = observations > 0 ? suppressedCount / observations : 0;
        const weight = this.resolveSourceReputationWeight(
          row.source,
          observations,
          falsePositiveRate,
        );
        return {
          source: row.source,
          weight,
          falsePositiveRate: this.roundScore(falsePositiveRate),
          observations,
          suppressed: suppressedCount,
        };
      })
      .sort((left, right) => left.source.localeCompare(right.source));
  }

  private async getSourceReputationMap(now: Date): Promise<Map<string, SourceReputation>> {
    const rows = await this.getSourceReputation(now);
    return new Map(rows.map((row) => [row.source, row]));
  }

  private resolveSourceReputationWeight(
    source: string,
    observations: number,
    falsePositiveRate: number,
  ): number {
    const baseWeight = this.resolveSourceBaseWeight(source);
    let qualityWeight = 1;
    if (observations >= 10 && falsePositiveRate >= 0.6) {
      qualityWeight = 0.5;
    } else if (observations >= 10 && falsePositiveRate >= 0.35) {
      qualityWeight = 0.65;
    } else if (observations >= 10 && falsePositiveRate >= 0.2) {
      qualityWeight = 0.8;
    }
    return this.roundScore(baseWeight * qualityWeight);
  }

  private resolveSourceBaseWeight(source: string): number {
    return SOURCE_BASE_REPUTATION_WEIGHTS[source as GlobalSpammerObservationSource] ?? 1;
  }

  private resolveDefaultEnforcementMode(
    configService?: ConfigService,
  ): GlobalSpammerEnforcementMode {
    const configuredMode = this.normalizeText(
      configService?.get<string>('GLOBAL_SPAMMER_ENFORCEMENT_MODE'),
    ).toLowerCase();
    if (configuredMode === 'shadow') {
      return 'shadow';
    }
    if (configuredMode === 'enforce') {
      return 'enforce';
    }

    const shadowFlag = this.normalizeText(
      configService?.get<string>('GLOBAL_SPAMMER_SHADOW_MODE'),
    ).toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(shadowFlag) ? 'shadow' : 'enforce';
  }

  private buildPolicyDecision(params: {
    userId: string;
    chatId: string | null;
    trigger: string;
    registryStatus: GlobalSpammerRegistryStatus;
    action: GlobalSpammerPolicyAction;
    enforcementMode: GlobalSpammerEnforcementMode;
    deleteSpammersEnabled: boolean;
    adminExempt: boolean;
    confidenceScore: number | null;
    reason: string;
    expiresAt: string | null;
    sourceBreakdown: Prisma.InputJsonValue | null;
    enforced: boolean;
  }): GlobalSpammerPolicyDecision {
    const wouldEnforce = params.registryStatus === 'ACTIVE_CONFIRMED';
    return {
      userId: params.userId,
      chatId: params.chatId,
      trigger: params.trigger,
      registryStatus: params.registryStatus,
      action: params.action,
      enforcementMode: params.enforcementMode,
      deleteSpammersEnabled: params.deleteSpammersEnabled,
      adminExempt: params.adminExempt,
      shadow: params.action === 'SHADOW_DELETE_AND_KICK',
      wouldEnforce,
      enforced: params.enforced,
      confidenceScore:
        typeof params.confidenceScore === 'number' ? this.roundScore(params.confidenceScore) : null,
      reason: params.reason,
      expiresAt: params.expiresAt,
      sourceBreakdown: params.sourceBreakdown,
    };
  }

  private async recordPolicyDecision(params: {
    decision: GlobalSpammerPolicyDecision;
    messageId: string | null;
  }): Promise<void> {
    const decision = params.decision;
    await this.prisma.globalSpammerEnforcementDecision.create({
      data: {
        userId: decision.userId,
        chatId: decision.chatId,
        messageId: params.messageId,
        trigger: decision.trigger,
        registryStatus: decision.registryStatus,
        decision: decision.action,
        enforcementMode: decision.enforcementMode,
        deleteSpammersEnabled: decision.deleteSpammersEnabled,
        adminExempt: decision.adminExempt,
        shadow: decision.shadow,
        wouldEnforce: decision.wouldEnforce,
        enforced: decision.enforced,
        confidenceScore: decision.confidenceScore,
        reason: decision.reason,
        expiresAt: decision.expiresAt ? new Date(decision.expiresAt) : null,
        sourceBreakdown: decision.sourceBreakdown ?? Prisma.JsonNull,
      },
    });
  }

  private async resolveRecentSuppressionThresholdAdjustment(
    userId: string,
    now: Date,
  ): Promise<number> {
    const recentSuppression = await this.prisma.globalSpammerSuppression.findFirst({
      where: {
        userId,
        suppressedUntil: {
          gte: new Date(now.getTime() - RECENT_SUPPRESSION_MEMORY_DAYS * DAY_MS),
        },
      },
      orderBy: {
        suppressedUntil: 'desc',
      },
    });
    return recentSuppression ? 0.08 : 0;
  }

  private isGraphObservationSource(source: GlobalSpammerObservationSource): boolean {
    return source.startsWith('GRAPH_');
  }

  private async recordGraphSignalsForObservation(params: {
    userId: string;
    input: GlobalSpammerObservationInput;
    observedAt: Date;
    activeSuppression: { reason: string } | null;
  }): Promise<void> {
    const graphSignals = this.extractGraphSignals(params.input);
    if (graphSignals.length === 0) {
      return;
    }

    for (const signal of graphSignals) {
      await this.recordGraphSignal({
        userId: params.userId,
        input: params.input,
        signal,
        observedAt: params.observedAt,
        activeSuppression: params.activeSuppression,
      });
    }
  }

  private async recordGraphSignal(params: {
    userId: string;
    input: GlobalSpammerObservationInput;
    signal: ExtractedGraphSignal;
    observedAt: Date;
    activeSuppression: { reason: string } | null;
  }): Promise<void> {
    const signalHash = this.buildEvidenceHash({
      type: params.signal.signalType,
      value: params.signal.value,
    });
    const chatId = params.input.chatId ?? null;
    const signalKey = `${params.userId}:${chatId ?? 'global'}:${params.signal.signalType}:${signalHash}`;
    const expiresAt = new Date(params.observedAt.getTime() + GRAPH_SIGNAL_TTL_DAYS * DAY_MS);
    await this.prisma.spammerGraphSignal.upsert({
      where: {
        signalKey,
      },
      create: {
        signalKey,
        userId: params.userId,
        chatId,
        messageId: params.input.messageId ?? null,
        signalType: params.signal.signalType,
        signalHash,
        source: params.signal.source,
        score: params.signal.score,
        evidence: params.signal.evidence,
        observedAt: params.observedAt,
        expiresAt,
      },
      update: {
        messageId: params.input.messageId ?? null,
        source: params.signal.source,
        score: params.signal.score,
        evidence: params.signal.evidence,
        observedAt: params.observedAt,
        expiresAt,
      },
    });

    const activeSignals = await this.prisma.spammerGraphSignal.findMany({
      where: {
        signalType: params.signal.signalType,
        signalHash,
        expiresAt: {
          gt: params.observedAt,
        },
      },
      select: {
        userId: true,
        chatId: true,
      },
      take: 200,
    });
    const distinctUsers = new Set(activeSignals.map((row) => row.userId)).size;
    const distinctChats = new Set(
      activeSignals.map((row) => row.chatId).filter((value): value is string => Boolean(value)),
    ).size;
    const shouldCreateObservation =
      distinctUsers >= 2 || distinctChats >= 2 || activeSignals.length >= 3;
    if (!shouldCreateObservation) {
      return;
    }

    const graphScore = this.resolveGraphObservationScore({
      signal: params.signal,
      distinctUsers,
      distinctChats,
      hits: activeSignals.length,
    });
    const graphEvidenceHash = `graph:${params.signal.signalType.toLowerCase()}:${signalHash}`;
    const suppressedAt = params.activeSuppression ? params.observedAt : null;
    const suppressionReason = params.activeSuppression?.reason ?? null;
    await this.prisma.spammerObservation.upsert({
      where: {
        userId_source_evidenceHash: {
          userId: params.userId,
          source: params.signal.source,
          evidenceHash: graphEvidenceHash,
        },
      },
      create: {
        userId: params.userId,
        source: params.signal.source,
        score: graphScore,
        confidenceLevel: this.resolveConfidenceLevel(graphScore),
        reason: params.signal.reason,
        chatId,
        messageId: params.input.messageId ?? null,
        evidenceHash: graphEvidenceHash,
        evidence: {
          ...params.signal.evidence,
          distinctUsers,
          distinctChats,
          hits: activeSignals.length,
        },
        observedAt: params.observedAt,
        expiresAt: new Date(params.observedAt.getTime() + GRAPH_OBSERVATION_TTL_DAYS * DAY_MS),
        suppressedAt,
        suppressionReason,
      },
      update: {
        score: graphScore,
        confidenceLevel: this.resolveConfidenceLevel(graphScore),
        reason: params.signal.reason,
        chatId,
        messageId: params.input.messageId ?? null,
        evidence: {
          ...params.signal.evidence,
          distinctUsers,
          distinctChats,
          hits: activeSignals.length,
        },
        observedAt: params.observedAt,
        expiresAt: new Date(params.observedAt.getTime() + GRAPH_OBSERVATION_TTL_DAYS * DAY_MS),
        suppressedAt,
        suppressionReason,
      },
    });
  }

  private resolveGraphObservationScore(params: {
    signal: ExtractedGraphSignal;
    distinctUsers: number;
    distinctChats: number;
    hits: number;
  }): number {
    const lift = Math.min(
      0.14,
      Math.max(params.distinctUsers, params.distinctChats, params.hits) * 0.025,
    );
    return this.roundScore(params.signal.score + lift);
  }

  private extractGraphSignals(input: GlobalSpammerObservationInput): ExtractedGraphSignal[] {
    const evidence = this.asRecord(input.evidence);
    const flattenedValues = this.collectEvidenceStrings(input.evidence);
    const signals: ExtractedGraphSignal[] = [];
    const domains = new Set<string>();
    const phones = new Set<string>();

    for (const value of flattenedValues) {
      for (const domain of this.extractDomains(value)) {
        domains.add(domain);
      }
      for (const phone of this.extractPhones(value)) {
        phones.add(phone);
      }
    }

    for (const domain of domains) {
      signals.push({
        signalType: 'DOMAIN',
        source: 'GRAPH_DOMAIN',
        value: domain,
        reason: 'GRAPH_DOMAIN_REUSE',
        score: 0.58,
        evidence: { domain },
      });
    }
    for (const phone of phones) {
      signals.push({
        signalType: 'PHONE',
        source: 'GRAPH_PHONE',
        value: phone,
        reason: 'GRAPH_PHONE_REUSE',
        score: 0.64,
        evidence: { phoneHash: this.buildEvidenceHash(phone) },
      });
    }

    const text = this.normalizeGraphText(
      this.readString(evidence?.excerpt) ||
        this.readString(evidence?.text) ||
        this.readString(evidence?.messageText) ||
        '',
    );
    if (text) {
      signals.push({
        signalType: 'TEXT',
        source: 'GRAPH_TEXT',
        value: text,
        reason: 'GRAPH_TEXT_REUSE',
        score: 0.54,
        evidence: { textHash: this.buildEvidenceHash(text) },
      });
    }

    const campaignValue =
      this.readString(evidence?.campaignId) ||
      this.readString(evidence?.campaignKey) ||
      this.readString(evidence?.campaignHash) ||
      this.readString(this.asRecord(evidence?.campaignContext)?.campaignKey) ||
      this.readString(this.asRecord(evidence?.campaignContext)?.signature);
    if (campaignValue) {
      signals.push({
        signalType: 'CAMPAIGN',
        source: 'GRAPH_CAMPAIGN',
        value: campaignValue,
        reason: 'GRAPH_CAMPAIGN_REUSE',
        score: 0.7,
        evidence: { campaignHash: this.buildEvidenceHash(campaignValue) },
      });
    }

    const uniqueChats = this.readNumber(evidence?.uniqueChats);
    const windowSec = this.readNumber(evidence?.windowSec);
    if (input.source.startsWith('FANOUT_') && uniqueChats && windowSec) {
      signals.push({
        signalType: 'FANOUT_PATTERN',
        source: 'GRAPH_FANOUT_PATTERN',
        value: `${input.reason}:${Math.floor(uniqueChats)}:${Math.floor(windowSec)}`,
        reason: 'GRAPH_FANOUT_PATTERN_REUSE',
        score: 0.56,
        evidence: { uniqueChats, windowSec, source: input.source },
      });
    }

    return signals.slice(0, 8);
  }

  private collectEvidenceStrings(value: unknown, depth = 0): string[] {
    if (depth > 4 || value === null || value === undefined) {
      return [];
    }
    if (typeof value === 'string') {
      return [value];
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return [];
    }
    if (Array.isArray(value)) {
      return value.flatMap((item) => this.collectEvidenceStrings(item, depth + 1));
    }
    if (typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).flatMap((item) =>
        this.collectEvidenceStrings(item, depth + 1),
      );
    }
    return [];
  }

  private extractDomains(value: string): string[] {
    const domains = new Set<string>();
    const urlMatches = value.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?:[/:?#]|$)/giu);
    for (const match of urlMatches) {
      const domain = this.normalizeDomain(match[1] ?? '');
      if (domain) {
        domains.add(domain);
      }
    }
    const bareMatches = value.matchAll(
      /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]{2,})+)\b/giu,
    );
    for (const match of bareMatches) {
      const domain = this.normalizeDomain(match[1] ?? '');
      if (domain) {
        domains.add(domain);
      }
    }
    return [...domains].slice(0, 5);
  }

  private normalizeDomain(value: string): string | null {
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/^www\./u, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/u.test(normalized)) {
      return null;
    }
    return normalized;
  }

  private extractPhones(value: string): string[] {
    const phones = new Set<string>();
    const matches = value.matchAll(/(?:\+?\d[\s().-]*){10,15}/gu);
    for (const match of matches) {
      const digits = (match[0] ?? '').replace(/\D/gu, '');
      if (digits.length >= 10 && digits.length <= 15) {
        phones.add(digits);
      }
    }
    return [...phones].slice(0, 5);
  }

  private normalizeGraphText(value: string): string | null {
    const normalized = value.trim().toLowerCase().replace(/\s+/gu, ' ');
    if (normalized.length < 24) {
      return null;
    }
    return normalized.slice(0, 500);
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

    const sourceReputation = await this.getSourceReputationMap(now);
    return this.computeAggregate(rows, now, sourceReputation);
  }

  computeAggregate(
    rows: readonly ActiveObservationRow[],
    now: Date,
    sourceReputation: ReadonlyMap<string, SourceReputation> = new Map(),
  ): AggregateResult {
    const sourceMap = new Map<string, AggregateSource>();
    for (const row of rows) {
      if (row.expiresAt <= now) {
        continue;
      }
      const reputation = sourceReputation.get(row.source);
      const reputationWeight = reputation?.weight ?? this.resolveSourceBaseWeight(row.source);
      const falsePositiveRate = reputation?.falsePositiveRate ?? 0;
      const decayedScore = this.calculateDecayedScore(row.score, row.observedAt, now);
      const adjustedScore = this.clampScore(decayedScore * reputationWeight);
      const existing = sourceMap.get(row.source);
      const latestAt =
        existing && Date.parse(existing.latestAt) > row.observedAt.getTime()
          ? existing.latestAt
          : row.observedAt.toISOString();
      const reasons = new Set(existing?.reasons ?? []);
      reasons.add(row.reason);
      sourceMap.set(row.source, {
        source: row.source,
        score: Math.max(existing?.score ?? 0, adjustedScore),
        rawScore: Math.max(existing?.rawScore ?? 0, row.score),
        reputationWeight,
        falsePositiveRate,
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
        reputationWeight: this.roundScore(source.reputationWeight),
        falsePositiveRate: this.roundScore(source.falsePositiveRate),
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

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}
