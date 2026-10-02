import { buildBotAccessSnapshotPersistence } from '../max/bot-access-snapshot.util';
import { PublisherBotAccessExecutor } from './publisher-bot-access-executor';
import {
  PublisherBindingMaintenanceSupersededError,
  PublisherRosterRefreshExecutor,
} from './publisher-roster-refresh-executor';
export { PublisherBindingMaintenanceSupersededError } from './publisher-roster-refresh-executor';
import { PublisherActorAccessExecutor } from './publisher-actor-access-executor';
import { PublisherCatalogRefreshExecutor } from './publisher-catalog-refresh-executor';
import {
  PublisherAccessRefreshPolicy,
  type PublisherAccessProbeOutcome,
} from './publisher-access-refresh-policy';
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import {
  MANAGED_HANDSHAKE_CONFIRMATION_AUTO_DELETE_DELAY_MS,
  PUBLISHER_HANDSHAKE_CONFIRMATION_TEXT,
} from '../max/managed-handshake-confirmation';
import { createHash } from 'node:crypto';
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
import { probePublisherAdminRoster, syncPublisherAdminRoster } from './publisher-admin-roster';
import { publisherAccessProbeLifecycleWhere } from './publisher-access-probe-fence';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import { hasPublisherRefreshEvidence } from './publisher-entity-connection.util';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import { PUBLISHER_ACCESS_CANDIDATE_SOURCE } from './publisher-entity-binding-lifecycle.service';
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
const PUBLISHER_USER_ACCESS_GRANTED_TTL_MS = 3 * 24 * 60 * 60_000;
const PUBLISHER_USER_ACCESS_DENIED_TTL_MS = 15 * 60_000;
const PUBLISHER_CATALOG_METADATA_MAX_AGE_MS = 30 * 60_000;
const PUBLISHER_HANDSHAKE_REPLY_TIMEOUT_MS = 1_500;
type RefreshTimingStage = 'botAccessMs' | 'catalogMs' | 'rosterMs' | 'userAccessMs';
type ProbeOutcomes = Partial<Record<'bot' | 'actor' | 'roster', PublisherAccessProbeOutcome>>;
type RefreshTimings = Partial<Record<RefreshTimingStage, number>>;
const REFRESH_TIMING_SAMPLE_INTERVAL_MS = 30_000;
const REFRESH_METRIC_WINDOW_MS = 60_000;
const REFRESH_QUEUE_AGE_BUCKETS_MS = [
  1_000, 5_000, 15_000, 60_000, 120_000, 300_000, 600_000,
] as const;
type RefreshMetricBucket = {
  reason: string;
  retrying: boolean;
  cohort: string;
  proofOutcomes: Record<string, number>;
  stageAttempts: Record<string, number>;
  deadlineProbes: number;
  confirmedBeforeDeadline: number;
  count: number;
  thrown: number;
  totalElapsedMs: number;
  maxElapsedMs: number;
  unknownAge: number;
  queueAgeHistogram: number[];
};
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

@Injectable()
export class PublisherBindingRefreshService implements OnModuleDestroy {
  private readonly logger = new Logger(PublisherBindingRefreshService.name);
  private readonly publisherBotId: string;
  private readonly botAccess: PublisherBotAccessExecutor;
  private readonly rosterRefresh: PublisherRosterRefreshExecutor;
  private readonly actorAccess: PublisherActorAccessExecutor;
  private readonly catalogRefresh: PublisherCatalogRefreshExecutor;
  private lastTimingSampleAt = 0;
  private metricWindowStartedAt = Date.now();
  private readonly metricBuckets = new Map<string, RefreshMetricBucket>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly credentials: PublisherActionCredentialService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly maxBotLinkService: MaxBotLinkService,
    @Optional() private readonly refreshQueue?: PublisherBindingRefreshQueueService,
    @Optional()
    private readonly refreshPolicy: PublisherAccessRefreshPolicy = new PublisherAccessRefreshPolicy(),
  ) {
    this.publisherBotId = credentials.getBotId();
    this.botAccess = new PublisherBotAccessExecutor(prisma, maxClient, this.publisherBotId);
    this.actorAccess = new PublisherActorAccessExecutor(prisma, maxClient, this.publisherBotId);
    this.catalogRefresh = new PublisherCatalogRefreshExecutor(
      prisma,
      maxClient,
      this.publisherBotId,
    );
    this.rosterRefresh = new PublisherRosterRefreshExecutor(
      prisma,
      maxClient,
      this.publisherBotId,
      this.catalogRefresh,
      this.refreshPolicy,
      refreshQueue,
    );
    credentials.getRequiredActionToken(this.publisherBotId);
  }

  async refresh(
    job: PublisherBindingRefreshJob,
    execution: { retrying: boolean } = { retrying: false },
  ): Promise<void> {
    // FLAG: A promoted job retains its durable ID/retry schedule but executes the urgent
    // proof path. Measure queue age from the first publication nomination, never rediscovery.
    if (
      job.publicationRequested &&
      [
        'scheduled_bot_access',
        'stale_user_access',
        'publication_due',
        'publication_actor_due',
      ].includes(job.reason)
    ) {
      job = {
        ...job,
        reason: job.candidateUserId ? 'publication_actor_due' : 'publication_due',
        requestedAt: job.publicationRequestedAt ?? job.requestedAt,
      };
    }
    const startedAt = performance.now();
    const requestedAt = Date.parse(job.requestedAt);
    const requestedAgeMs = Number.isFinite(requestedAt)
      ? Math.max(0, Date.now() - requestedAt)
      : null;
    const timings: RefreshTimings = {};
    const outcomes: ProbeOutcomes = {};
    let outcome: 'returned' | 'threw' = 'threw';
    try {
      await this.refreshBinding(job, execution.retrying, timings, outcomes);
      outcome = 'returned';
    } catch (error: unknown) {
      const stage =
        job.reason === 'binding_maintenance'
          ? 'roster'
          : timings.userAccessMs !== undefined
            ? 'actor'
            : 'bot';
      outcomes[stage] ??=
        error instanceof PublisherCandidateRefreshSupersededError ||
        error instanceof PublisherBindingMaintenanceSupersededError
          ? 'superseded'
          : 'transient_error';
      throw error;
    } finally {
      const now = Date.now();
      const reason = [
        'bot_added',
        'webhook_observed',
        'forwarded_private',
        'historical_actor_recovery',
        'bootstrap',
        'stale_access',
        'scheduled_bot_access',
        'publication_due',
        'publication_actor_due',
        'binding_maintenance',
        'stale_user_access',
        'manual_recheck',
        'policy_enablement_recheck',
        'send_access_lost',
      ].includes(job.reason)
        ? job.reason
        : 'other';
      this.recordRefreshMetric(
        reason,
        execution.retrying,
        outcome,
        requestedAgeMs,
        Math.round(performance.now() - startedAt),
        this.refreshPolicy.separatesMaintenance(this.publisherBotId, job.chatId)
          ? 'separated'
          : 'legacy',
        outcomes,
        timings,
        job.requiredBefore,
      );
      if (now - this.lastTimingSampleAt >= REFRESH_TIMING_SAMPLE_INTERVAL_MS) {
        this.lastTimingSampleAt = now;
        try {
          this.logger.log(
            {
              reason,
              outcome,
              retrying: execution.retrying,
              requestedAgeMs,
              elapsedMs: Math.round(performance.now() - startedAt),
              ...timings,
              proofOutcomes: outcomes,
            },
            'Publisher binding refresh timing sample',
          );
        } catch {
          // FLAG: A diagnostic sample cannot invalidate a committed permission probe.
        }
      }
    }
  }

  onModuleDestroy(): void {
    this.flushRefreshMetrics();
  }

  private recordRefreshMetric(
    reason: string,
    retrying: boolean,
    outcome: 'returned' | 'threw',
    queueAgeMs: number | null,
    elapsedMs: number,
    cohort: string,
    outcomes: ProbeOutcomes,
    timings: RefreshTimings,
    requiredBefore?: string,
  ): void {
    const key = `${reason}:${retrying}:${cohort}`;
    let bucket = this.metricBuckets.get(key);
    if (!bucket) {
      bucket = {
        reason,
        retrying,
        cohort,
        proofOutcomes: {},
        stageAttempts: {},
        deadlineProbes: 0,
        confirmedBeforeDeadline: 0,
        count: 0,
        thrown: 0,
        totalElapsedMs: 0,
        maxElapsedMs: 0,
        unknownAge: 0,
        queueAgeHistogram: Array(REFRESH_QUEUE_AGE_BUCKETS_MS.length + 1).fill(0),
      };
      this.metricBuckets.set(key, bucket);
    }
    for (const [stage, result] of Object.entries(outcomes)) {
      const name = `${stage}_${result}`;
      bucket.proofOutcomes[name] = (bucket.proofOutcomes[name] ?? 0) + 1;
    }
    for (const stage of Object.keys(timings))
      bucket.stageAttempts[stage] = (bucket.stageAttempts[stage] ?? 0) + 1;
    const deadline = Date.parse(requiredBefore ?? '');
    if (outcomes.bot && Number.isFinite(deadline)) {
      bucket.deadlineProbes += 1;
      if (outcomes.bot === 'confirmed' && Date.now() <= deadline)
        bucket.confirmedBeforeDeadline += 1;
    }
    bucket.count += 1;
    bucket.thrown += outcome === 'threw' ? 1 : 0;
    bucket.totalElapsedMs += elapsedMs;
    bucket.maxElapsedMs = Math.max(bucket.maxElapsedMs, elapsedMs);
    if (queueAgeMs === null) bucket.unknownAge += 1;
    else {
      const index = REFRESH_QUEUE_AGE_BUCKETS_MS.findIndex((upper) => queueAgeMs <= upper);
      bucket.queueAgeHistogram[index < 0 ? REFRESH_QUEUE_AGE_BUCKETS_MS.length : index] += 1;
    }
    if (Date.now() - this.metricWindowStartedAt >= REFRESH_METRIC_WINDOW_MS)
      this.flushRefreshMetrics();
  }

  private flushRefreshMetrics(): void {
    // FLAG: All attempts contribute to fixed-size identifier-free histograms. Returned work
    // is not evidence of a grant, and telemetry failure must never alter a permission verdict.
    for (const bucket of this.metricBuckets.values()) {
      try {
        this.logger.log(
          {
            metric: 'publisher_refresh_v1',
            windowMs: Math.max(0, Date.now() - this.metricWindowStartedAt),
            reason: bucket.reason,
            cohort: bucket.cohort,
            proofOutcomes: bucket.proofOutcomes,
            stageAttempts: bucket.stageAttempts,
            deadlineProbes: bucket.deadlineProbes,
            confirmedBeforeDeadline: bucket.confirmedBeforeDeadline,
            retrying: bucket.retrying,
            attempts: bucket.count,
            thrown: bucket.thrown,
            returned: bucket.count - bucket.thrown,
            averageElapsedMs: Math.round(bucket.totalElapsedMs / bucket.count),
            maxElapsedMs: bucket.maxElapsedMs,
            unknownQueueAge: bucket.unknownAge,
            queueAgeUpperBoundsMs: [...REFRESH_QUEUE_AGE_BUCKETS_MS, null],
            queueAgeHistogram: bucket.queueAgeHistogram,
          },
          'Publisher refresh window',
        );
      } catch {
        // FLAG: SQL and the exact MAX proof remain authoritative when logging is unavailable.
      }
    }
    this.metricBuckets.clear();
    this.metricWindowStartedAt = Date.now();
  }

  private async measureStage<T>(
    timings: RefreshTimings,
    stage: RefreshTimingStage,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      timings[stage] = (timings[stage] ?? 0) + Math.round(performance.now() - startedAt);
    }
  }

  private async refreshBinding(
    job: PublisherBindingRefreshJob,
    retrying: boolean,
    timings: RefreshTimings,
    outcomes: ProbeOutcomes,
  ): Promise<void> {
    const candidateUserId = job.candidateUserId?.trim() ?? '';
    const candidateJob = candidateUserId.length > 0;
    const lightweightBotRefresh =
      job.reason === 'scheduled_bot_access' || job.reason === 'publication_due';
    if (
      (lightweightBotRefresh || job.reason === 'binding_maintenance') &&
      (candidateJob || job.replyChatId || job.replyToStartCommand)
    ) {
      throw new Error('Publisher maintenance cannot carry interactive candidate replies');
    }
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
    if ((job.replyChatId?.trim() || job.replyToStartCommand) && !candidateJob) {
      throw new Error('Publisher actor verification reply is missing its candidate user');
    }
    await this.identityAttestation.assertAttested();
    if (durableInteractiveRefresh) {
      await this.dispatchHealth.assertDispatchAllowed();
    } else if (await this.dispatchHealth.isGloballyPaused()) {
      return;
    }
    if (job.reason === 'binding_maintenance') {
      outcomes.roster = await this.rosterRefresh.execute(job, (stage, work) =>
        this.measureStage(timings, stage, work),
      );
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
          publisherBinding: true,
        },
      }),
      this.prisma.managedBotChatCatalog.findUnique({
        where: { botId_chatId: { botId: this.publisherBotId, chatId } },
        select: { entityType: true, title: true, status: true, source: true, lastSeenAt: true },
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
      // FLAG: A bot snapshot is only the first committed stage. A retry/stalled recovery
      // must finish the catalog and roster even when its own earlier probe is newer.
      !(retrying && job.reason === 'stale_access' && !candidateJob) &&
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
    // FLAG: Access refresh never enables publishing. A new binding still requires an exact
    // Publisher-staged candidate, including while the publication policy is disabled.
    if (!candidate || (!bindingHasRefreshEvidence && !hasExactStagedForwardedCandidate)) {
      if (candidateJob) {
        await this.terminalizeUnverifiedForwardedConnection(job, new Date(), {
          reason: 'publisher_binding_unavailable',
        });
        await this.completeCandidateTerminal(job, {
          reason: !candidate ? 'publisher_entity_missing' : 'publisher_binding_unavailable',
        });
        await this.replyForwardedCandidate(job, 'bot_denied');
      }
      return;
    }

    const probeStartedAt = new Date();
    if (
      lightweightBotRefresh &&
      this.refreshQueue &&
      candidate.publisherBinding?.botAccessCheckedAt &&
      candidate.publisherBinding.botAccessCheckedAt.getTime() > Date.parse(job.requestedAt) &&
      candidate.publisherBinding.botAccessExpiresAt &&
      candidate.publisherBinding.botAccessExpiresAt > probeStartedAt
    ) {
      outcomes.bot = 'superseded';
      if (!this.refreshPolicy.separatesMaintenance(this.publisherBotId, chatId))
        await this.enqueueBindingMaintenance(chatId, probeStartedAt);
      return;
    }
    let botAccess: MaxChatMemberAccess;
    let committedBotAccessCheckedAt = probeStartedAt;
    let committedBotAccessState: ChatBotAccessState = ChatBotAccessState.UNKNOWN;
    const forwardedCandidateNeedsMaterialization =
      hasExactStagedForwardedCandidate && !bindingHasRefreshEvidence;
    try {
      const proof = await this.measureStage(timings, 'botAccessMs', () =>
        this.botAccess.execute({
          chatId,
          reason: job.reason,
          probeStartedAt,
          materializeForwarded: forwardedCandidateNeedsMaterialization,
        }),
      );
      outcomes.bot = proof.outcome;
      if (proof.outcome === 'superseded') {
        if (candidateJob) throw new PublisherCandidateRefreshSupersededError();
        return;
      }
      botAccess = proof.botAccess;
      committedBotAccessCheckedAt = proof.checkedAt;
      committedBotAccessState = proof.snapshot.botAccessState;
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
        outcomes.bot = 'denied';
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

    // FLAG: Catalog and actor verification remain available while publishing is disabled.

    if (lightweightBotRefresh && this.refreshQueue) {
      if (
        this.isAdminOrOwner(botAccess) &&
        !this.refreshPolicy.separatesMaintenance(this.publisherBotId, chatId)
      )
        await this.enqueueBindingMaintenance(chatId, committedBotAccessCheckedAt);
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

    const parallelRoster =
      !candidateJob &&
      (committedBotAccessState === ChatBotAccessState.CONFIRMED_ADMIN ||
        committedBotAccessState === ChatBotAccessState.CONFIRMED_OWNER);
    // FLAG: Only scheduled bot checks may reuse exact-bot metadata from a recent MAX
    // snapshot. Never advance its timestamp here or reuse bot/admin permission evidence.
    // Webhook/manual/candidate flows still hydrate; lifecycle writes replace this source.
    const catalogAgeMs = publisherCatalog?.lastSeenAt
      ? probeStartedAt.getTime() - publisherCatalog.lastSeenAt.getTime()
      : Number.NaN;
    const reuseCatalog =
      ((parallelRoster && job.reason === 'stale_access') ||
        (candidateJob && job.reason === 'publication_actor_due')) &&
      publisherCatalog?.source === 'publisher_targeted_snapshot' &&
      publisherCatalog.status === 'ACTIVE' &&
      Boolean(publisherCatalog.title?.trim()) &&
      catalogAgeMs >= 0 &&
      catalogAgeMs < PUBLISHER_CATALOG_METADATA_MAX_AGE_MS;
    // FLAG: Probe only after exact bot access is confirmed. Drain both independent reads
    // before returning on any error; catalog/roster writes retain their existing fences.
    const [catalogResult, rosterResult] = await Promise.allSettled([
      this.measureStage(timings, 'catalogMs', () =>
        reuseCatalog
          ? Promise.resolve({ entityType: publisherCatalog!.entityType, committed: true })
          : this.catalogRefresh.execute(
              chatId,
              publisherCatalog?.entityType ?? ChatEntityType.CHAT,
              probeStartedAt,
              committedBotAccessCheckedAt,
              committedBotAccessState,
              candidateJob,
            ),
      ),
      parallelRoster
        ? this.measureStage(timings, 'rosterMs', () =>
            probePublisherAdminRoster({
              maxClient: this.maxClient,
              chatId,
              publisherBotId: this.publisherBotId,
              probeStartedAt,
            }),
          )
        : Promise.resolve(null),
    ]);
    if (catalogResult.status === 'rejected') throw catalogResult.reason;
    const catalogRefresh = catalogResult.value;
    if (!catalogRefresh.committed) {
      if (candidateJob) {
        throw new PublisherCandidateRefreshSupersededError();
      }
      return;
    }
    if (rosterResult.status === 'rejected') throw rosterResult.reason;
    let startCommandAccessGranted = false;
    if (candidateJob) {
      const accessResult = await this.measureStage(timings, 'userAccessMs', () =>
        this.actorAccess.execute({
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
        }),
      );
      outcomes.actor = accessResult.outcome;
      if (!accessResult.committed) {
        throw new PublisherCandidateRefreshSupersededError();
      }
      startCommandAccessGranted = accessResult.state === ManagedEntityAccessState.GRANTED;
      await this.replyForwardedCandidate(
        job,
        accessResult.state === ManagedEntityAccessState.GRANTED ? 'granted' : 'user_denied',
      );
    }
    if (
      (!candidateJob ||
        job.reason === 'bot_added' ||
        job.reason === 'webhook_observed' ||
        job.reason === 'manual_recheck') &&
      (committedBotAccessState === ChatBotAccessState.CONFIRMED_ADMIN ||
        committedBotAccessState === ChatBotAccessState.CONFIRMED_OWNER)
    ) {
      const committed = await this.measureStage(timings, 'rosterMs', () =>
        syncPublisherAdminRoster(
          {
            prisma: this.prisma,
            maxClient: this.maxClient,
            chatId,
            publisherBotId: this.publisherBotId,
            entityType: catalogRefresh.entityType,
            probeStartedAt,
            botAccessCheckedAt: committedBotAccessCheckedAt,
            botAccessState: committedBotAccessState,
          },
          rosterResult.value ?? undefined,
        ),
      );
      outcomes.roster = committed ? 'confirmed' : 'superseded';
      if (!committed) throw new PublisherCandidateRefreshSupersededError();
    }
    if (startCommandAccessGranted && job.replyToStartCommand && job.reason === 'webhook_observed') {
      await this.replyToStartCommandSafely(job);
    }
  }

  private async enqueueBindingMaintenance(chatId: string, requestedAt: Date): Promise<void> {
    await this.refreshQueue?.enqueue({
      chatId,
      publisherBotId: this.publisherBotId,
      reason: 'binding_maintenance',
      requestedAt,
    });
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
          select: { title: true },
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
    if (
      job.reason !== 'stale_access' &&
      job.reason !== 'stale_user_access' &&
      job.reason !== 'publication_actor_due'
    ) {
      return false;
    }
    const requestedAtMs = Date.parse(job.requestedAt);
    if (!Number.isFinite(requestedAtMs)) {
      return false;
    }
    const checkedAt =
      job.reason === 'stale_user_access' || job.reason === 'publication_actor_due'
        ? edge?.checkedAt
        : binding?.botAccessCheckedAt;
    if (
      job.publicationRequested &&
      checkedAt instanceof Date &&
      checkedAt.getTime() <= Date.now() - 15 * 60_000
    )
      return false;
    return checkedAt instanceof Date && checkedAt.getTime() > requestedAtMs;
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
          publisherAccessProbeLifecycleWhere(probeStartedAt),
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

  private async replyToStartCommandSafely(job: PublisherBindingRefreshJob): Promise<void> {
    const miniappUrl = this.maxBotLinkService.buildMiniappStartUrlSync(
      PUBLISHER_HOME_START_PARAM,
      this.publisherBotId,
    );
    // FLAG: Public confirmation belongs only to an explicit Start after committed
    // Publisher bot AND actor admin checks. Fence retries by the exact command identity.
    try {
      await this.maxClient.sendMessage(
        job.chatId,
        PUBLISHER_HANDSHAKE_CONFIRMATION_TEXT,
        miniappUrl
          ? { buttons: [[{ type: 'link', text: 'Открыть Публик', url: miniappUrl }]] }
          : undefined,
        {
          immediate: true,
          botId: this.publisherBotId,
          idempotencyKey: `publisher-handshake-start:${job.chatId}:${job.candidateVersion}`,
          autoDeleteDelayMs: MANAGED_HANDSHAKE_CONFIRMATION_AUTO_DELETE_DELAY_MS,
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
          timeoutMs: PUBLISHER_HANDSHAKE_REPLY_TIMEOUT_MS,
          ignoreFailureMetricStatuses: [403, 404],
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        { chatId: job.chatId, err: error instanceof Error ? error.message : String(error) },
        'Failed to send Publisher Start confirmation',
      );
    }
  }
  private toAccessRole(access: MaxChatMemberAccess | null): ManagedEntityAccessRole {
    if (access?.isOwner) return ManagedEntityAccessRole.OWNER;
    if (access?.isAdmin) return ManagedEntityAccessRole.ADMIN;
    return access ? ManagedEntityAccessRole.MEMBER : ManagedEntityAccessRole.UNKNOWN;
  }
}

export { PublisherBindingRefreshSchedulerService } from './publisher-binding-refresh-scheduler.service';
