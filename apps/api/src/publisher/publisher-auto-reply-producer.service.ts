import type { MaxUpdate } from '@maxim/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  PublisherAutoReplyDeliveryStatus,
  PublisherAutoReplyMatchKind,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  WEBHOOK_PREPARATION_DEFER_DEFAULT_MS,
  WebhookPreparationDeferredError,
} from '../common/webhook-preparation-deferred.error';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import {
  extractPublisherAutoReplyMessageCandidate,
  isExplicitlyBotAuthoredPublisherGroupMessage,
  type PublisherAutoReplyMessageCandidate,
} from './publisher-auto-reply-normalization';
import { PublisherAutoReplyFloodGateService } from './publisher-auto-reply-flood-gate.service';
import {
  PublisherAutoReplySourceFenceService,
  type PublisherAutoReplySourceFenceState,
} from './publisher-auto-reply-source-fence.service';
import {
  PublisherAutoReplyAdmissionError,
  PublisherAutoReplyQueueService,
} from './publisher-auto-reply.queue';
import {
  arePublisherAutoReplyMatchDecisionsEqual,
  matchPublisherAutoReply,
  type PublisherAutoReplyMatchKind as MatcherMatchKind,
  type PublisherAutoReplyMatchResult,
  type PublisherAutoReplyTriggerCandidate,
} from './publisher-auto-reply-matcher';

const DEFAULT_AUTO_REPLY_DELAY_MS = 1_500;
const MAX_AUTO_REPLY_DELAY_MS = 60_000;
const AUTO_REPLY_MATCHER_VERSION = 1;
const AUTO_REPLY_MATCH_CACHE_MAX_ENTRIES = 500;

export type PublisherAutoReplyDisposition =
  | 'no_match'
  | 'selected'
  | 'suppressed'
  | 'ambiguous'
  | 'bot_authored';
export type PublisherAutoReplyObservation = {
  matched: boolean;
  disposition: PublisherAutoReplyDisposition;
};
export type PublisherAutoReplyObservationOptions = { duplicateRepair?: boolean };

type PublisherAutoReplyDeliverySnapshot = {
  id: string;
  sourceWebhookEventId: string | null;
  status: PublisherAutoReplyDeliveryStatus;
  dueAt: Date;
  dispatchStartedAt: Date | null;
};

type PublisherAutoReplyMatchConfig = {
  candidates: PublisherAutoReplyTriggerCandidate[];
};

export class PublisherAutoReplyEnqueuePendingError extends WebhookPreparationDeferredError {
  constructor(cause?: unknown) {
    super(
      'Publisher auto-reply durable job is not confirmed yet',
      WEBHOOK_PREPARATION_DEFER_DEFAULT_MS,
      cause,
    );
    this.name = 'PublisherAutoReplyEnqueuePendingError';
  }
}

@Injectable()
export class PublisherAutoReplyProducerService {
  private readonly logger = new Logger(PublisherAutoReplyProducerService.name);
  private readonly publisherBotId: string;
  private readonly deliveryDelayMs: number;
  private readonly extendedMatchingMode: 'off' | 'shadow' | 'on';
  private readonly matchConfigCache = new Map<string, PublisherAutoReplyMatchConfig>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublisherAutoReplyQueueService,
    private readonly botRegistry: MaxBotRegistryService,
    private readonly floodGate: PublisherAutoReplyFloodGateService,
    private readonly sourceFence: PublisherAutoReplySourceFenceService,
    configService: ConfigService,
  ) {
    this.publisherBotId = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
    const configuredDelay = configService.get<number>(
      'PUBLISHER_AUTO_REPLY_DELAY_MS',
      DEFAULT_AUTO_REPLY_DELAY_MS,
    );
    this.deliveryDelayMs = Number.isFinite(configuredDelay)
      ? Math.max(0, Math.min(MAX_AUTO_REPLY_DELAY_MS, Math.floor(configuredDelay)))
      : DEFAULT_AUTO_REPLY_DELAY_MS;
    this.extendedMatchingMode = configService.get<'off' | 'shadow' | 'on'>(
      'PUBLISHER_AUTO_REPLY_EXTENDED_MATCHING_MODE',
      'on',
    );
  }

  async observeWebhook(
    update: MaxUpdate,
    sourceWebhookEventId?: string | null,
    options: PublisherAutoReplyObservationOptions = {},
  ): Promise<PublisherAutoReplyObservation> {
    if (update.botId?.trim() !== this.publisherBotId) {
      return this.observation('no_match');
    }
    if (isExplicitlyBotAuthoredPublisherGroupMessage(update, this.publisherBotId)) {
      return this.observation('bot_authored');
    }
    const updateType = update.type.trim().toLowerCase();
    if (updateType === 'message_edited' || updateType === 'message_removed') {
      await this.cancelPendingSourceDelivery(update, updateType, sourceWebhookEventId);
      return this.observation('no_match');
    }

    const candidate = extractPublisherAutoReplyMessageCandidate(update, {
      publisherBotId: this.publisherBotId,
      isKnownRuntimeBotUserId: (userId) => this.botRegistry.isKnownBotUserId(userId),
    });
    if (!candidate) {
      return this.observation('no_match');
    }
    let replayedFloodDecision: { allowed: true; replayed: true } | null = null;
    if (options.duplicateRepair === true) {
      const delivery = await this.findSourceDelivery(candidate.chatId, candidate.sourceMessageId);
      if (delivery) {
        const sourceState = await this.admitSource(
          candidate,
          delivery.sourceWebhookEventId ?? sourceWebhookEventId,
        );
        if (sourceState !== 'admitted') {
          await this.cancelPendingDelivery(delivery.id, 'SOURCE_CHANGED');
          return this.observation('suppressed');
        }
        await this.ensureDeliveryJob(delivery);
        return this.observation('selected');
      }
      let replayDecision: Awaited<ReturnType<PublisherAutoReplyFloodGateService['replay']>>;
      try {
        replayDecision = await this.floodGate.replay({
          publisherBotId: this.publisherBotId,
          chatId: candidate.chatId,
          senderUserId: candidate.senderUserId,
          sourceMessageId: candidate.sourceMessageId,
        });
      } catch (error: unknown) {
        throw new PublisherAutoReplyEnqueuePendingError(error);
      }
      if (!replayDecision.allowed) {
        return this.observation('suppressed');
      }
      if (!replayDecision.replayed) {
        throw new PublisherAutoReplyEnqueuePendingError();
      }
      replayedFloodDecision = { allowed: true, replayed: true };
    }

    const now = new Date();
    const entity = await this.prisma.chat.findFirst({
      where: {
        id: candidate.chatId,
        entityType: ChatEntityType.CHAT,
        OR: [
          { publicationPolicy: { is: null } },
          { publicationPolicy: { is: { publikEnabled: true } } },
        ],
        publisherSettings: { is: { autoRepliesEnabled: true } },
        publisherBinding: {
          is: {
            publisherBotId: this.publisherBotId,
            status: ChatBotMembershipStatus.ACTIVE,
            botAccessState: {
              in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
            },
            botAccessExpiresAt: { gt: now },
            OR: [{ sendRouteQuarantinedUntil: null }, { sendRouteQuarantinedUntil: { lte: now } }],
          },
        },
      },
      select: {
        publisherSettings: {
          select: {
            revision: true,
            autoRepliesEnabled: true,
            autoReplyConfigRevision: true,
          },
        },
        publicationPolicy: { select: { revision: true, publikEnabled: true } },
      },
    });
    if (!entity?.publisherSettings?.autoRepliesEnabled) {
      return this.observation(replayedFloodDecision ? 'suppressed' : 'no_match');
    }
    const matchConfig = await this.loadMatchConfig(
      candidate.chatId,
      entity.publisherSettings.autoReplyConfigRevision,
    );
    const fullMatch = matchPublisherAutoReply(candidate.normalizedTrigger, matchConfig.candidates);
    let enforcedMatch = fullMatch;
    if (this.extendedMatchingMode !== 'on') {
      const exactOnlyCandidates = matchConfig.candidates.map((trigger) => ({
        ...trigger,
        matchInContext: false,
        fuzzyMatch: false,
      }));
      enforcedMatch = matchPublisherAutoReply(candidate.normalizedTrigger, exactOnlyCandidates);
      if (
        this.extendedMatchingMode === 'shadow' &&
        !arePublisherAutoReplyMatchDecisionsEqual(fullMatch, enforcedMatch)
      ) {
        this.logger.debug(
          {
            chatId: candidate.chatId,
            shadow: this.matchTelemetry(fullMatch),
            enforced: this.matchTelemetry(enforcedMatch),
          },
          'Publisher auto-reply extended matcher shadow outcome',
        );
      }
    }
    if (enforcedMatch.kind === 'no_match' && enforcedMatch.reason === 'budget_exceeded') {
      enforcedMatch = await this.findExactMatch(candidate.chatId, candidate.normalizedTrigger);
    }
    if (enforcedMatch.kind === 'ambiguous') {
      this.logger.warn(
        { chatId: candidate.chatId, candidateCount: enforcedMatch.winners.length },
        'Publisher auto-reply match is ambiguous; delivery was suppressed',
      );
      return this.observation('ambiguous');
    }
    if (enforcedMatch.kind === 'no_match') {
      if (enforcedMatch.reason === 'budget_exceeded') {
        this.logger.warn(
          { chatId: candidate.chatId },
          'Publisher auto-reply matcher budget was exceeded; delivery was suppressed',
        );
      }
      return this.observation(replayedFloodDecision ? 'suppressed' : 'no_match');
    }
    const winner = enforcedMatch.winner;
    const rule = await this.prisma.publisherAutoReplyRule.findFirst({
      where: {
        id: winner.ruleId,
        chatId: candidate.chatId,
        enabled: true,
        archivedAt: null,
        currentContentRevisionId: { not: null },
      },
      select: { id: true, version: true, currentContentRevisionId: true },
    });
    const contentRevisionId = rule?.currentContentRevisionId?.trim() ?? '';
    if (!rule || !contentRevisionId) {
      throw new PublisherAutoReplyEnqueuePendingError();
    }
    let upstreamDenialReason: 'backlog_limit' | 'backlog_unavailable' | undefined;
    try {
      await this.queue.assertNewDeliveryAdmissionEnabled();
    } catch (error: unknown) {
      if (error instanceof PublisherAutoReplyAdmissionError) {
        if (error.reason === 'dispatch_disabled') {
          return this.observation('suppressed');
        }
        upstreamDenialReason = error.reason;
      } else {
        throw new PublisherAutoReplyEnqueuePendingError(error);
      }
    }
    let floodDecision: Awaited<ReturnType<PublisherAutoReplyFloodGateService['reserve']>>;
    if (replayedFloodDecision) {
      floodDecision = replayedFloodDecision;
    } else {
      try {
        floodDecision = await this.floodGate.reserve({
          publisherBotId: this.publisherBotId,
          chatId: candidate.chatId,
          senderUserId: candidate.senderUserId,
          sourceMessageId: candidate.sourceMessageId,
          ...(upstreamDenialReason ? { upstreamDenialReason } : {}),
        });
      } catch (error: unknown) {
        throw new PublisherAutoReplyEnqueuePendingError(error);
      }
    }
    if (!floodDecision.allowed || (upstreamDenialReason && !floodDecision.replayed)) {
      return this.observation('suppressed');
    }
    const sourceState = await this.admitSource(candidate, sourceWebhookEventId);
    if (sourceState !== 'admitted') {
      return this.observation('suppressed');
    }
    const dueAt = new Date(now.getTime() + this.deliveryDelayMs);
    await this.prisma.publisherAutoReplyDelivery.createMany({
      data: [
        {
          chatId: candidate.chatId,
          ruleId: rule.id,
          contentRevisionId,
          publisherBotId: this.publisherBotId,
          sourceMessageId: candidate.sourceMessageId,
          sourceUserId: candidate.senderUserId,
          sourceWebhookEventId: sourceWebhookEventId?.trim() || null,
          matchedRuleVersion: rule.version,
          matchedNormalizedPhrase: winner.normalizedPhrase,
          matchedTriggerId: winner.triggerId,
          matchKind: this.toPrismaMatchKind(winner.matchKind),
          distance: winner.distance,
          matcherVersion: AUTO_REPLY_MATCHER_VERSION,
          autoReplyConfigRevision: entity.publisherSettings.autoReplyConfigRevision,
          publisherSettingsRevision: entity.publisherSettings.revision,
          publicationPolicyRevision: entity.publicationPolicy?.revision ?? 0,
          dueAt,
        },
      ],
      skipDuplicates: true,
    });
    const delivery = await this.findSourceDelivery(candidate.chatId, candidate.sourceMessageId);
    if (!delivery) {
      throw new PublisherAutoReplyEnqueuePendingError();
    }
    const confirmedSourceState = await this.readSourceFence(candidate);
    if (confirmedSourceState !== 'admitted') {
      await this.cancelPendingDelivery(
        delivery.id,
        confirmedSourceState === 'canceled' ? 'SOURCE_CHANGED' : 'SOURCE_FENCE_MISSING',
      );
      return this.observation('suppressed');
    }
    await this.ensureDeliveryJob(delivery);
    return this.observation('selected');
  }

  private observation(disposition: PublisherAutoReplyDisposition): PublisherAutoReplyObservation {
    return { matched: disposition !== 'no_match', disposition };
  }

  private async loadMatchConfig(
    chatId: string,
    revision: number,
  ): Promise<PublisherAutoReplyMatchConfig> {
    const cacheKey = `${chatId}:${revision}`;
    const cached = this.matchConfigCache.get(cacheKey);
    if (cached) {
      this.matchConfigCache.delete(cacheKey);
      this.matchConfigCache.set(cacheKey, cached);
      return cached;
    }
    const rows = await this.prisma.publisherAutoReplyTrigger.findMany({
      where: {
        chatId,
        archivedAt: null,
        rule: {
          is: {
            enabled: true,
            archivedAt: null,
            currentContentRevisionId: { not: null },
          },
        },
      },
      orderBy: [{ ruleId: 'asc' }, { position: 'asc' }, { id: 'asc' }],
      take: 201,
      select: {
        id: true,
        ruleId: true,
        position: true,
        phrase: true,
        normalizedPhrase: true,
        rule: {
          select: {
            matchInContext: true,
            fuzzyMatch: true,
          },
        },
      },
    });
    const candidates: PublisherAutoReplyTriggerCandidate[] = [];
    for (const row of rows) {
      candidates.push({
        ruleId: row.ruleId,
        triggerId: row.id,
        position: row.position,
        phrase: row.phrase,
        normalizedPhrase: row.normalizedPhrase,
        matchInContext: row.rule.matchInContext,
        fuzzyMatch: row.rule.fuzzyMatch,
      });
    }
    const loaded = { candidates };
    while (this.matchConfigCache.size >= AUTO_REPLY_MATCH_CACHE_MAX_ENTRIES) {
      const oldestKey = this.matchConfigCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.matchConfigCache.delete(oldestKey);
    }
    this.matchConfigCache.set(cacheKey, loaded);
    return loaded;
  }

  private async findExactMatch(
    chatId: string,
    normalizedPhrase: string,
  ): Promise<PublisherAutoReplyMatchResult> {
    const row = await this.prisma.publisherAutoReplyTrigger.findFirst({
      where: {
        chatId,
        normalizedPhrase,
        archivedAt: null,
        rule: {
          is: {
            enabled: true,
            archivedAt: null,
            currentContentRevisionId: { not: null },
          },
        },
      },
      select: {
        id: true,
        ruleId: true,
        position: true,
        phrase: true,
        normalizedPhrase: true,
        rule: {
          select: {
            matchInContext: true,
            fuzzyMatch: true,
          },
        },
      },
    });
    if (!row) {
      return { kind: 'no_match', reason: 'budget_exceeded' };
    }
    return matchPublisherAutoReply(normalizedPhrase, [
      {
        ruleId: row.ruleId,
        triggerId: row.id,
        position: row.position,
        phrase: row.phrase,
        normalizedPhrase: row.normalizedPhrase,
        matchInContext: row.rule.matchInContext,
        fuzzyMatch: row.rule.fuzzyMatch,
      },
    ]);
  }

  private toPrismaMatchKind(kind: MatcherMatchKind): PublisherAutoReplyMatchKind {
    switch (kind) {
      case 'exact_full':
        return PublisherAutoReplyMatchKind.EXACT_FULL;
      case 'exact_context':
        return PublisherAutoReplyMatchKind.EXACT_CONTEXT;
      case 'fuzzy_full':
        return PublisherAutoReplyMatchKind.FUZZY_FULL;
      case 'fuzzy_context':
        return PublisherAutoReplyMatchKind.FUZZY_CONTEXT;
    }
  }

  private matchTelemetry(match: PublisherAutoReplyMatchResult): Record<string, unknown> {
    if (match.kind === 'matched') {
      return {
        outcome: match.kind,
        matchKind: match.winner.matchKind,
        distance: match.winner.distance,
      };
    }
    if (match.kind === 'ambiguous') {
      return { outcome: match.kind, winnerCount: match.winners.length };
    }
    return { outcome: match.kind, reason: match.reason ?? null };
  }

  private async findSourceDelivery(
    chatId: string,
    sourceMessageId: string,
  ): Promise<PublisherAutoReplyDeliverySnapshot | null> {
    return this.prisma.publisherAutoReplyDelivery.findUnique({
      where: {
        chatId_sourceMessageId: {
          chatId,
          sourceMessageId,
        },
      },
      select: {
        id: true,
        sourceWebhookEventId: true,
        status: true,
        dueAt: true,
        dispatchStartedAt: true,
      },
    });
  }

  private async ensureDeliveryJob(delivery: PublisherAutoReplyDeliverySnapshot): Promise<void> {
    if (
      delivery.dispatchStartedAt === null &&
      (delivery.status === PublisherAutoReplyDeliveryStatus.PENDING ||
        delivery.status === PublisherAutoReplyDeliveryStatus.SENDING)
    ) {
      try {
        await this.queue.ensureDeliveryJob(delivery.id, delivery.dueAt);
      } catch (error: unknown) {
        if (
          error instanceof PublisherAutoReplyAdmissionError &&
          error.reason === 'dispatch_disabled'
        ) {
          await this.prisma.publisherAutoReplyDelivery.updateMany({
            where: {
              id: delivery.id,
              status: PublisherAutoReplyDeliveryStatus.PENDING,
              dispatchStartedAt: null,
            },
            data: {
              status: PublisherAutoReplyDeliveryStatus.CANCELED,
              canceledAt: new Date(),
              failureCode: 'DISPATCH_DISABLED',
              failureMessage: null,
            },
          });
          return;
        }
        throw new PublisherAutoReplyEnqueuePendingError(error);
      }
    }
  }

  private async cancelPendingSourceDelivery(
    update: MaxUpdate,
    updateType: 'message_edited' | 'message_removed',
    sourceWebhookEventId?: string | null,
  ): Promise<void> {
    const chatId = update.message?.chatId?.trim() ?? '';
    const sourceMessageId = update.message?.messageId?.trim() ?? '';
    if (!chatId || !sourceMessageId) {
      return;
    }
    let fenceError: unknown = null;
    try {
      await this.sourceFence.cancel({
        publisherBotId: this.publisherBotId,
        chatId,
        sourceMessageId,
        sourceWebhookEventId,
      });
    } catch (error: unknown) {
      fenceError = error;
    }
    const now = new Date();
    await this.prisma.publisherAutoReplyDelivery.updateMany({
      where: {
        chatId,
        sourceMessageId,
        publisherBotId: this.publisherBotId,
        status: {
          in: [PublisherAutoReplyDeliveryStatus.PENDING, PublisherAutoReplyDeliveryStatus.SENDING],
        },
        dispatchStartedAt: null,
      },
      data: {
        status: PublisherAutoReplyDeliveryStatus.CANCELED,
        canceledAt: now,
        lockedAt: null,
        lockToken: null,
        failureCode: updateType === 'message_edited' ? 'SOURCE_EDITED' : 'SOURCE_REMOVED',
        failureMessage: null,
      },
    });
    if (fenceError) {
      throw new PublisherAutoReplyEnqueuePendingError(fenceError);
    }
  }

  private async admitSource(
    candidate: PublisherAutoReplyMessageCandidate,
    sourceWebhookEventId?: string | null,
  ): Promise<PublisherAutoReplySourceFenceState> {
    try {
      return await this.sourceFence.admit({
        publisherBotId: this.publisherBotId,
        chatId: candidate.chatId,
        sourceMessageId: candidate.sourceMessageId,
        sourceWebhookEventId,
      });
    } catch (error: unknown) {
      throw new PublisherAutoReplyEnqueuePendingError(error);
    }
  }

  private async readSourceFence(
    candidate: PublisherAutoReplyMessageCandidate,
  ): Promise<PublisherAutoReplySourceFenceState> {
    try {
      return await this.sourceFence.read({
        publisherBotId: this.publisherBotId,
        chatId: candidate.chatId,
        sourceMessageId: candidate.sourceMessageId,
      });
    } catch (error: unknown) {
      throw new PublisherAutoReplyEnqueuePendingError(error);
    }
  }

  private cancelPendingDelivery(id: string, failureCode: string): Promise<{ count: number }> {
    return this.prisma.publisherAutoReplyDelivery.updateMany({
      where: {
        id,
        status: {
          in: [PublisherAutoReplyDeliveryStatus.PENDING, PublisherAutoReplyDeliveryStatus.SENDING],
        },
        dispatchStartedAt: null,
      },
      data: {
        status: PublisherAutoReplyDeliveryStatus.CANCELED,
        canceledAt: new Date(),
        lockedAt: null,
        lockToken: null,
        failureCode,
        failureMessage: null,
      },
    });
  }
}
