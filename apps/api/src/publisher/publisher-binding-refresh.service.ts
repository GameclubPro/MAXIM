import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { buildBotAccessSnapshotPersistence } from '../max/bot-access-snapshot.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxChatMemberAccess,
} from '../max/max-client.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { normalizePermissionName } from '../max/max-bot-access-policy.util';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  Prisma,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import {
  hasPublisherRefreshEvidence,
  publisherRefreshEvidenceWhere,
} from './publisher-entity-connection.util';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import {
  PUBLISHER_ACCESS_CANDIDATE_SOURCE,
  PUBLISHER_ACCESS_CANDIDATE_PENDING_REASON,
  PublisherEntityBindingLifecycleService,
} from './publisher-entity-binding-lifecycle.service';
import {
  type PublisherBindingRefreshJob,
  PublisherBindingRefreshQueueService,
} from './publisher-binding-refresh.queue';
import {
  classifyPublisherFailure,
  extractPublisherMaxStatusCode,
  PublisherDispatchHealthService,
} from './publisher-dispatch-health.service';

const PUBLISHER_ACCESS_SNAPSHOT_TTL_MS = 15 * 60_000;
const PUBLISHER_REFRESH_SCAN_INTERVAL_MS = 60_000;
const PUBLISHER_READY_REFRESH_BATCH_SIZE = 200;
const PUBLISHER_DISCOVERY_REFRESH_BATCH_SIZE = 25;
const PUBLISHER_BINDING_ACCESS_REFRESH_AHEAD_MS = 5 * 60_000;
// At 25 actor edges per minute, the scheduler can nominate 18k unique edges in this window.
const PUBLISHER_USER_ACCESS_REFRESH_AHEAD_MS = 12 * 60 * 60_000;
const PUBLISHER_UNKNOWN_REPROBE_COOLDOWN_MS = 5 * 60_000;
const PUBLISHER_NON_ADMIN_REPROBE_COOLDOWN_MS = 15 * 60_000;
const PUBLISHER_LOST_REPROBE_COOLDOWN_MS = 6 * 60 * 60_000;
const PUBLISHER_USER_ACCESS_GRANTED_TTL_MS = 3 * 24 * 60 * 60_000;
const PUBLISHER_USER_ACCESS_DENIED_TTL_MS = 15 * 60_000;
const PUBLISHER_USER_ACCESS_REFRESH_BATCH_SIZE = 25;
const PUBLISHER_PENDING_CANDIDATE_RETRY_MS = 60_000;
const PUBLISHER_DENIED_USER_ACCESS_REPROBE_COOLDOWN_MS = 6 * 60 * 60_000;
const PUBLISHER_ACTOR_EVIDENCE_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
const PUBLISHER_HANDSHAKE_REPLY_TIMEOUT_MS = 1_500;
const PUBLISHER_FORWARDED_CANDIDATE_SOURCE = `${PUBLISHER_ACCESS_CANDIDATE_SOURCE}_forwarded`;
const PUBLISHER_HOME_START_PARAM = `mr-${Buffer.from(
  JSON.stringify({ v: 1, k: 'route', r: '/' }),
  'utf8',
).toString('base64url')}`;

export class PublisherCandidateRefreshSupersededError extends Error {
  readonly code = 'PUBLISHER_CANDIDATE_REFRESH_SUPERSEDED';

  constructor() {
    super('Publisher actor verification was superseded by a newer lifecycle state');
    this.name = 'PublisherCandidateRefreshSupersededError';
  }
}

type PublisherBindingRefreshCandidate = { chatId: string };
type PublisherUserAccessRefreshCandidate = {
  chatId: string;
  userId: string;
  sourceVersion: string | null;
};
type PublisherUserAccessRefreshCursor = { chatId: string; userId: string };

@Injectable()
export class PublisherBindingRefreshService {
  private readonly logger = new Logger(PublisherBindingRefreshService.name);
  private readonly publisherBotId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly credentials: PublisherActionCredentialService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly maxBotLinkService: MaxBotLinkService,
  ) {
    this.publisherBotId = credentials.getBotId();
    credentials.getRequiredActionToken(this.publisherBotId);
  }

  async refresh(job: PublisherBindingRefreshJob): Promise<void> {
    const candidateUserId = job.candidateUserId?.trim() ?? '';
    const candidateJob = candidateUserId.length > 0;
    const policyEnablementRecheckRequested = job.reason === 'policy_enablement_recheck';
    const durableInteractiveRefresh = candidateJob || policyEnablementRecheckRequested;
    if (!this.runtimeBoundary.dispatchEnabled) {
      if (durableInteractiveRefresh) {
        this.runtimeBoundary.assertDispatchEnabled();
      }
      return;
    }
    if (job.version !== 1 || job.publisherBotId.trim() !== this.publisherBotId) {
      throw new Error('Publisher binding refresh job targets a different bot');
    }
    const chatId = job.chatId.trim();
    if (!chatId) {
      if (candidateJob) {
        throw new Error('Publisher actor verification job is missing its entity id');
      }
      return;
    }
    if (job.replyChatId?.trim() && !candidateJob) {
      throw new Error('Publisher actor verification reply is missing its candidate user');
    }
    await this.identityAttestation.assertAttested();
    if (durableInteractiveRefresh) {
      await this.dispatchHealth.assertDispatchAllowed();
    } else if (await this.dispatchHealth.isGloballyPaused()) {
      return;
    }
    if (candidateJob) {
      job = {
        ...job,
        candidateVersion: await this.resolveCandidateVersion(job),
      };
    }

    const [candidate, publisherCatalog, candidateEdge] = await Promise.all([
      this.prisma.chat.findUnique({
        where: { id: chatId },
        select: {
          id: true,
          publicationPolicy: {
            select: { publikEnabled: true },
          },
          publisherBinding: true,
        },
      }),
      this.prisma.managedBotChatCatalog.findUnique({
        where: { botId_chatId: { botId: this.publisherBotId, chatId } },
        select: { entityType: true },
      }),
      candidateJob
        ? this.prisma.managedEntityAccessEdge.findUnique({
            where: {
              chatId_userId_botId: {
                chatId,
                userId: candidateUserId,
                botId: this.publisherBotId,
              },
            },
            select: { checkedAt: true, deniedReason: true, source: true, sourceVersion: true },
          })
        : Promise.resolve(null),
    ]);
    if (
      this.isScheduledRefreshSuperseded(job, candidate?.publisherBinding ?? null, candidateEdge)
    ) {
      return;
    }
    const bindingHasRefreshEvidence = hasPublisherRefreshEvidence(
      candidate?.publisherBinding ?? null,
      this.publisherBotId,
    );
    const hasExactStagedForwardedCandidate = Boolean(
      job.candidateVersion?.startsWith('forwarded:') &&
      candidateEdge?.source === PUBLISHER_FORWARDED_CANDIDATE_SOURCE &&
      candidateEdge.sourceVersion === job.candidateVersion,
    );
    const forwardedCandidateFlow = hasExactStagedForwardedCandidate;
    const disabledPolicyEnablementRecheck = Boolean(
      policyEnablementRecheckRequested &&
      !candidateJob &&
      candidate?.publicationPolicy?.publikEnabled === false,
    );
    // FLAG: Only an exact Publisher-staged forwarded candidate may establish a binding;
    // a policy enablement recheck may bypass disabled policy, never missing Publisher evidence.
    if (
      !candidate ||
      (candidate.publicationPolicy?.publikEnabled === false && !disabledPolicyEnablementRecheck) ||
      (!bindingHasRefreshEvidence && !hasExactStagedForwardedCandidate)
    ) {
      if (candidateJob) {
        await this.terminalizeUnverifiedForwardedConnection(job, new Date(), {
          reason: 'publisher_binding_unavailable',
        });
        await this.completeCandidateTerminal(job, {
          reason: !candidate
            ? 'publisher_entity_missing'
            : candidate.publicationPolicy?.publikEnabled === false
              ? 'publisher_policy_disabled'
              : 'publisher_binding_unavailable',
        });
        await this.replyForwardedCandidate(job, 'bot_denied');
      }
      return;
    }

    const probeStartedAt = new Date();
    let botAccess: MaxChatMemberAccess;
    let committedBotAccessCheckedAt = probeStartedAt;
    let committedBotAccessState: ChatBotAccessState = ChatBotAccessState.UNKNOWN;
    const forwardedCandidateNeedsMaterialization =
      hasExactStagedForwardedCandidate && !bindingHasRefreshEvidence;
    try {
      botAccess = await this.maxClient.getCurrentChatMemberAccess(chatId, {
        botId: this.publisherBotId,
        trafficClass:
          job.reason === 'manual_recheck' || job.reason === 'policy_enablement_recheck'
            ? 'interactive'
            : 'background',
        sourceTag: 'publisher_readiness',
        bypassCache: true,
        timeoutMs: 5_000,
      });
      const checkedAt = new Date();
      const snapshot = buildBotAccessSnapshotPersistence(botAccess, {
        source: `publisher_refresh_${job.reason}`,
        now: checkedAt,
        ttlMs: PUBLISHER_ACCESS_SNAPSHOT_TTL_MS,
      });
      if (!forwardedCandidateNeedsMaterialization) {
        const committed = await this.prisma.publisherEntityBinding.updateMany({
          where: {
            chatId,
            publisherBotId: this.publisherBotId,
            status: ChatBotMembershipStatus.ACTIVE,
            AND: [
              {
                OR: [{ lifecycleEventAt: null }, { lifecycleEventAt: { lte: probeStartedAt } }],
              },
              {
                OR: [{ botAccessCheckedAt: null }, { botAccessCheckedAt: { lte: probeStartedAt } }],
              },
            ],
          },
          data: {
            status: ChatBotMembershipStatus.ACTIVE,
            capabilities: botAccess.permissions,
            ...snapshot,
            lastSeenAt: checkedAt,
          },
        });
        if (committed.count === 0) {
          this.logger.debug(
            { chatId, reason: job.reason },
            'Discarded publisher access probe superseded by a newer lifecycle event',
          );
          if (candidateJob) {
            throw new PublisherCandidateRefreshSupersededError();
          }
          return;
        }
      }
      committedBotAccessCheckedAt = checkedAt;
      committedBotAccessState = snapshot.botAccessState;
      await this.dispatchHealth.recordAuthenticatedSuccess(probeStartedAt);
    } catch (error: unknown) {
      const classification = classifyPublisherFailure(error);
      if (classification === 'global_paused') {
        await this.dispatchHealth.recordGlobalAuthorizationFailure(new Date());
        throw error;
      }
      if (
        classification === 'setup_required' ||
        (forwardedCandidateFlow && this.isForwardedTerminalTargetFailure(error))
      ) {
        if (candidateJob) {
          await this.terminalizeUnverifiedForwardedConnection(job, probeStartedAt, {
            reason: 'publisher_bot_access_lost',
            statusCode: extractPublisherMaxStatusCode(error),
          });
          if (classification === 'setup_required' && bindingHasRefreshEvidence) {
            await this.recordAccessLost(chatId, probeStartedAt, error);
          }
          await this.completeCandidateTerminal(job, {
            reason: 'publisher_bot_access_lost',
            statusCode: extractPublisherMaxStatusCode(error),
          });
          await this.replyForwardedCandidate(job, 'bot_denied');
        } else {
          await this.recordAccessLost(chatId, probeStartedAt, error);
        }
        return;
      }
      throw error;
    }

    // FLAG: A disabled-policy probe refreshes only the exact binding snapshot. Catalog and
    // user-access refresh remain disabled until the Major-owned policy is enabled.
    if (disabledPolicyEnablementRecheck) {
      return;
    }

    if (
      forwardedCandidateFlow &&
      (!this.isAdminOrOwner(botAccess) || !this.hasForwardedRecoveryReadAccess(botAccess))
    ) {
      await this.terminalizeUnverifiedForwardedConnection(job, probeStartedAt, {
        reason: this.isAdminOrOwner(botAccess)
          ? 'publisher_bot_missing_read_all_messages'
          : 'publisher_bot_not_admin',
      });
      await this.completeCandidateTerminal(job, {
        reason: this.isAdminOrOwner(botAccess)
          ? 'publisher_bot_missing_read_all_messages'
          : 'publisher_bot_not_admin',
      });
      await this.replyForwardedCandidate(job, 'bot_denied');
      return;
    }

    if (forwardedCandidateNeedsMaterialization) {
      await this.materializeForwardedCandidate({
        job,
        botAccess,
        probeStartedAt,
        botAccessCheckedAt: committedBotAccessCheckedAt,
        fallbackEntityType: publisherCatalog?.entityType ?? ChatEntityType.CHAT,
        expectedBinding: candidate.publisherBinding
          ? {
              publisherBotId: candidate.publisherBinding.publisherBotId,
              status: candidate.publisherBinding.status,
              botAccessState: candidate.publisherBinding.botAccessState,
              botAccessSource: candidate.publisherBinding.botAccessSource,
              botAccessCheckedAt: candidate.publisherBinding.botAccessCheckedAt,
              lastWebhookAt: candidate.publisherBinding.lastWebhookAt,
              lifecycleEventAt: candidate.publisherBinding.lifecycleEventAt,
            }
          : null,
      });
      return;
    }

    const catalogRefresh = await this.refreshPublisherCatalog(
      chatId,
      publisherCatalog?.entityType ?? ChatEntityType.CHAT,
      probeStartedAt,
      committedBotAccessCheckedAt,
      committedBotAccessState,
      candidateJob,
    );
    if (!catalogRefresh.committed) {
      if (candidateJob) {
        throw new PublisherCandidateRefreshSupersededError();
      }
      return;
    }
    if (candidateJob) {
      const accessResult = await this.refreshPublisherUserAccess({
        chatId,
        entityType: catalogRefresh.entityType,
        userId: candidateUserId,
        candidateVersion: job.candidateVersion?.trim() || null,
        botAccess,
        probeStartedAt,
        committedBotAccessCheckedAt,
        committedBotAccessState,
        interactive:
          job.reason === 'manual_recheck' ||
          job.reason === 'bot_added' ||
          job.reason === 'webhook_observed' ||
          job.reason === 'forwarded_private',
      });
      if (!accessResult.committed) {
        throw new PublisherCandidateRefreshSupersededError();
      }
      await this.replyForwardedCandidate(
        job,
        accessResult.state === ManagedEntityAccessState.GRANTED ? 'granted' : 'user_denied',
      );
    }
  }

  private async materializeForwardedCandidate(params: {
    job: PublisherBindingRefreshJob;
    botAccess: MaxChatMemberAccess;
    probeStartedAt: Date;
    botAccessCheckedAt: Date;
    fallbackEntityType: ChatEntityType;
    expectedBinding: {
      publisherBotId: string;
      status: ChatBotMembershipStatus;
      botAccessState: ChatBotAccessState;
      botAccessSource: string | null;
      botAccessCheckedAt: Date | null;
      lastWebhookAt: Date | null;
      lifecycleEventAt: Date | null;
    } | null;
  }): Promise<void> {
    const chatId = params.job.chatId.trim();
    const userId = params.job.candidateUserId?.trim() ?? '';
    const candidateVersion = params.job.candidateVersion?.trim() ?? '';
    if (!chatId || !userId || !candidateVersion) {
      throw new PublisherCandidateRefreshSupersededError();
    }

    let userAccess: MaxChatMemberAccess | null;
    try {
      userAccess = await this.maxClient.getChatMemberAccess(chatId, userId, {
        botId: this.publisherBotId,
        trafficClass: params.job.reason === 'forwarded_private' ? 'interactive' : 'background',
        sourceTag: 'publisher_user_access',
        bypassCache: true,
        timeoutMs: 5_000,
        ignoreFailureMetricStatuses: [400, 403, 404, 422],
      });
    } catch (error: unknown) {
      if (!this.isForwardedTerminalTargetFailure(error)) {
        throw error;
      }
      await this.terminalizeUnverifiedForwardedConnection(params.job, params.probeStartedAt, {
        reason: 'publisher_user_access_unavailable',
        statusCode: extractPublisherMaxStatusCode(error),
      });
      await this.completeCandidateTerminal(params.job, {
        reason: 'publisher_user_access_unavailable',
        statusCode: extractPublisherMaxStatusCode(error),
      });
      await this.replyForwardedCandidate(params.job, 'user_denied');
      return;
    }

    const userIsBot = userAccess?.isBot === true;
    const userHasUnverifiedBotType =
      userAccess?.isBot !== false && (userAccess?.isAdmin === true || userAccess?.isOwner === true);
    const userHasAdminAccess =
      userAccess?.isBot === false && (userAccess.isAdmin === true || userAccess.isOwner === true);
    if (!userHasAdminAccess) {
      await this.terminalizeUnverifiedForwardedConnection(params.job, params.probeStartedAt, {
        reason: 'publisher_user_not_admin',
      });
      await this.completeCandidateTerminal(params.job, {
        reason: userIsBot
          ? 'publisher_actor_is_bot'
          : userHasUnverifiedBotType
            ? 'publisher_actor_type_unverified'
            : 'publisher_user_not_admin',
      });
      await this.replyForwardedCandidate(params.job, 'user_denied');
      return;
    }

    let snapshot: Awaited<ReturnType<MaxClientService['getChatSnapshot']>>;
    try {
      snapshot = await this.maxClient.getChatSnapshot(chatId, {
        botId: this.publisherBotId,
        trafficClass: 'background',
        sourceTag: 'publisher_readiness',
        bypassCache: true,
        timeoutMs: 5_000,
        ignoreFailureMetricStatuses: [400, 403, 404, 422],
      });
    } catch (error: unknown) {
      if (!this.isForwardedTerminalTargetFailure(error)) {
        throw error;
      }
      await this.terminalizeUnverifiedForwardedConnection(params.job, params.probeStartedAt, {
        reason: 'publisher_entity_hydration_unavailable',
        statusCode: extractPublisherMaxStatusCode(error),
      });
      await this.completeCandidateTerminal(params.job, {
        reason: 'publisher_entity_hydration_unavailable',
        statusCode: extractPublisherMaxStatusCode(error),
      });
      await this.replyForwardedCandidate(params.job, 'bot_denied');
      return;
    }

    const entityType =
      snapshot.entityType === 'channel'
        ? ChatEntityType.CHANNEL
        : snapshot.entityType === 'chat'
          ? ChatEntityType.CHAT
          : params.fallbackEntityType;
    const checkedAt = new Date();
    const botSnapshot = buildBotAccessSnapshotPersistence(params.botAccess, {
      source: 'publisher_refresh_forwarded_private',
      now: params.botAccessCheckedAt,
      ttlMs: PUBLISHER_ACCESS_SNAPSHOT_TTL_MS,
    });
    const userRole = this.toAccessRole(userAccess);
    const botRole = this.toAccessRole(params.botAccess);
    const committed = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT chat."id"
        FROM "chats" AS chat
        WHERE chat."id" = ${chatId}
        FOR UPDATE OF chat
      `);
      if (locked.length !== 1) {
        return false;
      }
      const [chat, binding, edge] = await Promise.all([
        tx.chat.findUnique({
          where: { id: chatId },
          select: { title: true, publicationPolicy: { select: { publikEnabled: true } } },
        }),
        tx.publisherEntityBinding.findUnique({
          where: { chatId },
          select: {
            publisherBotId: true,
            status: true,
            botAccessState: true,
            botAccessSource: true,
            lifecycleEventAt: true,
            botAccessCheckedAt: true,
            lastWebhookAt: true,
          },
        }),
        tx.managedEntityAccessEdge.findUnique({
          where: {
            chatId_userId_botId: { chatId, userId, botId: this.publisherBotId },
          },
          select: { deniedReason: true, source: true, sourceVersion: true },
        }),
      ]);
      if (
        !chat ||
        chat.publicationPolicy?.publikEnabled === false ||
        !this.matchesExpectedForwardedBinding(binding, params.expectedBinding) ||
        edge?.source !== PUBLISHER_FORWARDED_CANDIDATE_SOURCE ||
        edge.sourceVersion !== candidateVersion
      ) {
        return false;
      }
      const claimed = await tx.managedEntityAccessEdge.updateMany({
        where: {
          chatId,
          userId,
          botId: this.publisherBotId,
          source: PUBLISHER_FORWARDED_CANDIDATE_SOURCE,
          sourceVersion: candidateVersion,
        },
        data: {
          entityType,
          state: ManagedEntityAccessState.GRANTED,
          userRole,
          botRole,
          checkedAt,
          expiresAt: new Date(checkedAt.getTime() + PUBLISHER_USER_ACCESS_GRANTED_TTL_MS),
          deniedReason: null,
          lastMaxErrorCode: null,
          lastMaxErrorMessage: null,
          lastMaxStatusCode: null,
          source: 'publisher_targeted_user_access',
          sourceVersion: candidateVersion,
        },
      });
      if (claimed.count !== 1) {
        return false;
      }
      await tx.chat.update({
        where: { id: chatId },
        data: {
          entityType,
          title:
            snapshot.title?.trim() ||
            chat.title.trim() ||
            (entityType === ChatEntityType.CHANNEL ? `Channel ${chatId}` : `Chat ${chatId}`),
        },
      });
      await tx.publisherEntityBinding.upsert({
        where: { chatId },
        create: {
          chatId,
          publisherBotId: this.publisherBotId,
          status: ChatBotMembershipStatus.ACTIVE,
          capabilities: params.botAccess.permissions,
          ...botSnapshot,
          botAccessSource: 'publisher_refresh_forwarded_private',
          lastSeenAt: params.botAccessCheckedAt,
        },
        update: {
          publisherBotId: this.publisherBotId,
          status: ChatBotMembershipStatus.ACTIVE,
          capabilities: params.botAccess.permissions,
          ...botSnapshot,
          botAccessSource: 'publisher_refresh_forwarded_private',
          lastSeenAt: params.botAccessCheckedAt,
          sendRouteFailureCount: 0,
          sendRouteQuarantinedUntil: null,
          sendRouteLastFailureAt: null,
          sendRouteLastFailureCode: null,
        },
      });
      await tx.managedBotChatCatalog.upsert({
        where: { botId_chatId: { botId: this.publisherBotId, chatId } },
        create: {
          botId: this.publisherBotId,
          chatId,
          entityType,
          title: snapshot.title?.trim() || null,
          link: snapshot.link,
          avatarUrl: snapshot.avatarUrl,
          status: 'ACTIVE',
          source: 'publisher_targeted_snapshot',
          lastSeenAt: params.botAccessCheckedAt,
        },
        update: {
          entityType,
          ...(snapshot.title?.trim() ? { title: snapshot.title.trim() } : {}),
          link: snapshot.link,
          avatarUrl: snapshot.avatarUrl,
          status: 'ACTIVE',
          source: 'publisher_targeted_snapshot',
          lastSeenAt: params.botAccessCheckedAt,
        },
      });
      return true;
    });
    if (!committed) {
      throw new PublisherCandidateRefreshSupersededError();
    }
    await this.replyForwardedCandidate(params.job, 'granted');
  }

  private isScheduledRefreshSuperseded(
    job: PublisherBindingRefreshJob,
    binding: { botAccessCheckedAt: Date | null } | null,
    edge: { checkedAt: Date } | null,
  ): boolean {
    if (job.reason !== 'stale_access' && job.reason !== 'stale_user_access') {
      return false;
    }
    const requestedAtMs = Date.parse(job.requestedAt);
    if (!Number.isFinite(requestedAtMs)) {
      return false;
    }
    const checkedAt =
      job.reason === 'stale_user_access' ? edge?.checkedAt : binding?.botAccessCheckedAt;
    return checkedAt instanceof Date && checkedAt.getTime() > requestedAtMs;
  }

  private async refreshPublisherCatalog(
    chatId: string,
    fallbackEntityType: ChatEntityType,
    probeStartedAt: Date,
    committedBotAccessCheckedAt: Date,
    committedBotAccessState: ChatBotAccessState,
    requireHydration: boolean,
  ): Promise<{ entityType: ChatEntityType; committed: boolean }> {
    try {
      const snapshot = await this.maxClient.getChatSnapshot(chatId, {
        botId: this.publisherBotId,
        trafficClass: 'background',
        sourceTag: 'publisher_readiness',
        bypassCache: true,
        timeoutMs: 5_000,
      });
      const entityType =
        snapshot.entityType === 'channel'
          ? ChatEntityType.CHANNEL
          : snapshot.entityType === 'chat'
            ? ChatEntityType.CHAT
            : fallbackEntityType;
      const title = snapshot.title?.trim();
      const committed = await this.prisma.$transaction(async (tx) => {
        const chats = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT chat."id"
          FROM "chats" AS chat
          WHERE chat."id" = ${chatId}
          FOR UPDATE OF chat
        `);
        if (chats.length === 0) return false;
        const binding = await tx.publisherEntityBinding.findUnique({
          where: { chatId },
          select: {
            publisherBotId: true,
            status: true,
            lifecycleEventAt: true,
            botAccessCheckedAt: true,
            botAccessState: true,
          },
        });
        if (
          !binding ||
          binding.publisherBotId !== this.publisherBotId ||
          binding.status !== ChatBotMembershipStatus.ACTIVE ||
          (binding.lifecycleEventAt && binding.lifecycleEventAt > probeStartedAt) ||
          binding.botAccessCheckedAt?.getTime() !== committedBotAccessCheckedAt.getTime() ||
          binding.botAccessState !== committedBotAccessState
        ) {
          return false;
        }
        await tx.managedBotChatCatalog.upsert({
          where: { botId_chatId: { botId: this.publisherBotId, chatId } },
          create: {
            botId: this.publisherBotId,
            chatId,
            entityType,
            title: title ?? null,
            link: snapshot.link,
            avatarUrl: snapshot.avatarUrl,
            status: 'ACTIVE',
            source: 'publisher_targeted_snapshot',
            lastSeenAt: probeStartedAt,
          },
          update: {
            entityType,
            ...(title ? { title } : {}),
            link: snapshot.link,
            avatarUrl: snapshot.avatarUrl,
            status: 'ACTIVE',
            source: 'publisher_targeted_snapshot',
            lastSeenAt: probeStartedAt,
          },
        });
        return true;
      });
      return { entityType, committed };
    } catch (error: unknown) {
      if (requireHydration) {
        throw error;
      }
      this.logger.warn(
        { chatId, err: error instanceof Error ? error.message : String(error) },
        'Publisher access refreshed but entity metadata hydration failed',
      );
      return { entityType: fallbackEntityType, committed: true };
    }
  }

  private async refreshPublisherUserAccess(params: {
    chatId: string;
    entityType: ChatEntityType;
    userId: string;
    candidateVersion: string | null;
    botAccess: MaxChatMemberAccess;
    probeStartedAt: Date;
    committedBotAccessCheckedAt: Date;
    committedBotAccessState: ChatBotAccessState;
    interactive: boolean;
  }): Promise<{ committed: boolean; state: ManagedEntityAccessState }> {
    let userAccess: MaxChatMemberAccess | null;
    let terminalStatusCode: number | null = null;
    try {
      userAccess = await this.maxClient.getChatMemberAccess(params.chatId, params.userId, {
        botId: this.publisherBotId,
        trafficClass: params.interactive ? 'interactive' : 'background',
        sourceTag: 'publisher_user_access',
        bypassCache: true,
        timeoutMs: 5_000,
        ignoreFailureMetricStatuses: [403, 404],
      });
    } catch (error: unknown) {
      const statusCode = extractPublisherMaxStatusCode(error);
      if (statusCode !== 403 && statusCode !== 404) {
        throw error;
      }
      userAccess = null;
      terminalStatusCode = statusCode;
    }
    const checkedAt = new Date();
    const userIsBot = userAccess?.isBot === true;
    const userHasUnverifiedBotType =
      userAccess?.isBot !== false && (userAccess?.isAdmin === true || userAccess?.isOwner === true);
    const userHasAdminAccess =
      userAccess?.isBot === false && (userAccess.isAdmin === true || userAccess.isOwner === true);
    const botHasAdminAccess = params.botAccess.isAdmin || params.botAccess.isOwner;
    const granted = userHasAdminAccess && botHasAdminAccess;
    const state = granted
      ? ManagedEntityAccessState.GRANTED
      : botHasAdminAccess
        ? ManagedEntityAccessState.USER_DENIED
        : ManagedEntityAccessState.BOT_DENIED;
    const deniedReason = granted
      ? null
      : botHasAdminAccess
        ? terminalStatusCode
          ? 'publisher_user_access_unavailable'
          : userIsBot
            ? 'publisher_actor_is_bot'
            : userHasUnverifiedBotType
              ? 'publisher_actor_type_unverified'
              : 'publisher_user_not_admin'
        : 'publisher_bot_not_admin';
    const userRole = this.toAccessRole(userAccess);
    const botRole = this.toAccessRole(params.botAccess);
    const committed = await this.prisma.$transaction(async (tx) => {
      const chats = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT chat."id"
        FROM "chats" AS chat
        WHERE chat."id" = ${params.chatId}
        FOR UPDATE OF chat
      `);
      if (chats.length === 0) return false;
      const binding = await tx.publisherEntityBinding.findUnique({
        where: { chatId: params.chatId },
        select: {
          publisherBotId: true,
          status: true,
          lifecycleEventAt: true,
          botAccessCheckedAt: true,
          botAccessState: true,
        },
      });
      if (
        !binding ||
        binding.publisherBotId !== this.publisherBotId ||
        binding.status !== ChatBotMembershipStatus.ACTIVE ||
        (binding.lifecycleEventAt && binding.lifecycleEventAt > params.probeStartedAt) ||
        binding.botAccessCheckedAt?.getTime() !== params.committedBotAccessCheckedAt.getTime() ||
        binding.botAccessState !== params.committedBotAccessState
      ) {
        return false;
      }
      if (params.candidateVersion) {
        const candidateEdge = await tx.managedEntityAccessEdge.findUnique({
          where: {
            chatId_userId_botId: {
              chatId: params.chatId,
              userId: params.userId,
              botId: this.publisherBotId,
            },
          },
          select: { sourceVersion: true },
        });
        if (candidateEdge?.sourceVersion !== params.candidateVersion) {
          return false;
        }
      }
      await tx.managedEntityAccessEdge.upsert({
        where: {
          chatId_userId_botId: {
            chatId: params.chatId,
            userId: params.userId,
            botId: this.publisherBotId,
          },
        },
        create: {
          chatId: params.chatId,
          userId: params.userId,
          botId: this.publisherBotId,
          entityType: params.entityType,
          state,
          userRole,
          botRole,
          checkedAt,
          expiresAt: new Date(
            checkedAt.getTime() +
              (granted
                ? PUBLISHER_USER_ACCESS_GRANTED_TTL_MS
                : PUBLISHER_USER_ACCESS_DENIED_TTL_MS),
          ),
          deniedReason,
          lastMaxErrorCode: terminalStatusCode ? `HTTP_${terminalStatusCode}` : null,
          lastMaxErrorMessage: null,
          lastMaxStatusCode: terminalStatusCode,
          source: 'publisher_targeted_user_access',
          sourceVersion: params.candidateVersion,
        },
        update: {
          entityType: params.entityType,
          state,
          userRole,
          botRole,
          checkedAt,
          expiresAt: new Date(
            checkedAt.getTime() +
              (granted
                ? PUBLISHER_USER_ACCESS_GRANTED_TTL_MS
                : PUBLISHER_USER_ACCESS_DENIED_TTL_MS),
          ),
          deniedReason,
          lastMaxErrorCode: terminalStatusCode ? `HTTP_${terminalStatusCode}` : null,
          lastMaxErrorMessage: null,
          lastMaxStatusCode: terminalStatusCode,
          source: 'publisher_targeted_user_access',
          sourceVersion: params.candidateVersion,
        },
      });
      return true;
    });
    return { committed, state };
  }

  private async terminalizeUnverifiedForwardedConnection(
    job: PublisherBindingRefreshJob,
    fenceAt: Date,
    outcome: { reason: string; statusCode?: number | null },
  ): Promise<boolean> {
    const candidateVersion = job.candidateVersion?.trim() ?? '';
    if (!candidateVersion.startsWith('forwarded:')) {
      return false;
    }
    const chatId = job.chatId.trim();
    const userId = job.candidateUserId?.trim() ?? '';
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT chat."id"
        FROM "chats" AS chat
        WHERE chat."id" = ${chatId}
        FOR UPDATE OF chat
      `);
      if (locked.length !== 1) {
        return false;
      }
      const [binding, edge] = await Promise.all([
        tx.publisherEntityBinding.findUnique({
          where: { chatId },
          select: {
            publisherBotId: true,
            status: true,
            botAccessState: true,
            lastWebhookAt: true,
            lifecycleEventAt: true,
          },
        }),
        tx.managedEntityAccessEdge.findUnique({
          where: {
            chatId_userId_botId: { chatId, userId, botId: this.publisherBotId },
          },
          select: { source: true, sourceVersion: true },
        }),
      ]);
      if (
        !binding ||
        binding.publisherBotId !== this.publisherBotId ||
        binding.status !== ChatBotMembershipStatus.ACTIVE ||
        binding.lastWebhookAt !== null ||
        binding.botAccessState === ChatBotAccessState.CONFIRMED_MEMBER ||
        binding.botAccessState === ChatBotAccessState.CONFIRMED_ADMIN ||
        binding.botAccessState === ChatBotAccessState.CONFIRMED_OWNER ||
        (binding.lifecycleEventAt && binding.lifecycleEventAt > fenceAt) ||
        edge?.source !== PUBLISHER_FORWARDED_CANDIDATE_SOURCE ||
        edge.sourceVersion !== candidateVersion
      ) {
        return false;
      }
      await tx.publisherEntityBinding.update({
        where: { chatId },
        data: {
          status: ChatBotMembershipStatus.REMOVED,
          capabilities: [],
          permissionsSnapshot: Prisma.JsonNull,
          botAccessState: ChatBotAccessState.LOST,
          botAccessCheckedAt: new Date(),
          botAccessExpiresAt: null,
          botAccessSource: 'publisher_forwarded_terminal',
          botAccessLastErrorCode: outcome.statusCode
            ? `HTTP_${outcome.statusCode}`
            : outcome.reason,
          permissionsHash: null,
        },
      });
      await tx.managedBotChatCatalog.updateMany({
        where: { botId: this.publisherBotId, chatId },
        data: {
          status: 'MISSING',
          source: 'publisher_forwarded_terminal',
          lastSeenAt: new Date(),
        },
      });
      return true;
    });
  }

  private async completeCandidateTerminal(
    job: PublisherBindingRefreshJob,
    outcome: { reason: string; statusCode?: number | null },
  ): Promise<void> {
    const chatId = job.chatId.trim();
    const userId = job.candidateUserId?.trim() ?? '';
    if (!chatId || !userId) {
      throw new Error('Publisher actor verification terminal outcome is missing its identity');
    }
    const checkedAt = new Date();
    const candidateVersion = job.candidateVersion?.trim() || null;
    const updated = await this.prisma.managedEntityAccessEdge.updateMany({
      where: {
        chatId,
        userId,
        botId: this.publisherBotId,
        ...(candidateVersion ? { sourceVersion: candidateVersion } : {}),
        source: { startsWith: `${PUBLISHER_ACCESS_CANDIDATE_SOURCE}_` },
      },
      data: {
        state: ManagedEntityAccessState.BOT_DENIED,
        userRole: ManagedEntityAccessRole.UNKNOWN,
        botRole: ManagedEntityAccessRole.UNKNOWN,
        checkedAt,
        expiresAt: new Date(checkedAt.getTime() + PUBLISHER_USER_ACCESS_DENIED_TTL_MS),
        deniedReason: outcome.reason,
        lastMaxStatusCode: outcome.statusCode ?? null,
        lastMaxErrorCode: outcome.statusCode ? `HTTP_${outcome.statusCode}` : null,
        lastMaxErrorMessage: null,
        source: 'publisher_actor_verification_terminal',
        sourceVersion: candidateVersion,
      },
    });
    if (updated.count > 0) {
      return;
    }

    const edge = await this.prisma.managedEntityAccessEdge.findUnique({
      where: {
        chatId_userId_botId: { chatId, userId, botId: this.publisherBotId },
      },
      select: { deniedReason: true, source: true, sourceVersion: true },
    });
    if (
      edge?.sourceVersion === candidateVersion &&
      edge.source === 'publisher_actor_verification_terminal'
    ) {
      return;
    }
    throw new PublisherCandidateRefreshSupersededError();
  }

  private isForwardedTerminalTargetFailure(error: unknown): boolean {
    const statusCode = extractPublisherMaxStatusCode(error);
    return statusCode === 400 || statusCode === 403 || statusCode === 404 || statusCode === 422;
  }

  private matchesExpectedForwardedBinding(
    actual: {
      publisherBotId: string;
      status: ChatBotMembershipStatus;
      botAccessState: ChatBotAccessState;
      botAccessSource: string | null;
      botAccessCheckedAt: Date | null;
      lastWebhookAt: Date | null;
      lifecycleEventAt: Date | null;
    } | null,
    expected: {
      publisherBotId: string;
      status: ChatBotMembershipStatus;
      botAccessState: ChatBotAccessState;
      botAccessSource: string | null;
      botAccessCheckedAt: Date | null;
      lastWebhookAt: Date | null;
      lifecycleEventAt: Date | null;
    } | null,
  ): boolean {
    if (!expected) {
      return actual === null;
    }
    return Boolean(
      actual &&
      actual.publisherBotId === this.publisherBotId &&
      actual.publisherBotId === expected.publisherBotId &&
      actual.status === expected.status &&
      actual.botAccessState === expected.botAccessState &&
      actual.botAccessSource === expected.botAccessSource &&
      this.sameNullableDate(actual.botAccessCheckedAt, expected.botAccessCheckedAt) &&
      this.sameNullableDate(actual.lastWebhookAt, expected.lastWebhookAt) &&
      this.sameNullableDate(actual.lifecycleEventAt, expected.lifecycleEventAt),
    );
  }

  private sameNullableDate(left: Date | null, right: Date | null): boolean {
    return left === null || right === null ? left === right : left.getTime() === right.getTime();
  }

  private async resolveCandidateVersion(job: PublisherBindingRefreshJob): Promise<string> {
    const chatId = job.chatId.trim();
    const userId = job.candidateUserId?.trim() ?? '';
    if (!chatId || !userId) {
      throw new Error('Publisher actor verification fence is missing its identity');
    }
    const key = { chatId, userId, botId: this.publisherBotId };
    const edge = await this.prisma.managedEntityAccessEdge.findUnique({
      where: { chatId_userId_botId: key },
      select: { sourceVersion: true },
    });
    const requestedVersion = job.candidateVersion?.trim() ?? '';
    if (requestedVersion) {
      if (edge?.sourceVersion !== requestedVersion) {
        throw new PublisherCandidateRefreshSupersededError();
      }
      return requestedVersion;
    }
    if (!edge) {
      throw new PublisherCandidateRefreshSupersededError();
    }
    if (edge.sourceVersion?.trim()) {
      return edge.sourceVersion.trim();
    }

    const stagedVersion = `explicit:${createHash('sha256')
      .update(`${chatId}\0${userId}\0${job.reason}\0${job.requestedAt}`)
      .digest('hex')
      .slice(0, 32)}`;
    const staged = await this.prisma.managedEntityAccessEdge.updateMany({
      where: { ...key, sourceVersion: null },
      data: { sourceVersion: stagedVersion },
    });
    if (staged.count !== 1) {
      throw new PublisherCandidateRefreshSupersededError();
    }
    return stagedVersion;
  }

  private async replyForwardedCandidate(
    job: PublisherBindingRefreshJob,
    outcome: 'granted' | 'user_denied' | 'bot_denied',
  ): Promise<void> {
    const replyChatId = job.replyChatId?.trim() ?? '';
    if (!replyChatId) {
      return;
    }
    const text =
      outcome === 'granted'
        ? 'Готово. Чат или канал подключен к Публику и появился в мини-приложении.'
        : outcome === 'user_denied'
          ? 'Подключить чат или канал может только его владелец или администратор.'
          : 'Публик не может открыть этот чат или канал. Назначьте его администратором с доступом ко всем сообщениям и повторите отправку.';
    const miniappUrl =
      outcome === 'granted'
        ? this.maxBotLinkService.buildMiniappStartUrlSync(
            PUBLISHER_HOME_START_PARAM,
            this.publisherBotId,
          )
        : null;
    try {
      await this.maxClient.sendMessageImmediateWithId(
        replyChatId,
        text,
        miniappUrl
          ? {
              buttons: [[{ type: 'link', text: 'Открыть Публик', url: miniappUrl }]],
              debugContext: {
                screen: 'publisher_forwarded_recovery',
                action: outcome,
              },
            }
          : undefined,
        {
          botId: this.publisherBotId,
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
          timeoutMs: PUBLISHER_HANDSHAKE_REPLY_TIMEOUT_MS,
          ignoreFailureMetricStatuses: [403, 404],
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: job.chatId,
          outcome,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to send Publisher forwarded recovery outcome',
      );
    }
  }

  private isAdminOrOwner(access: MaxChatMemberAccess): boolean {
    return access.isAdmin || access.isOwner;
  }

  private hasForwardedRecoveryReadAccess(access: MaxChatMemberAccess): boolean {
    if (access.isOwner) {
      return true;
    }
    return access.permissions.some((permission) => {
      const normalized = normalizePermissionName(permission);
      return normalized === 'read_all_messages' || normalized === 'can_read_all_messages';
    });
  }

  private toAccessRole(access: MaxChatMemberAccess | null): ManagedEntityAccessRole {
    if (access?.isOwner) return ManagedEntityAccessRole.OWNER;
    if (access?.isAdmin) return ManagedEntityAccessRole.ADMIN;
    return access ? ManagedEntityAccessRole.MEMBER : ManagedEntityAccessRole.UNKNOWN;
  }

  private async recordAccessLost(
    chatId: string,
    probeStartedAt: Date,
    error: unknown,
  ): Promise<void> {
    const statusCode = extractPublisherMaxStatusCode(error);
    const checkedAt = new Date();
    await this.prisma.publisherEntityBinding.updateMany({
      where: {
        chatId,
        publisherBotId: this.publisherBotId,
        status: ChatBotMembershipStatus.ACTIVE,
        AND: [
          {
            OR: [{ lifecycleEventAt: null }, { lifecycleEventAt: { lte: probeStartedAt } }],
          },
          {
            OR: [{ botAccessCheckedAt: null }, { botAccessCheckedAt: { lte: probeStartedAt } }],
          },
        ],
      },
      data: {
        permissionsSnapshot: Prisma.JsonNull,
        botAccessState: ChatBotAccessState.LOST,
        botAccessCheckedAt: checkedAt,
        botAccessExpiresAt: null,
        botAccessSource: 'publisher_targeted_access_probe',
        botAccessLastErrorCode: statusCode ? `HTTP_${statusCode}` : 'ACCESS_LOST',
        permissionsHash: null,
      },
    });
  }
}

@Injectable()
export class PublisherBindingRefreshSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherBindingRefreshSchedulerService.name);
  private readonly publisherBotId: string;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private readyBindingCursor: string | null = null;
  private discoveryCursor: string | null = null;
  private userAccessCursor: PublisherUserAccessRefreshCursor | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly refreshQueue: PublisherBindingRefreshQueueService,
    credentials: PublisherActionCredentialService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly backgroundWork: PublisherBackgroundWorkCoordinatorService,
    private readonly bindingLifecycle: PublisherEntityBindingLifecycleService,
  ) {
    this.publisherBotId = credentials.getBotId();
    // FLAG: Resolve before scanning so this worker can never probe with another bot token.
    credentials.getRequiredActionToken(this.publisherBotId);
  }

  async onModuleInit(): Promise<void> {
    if (!this.runtimeBoundary.dispatchEnabled) {
      return;
    }
    this.timer = setInterval(() => {
      void this.scan('scheduled');
    }, PUBLISHER_REFRESH_SCAN_INTERVAL_MS);
    this.timer.unref();
    this.inFlight = true;
    try {
      const compacted = await this.refreshQueue.compactScheduledBacklog();
      if (compacted.scheduledCount > 0 || compacted.truncated) {
        this.logger.log({ ...compacted }, 'Compacted Publisher scheduled refresh backlog');
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Publisher scheduled refresh backlog compaction failed',
      );
    } finally {
      this.inFlight = false;
    }
    await this.scan('startup');
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async scan(reason: 'startup' | 'scheduled'): Promise<void> {
    if (!this.runtimeBoundary.dispatchEnabled || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      await this.backgroundWork.runExclusive('binding_refresh', async () => {
        if (await this.dispatchHealth.isGloballyPaused()) {
          return;
        }
        await this.identityAttestation.assertAttested();
        const now = new Date();
        // FLAG: Publisher webhooks own binding creation; this scan only refreshes existing evidence.
        await this.bindingLifecycle.recoverHistoricalActorCandidates(now);
        const readyBindings = await this.readReadyRefreshCandidates(now);
        const discoveryBindings = await this.readDiscoveryRefreshCandidates(now);
        const userAccessBindings = await this.readUserAccessRefreshCandidates(now);

        const bindingIds = new Set(
          [...readyBindings, ...discoveryBindings].map((binding) => binding.chatId),
        );
        for (const chatId of bindingIds) {
          await this.refreshQueue.enqueue({
            chatId,
            publisherBotId: this.publisherBotId,
            reason: 'stale_access',
            requestedAt: now,
          });
        }
        for (const binding of userAccessBindings) {
          await this.refreshQueue.enqueue({
            chatId: binding.chatId,
            publisherBotId: this.publisherBotId,
            candidateUserId: binding.userId,
            ...(binding.sourceVersion ? { candidateVersion: binding.sourceVersion } : {}),
            reason: 'stale_user_access',
            requestedAt: now,
          });
        }
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Publisher binding refresh scan failed',
      );
    } finally {
      this.inFlight = false;
    }
  }

  private async readReadyRefreshCandidates(now: Date): Promise<PublisherBindingRefreshCandidate[]> {
    const refreshBefore = new Date(now.getTime() + PUBLISHER_BINDING_ACCESS_REFRESH_AHEAD_MS);
    const rows = await this.prisma.publisherEntityBinding.findMany({
      where: {
        publisherBotId: this.publisherBotId,
        status: ChatBotMembershipStatus.ACTIVE,
        ...(this.readyBindingCursor ? { chatId: { gt: this.readyBindingCursor } } : {}),
        botAccessState: {
          in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
        },
        chat: this.managedChatFilter(),
        OR: [{ botAccessExpiresAt: null }, { botAccessExpiresAt: { lte: refreshBefore } }],
      },
      select: { chatId: true },
      orderBy: { chatId: 'asc' },
      take: PUBLISHER_READY_REFRESH_BATCH_SIZE,
    });
    this.readyBindingCursor =
      rows.length < PUBLISHER_READY_REFRESH_BATCH_SIZE ? null : (rows.at(-1)?.chatId ?? null);
    return rows;
  }

  private async readDiscoveryRefreshCandidates(
    now: Date,
  ): Promise<PublisherBindingRefreshCandidate[]> {
    const unknownRetryBefore = new Date(now.getTime() - PUBLISHER_UNKNOWN_REPROBE_COOLDOWN_MS);
    const nonAdminRetryBefore = new Date(now.getTime() - PUBLISHER_NON_ADMIN_REPROBE_COOLDOWN_MS);
    const lostRetryBefore = new Date(now.getTime() - PUBLISHER_LOST_REPROBE_COOLDOWN_MS);
    const refreshBefore = new Date(now.getTime() + PUBLISHER_BINDING_ACCESS_REFRESH_AHEAD_MS);
    const catalogRows = await this.prisma.managedBotChatCatalog.findMany({
      where: {
        botId: this.publisherBotId,
        status: 'ACTIVE',
        ...(this.discoveryCursor ? { chatId: { gt: this.discoveryCursor } } : {}),
      },
      select: { chatId: true },
      orderBy: { chatId: 'asc' },
      take: PUBLISHER_DISCOVERY_REFRESH_BATCH_SIZE,
    });
    this.discoveryCursor =
      catalogRows.length < PUBLISHER_DISCOVERY_REFRESH_BATCH_SIZE
        ? null
        : (catalogRows.at(-1)?.chatId ?? null);
    if (catalogRows.length === 0) {
      return [];
    }
    return this.prisma.publisherEntityBinding.findMany({
      where: {
        ...publisherRefreshEvidenceWhere(this.publisherBotId),
        chatId: { in: catalogRows.map((row) => row.chatId) },
        chat: this.managedChatFilter(),
        AND: [
          {
            OR: [
              {
                botAccessState: ChatBotAccessState.UNKNOWN,
                OR: [
                  { botAccessCheckedAt: { lte: unknownRetryBefore } },
                  {
                    botAccessCheckedAt: null,
                    updatedAt: { lte: unknownRetryBefore },
                  },
                ],
              },
              {
                botAccessState: {
                  in: [ChatBotAccessState.CONFIRMED_MEMBER, ChatBotAccessState.STALE],
                },
                OR: [
                  { botAccessExpiresAt: { lte: refreshBefore } },
                  {
                    botAccessExpiresAt: null,
                    botAccessCheckedAt: { lte: nonAdminRetryBefore },
                  },
                  {
                    botAccessExpiresAt: null,
                    botAccessCheckedAt: null,
                    updatedAt: { lte: nonAdminRetryBefore },
                  },
                ],
              },
              {
                botAccessState: { in: [ChatBotAccessState.DENIED, ChatBotAccessState.LOST] },
                OR: [
                  { botAccessCheckedAt: { lte: lostRetryBefore } },
                  {
                    botAccessCheckedAt: null,
                    updatedAt: { lte: unknownRetryBefore },
                  },
                ],
              },
            ],
          },
        ],
      },
      select: { chatId: true },
      orderBy: { chatId: 'asc' },
      take: PUBLISHER_DISCOVERY_REFRESH_BATCH_SIZE,
    });
  }

  private async readUserAccessRefreshCandidates(
    now: Date,
  ): Promise<PublisherUserAccessRefreshCandidate[]> {
    const refreshBefore = new Date(now.getTime() + PUBLISHER_USER_ACCESS_REFRESH_AHEAD_MS);
    const pendingRetryBefore = new Date(now.getTime() - PUBLISHER_PENDING_CANDIDATE_RETRY_MS);
    const deniedRetryBefore = new Date(
      now.getTime() - PUBLISHER_DENIED_USER_ACCESS_REPROBE_COOLDOWN_MS,
    );
    const actorEvidenceAfter = new Date(now.getTime() - PUBLISHER_ACTOR_EVIDENCE_LOOKBACK_MS);
    const rows = await this.prisma.managedEntityAccessEdge.findMany({
      where: {
        botId: this.publisherBotId,
        OR: [
          {
            state: ManagedEntityAccessState.GRANTED,
            userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
            OR: [
              {
                source: { startsWith: `${PUBLISHER_ACCESS_CANDIDATE_SOURCE}_` },
                checkedAt: { lte: pendingRetryBefore },
                expiresAt: { gt: now },
              },
              { expiresAt: null },
              { expiresAt: { lte: refreshBefore } },
            ],
          },
          {
            state: {
              in: [ManagedEntityAccessState.USER_DENIED, ManagedEntityAccessState.BOT_DENIED],
            },
            OR: [
              {
                deniedReason: PUBLISHER_ACCESS_CANDIDATE_PENDING_REASON,
                checkedAt: { lte: pendingRetryBefore },
                expiresAt: { gt: now },
              },
              {
                createdAt: { gt: actorEvidenceAfter },
                checkedAt: { lte: deniedRetryBefore },
                OR: [{ expiresAt: null }, { expiresAt: { lte: now } }],
              },
            ],
          },
        ],
        AND: [
          {
            OR: [
              {
                chat: {
                  publisherBinding: { is: publisherRefreshEvidenceWhere(this.publisherBotId) },
                  OR: [
                    { publicationPolicy: { is: null } },
                    { publicationPolicy: { is: { publikEnabled: true } } },
                  ],
                },
              },
              {
                source: PUBLISHER_FORWARDED_CANDIDATE_SOURCE,
                sourceVersion: { startsWith: 'forwarded:' },
                chat: {
                  OR: [
                    { publicationPolicy: { is: null } },
                    { publicationPolicy: { is: { publikEnabled: true } } },
                  ],
                },
              },
            ],
          },
          ...(this.userAccessCursor
            ? [
                {
                  OR: [
                    { chatId: { gt: this.userAccessCursor.chatId } },
                    {
                      chatId: this.userAccessCursor.chatId,
                      userId: { gt: this.userAccessCursor.userId },
                    },
                  ],
                },
              ]
            : []),
        ],
      },
      select: { chatId: true, userId: true, sourceVersion: true },
      orderBy: [{ chatId: 'asc' }, { userId: 'asc' }],
      take: PUBLISHER_USER_ACCESS_REFRESH_BATCH_SIZE,
    });
    this.userAccessCursor =
      rows.length < PUBLISHER_USER_ACCESS_REFRESH_BATCH_SIZE
        ? null
        : rows.at(-1)
          ? { chatId: rows.at(-1)!.chatId, userId: rows.at(-1)!.userId }
          : null;
    return rows;
  }

  private managedChatFilter() {
    return {
      OR: [
        { publicationPolicy: { is: null } },
        { publicationPolicy: { is: { publikEnabled: true } } },
      ],
    } satisfies Prisma.ChatWhereInput;
  }
}
