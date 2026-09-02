import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  buildMaxActionNoExecutableRouteMessage,
  buildMaxActionRouteQuarantinedMessage,
} from '../max/max-action-dispatch-error';
import { buildNightModeNoticeIdempotencyKey } from '../max/max-action-idempotency.util';
import {
  getNightModeTransitionAccessRecoveryMarker,
  prepareDefinitivelyRejectedNightModeOpenRetry,
  prepareDefinitivelyRejectedNightModeTransitionRetry,
} from '../max/max-action-ledger.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  ChatBotMembershipStatus,
  ChatEntityType,
  MaxActionLedgerStatus,
  Prisma,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { moderationBackgroundTasksEnabled } from '../runtime/moderation-runtime';
import {
  hasNightModeTransitionMembershipCandidate,
  NIGHT_MODE_TRANSITION_REFRESHABLE_ACCESS_STATES,
} from './night-mode-transition-eligibility.util';
import {
  buildNightModeTransitionJobId,
  buildNightModeTransitionRecoveryJobId,
  NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
  NIGHT_MODE_TRANSITION_JOB_NAME,
  NIGHT_MODE_TRANSITION_LOCK_BUSY_FAILURE_PREFIX,
  NIGHT_MODE_TRANSITION_POST_EXECUTION_CLEANUP_FAILURE_PREFIX,
  NIGHT_MODE_TRANSITION_QUEUE,
  parseNightModeTransitionRecoveryOnly,
  type NightModeTransitionJob,
  type NightModeTransitionRecoveryOnly,
} from './night-mode-transition.queue';
import {
  parseNightModeTransitionSessionKey,
  resolveCurrentNightModeCloseOccurrence,
  resolveCurrentNightModeOpenOccurrence,
  resolveNightModeTransitionSessionCloseAt,
  resolveNextNightModeTransitionOccurrences,
  type NightModeTransitionOccurrence,
  type NightModeTransitionScheduleSettings,
} from './night-mode-transition-time.util';
import { buildNightModeTransitionScheduleFingerprint } from './night-mode-transition-generation.util';
import {
  buildNightModeTransitionStateKey,
  DEFAULT_NIGHT_MODE_TRANSITION_STARTUP_DELAY_MS,
  parseNightModeTransitionState,
} from './moderation.service.support';
import { RedisCounterService } from './redis-counter.service';

const NIGHT_MODE_TRANSITION_JOB_ATTEMPTS = 3;
const NIGHT_MODE_TRANSITION_JOB_BACKOFF_MS = 15_000;
const NIGHT_MODE_TRANSITION_RUNTIME_VERSION = 4 as const;
const NIGHT_MODE_TRANSITION_BOOTSTRAP_BATCH_SIZE = 200;
const NIGHT_MODE_TRANSITION_BOOTSTRAP_RETRY_MS = 30_000;
const NIGHT_MODE_TRANSITION_RECONCILE_MAX_PASSES = 3;
const NIGHT_MODE_QUEUE_MUTATION_LOCK_TTL_MS = 120_000;
const NIGHT_MODE_QUEUE_MUTATION_LOCK_HEARTBEAT_MS = 30_000;
const NIGHT_MODE_QUEUE_MUTATION_LOCK_WAIT_MS = 4_000;
const NIGHT_MODE_TRANSITION_SOURCE_TAG = 'night_mode_transition';
const NIGHT_MODE_RECOVERY_LEDGER_PAGE_SIZE = 20;

type NightModeTransitionReconcileSnapshot = {
  signature: string;
  cleanupRequired: boolean;
  scheduleConfigured: boolean;
  settings: (NightModeTransitionScheduleSettings & { chatId: string }) | null;
};

export type NightModeTransitionManualBlockCategory =
  | 'unsafe_prior_dispatch'
  | 'unsafe_prior_provenance'
  | 'no_fresh_access'
  | 'failed_job_unclassified';

export type NightModeTransitionManualReview = {
  category: NightModeTransitionManualBlockCategory;
  reason: string;
  jobId: string;
  ledgerJobId: string | null;
  sessionKey: string;
  fingerprint: string;
};

export type NightModeTransitionReconcileFence = {
  generation: bigint;
  leaseToken: string;
};

type NightModeCurrentCatchUpResolution =
  | { kind: 'enqueue' }
  | { kind: 'skip' }
  | { kind: 'blocked'; manualReview: NightModeTransitionManualReview };

type NightModeCloseRecoveryResolution =
  | { kind: 'none' }
  | { kind: 'needed'; recovery: NightModeTransitionRecoveryOnly }
  | { kind: 'already_complete'; recovery: NightModeTransitionRecoveryOnly }
  | { kind: 'blocked'; manualReview: NightModeTransitionManualReview };

export type NightModeRecoveryOnlyPreflight = 'needed' | 'already_complete' | 'unsafe';

type NightModeRecoveryScheduleResult = {
  jobId: string | null;
  manualReview: NightModeTransitionManualReview | null;
  blocksCurrentCatchUp: boolean;
};

type NightModeManualReviewDisposition =
  | { kind: 'none' }
  | { kind: 'acknowledged'; category: NightModeTransitionManualBlockCategory }
  | { kind: 'blocked'; manualReview: NightModeTransitionManualReview };

type NightModeAccessScheduleExpectation = {
  futureJobIds: string[];
  manualReview: NightModeTransitionManualReview | null;
  recoveryJobId: string | null;
  currentCatchUp: {
    jobId: string;
    sessionKey: string;
    transition: NightModeTransitionOccurrence['transition'];
  } | null;
};

type NightModeEnqueueOccurrencesResult = {
  manualReview: NightModeTransitionManualReview | null;
  skippedCurrentJobIds?: ReadonlySet<string>;
};

type NightModeScheduledJobRegistryRow = {
  chat_id: string;
  job_id: string;
  transition: NightModeTransitionOccurrence['transition'];
  session_key: string;
  scheduled_for: Date;
  schedule_fingerprint: string;
  runtime_version?: number;
};

type NightModeCloseLedgerRow = {
  id?: string;
  jobId?: string;
  updatedAt?: Date;
  actionType: string;
  chatId: string;
  sourceTag: string | null;
  status: MaxActionLedgerStatus;
  ambiguous: boolean;
  terminal: boolean;
  completedAt: Date | null;
  dispatchToken?: string | null;
  dispatchStartedAt?: Date | null;
  dispatchBotId: string | null;
  remoteMessageId: string | null;
};

type NightModeCompletedCloseLedgerRecoveryRow = {
  id: string;
  jobId: string;
  completedAt: Date;
  dispatchBotId: string;
  remoteMessageId: string;
};

type NightModeQueueMutationLockApi = Pick<
  RedisCounterService,
  'acquireLock' | 'releaseLock' | 'renewLock'
>;

class NightModeTransitionJobsActiveError extends Error {
  constructor(jobIds: readonly string[]) {
    super(
      `Night mode transition jobs are active during schedule replacement (${jobIds.join(',')})`,
    );
    this.name = 'NightModeTransitionJobsActiveError';
  }
}

export type NightModeTransitionReconcileResult = {
  queueAvailable: boolean;
  scheduleEnabled: boolean | null;
  passes: number;
  manualReview?: {
    category: NightModeTransitionManualBlockCategory;
    reason: string;
    jobId: string;
    ledgerJobId: string | null;
    sessionKey: string;
    fingerprint: string;
  };
};

@Injectable()
export class NightModeTransitionSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NightModeTransitionSchedulerService.name);
  private readonly runtimeStartedAtMs = Date.now();
  private readonly startupDelayMs: number;
  private readonly backgroundTasksEnabled: boolean;
  private startupTimer: NodeJS.Timeout | null = null;
  private bootstrapInFlight = false;
  private bootstrapRetryRequested = false;
  private shuttingDown = false;
  private readonly localQueueMutationChains = new Map<string, Promise<void>>();
  private readonly fallbackScheduledJobRegistry = new Map<
    string,
    NightModeScheduledJobRegistryRow
  >();

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @InjectQueue(NIGHT_MODE_TRANSITION_QUEUE)
    private readonly queue?: Queue<NightModeTransitionJob>,
    @Optional() configService?: ConfigService,
    @Optional() private readonly maxBotRegistry?: MaxBotRegistryService,
    @Optional() private readonly redisCounter?: RedisCounterService,
  ) {
    this.startupDelayMs = this.readNonNegativeConfigInt(
      configService?.get<number>('NIGHT_MODE_TRANSITION_STARTUP_DELAY_MS'),
      DEFAULT_NIGHT_MODE_TRANSITION_STARTUP_DELAY_MS,
    );
    this.backgroundTasksEnabled = moderationBackgroundTasksEnabled(
      configService?.get<boolean | string>('MODERATION_BACKGROUND_TASKS_ENABLED'),
    );
  }

  onModuleInit(): void {
    if (!roleRunsModeration(getAppRole()) || !this.backgroundTasksEnabled) {
      return;
    }

    this.scheduleBootstrap(this.startupDelayMs);
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  async bootstrapEnabledChats(): Promise<void> {
    if (
      this.bootstrapInFlight ||
      !this.queue ||
      typeof this.prisma.chatSettings?.findMany !== 'function'
    ) {
      return;
    }

    this.bootstrapInFlight = true;
    try {
      let cursor: { chatId: string } | undefined;
      for (;;) {
        const settingsRows = await this.prisma.chatSettings.findMany({
          where: {
            nightModeEnabled: true,
            chat: this.buildActiveBotMembershipFilter(),
          },
          select: {
            chatId: true,
            nightModeEnabled: true,
            nightModeStartTimeMinutes: true,
            nightModeEndTimeMinutes: true,
            nightModeTimezone: true,
          },
          orderBy: {
            chatId: 'asc',
          },
          take: NIGHT_MODE_TRANSITION_BOOTSTRAP_BATCH_SIZE,
          ...(cursor
            ? {
                skip: 1,
                cursor,
              }
            : {}),
        });

        const eligibleSettingsRows = await this.filterEligibleSettingsRows(settingsRows);
        // Startup may inspect the current boundary, but canEnqueueCurrentCatchUp authorizes it only
        // when v4 durable proof shows that this process generation accepted it while still future.
        await this.enqueueChatSettingsRows(eligibleSettingsRows, {
          includeCurrentClose: true,
          includeCurrentOpen: true,
        });

        if (settingsRows.length < NIGHT_MODE_TRANSITION_BOOTSTRAP_BATCH_SIZE) {
          break;
        }
        cursor = { chatId: settingsRows[settingsRows.length - 1]!.chatId };
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to bootstrap night mode transition jobs',
      );
      this.requestBootstrapRetry();
    } finally {
      this.bootstrapInFlight = false;
      if (this.bootstrapRetryRequested) {
        this.bootstrapRetryRequested = false;
        this.scheduleBootstrap(NIGHT_MODE_TRANSITION_BOOTSTRAP_RETRY_MS);
      }
    }
  }

  async reconcileChat(chatId: string): Promise<NightModeTransitionReconcileResult> {
    const normalizedChatIds = this.normalizeChatIds([chatId]);
    if (normalizedChatIds.length === 0) {
      return {
        queueAvailable: Boolean(this.queue),
        scheduleEnabled: false,
        passes: 0,
      };
    }
    if (!this.queue) {
      return {
        queueAvailable: false,
        scheduleEnabled: null,
        passes: 0,
      };
    }

    const normalizedChatId = normalizedChatIds[0]!;
    return this.runChatQueueMutationSerialized(normalizedChatId, () =>
      this.replaceChatScheduleFromCurrentSnapshot(normalizedChatId, {
        includeCurrentClose: true,
        includeCurrentOpen: true,
      }),
    );
  }

  async repairAccessSchedule(
    chatId: string,
    reconcileFence?: NightModeTransitionReconcileFence,
  ): Promise<NightModeTransitionReconcileResult> {
    const normalizedChatIds = this.normalizeChatIds([chatId]);
    if (normalizedChatIds.length === 0) {
      return {
        queueAvailable: Boolean(this.queue),
        scheduleEnabled: false,
        passes: 0,
      };
    }
    if (!this.queue) {
      return {
        queueAvailable: false,
        scheduleEnabled: null,
        passes: 0,
      };
    }

    const normalizedChatId = normalizedChatIds[0]!;
    return this.runChatQueueMutationSerialized(normalizedChatId, async () => {
      let snapshot = await this.readReconcileSnapshot(normalizedChatId);
      // FLAG: Settings and membership writes durably request this repair in PostgreSQL. Eligible
      // schedules only fill missing deterministic jobs so routine refreshes do not churn the queue.
      for (let pass = 1; pass <= NIGHT_MODE_TRANSITION_RECONCILE_MAX_PASSES; pass += 1) {
        const recovery = await this.ensureCloseEventRecoveryJob(normalizedChatId, reconcileFence, {
          scanHistoricalLedger: true,
        });
        const expectation = snapshot.settings
          ? await this.ensureAccessScheduleOccurrences(snapshot.settings, reconcileFence, recovery)
          : null;
        if (!snapshot.settings) {
          await this.clearChatJobsForChatIds(normalizedChatIds, {
            strict: true,
            keepJobIds: recovery.jobId ? new Set([recovery.jobId]) : undefined,
            reconcileFence,
          });
        }

        const verified = await this.readReconcileSnapshot(normalizedChatId);
        if (verified.signature === snapshot.signature) {
          if (verified.settings && expectation) {
            await this.verifyAccessScheduleExpectation(verified.settings, expectation);
          }
          return {
            queueAvailable: true,
            scheduleEnabled: verified.settings !== null,
            passes: pass,
            ...(recovery.manualReview || expectation?.manualReview
              ? { manualReview: recovery.manualReview ?? expectation!.manualReview! }
              : {}),
          };
        }
        // FLAG: Any effective state change invalidates jobs observed or created in this pass.
        // Clear them before rebuilding from the newly committed snapshot.
        await this.clearChatJobsForChatIds(normalizedChatIds, {
          strict: true,
          reconcileFence,
        });
        snapshot = verified;
      }

      throw new Error(
        `Night mode transition access state did not stabilize during durable repair (${normalizedChatId})`,
      );
    });
  }

  async shouldProcessChatTransitions(chatId: string): Promise<boolean> {
    const normalizedChatIds = this.normalizeChatIds([chatId]);
    if (normalizedChatIds.length === 0) {
      return false;
    }

    return this.hasActionableTransitionCandidate(normalizedChatIds[0]!);
  }

  async inspectRecoveryOnlyTransition(
    job: NightModeTransitionJob,
  ): Promise<NightModeRecoveryOnlyPreflight> {
    const recovery = parseNightModeTransitionRecoveryOnly(job.recoveryOnly);
    if (!recovery || job.chatId.trim().length === 0) {
      return 'unsafe';
    }
    return this.inspectRecoveryEnvelope(job.chatId.trim(), recovery);
  }

  async isTransitionManuallyFenced(
    job: NightModeTransitionJob,
    bullJobId?: string | null,
  ): Promise<boolean> {
    if (job.recoveryOnly) {
      return false;
    }
    const normalizedChatId = job.chatId.trim();
    const fingerprint = this.resolveJobScheduleFingerprint(job);
    if (!normalizedChatId) {
      return false;
    }
    const expectedJobId = buildNightModeTransitionJobId(
      normalizedChatId,
      job.transition,
      job.scheduledFor,
      job.sessionKey,
    );
    const actualJobId = bullJobId?.trim() || expectedJobId;
    if (actualJobId !== expectedJobId) {
      return false;
    }
    if (typeof this.prisma.nightModeTransitionReconcileRequest?.findUnique !== 'function') {
      return false;
    }
    const row = await this.prisma.nightModeTransitionReconcileRequest.findUnique({
      where: { chatId: normalizedChatId },
      select: {
        manualBlockedAt: true,
        manualBlockedCategory: true,
        manualBlockedJobId: true,
        manualBlockedSessionKey: true,
        manualBlockedFingerprint: true,
      },
    });
    return (
      row?.manualBlockedAt instanceof Date &&
      this.isManualBlockCategory(row.manualBlockedCategory) &&
      row.manualBlockedJobId === actualJobId &&
      row.manualBlockedSessionKey === job.sessionKey &&
      (fingerprint === null || row.manualBlockedFingerprint === fingerprint)
    );
  }

  private resolveJobScheduleFingerprint(job: NightModeTransitionJob): string | null {
    const persisted = job.scheduleFingerprint?.trim();
    if (persisted) {
      return persisted;
    }
    const parsed = parseNightModeTransitionSessionKey(job.sessionKey);
    return parsed
      ? this.buildRecoveryScheduleFingerprint(
          parsed.timezone,
          parsed.startMinutes,
          parsed.endMinutes,
        )
      : null;
  }

  async requestJobReconcile(job: NightModeTransitionJob): Promise<void> {
    const normalizedChatIds = this.normalizeChatIds([job.chatId]);
    if (normalizedChatIds.length === 0) {
      return;
    }
    await this.requestDurableReconcile(normalizedChatIds[0]!);
  }

  async completeScheduledJob(
    job: NightModeTransitionJob,
    completedJobId?: string | null,
  ): Promise<void> {
    const normalizedChatIds = this.normalizeChatIds([job.chatId]);
    if (normalizedChatIds.length === 0) {
      return;
    }
    const jobId =
      completedJobId?.trim() ||
      (job.recoveryOnly
        ? (() => {
            const recovery = parseNightModeTransitionRecoveryOnly(job.recoveryOnly);
            return recovery
              ? buildNightModeTransitionRecoveryJobId(normalizedChatIds[0]!, recovery)
              : null;
          })()
        : buildNightModeTransitionJobId(
            normalizedChatIds[0]!,
            job.transition,
            job.scheduledFor,
            job.sessionKey,
          ));
    if (jobId) {
      await this.deleteScheduledJobRegistryRow(normalizedChatIds[0]!, jobId);
    }
  }

  async enqueueNextTransitionsForChat(chatId: string): Promise<void> {
    const normalizedChatIds = this.normalizeChatIds([chatId]);
    if (normalizedChatIds.length === 0 || !this.queue) {
      return;
    }

    const normalizedChatId = normalizedChatIds[0]!;
    await this.runChatQueueMutationSerialized(normalizedChatId, async () => {
      if (typeof this.prisma.chat?.findUnique === 'function') {
        await this.replaceChatScheduleFromCurrentSnapshot(normalizedChatId, {
          deferActiveJobs: true,
        });
        return;
      }

      const settings = await this.findEnabledSettingsForChat(normalizedChatId);
      if (settings) {
        await this.enqueueChatSettingsOccurrences(settings.chatId, settings);
      }
    });
  }

  async reconcileChats(chatIds: readonly string[]): Promise<void> {
    const normalizedChatIds = this.normalizeChatIds(chatIds);
    if (normalizedChatIds.length === 0 || !this.queue) {
      return;
    }

    // FLAG: Each chat owns an independent durable SQL request. A busy or broken chat must not
    // prevent later chats in a bulk settings operation from reconciling immediately.
    for (const chatId of normalizedChatIds) {
      try {
        await this.reconcileChat(chatId);
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Deferred night mode transition reconciliation to its durable request',
        );
      }
    }
  }

  async reconcileChatSettings(
    chatId: string,
    settings: NightModeTransitionScheduleSettings,
  ): Promise<void> {
    if (!this.queue) {
      return;
    }

    const normalizedChatIds = this.normalizeChatIds([chatId]);
    if (normalizedChatIds.length === 0) {
      return;
    }
    const normalizedChatId = normalizedChatIds[0]!;
    await this.runChatQueueMutationSerialized(normalizedChatId, async () => {
      if (typeof this.prisma.chat?.findUnique === 'function') {
        await this.replaceChatScheduleFromCurrentSnapshot(normalizedChatId, {
          includeCurrentClose: true,
          includeCurrentOpen: true,
          strictCatchUp: false,
        });
        return;
      }

      await this.clearChatJobsForChatIds([normalizedChatId]);
      if (await this.hasActionableTransitionCandidate(normalizedChatId)) {
        await this.enqueueChatSettingsOccurrences(normalizedChatId, settings, {
          includeCurrentClose: true,
          includeCurrentOpen: true,
        });
      }
    });
  }

  async clearChatJobs(chatId: string): Promise<void> {
    const normalizedChatIds = this.normalizeChatIds([chatId]);
    if (normalizedChatIds.length === 0) {
      return;
    }
    const normalizedChatId = normalizedChatIds[0]!;
    await this.runChatQueueMutationSerialized(normalizedChatId, () =>
      this.clearChatJobsForChatIds([normalizedChatId], { strict: true }),
    );
  }

  private async enqueueChatSettingsRows(
    settingsRows: readonly (NightModeTransitionScheduleSettings & { chatId: string })[],
    options: { includeCurrentClose?: boolean; includeCurrentOpen?: boolean } = {},
  ): Promise<void> {
    if (!this.queue) {
      return;
    }

    for (const initialSettings of settingsRows) {
      try {
        await this.enqueueBootstrapChatSettings(initialSettings, options);
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: initialSettings.chatId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Deferred failed night mode bootstrap chat to its durable request',
        );
        try {
          await this.requestDurableReconcile(initialSettings.chatId);
        } catch (requestError: unknown) {
          this.logger.error(
            {
              chatId: initialSettings.chatId,
              error: requestError instanceof Error ? requestError.message : String(requestError),
            },
            'Failed to retain a durable night mode bootstrap retry',
          );
          this.requestBootstrapRetry();
        }
      }
    }
  }

  private async enqueueBootstrapChatSettings(
    initialSettings: NightModeTransitionScheduleSettings & { chatId: string },
    options: { includeCurrentClose?: boolean; includeCurrentOpen?: boolean },
  ): Promise<void> {
    await this.runChatQueueMutationSerialized(initialSettings.chatId, async () => {
      if (typeof this.prisma.chat?.findUnique !== 'function') {
        await this.enqueueChatSettingsOccurrences(initialSettings.chatId, initialSettings, options);
        return;
      }

      let snapshot = await this.readReconcileSnapshot(initialSettings.chatId);
      if (!snapshot.settings) {
        await this.clearChatJobsForChatIds([initialSettings.chatId], { strict: true });
        return;
      }
      // FLAG: A stale bootstrap row must not recreate jobs after a concurrent disable/access
      // loss. A changed snapshot clears this pass before retrying under the same per-chat lock.
      for (let pass = 1; pass <= NIGHT_MODE_TRANSITION_RECONCILE_MAX_PASSES; pass += 1) {
        const currentSettings = snapshot.settings;
        if (!currentSettings) {
          return;
        }
        const recovery = await this.ensureCloseEventRecoveryJob(currentSettings.chatId, undefined, {
          scanHistoricalLedger: false,
        });
        const occurrences = this.resolveTransitionOccurrences(currentSettings, options);
        await this.clearChatJobsForChatIds([currentSettings.chatId], {
          strict: true,
          keepJobIds: new Set([
            ...occurrences.map((occurrence) =>
              buildNightModeTransitionJobId(
                currentSettings.chatId,
                occurrence.transition,
                occurrence.dueAt.toISOString(),
                occurrence.sessionKey,
              ),
            ),
            ...(recovery.jobId ? [recovery.jobId] : []),
          ]),
        });
        await this.enqueueChatSettingsOccurrences(currentSettings.chatId, currentSettings, {
          ...options,
          skipCurrentCatchUp: recovery.blocksCurrentCatchUp,
        });
        const verified = await this.readReconcileSnapshot(initialSettings.chatId);
        if (verified.signature === snapshot.signature) {
          return;
        }

        await this.clearChatJobsForChatIds([initialSettings.chatId], { strict: true });
        if (!verified.settings) {
          return;
        }
        snapshot = verified;
      }

      throw new Error(
        `Night mode transition state did not stabilize during bootstrap (${initialSettings.chatId})`,
      );
    });
  }

  private async replaceChatScheduleFromCurrentSnapshot(
    chatId: string,
    options: {
      includeCurrentClose?: boolean;
      includeCurrentOpen?: boolean;
      strictCatchUp?: boolean;
      deferActiveJobs?: boolean;
    } = {},
  ): Promise<NightModeTransitionReconcileResult> {
    let snapshot = await this.readReconcileSnapshot(chatId);
    // FLAG: A writer that commits during queue mutation changes the verified snapshot and forces
    // another exact replacement. A later writer owns its existing post-commit reconciliation.
    for (let pass = 1; pass <= NIGHT_MODE_TRANSITION_RECONCILE_MAX_PASSES; pass += 1) {
      let enqueueResult: NightModeEnqueueOccurrencesResult | null = null;
      const recovery = await this.ensureCloseEventRecoveryJob(chatId, undefined, {
        scanHistoricalLedger: false,
      });
      if (snapshot.settings) {
        const occurrences = this.resolveTransitionOccurrences(snapshot.settings, options);
        await this.clearChatJobsForChatIds([chatId], {
          strict: true,
          throwOnActive: options.deferActiveJobs !== true,
          keepJobIds: new Set([
            ...occurrences.map((occurrence) =>
              buildNightModeTransitionJobId(
                chatId,
                occurrence.transition,
                occurrence.dueAt.toISOString(),
                occurrence.sessionKey,
              ),
            ),
            ...(recovery.jobId ? [recovery.jobId] : []),
          ]),
        });
        enqueueResult = await this.enqueueChatSettingsOccurrences(
          snapshot.settings.chatId,
          snapshot.settings,
          {
            includeCurrentClose: options.includeCurrentClose,
            includeCurrentOpen: options.includeCurrentOpen,
            strict: options.strictCatchUp ?? true,
            skipCurrentCatchUp: recovery.blocksCurrentCatchUp,
          },
        );
      } else {
        await this.clearChatJobsForChatIds([chatId], {
          strict: true,
          throwOnActive: options.deferActiveJobs !== true,
          keepJobIds: recovery.jobId ? new Set([recovery.jobId]) : undefined,
        });
      }

      const verified = await this.readReconcileSnapshot(chatId);
      if (verified.signature === snapshot.signature) {
        return {
          queueAvailable: true,
          scheduleEnabled: verified.settings !== null,
          passes: pass,
          ...(recovery.manualReview || enqueueResult?.manualReview
            ? { manualReview: recovery.manualReview ?? enqueueResult!.manualReview! }
            : {}),
        };
      }
      snapshot = verified;
    }

    throw new Error(
      `Night mode transition access state did not stabilize during reconciliation (${chatId})`,
    );
  }

  private async findEnabledSettingsForChat(
    chatId: string,
  ): Promise<(NightModeTransitionScheduleSettings & { chatId: string }) | null> {
    if (typeof this.prisma.chatSettings?.findFirst === 'function') {
      const settings = await this.prisma.chatSettings.findFirst({
        where: {
          chatId,
          nightModeEnabled: true,
          chat: this.buildActiveBotMembershipFilter(),
        },
        select: {
          chatId: true,
          nightModeEnabled: true,
          nightModeStartTimeMinutes: true,
          nightModeEndTimeMinutes: true,
          nightModeTimezone: true,
        },
      });
      return settings && (await this.hasActionableTransitionCandidate(chatId)) ? settings : null;
    }

    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      select: {
        chatId: true,
        nightModeEnabled: true,
        nightModeStartTimeMinutes: true,
        nightModeEndTimeMinutes: true,
        nightModeTimezone: true,
      },
    });
    if (!settings?.nightModeEnabled || !(await this.hasActionableTransitionCandidate(chatId))) {
      return null;
    }

    return settings;
  }

  private async readReconcileSnapshot(
    chatId: string,
  ): Promise<NightModeTransitionReconcileSnapshot> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
        settings: {
          select: {
            chatId: true,
            nightModeEnabled: true,
            nightModeStartTimeMinutes: true,
            nightModeEndTimeMinutes: true,
            nightModeTimezone: true,
          },
        },
        botMemberships: {
          select: {
            botId: true,
            status: true,
            botAccessState: true,
            permissionsSnapshot: true,
          },
          orderBy: {
            botId: 'asc',
          },
        },
      },
    });
    if (!chat) {
      return {
        signature: JSON.stringify(['missing']),
        cleanupRequired: true,
        scheduleConfigured: false,
        settings: null,
      };
    }

    const hasActionableTransitionCandidate = this.snapshotHasActionableTransitionCandidate(
      chat.botMemberships,
    );
    const scheduleConfigured =
      chat.entityType === ChatEntityType.CHAT && chat.settings?.nightModeEnabled === true;
    const settings = scheduleConfigured && hasActionableTransitionCandidate ? chat.settings : null;
    const cleanupRequired =
      chat.entityType !== ChatEntityType.CHAT ||
      (scheduleConfigured && !hasActionableTransitionCandidate);
    return {
      // FLAG: Fence only the derived queue state. Evidence refreshes that preserve effective
      // access must not trigger another destructive queue pass.
      signature: JSON.stringify([
        chat.entityType,
        scheduleConfigured,
        cleanupRequired,
        settings
          ? [
              settings.nightModeEnabled,
              settings.nightModeStartTimeMinutes,
              settings.nightModeEndTimeMinutes,
              settings.nightModeTimezone,
            ]
          : null,
        hasActionableTransitionCandidate,
      ]),
      cleanupRequired,
      scheduleConfigured,
      settings,
    };
  }

  private async hasActionableTransitionCandidate(chatId: string): Promise<boolean> {
    if (typeof this.prisma.chat?.findUnique !== 'function') {
      return true;
    }
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
        botMemberships: {
          select: {
            botId: true,
            status: true,
            botAccessState: true,
            permissionsSnapshot: true,
          },
        },
      },
    });
    if (chat?.entityType !== ChatEntityType.CHAT) {
      return false;
    }
    return this.snapshotHasActionableTransitionCandidate(chat.botMemberships);
  }

  private async filterEligibleSettingsRows<
    T extends NightModeTransitionScheduleSettings & { chatId: string },
  >(settingsRows: readonly T[]): Promise<T[]> {
    if (settingsRows.length === 0 || typeof this.prisma.chat?.findMany !== 'function') {
      return [...settingsRows];
    }

    const chats = await this.prisma.chat.findMany({
      where: {
        id: {
          in: settingsRows.map((settings) => settings.chatId),
        },
      },
      select: {
        id: true,
        entityType: true,
        botMemberships: {
          select: {
            botId: true,
            status: true,
            botAccessState: true,
            permissionsSnapshot: true,
          },
        },
      },
    });
    const eligibleChatIds = new Set(
      chats
        .filter(
          (chat) =>
            chat.entityType === ChatEntityType.CHAT &&
            this.snapshotHasActionableTransitionCandidate(chat.botMemberships),
        )
        .map((chat) => chat.id),
    );
    return settingsRows.filter((settings) => eligibleChatIds.has(settings.chatId));
  }

  private snapshotHasActionableTransitionCandidate(
    memberships: Parameters<typeof hasNightModeTransitionMembershipCandidate>[0],
  ): boolean {
    const actionableBotIds = this.getActionableBotIds();
    const actionableBotIdSet = actionableBotIds ? new Set(actionableBotIds) : null;
    return hasNightModeTransitionMembershipCandidate(memberships, {
      ...(actionableBotIdSet
        ? { isActionableBotId: (botId) => actionableBotIdSet.has(botId) }
        : {}),
    });
  }

  private getActionableBotIds(): string[] | null {
    return this.maxBotRegistry?.getActionableBots().map((bot) => bot.id) ?? null;
  }

  private buildActiveBotMembershipFilter() {
    const actionableBotIds = this.getActionableBotIds();
    return {
      entityType: ChatEntityType.CHAT,
      botMemberships: {
        some: {
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: {
            in: [...NIGHT_MODE_TRANSITION_REFRESHABLE_ACCESS_STATES],
          },
          ...(actionableBotIds
            ? {
                botId: {
                  in: actionableBotIds,
                },
              }
            : {}),
        },
      },
    };
  }

  private async enqueueChatSettingsOccurrences(
    chatId: string,
    settings: NightModeTransitionScheduleSettings,
    options: {
      includeCurrentClose?: boolean;
      includeCurrentOpen?: boolean;
      includeFuture?: boolean;
      strict?: boolean;
      reconcileFence?: NightModeTransitionReconcileFence;
      skipCurrentCatchUp?: boolean;
    } = {},
  ): Promise<NightModeEnqueueOccurrencesResult> {
    if (!this.queue) {
      return { manualReview: null };
    }

    const occurrences = this.resolveTransitionOccurrences(settings, options);
    if (occurrences.length === 0) {
      return { manualReview: null };
    }

    const nowMs = Date.now();
    const scheduleFingerprint = buildNightModeTransitionScheduleFingerprint(settings);
    let manualReview: NightModeTransitionManualReview | null = null;
    const skippedCurrentJobIds = new Set<string>();
    for (const occurrence of occurrences) {
      const scheduledFor = occurrence.dueAt.toISOString();
      const jobId = buildNightModeTransitionJobId(
        chatId,
        occurrence.transition,
        scheduledFor,
        occurrence.sessionKey,
      );
      const isCurrentCatchUp =
        occurrence.dueAt.getTime() <= nowMs &&
        ((options.includeCurrentOpen === true && occurrence.transition === 'open') ||
          (options.includeCurrentClose === true && occurrence.transition === 'close'));
      if (isCurrentCatchUp && options.skipCurrentCatchUp) {
        continue;
      }
      const catchUpResolution = isCurrentCatchUp
        ? await this.canEnqueueCurrentCatchUp(
            {
              chatId,
              jobId,
              sessionKey: occurrence.sessionKey,
              transition: occurrence.transition,
              scheduledFor,
              fingerprint: scheduleFingerprint,
            },
            { strict: options.strict, reconcileFence: options.reconcileFence },
          )
        : ({ kind: 'enqueue' } satisfies NightModeCurrentCatchUpResolution);
      if (catchUpResolution.kind === 'blocked') {
        manualReview ??= catchUpResolution.manualReview;
        continue;
      }
      if (catchUpResolution.kind === 'skip') {
        skippedCurrentJobIds.add(jobId);
        continue;
      }

      const durableReconcileRetained = await this.upsertScheduledJobRegistryIntent(
        {
          chat_id: chatId,
          job_id: jobId,
          transition: occurrence.transition,
          session_key: occurrence.sessionKey,
          scheduled_for: occurrence.dueAt,
          schedule_fingerprint: scheduleFingerprint,
          runtime_version: NIGHT_MODE_TRANSITION_RUNTIME_VERSION,
        },
        options.reconcileFence,
      );
      try {
        if (!isCurrentCatchUp) {
          await this.promoteFutureTransitionJob(jobId, scheduleFingerprint);
        }
        await this.queue.add(
          NIGHT_MODE_TRANSITION_JOB_NAME,
          {
            chatId,
            transition: occurrence.transition,
            scheduledFor,
            sessionKey: occurrence.sessionKey,
            retryPolicyName: 'night-mode-transition',
            transitionRuntimeVersion: NIGHT_MODE_TRANSITION_RUNTIME_VERSION,
            scheduleFingerprint,
            createdAt: new Date().toISOString(),
          },
          {
            jobId,
            delay: Math.max(0, occurrence.dueAt.getTime() - nowMs),
            attempts: NIGHT_MODE_TRANSITION_JOB_ATTEMPTS,
            backoff: {
              type: 'fixed',
              delay: NIGHT_MODE_TRANSITION_JOB_BACKOFF_MS,
            },
            removeOnComplete: true,
            removeOnFail: 1_000,
          },
        );
      } catch (error: unknown) {
        await this.retainDurableReconcileAfterQueueFailure(
          chatId,
          durableReconcileRetained,
          options.reconcileFence,
        );
        throw error;
      }
    }

    return {
      manualReview,
      ...(skippedCurrentJobIds.size > 0 ? { skippedCurrentJobIds } : {}),
    };
  }

  private async ensureAccessScheduleOccurrences(
    settings: NightModeTransitionScheduleSettings & { chatId: string },
    reconcileFence?: NightModeTransitionReconcileFence,
    recovery: NightModeRecoveryScheduleResult = {
      jobId: null,
      manualReview: null,
      blocksCurrentCatchUp: false,
    },
  ): Promise<NightModeAccessScheduleExpectation> {
    const queue = this.queue;
    if (!queue) {
      return {
        futureJobIds: [],
        currentCatchUp: null,
        manualReview: recovery.manualReview,
        recoveryJobId: recovery.jobId,
      };
    }

    const futureOccurrences = resolveNextNightModeTransitionOccurrences(settings);
    if (futureOccurrences.length === 0) {
      return {
        futureJobIds: [],
        currentCatchUp: null,
        manualReview: recovery.manualReview,
        recoveryJobId: recovery.jobId,
      };
    }

    const futureJobIds = futureOccurrences.map((occurrence) =>
      buildNightModeTransitionJobId(
        settings.chatId,
        occurrence.transition,
        occurrence.dueAt.toISOString(),
        occurrence.sessionKey,
      ),
    );

    const expectedJobs = await Promise.all(futureJobIds.map((jobId) => queue.getJob(jobId)));
    const futureScheduleComplete = expectedJobs.every(
      (job) =>
        Boolean(job) &&
        (job?.data === undefined ||
          job.data.transitionRuntimeVersion === NIGHT_MODE_TRANSITION_RUNTIME_VERSION),
    );
    const currentCatchUpRequired =
      recovery.blocksCurrentCatchUp ||
      ((await this.isCurrentCatchUpRequired(settings)) ?? !futureScheduleComplete);
    const currentOccurrence =
      currentCatchUpRequired && !recovery.blocksCurrentCatchUp
        ? (resolveCurrentNightModeCloseOccurrence(settings) ??
          resolveCurrentNightModeOpenOccurrence(settings))
        : null;
    const currentCatchUp = currentOccurrence
      ? {
          jobId: buildNightModeTransitionJobId(
            settings.chatId,
            currentOccurrence.transition,
            currentOccurrence.dueAt.toISOString(),
            currentOccurrence.sessionKey,
          ),
          sessionKey: currentOccurrence.sessionKey,
          transition: currentOccurrence.transition,
        }
      : null;
    await this.clearChatJobsForChatIds([settings.chatId], {
      strict: true,
      keepJobIds: new Set([
        ...futureJobIds,
        ...(currentCatchUp ? [currentCatchUp.jobId] : []),
        ...(recovery.jobId ? [recovery.jobId] : []),
      ]),
      reconcileFence,
    });
    if (futureScheduleComplete && !currentCatchUpRequired) {
      return {
        futureJobIds,
        currentCatchUp,
        manualReview: recovery.manualReview,
        recoveryJobId: recovery.jobId,
      };
    }

    const enqueueResult = await this.enqueueChatSettingsOccurrences(settings.chatId, settings, {
      includeCurrentClose: currentCatchUpRequired,
      includeCurrentOpen: currentCatchUpRequired,
      includeFuture: !futureScheduleComplete,
      strict: true,
      reconcileFence,
      skipCurrentCatchUp: recovery.blocksCurrentCatchUp,
    });
    return {
      futureJobIds,
      currentCatchUp:
        currentCatchUp && enqueueResult.skippedCurrentJobIds?.has(currentCatchUp.jobId)
          ? null
          : currentCatchUp,
      manualReview: recovery.manualReview ?? enqueueResult.manualReview,
      recoveryJobId: recovery.jobId,
    };
  }

  private async verifyAccessScheduleExpectation(
    settings: NightModeTransitionScheduleSettings & { chatId: string },
    expectation: NightModeAccessScheduleExpectation,
  ): Promise<void> {
    const queue = this.queue;
    if (!queue) {
      throw new Error('Night mode transition queue disappeared during durable access repair');
    }

    const futureJobs = await Promise.all(
      expectation.futureJobIds.map((jobId) => queue.getJob(jobId)),
    );
    for (const [index, jobId] of expectation.futureJobIds.entries()) {
      const job = futureJobs[index];
      if (!job) {
        throw new Error(
          `Night mode transition future job disappeared during durable repair (${jobId})`,
        );
      }
      if (typeof job.getState === 'function' && (await job.getState()) === 'failed') {
        throw new Error(
          `Night mode transition future job is failed during durable repair (${jobId})`,
        );
      }
    }

    if (!expectation.currentCatchUp || expectation.manualReview) {
      return;
    }

    const currentJob = await queue.getJob(expectation.currentCatchUp.jobId);
    if (currentJob) {
      if (typeof currentJob.getState === 'function') {
        const currentState = await currentJob.getState();
        if (currentState === 'failed') {
          throw new Error(
            `Night mode transition catch-up failed during durable repair (${expectation.currentCatchUp.jobId})`,
          );
        }
        if (currentState === 'active') {
          throw new Error(
            `Night mode transition catch-up is still active during durable repair (${expectation.currentCatchUp.jobId})`,
          );
        }
      }
      return;
    }

    if ((await this.isCurrentCatchUpRequired(settings)) === false) {
      return;
    }
    throw new Error(
      `Night mode transition catch-up disappeared before state repair (${expectation.currentCatchUp.jobId})`,
    );
  }

  private async isCurrentCatchUpRequired(
    settings: NightModeTransitionScheduleSettings & { chatId: string },
  ): Promise<boolean | null> {
    const currentOccurrence =
      resolveCurrentNightModeCloseOccurrence(settings) ??
      resolveCurrentNightModeOpenOccurrence(settings);
    if (!currentOccurrence) {
      return false;
    }
    const occurrenceIdentity = {
      chatId: settings.chatId,
      jobId: buildNightModeTransitionJobId(
        settings.chatId,
        currentOccurrence.transition,
        currentOccurrence.dueAt.toISOString(),
        currentOccurrence.sessionKey,
      ),
      sessionKey: currentOccurrence.sessionKey,
      fingerprint: buildNightModeTransitionScheduleFingerprint(settings),
    };
    const manualDisposition = await this.findExactManualReviewDisposition(occurrenceIdentity);
    if (manualDisposition.kind === 'blocked') {
      return true;
    }
    if (manualDisposition.kind === 'acknowledged') {
      return true;
    }

    const state = await this.readNightModeTransitionState(settings.chatId);
    if (!this.redisCounter) {
      return null;
    }
    const expectedStatus = currentOccurrence.transition === 'close' ? 'closed' : 'open';
    const closeNoticeRecoveryPending =
      currentOccurrence.transition === 'close' && state?.closeNoticeEventRecovery?.pending === true;
    return (
      closeNoticeRecoveryPending ||
      state?.status !== expectedStatus ||
      state.sessionKey !== currentOccurrence.sessionKey
    );
  }

  private async readNightModeTransitionState(
    chatId: string,
  ): Promise<ReturnType<typeof parseNightModeTransitionState>> {
    if (!this.redisCounter || typeof this.redisCounter.getString !== 'function') {
      return null;
    }
    const rawState = await this.redisCounter.getString(buildNightModeTransitionStateKey(chatId));
    let state: ReturnType<typeof parseNightModeTransitionState> = null;
    if (rawState) {
      try {
        state = parseNightModeTransitionState(JSON.parse(rawState) as unknown);
      } catch {
        state = null;
      }
    }
    return state;
  }

  private async findExactManualReviewDisposition(params: {
    chatId: string;
    jobId: string;
    sessionKey: string;
    fingerprint: string;
    category?: NightModeTransitionManualBlockCategory;
  }): Promise<NightModeManualReviewDisposition> {
    if (typeof this.prisma.nightModeTransitionReconcileRequest?.findUnique !== 'function') {
      return { kind: 'none' };
    }
    const row = await this.prisma.nightModeTransitionReconcileRequest.findUnique({
      where: { chatId: params.chatId },
      select: {
        manualBlockedAt: true,
        manualBlockedReason: true,
        manualBlockedCategory: true,
        manualBlockedJobId: true,
        manualBlockedLedgerJobId: true,
        manualBlockedSessionKey: true,
        manualBlockedFingerprint: true,
        manualAcknowledgedAt: true,
      },
    });
    if (
      !row?.manualBlockedAt ||
      !this.isManualBlockCategory(row.manualBlockedCategory) ||
      row.manualBlockedJobId !== params.jobId ||
      row.manualBlockedSessionKey !== params.sessionKey ||
      row.manualBlockedFingerprint !== params.fingerprint ||
      (params.category !== undefined && row.manualBlockedCategory !== params.category)
    ) {
      return { kind: 'none' };
    }
    if (row.manualAcknowledgedAt) {
      return { kind: 'acknowledged', category: row.manualBlockedCategory };
    }
    return {
      kind: 'blocked',
      manualReview: {
        category: row.manualBlockedCategory,
        reason:
          row.manualBlockedReason ?? `Night mode catch-up is manually blocked (${params.jobId})`,
        jobId: row.manualBlockedJobId,
        ledgerJobId: row.manualBlockedLedgerJobId,
        sessionKey: row.manualBlockedSessionKey,
        fingerprint: row.manualBlockedFingerprint,
      },
    };
  }

  private isManualBlockCategory(
    value: string | null,
  ): value is NightModeTransitionManualBlockCategory {
    return (
      value === 'unsafe_prior_dispatch' ||
      value === 'unsafe_prior_provenance' ||
      value === 'no_fresh_access' ||
      value === 'failed_job_unclassified'
    );
  }

  private async ensureCloseEventRecoveryJob(
    chatId: string,
    reconcileFence?: NightModeTransitionReconcileFence,
    options: { scanHistoricalLedger?: boolean } = {},
  ): Promise<NightModeRecoveryScheduleResult> {
    const resolution = await this.resolveChatCloseEventRecovery(chatId, options);
    if (resolution.kind === 'none' || resolution.kind === 'already_complete') {
      return { jobId: null, manualReview: null, blocksCurrentCatchUp: false };
    }
    if (resolution.kind === 'blocked') {
      const disposition = await this.findExactManualReviewDisposition({
        chatId,
        jobId: resolution.manualReview.jobId,
        sessionKey: resolution.manualReview.sessionKey,
        fingerprint: resolution.manualReview.fingerprint,
        category: resolution.manualReview.category,
      });
      if (disposition.kind === 'acknowledged') {
        return { jobId: null, manualReview: null, blocksCurrentCatchUp: false };
      }
      return {
        jobId: null,
        manualReview:
          disposition.kind === 'blocked' ? disposition.manualReview : resolution.manualReview,
        blocksCurrentCatchUp: true,
      };
    }
    if (!this.queue) {
      return { jobId: null, manualReview: null, blocksCurrentCatchUp: true };
    }

    const recovery = resolution.recovery;
    const jobId = buildNightModeTransitionRecoveryJobId(chatId, recovery);
    const fingerprint = this.buildRecoveryScheduleFingerprint(
      recovery.timezone,
      recovery.startMinutes,
      recovery.endMinutes,
    );
    const manualDisposition = await this.findExactManualReviewDisposition({
      chatId,
      jobId,
      sessionKey: recovery.sessionKey,
      fingerprint,
    });
    if (manualDisposition.kind === 'acknowledged') {
      return { jobId: null, manualReview: null, blocksCurrentCatchUp: false };
    }
    if (manualDisposition.kind === 'blocked') {
      return {
        jobId: null,
        manualReview: manualDisposition.manualReview,
        blocksCurrentCatchUp: true,
      };
    }
    const closeAt = resolveNightModeTransitionSessionCloseAt(recovery.sessionKey);
    if (!closeAt) {
      const blocked = this.blockRecovery(
        chatId,
        jobId,
        recovery.sessionKey,
        fingerprint,
        'Night mode recovery envelope has no canonical close time',
      );
      return {
        jobId: null,
        manualReview: blocked.manualReview,
        blocksCurrentCatchUp: true,
      };
    }

    const existing = await this.queue.getJob(jobId);
    if (existing && typeof existing.getState === 'function') {
      const state = await existing.getState();
      const existingRecovery = parseNightModeTransitionRecoveryOnly(existing.data.recoveryOnly);
      if (
        state !== 'failed' &&
        existingRecovery &&
        JSON.stringify(existingRecovery) === JSON.stringify(recovery)
      ) {
        return { jobId, manualReview: null, blocksCurrentCatchUp: true };
      }
      if (state === 'active') {
        throw new NightModeTransitionJobsActiveError([jobId]);
      }
      await existing.remove();
      await this.deleteScheduledJobRegistryRow(chatId, jobId);
    }

    await this.upsertScheduledJobRegistryIntent(
      {
        chat_id: chatId,
        job_id: jobId,
        transition: 'close',
        session_key: recovery.sessionKey,
        scheduled_for: closeAt,
        schedule_fingerprint: fingerprint,
        runtime_version: NIGHT_MODE_TRANSITION_RUNTIME_VERSION,
      },
      reconcileFence,
    );
    await this.queue.add(
      NIGHT_MODE_TRANSITION_JOB_NAME,
      {
        chatId,
        transition: 'close',
        scheduledFor: closeAt.toISOString(),
        sessionKey: recovery.sessionKey,
        retryPolicyName: 'night-mode-transition',
        transitionRuntimeVersion: NIGHT_MODE_TRANSITION_RUNTIME_VERSION,
        scheduleFingerprint: fingerprint,
        recoveryOnly: recovery,
        createdAt: new Date().toISOString(),
      },
      {
        jobId,
        attempts: NIGHT_MODE_TRANSITION_JOB_ATTEMPTS,
        backoff: { type: 'fixed', delay: NIGHT_MODE_TRANSITION_JOB_BACKOFF_MS },
        removeOnComplete: true,
        removeOnFail: 1_000,
      },
    );
    return { jobId, manualReview: null, blocksCurrentCatchUp: true };
  }

  private async resolveChatCloseEventRecovery(
    chatId: string,
    options: { scanHistoricalLedger?: boolean } = {},
  ): Promise<NightModeCloseRecoveryResolution> {
    let selectedNeeded: Extract<NightModeCloseRecoveryResolution, { kind: 'needed' }> | null = null;
    let selectedBlocked: Extract<NightModeCloseRecoveryResolution, { kind: 'blocked' }> | null =
      null;
    const seenSessions = new Set<string>();
    const consider = async (resolution: NightModeCloseRecoveryResolution): Promise<void> => {
      if (resolution.kind === 'needed') {
        if (
          !selectedNeeded ||
          this.compareRecoverySessions(
            resolution.recovery.sessionKey,
            selectedNeeded.recovery.sessionKey,
          ) > 0
        ) {
          selectedNeeded = resolution;
        }
        return;
      }
      if (resolution.kind !== 'blocked') {
        return;
      }
      const disposition = await this.findExactManualReviewDisposition({
        chatId,
        jobId: resolution.manualReview.jobId,
        sessionKey: resolution.manualReview.sessionKey,
        fingerprint: resolution.manualReview.fingerprint,
        category: resolution.manualReview.category,
      });
      if (disposition.kind === 'acknowledged') {
        return;
      }
      const candidate =
        disposition.kind === 'blocked'
          ? { kind: 'blocked' as const, manualReview: disposition.manualReview }
          : resolution;
      if (
        !selectedBlocked ||
        this.compareRecoverySessions(
          candidate.manualReview.sessionKey,
          selectedBlocked.manualReview.sessionKey,
        ) > 0
      ) {
        selectedBlocked = candidate;
      }
    };

    const state = await this.readNightModeTransitionState(chatId);
    const marker = state?.closeNoticeEventRecovery;
    if (state && marker?.pending === true) {
      const parsed = parseNightModeTransitionSessionKey(state.sessionKey);
      const messageId = state.closeNoticeMessageId?.trim() ?? '';
      const botId = state.closeNoticeBotId?.trim() ?? '';
      const fingerprint = parsed
        ? this.buildRecoveryScheduleFingerprint(
            parsed.timezone,
            parsed.startMinutes,
            parsed.endMinutes,
          )
        : `sha256:${'0'.repeat(64)}`;
      const fallbackJobId = buildNightModeTransitionJobId(
        chatId,
        'close',
        resolveNightModeTransitionSessionCloseAt(state.sessionKey)?.toISOString() ??
          state.sessionKey,
        state.sessionKey,
      );
      if (
        state.status !== 'closed' ||
        marker.version !== 2 ||
        !parsed ||
        marker.timezone !== parsed.timezone ||
        marker.startMinutes !== parsed.startMinutes ||
        marker.endMinutes !== parsed.endMinutes ||
        !messageId ||
        !botId
      ) {
        await consider(
          this.blockRecovery(
            chatId,
            fallbackJobId,
            state.sessionKey,
            fingerprint,
            'Night mode close-event recovery marker has no immutable original envelope',
          ),
        );
      } else {
        const resolution = await this.inspectRecoveryCandidate(
          chatId,
          {
            kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
            version: 1,
            sessionKey: state.sessionKey,
            messageId,
            botId,
            timezone: parsed.timezone,
            startMinutes: parsed.startMinutes,
            endMinutes: parsed.endMinutes,
          },
          true,
          fallbackJobId,
          fingerprint,
        );
        await consider(
          resolution.kind === 'already_complete'
            ? { kind: 'needed', recovery: resolution.recovery }
            : resolution,
        );
      }
      seenSessions.add(state.sessionKey);
    }

    if (state && !seenSessions.has(state.sessionKey)) {
      const parsed = parseNightModeTransitionSessionKey(state.sessionKey);
      const closeAt = resolveNightModeTransitionSessionCloseAt(state.sessionKey);
      if (parsed && closeAt) {
        const stateResolution = await this.inspectMarkerlessRegistryRecovery(chatId, {
          chat_id: chatId,
          job_id: buildNightModeTransitionJobId(
            chatId,
            'close',
            closeAt.toISOString(),
            state.sessionKey,
          ),
          transition: 'close',
          session_key: state.sessionKey,
          scheduled_for: closeAt,
          schedule_fingerprint: this.buildRecoveryScheduleFingerprint(
            parsed.timezone,
            parsed.startMinutes,
            parsed.endMinutes,
          ),
        });
        await consider(stateResolution);
        seenSessions.add(state.sessionKey);
      }
    }

    if (options.scanHistoricalLedger !== false) {
      await this.scanCompletedCloseLedgerRecoveries(chatId, seenSessions, consider);
    }

    const rows = (await this.listScheduledJobRegistryRows([chatId])).filter(
      (row) => row.scheduled_for.getTime() <= Date.now(),
    );
    for (const row of rows) {
      if (seenSessions.has(row.session_key)) {
        continue;
      }
      seenSessions.add(row.session_key);
      await consider(await this.inspectMarkerlessRegistryRecovery(chatId, row));
    }
    return selectedNeeded ?? selectedBlocked ?? { kind: 'none' };
  }

  private async scanCompletedCloseLedgerRecoveries(
    chatId: string,
    seenSessions: Set<string>,
    consider: (resolution: NightModeCloseRecoveryResolution) => Promise<void>,
  ): Promise<void> {
    if (typeof this.prisma.maxActionLedgerEntry?.findMany !== 'function') {
      return;
    }
    const jobIdPrefix = buildNightModeNoticeIdempotencyKey('close', chatId, '');
    let cursor: { completedAt: Date; id: string } | null = null;
    while (true) {
      const page = await this.listMissingCloseEventLedgerPage(chatId, jobIdPrefix, cursor);
      for (const row of page) {
        const ledger: NightModeCloseLedgerRow & { id: string; jobId: string } = {
          ...row,
          actionType: 'SEND_MESSAGE',
          chatId,
          sourceTag: NIGHT_MODE_TRANSITION_SOURCE_TAG,
          status: MaxActionLedgerStatus.SUCCEEDED,
          ambiguous: false,
          terminal: true,
        };
        if (!ledger.jobId.startsWith(jobIdPrefix)) {
          continue;
        }
        const sessionKey = ledger.jobId.slice(jobIdPrefix.length);
        if (
          !sessionKey ||
          seenSessions.has(sessionKey) ||
          ledger.jobId !== buildNightModeNoticeIdempotencyKey('close', chatId, sessionKey)
        ) {
          continue;
        }
        seenSessions.add(sessionKey);
        const parsed = parseNightModeTransitionSessionKey(sessionKey);
        const closeAt = resolveNightModeTransitionSessionCloseAt(sessionKey);
        const messageId = ledger.remoteMessageId?.trim() ?? '';
        const botId = ledger.dispatchBotId?.trim() ?? '';
        if (!parsed || !closeAt) {
          continue;
        }
        const fingerprint = this.buildRecoveryScheduleFingerprint(
          parsed.timezone,
          parsed.startMinutes,
          parsed.endMinutes,
        );
        const fallbackJobId = buildNightModeTransitionJobId(
          chatId,
          'close',
          closeAt.toISOString(),
          sessionKey,
        );
        if (this.hasNoAcceptedCloseDispatch(ledger, chatId)) {
          continue;
        }
        if (!this.isExactCompletedCloseLedger(ledger, chatId) || !messageId || !botId) {
          continue;
        }
        const resolution = await this.inspectRecoveryCandidate(
          chatId,
          {
            kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
            version: 1,
            sessionKey,
            messageId,
            botId,
            timezone: parsed.timezone,
            startMinutes: parsed.startMinutes,
            endMinutes: parsed.endMinutes,
          },
          false,
          fallbackJobId,
          fingerprint,
          ledger,
        );
        await consider(resolution);
        if (resolution.kind === 'needed') {
          return;
        }
      }
      if (page.length < NIGHT_MODE_RECOVERY_LEDGER_PAGE_SIZE) {
        return;
      }
      const lastRow = page[page.length - 1]!;
      cursor = { completedAt: lastRow.completedAt, id: lastRow.id };
    }
  }

  private async listMissingCloseEventLedgerPage(
    chatId: string,
    jobIdPrefix: string,
    cursor: { completedAt: Date; id: string } | null,
  ): Promise<NightModeCompletedCloseLedgerRecoveryRow[]> {
    if (typeof this.prisma.$queryRaw === 'function') {
      const cursorPredicate = cursor
        ? Prisma.sql`
            AND (ledger."completed_at", ledger."id") < (${cursor.completedAt}, ${cursor.id})
          `
        : Prisma.empty;
      return this.prisma.$queryRaw<NightModeCompletedCloseLedgerRecoveryRow[]>(Prisma.sql`
        SELECT
          ledger."id",
          ledger."job_id" AS "jobId",
          ledger."completed_at" AS "completedAt",
          ledger."dispatch_bot_id" AS "dispatchBotId",
          ledger."remote_message_id" AS "remoteMessageId"
        FROM "max_action_ledger" ledger
        WHERE ledger."chat_id" = ${chatId}
          AND ledger."terminal" = true
          AND ledger."completed_at" IS NOT NULL
          AND ledger."status" = 'SUCCEEDED'
          AND ledger."ambiguous" = false
          AND ledger."action_type" = 'SEND_MESSAGE'
          AND ledger."source_tag" = 'night_mode_transition'
          AND ledger."remote_message_id" IS NOT NULL
          AND BTRIM(ledger."remote_message_id") <> ''
          AND ledger."dispatch_bot_id" IS NOT NULL
          AND BTRIM(ledger."dispatch_bot_id") <> ''
          AND ledger."job_id" LIKE 'night-mode:close:%'
          AND LEFT(ledger."job_id", CHAR_LENGTH(${jobIdPrefix})) = ${jobIdPrefix}
          AND NOT EXISTS (
            SELECT 1
            FROM "moderation_events" event
            WHERE event."chat_id" = ledger."chat_id"
              AND event."message_id" = ledger."remote_message_id"
              AND event."bot_id" = ledger."dispatch_bot_id"
              AND event."rule_code" = 'NIGHT_MODE_CLOSE_NOTICE'
              AND event."metadata" ->> 'sessionKey' = SUBSTRING(
                ledger."job_id" FROM CHAR_LENGTH(${jobIdPrefix}) + 1
              )
          )
          ${cursorPredicate}
        ORDER BY ledger."completed_at" DESC, ledger."id" DESC
        LIMIT ${NIGHT_MODE_RECOVERY_LEDGER_PAGE_SIZE}
      `);
    }

    return (await this.prisma.maxActionLedgerEntry.findMany({
      where: {
        chatId,
        actionType: 'SEND_MESSAGE',
        sourceTag: NIGHT_MODE_TRANSITION_SOURCE_TAG,
        jobId: { startsWith: jobIdPrefix },
        status: MaxActionLedgerStatus.SUCCEEDED,
        ambiguous: false,
        terminal: true,
        completedAt: { not: null },
        dispatchBotId: { not: null },
        remoteMessageId: { not: null },
      },
      select: {
        id: true,
        jobId: true,
        completedAt: true,
        dispatchBotId: true,
        remoteMessageId: true,
      },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: NIGHT_MODE_RECOVERY_LEDGER_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
    })) as NightModeCompletedCloseLedgerRecoveryRow[];
  }

  private compareRecoverySessions(leftSessionKey: string, rightSessionKey: string): number {
    const leftAt = resolveNightModeTransitionSessionCloseAt(leftSessionKey)?.getTime();
    const rightAt = resolveNightModeTransitionSessionCloseAt(rightSessionKey)?.getTime();
    return (leftAt ?? Number.NEGATIVE_INFINITY) - (rightAt ?? Number.NEGATIVE_INFINITY);
  }

  private async inspectMarkerlessRegistryRecovery(
    chatId: string,
    row: NightModeScheduledJobRegistryRow,
  ): Promise<NightModeCloseRecoveryResolution> {
    const ledger = await this.readCloseLedger(chatId, row.session_key);
    if (!ledger || this.hasNoAcceptedCloseDispatch(ledger, chatId)) {
      return { kind: 'none' };
    }
    const parsed = parseNightModeTransitionSessionKey(row.session_key);
    const messageId = ledger.remoteMessageId?.trim() ?? '';
    const botId = ledger.dispatchBotId?.trim() ?? '';
    if (!parsed || !this.isExactCompletedCloseLedger(ledger, chatId) || !messageId || !botId) {
      return this.blockRecovery(
        chatId,
        row.job_id,
        row.session_key,
        row.schedule_fingerprint,
        'Markerless night mode close recovery has unsafe ledger or session metadata',
      );
    }
    return this.inspectRecoveryCandidate(
      chatId,
      {
        kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
        version: 1,
        sessionKey: row.session_key,
        messageId,
        botId,
        timezone: parsed.timezone,
        startMinutes: parsed.startMinutes,
        endMinutes: parsed.endMinutes,
      },
      false,
      row.job_id,
      row.schedule_fingerprint,
      ledger,
    );
  }

  private async inspectRecoveryCandidate(
    chatId: string,
    recovery: NightModeTransitionRecoveryOnly,
    missingIsBlocked: boolean,
    fallbackJobId: string,
    fingerprint: string,
    knownLedger?: NightModeCloseLedgerRow,
  ): Promise<NightModeCloseRecoveryResolution> {
    const ledger = knownLedger ?? (await this.readCloseLedger(chatId, recovery.sessionKey));
    if (!ledger) {
      return missingIsBlocked
        ? this.blockRecovery(
            chatId,
            fallbackJobId,
            recovery.sessionKey,
            fingerprint,
            'Night mode close-event recovery ledger proof is missing',
          )
        : { kind: 'none' };
    }
    if (this.hasNoAcceptedCloseDispatch(ledger, chatId)) {
      return { kind: 'none' };
    }
    if (
      !this.isExactCompletedCloseLedger(ledger, chatId) ||
      ledger.remoteMessageId?.trim() !== recovery.messageId ||
      ledger.dispatchBotId?.trim() !== recovery.botId
    ) {
      return this.blockRecovery(
        chatId,
        fallbackJobId,
        recovery.sessionKey,
        fingerprint,
        'Night mode close-event recovery ledger proof is unsafe',
      );
    }
    const preflight = await this.inspectRecoveryEnvelope(chatId, recovery, ledger);
    return preflight === 'already_complete'
      ? { kind: 'already_complete', recovery }
      : preflight === 'needed'
        ? { kind: 'needed', recovery }
        : this.blockRecovery(
            chatId,
            fallbackJobId,
            recovery.sessionKey,
            fingerprint,
            'Night mode close-event recovery event proof is unavailable',
          );
  }

  private async inspectRecoveryEnvelope(
    chatId: string,
    recovery: NightModeTransitionRecoveryOnly,
    knownLedger?: NightModeCloseLedgerRow,
  ): Promise<NightModeRecoveryOnlyPreflight> {
    const ledger = knownLedger ?? (await this.readCloseLedger(chatId, recovery.sessionKey));
    if (
      !ledger ||
      !this.isExactCompletedCloseLedger(ledger, chatId) ||
      ledger.remoteMessageId?.trim() !== recovery.messageId ||
      ledger.dispatchBotId?.trim() !== recovery.botId ||
      typeof this.prisma.moderationEvent?.findFirst !== 'function'
    ) {
      return 'unsafe';
    }
    const event = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        messageId: recovery.messageId,
        botId: recovery.botId,
        ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
        metadata: {
          path: ['sessionKey'],
          equals: recovery.sessionKey,
        } satisfies Prisma.JsonFilter,
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    return event ? 'already_complete' : 'needed';
  }

  private async readCloseLedger(
    chatId: string,
    sessionKey: string,
  ): Promise<NightModeCloseLedgerRow | null> {
    if (typeof this.prisma.maxActionLedgerEntry?.findUnique !== 'function') {
      return null;
    }
    return this.prisma.maxActionLedgerEntry.findUnique({
      where: { jobId: buildNightModeNoticeIdempotencyKey('close', chatId, sessionKey) },
      select: {
        actionType: true,
        chatId: true,
        sourceTag: true,
        status: true,
        ambiguous: true,
        terminal: true,
        completedAt: true,
        dispatchToken: true,
        dispatchStartedAt: true,
        dispatchBotId: true,
        remoteMessageId: true,
      },
    }) as Promise<NightModeCloseLedgerRow | null>;
  }

  private isExactCompletedCloseLedger(ledger: NightModeCloseLedgerRow, chatId: string): boolean {
    return (
      ledger.actionType === 'SEND_MESSAGE' &&
      ledger.chatId === chatId &&
      ledger.sourceTag === NIGHT_MODE_TRANSITION_SOURCE_TAG &&
      ledger.status === MaxActionLedgerStatus.SUCCEEDED &&
      !ledger.ambiguous &&
      ledger.terminal &&
      ledger.completedAt instanceof Date &&
      Number.isFinite(ledger.completedAt.getTime())
    );
  }

  private hasNoAcceptedCloseDispatch(ledger: NightModeCloseLedgerRow, chatId: string): boolean {
    return (
      ledger.actionType === 'SEND_MESSAGE' &&
      ledger.chatId === chatId &&
      ledger.sourceTag === NIGHT_MODE_TRANSITION_SOURCE_TAG &&
      !ledger.ambiguous &&
      !ledger.dispatchToken &&
      !ledger.dispatchStartedAt &&
      !ledger.dispatchBotId &&
      !ledger.remoteMessageId
    );
  }

  private blockRecovery(
    chatId: string,
    jobId: string,
    sessionKey: string,
    fingerprint: string,
    reason: string,
  ): Extract<NightModeCloseRecoveryResolution, { kind: 'blocked' }> {
    return {
      kind: 'blocked',
      manualReview: {
        category: 'unsafe_prior_provenance',
        reason: `${reason} (${jobId})`,
        jobId,
        ledgerJobId: buildNightModeNoticeIdempotencyKey('close', chatId, sessionKey),
        sessionKey,
        fingerprint,
      },
    };
  }

  private buildRecoveryScheduleFingerprint(
    timezone: string,
    startMinutes: number,
    endMinutes: number,
  ): string {
    return buildNightModeTransitionScheduleFingerprint({
      nightModeEnabled: true,
      nightModeStartTimeMinutes: startMinutes,
      nightModeEndTimeMinutes: endMinutes,
      nightModeTimezone: timezone,
    });
  }

  private async resolveMissingBullCatchUp(
    params: {
      chatId: string;
      jobId: string;
      sessionKey: string;
      transition: NightModeTransitionOccurrence['transition'];
      fingerprint: string;
    },
    options: { durableRegistryProof: boolean },
  ): Promise<NightModeCurrentCatchUpResolution> {
    if (typeof this.prisma.maxActionLedgerEntry?.findUnique !== 'function') {
      if (!options.durableRegistryProof) {
        return { kind: 'skip' };
      }
      return {
        kind: 'blocked',
        manualReview: {
          category: 'failed_job_unclassified',
          reason: `Night mode catch-up ledger is unavailable (${params.jobId})`,
          jobId: params.jobId,
          ledgerJobId: null,
          sessionKey: params.sessionKey,
          fingerprint: params.fingerprint,
        },
      };
    }
    const ledgerJobId = buildNightModeNoticeIdempotencyKey(
      params.transition,
      params.chatId,
      params.sessionKey,
    );
    const ledger = await this.prisma.maxActionLedgerEntry.findUnique({
      where: { jobId: ledgerJobId },
      select: {
        actionType: true,
        chatId: true,
        sourceTag: true,
        status: true,
        ambiguous: true,
        terminal: true,
        attemptCount: true,
        completedAt: true,
        lastError: true,
        dispatchToken: true,
        dispatchStartedAt: true,
        dispatchBotId: true,
        remoteMessageId: true,
      },
    });
    if (!ledger) {
      return options.durableRegistryProof ? { kind: 'enqueue' } : { kind: 'skip' };
    }
    const accessRecoveryMarker = getNightModeTransitionAccessRecoveryMarker(params.transition);
    const exactIdentity =
      ledger.actionType === 'SEND_MESSAGE' &&
      ledger.chatId === params.chatId &&
      ledger.sourceTag === NIGHT_MODE_TRANSITION_SOURCE_TAG;
    const noDispatchFence =
      !ledger.ambiguous &&
      !ledger.dispatchToken &&
      !ledger.dispatchStartedAt &&
      !ledger.dispatchBotId;
    if (
      exactIdentity &&
      ledger.status === MaxActionLedgerStatus.SUCCEEDED &&
      ledger.terminal &&
      !ledger.ambiguous &&
      ledger.completedAt instanceof Date &&
      Boolean(ledger.remoteMessageId?.trim()) &&
      Boolean(ledger.dispatchBotId?.trim())
    ) {
      return options.durableRegistryProof ? { kind: 'enqueue' } : { kind: 'skip' };
    }
    if (
      options.durableRegistryProof &&
      exactIdentity &&
      noDispatchFence &&
      !ledger.remoteMessageId &&
      (ledger.status === MaxActionLedgerStatus.ENQUEUED ||
        ledger.status === MaxActionLedgerStatus.IN_PROGRESS ||
        ledger.status === MaxActionLedgerStatus.FAILED_RETRYABLE) &&
      !ledger.terminal &&
      ledger.completedAt === null &&
      ledger.lastError !== accessRecoveryMarker
    ) {
      return { kind: 'enqueue' };
    }
    const potentiallyRecoverable =
      exactIdentity &&
      noDispatchFence &&
      !ledger.remoteMessageId &&
      ((ledger.status === MaxActionLedgerStatus.FAILED_TERMINAL && ledger.terminal) ||
        (ledger.status === MaxActionLedgerStatus.ENQUEUED &&
          !ledger.terminal &&
          ledger.attemptCount === 0 &&
          ledger.lastError === accessRecoveryMarker));
    if (potentiallyRecoverable) {
      const recovery = await prepareDefinitivelyRejectedNightModeTransitionRetry(this.prisma, {
        chatId: params.chatId,
        sessionKey: params.sessionKey,
        transition: params.transition,
        actionableBotIds: this.getActionableBotIds(),
      });
      if (recovery.kind === 'ready') {
        return { kind: 'enqueue' };
      }
      return {
        kind: 'blocked',
        manualReview: {
          category: recovery.category,
          reason: `Night mode catch-up cannot safely recover terminal ledger state (${recovery.jobId})`,
          jobId: params.jobId,
          ledgerJobId: recovery.jobId,
          sessionKey: params.sessionKey,
          fingerprint: params.fingerprint,
        },
      };
    }
    return {
      kind: 'blocked',
      manualReview: {
        category: 'unsafe_prior_provenance',
        reason: `Night mode catch-up has durable send provenance without a Bull job (${params.jobId})`,
        jobId: params.jobId,
        ledgerJobId,
        sessionKey: params.sessionKey,
        fingerprint: params.fingerprint,
      },
    };
  }

  private async canEnqueueCurrentCatchUp(
    params: {
      chatId: string;
      jobId: string;
      sessionKey: string;
      transition: NightModeTransitionOccurrence['transition'];
      scheduledFor: string;
      fingerprint: string;
    },
    options: {
      strict?: boolean;
      ignoreManualReview?: boolean;
      reconcileFence?: NightModeTransitionReconcileFence;
    } = {},
  ): Promise<NightModeCurrentCatchUpResolution> {
    try {
      if (!options.ignoreManualReview) {
        const manualDisposition = await this.findExactManualReviewDisposition(params);
        if (manualDisposition.kind === 'acknowledged') {
          const currentResolution = await this.canEnqueueCurrentCatchUp(params, {
            ...options,
            ignoreManualReview: true,
          });
          if (
            currentResolution.kind === 'blocked' &&
            currentResolution.manualReview.category !== manualDisposition.category
          ) {
            return currentResolution;
          }
          return { kind: 'skip' };
        }
        if (manualDisposition.kind === 'blocked') {
          return { kind: 'blocked', manualReview: manualDisposition.manualReview };
        }
      }
      if (!this.queue || typeof this.queue.getJob !== 'function') {
        await this.deleteScheduledJobRegistryRow(params.chatId, params.jobId);
        return { kind: 'skip' };
      }
      const existing = await this.queue.getJob(params.jobId);
      if (!existing) {
        const registry = await this.findScheduledJobRegistryRow(params.chatId, params.jobId);
        if (!registry) {
          return this.resolveMissingBullCatchUp(params, { durableRegistryProof: false });
        }
        const currentRuntimeRegistry =
          registry?.runtime_version === NIGHT_MODE_TRANSITION_RUNTIME_VERSION ||
          Boolean(registry && registry.scheduled_for.getTime() >= this.runtimeStartedAtMs);
        if (!currentRuntimeRegistry) {
          if (registry) {
            await this.deleteScheduledJobRegistryRow(params.chatId, params.jobId);
          }
          return { kind: 'skip' };
        }
        return this.resolveMissingBullCatchUp(params, { durableRegistryProof: true });
      }
      let transitionRuntimeVersion = existing.data?.transitionRuntimeVersion;
      const registry = await this.findScheduledJobRegistryRow(params.chatId, params.jobId);
      const failedUnderCurrentV4Runtime =
        this.isExactCurrentV4BullEnvelope(existing.data, params) &&
        this.isExactCurrentV4Registry(registry, params);
      const existingState =
        typeof existing.getState === 'function' ? await existing.getState() : null;
      const currentRuntimeJob =
        existing.data === undefined ||
        transitionRuntimeVersion === NIGHT_MODE_TRANSITION_RUNTIME_VERSION ||
        registry?.runtime_version === NIGHT_MODE_TRANSITION_RUNTIME_VERSION ||
        (existing.data !== undefined &&
          Number.isFinite(Date.parse(params.scheduledFor)) &&
          Date.parse(params.scheduledFor) >= this.runtimeStartedAtMs);
      if (!currentRuntimeJob) {
        if (existingState !== 'active') {
          if (await this.removeJob(existing, { strict: true })) {
            await this.deleteScheduledJobRegistryRow(params.chatId, params.jobId);
          }
        }
        return { kind: 'skip' };
      }
      if (
        existing.data !== undefined &&
        transitionRuntimeVersion !== NIGHT_MODE_TRANSITION_RUNTIME_VERSION
      ) {
        if (existingState === 'active') {
          return { kind: 'skip' };
        }
        await this.upsertScheduledJobRegistryIntent(
          {
            chat_id: params.chatId,
            job_id: params.jobId,
            transition: params.transition,
            session_key: params.sessionKey,
            scheduled_for: new Date(params.scheduledFor),
            schedule_fingerprint: params.fingerprint,
            runtime_version: NIGHT_MODE_TRANSITION_RUNTIME_VERSION,
          },
          options.reconcileFence,
        );
        await this.promoteTransitionJob(existing, params);
        transitionRuntimeVersion = NIGHT_MODE_TRANSITION_RUNTIME_VERSION;
      }
      if (typeof existing.getState !== 'function') {
        return { kind: 'enqueue' };
      }

      if (existingState !== 'failed') {
        return { kind: 'enqueue' };
      }

      const preDispatchLedger = await this.inspectExactRetryablePreDispatchLedger(params);
      // FLAG: v4 records SEND_MESSAGE start before any remote dispatch. Only a pre-existing exact
      // v4 Bull/SQL intent makes a missing ledger definitive pre-dispatch proof.
      if (
        preDispatchLedger === 'retryable' ||
        (preDispatchLedger === 'missing' && failedUnderCurrentV4Runtime)
      ) {
        await this.retryFailedTransitionJob(existing, params.jobId);
        return { kind: 'enqueue' };
      }
      const legacyPreDispatchNoRouteFailure =
        existing.failedReason ===
        buildMaxActionNoExecutableRouteMessage('SEND_MESSAGE', params.chatId);
      const preDispatchRouteQuarantineFailure =
        existing.failedReason ===
        buildMaxActionRouteQuarantinedMessage('SEND_MESSAGE', params.chatId);
      const preDispatchLockContentionFailure =
        existing.failedReason ===
        `${NIGHT_MODE_TRANSITION_LOCK_BUSY_FAILURE_PREFIX} (${params.chatId})`;
      const recoverableLegacyOpenFailure =
        params.transition === 'open' &&
        transitionRuntimeVersion === undefined &&
        this.isRecoverableCurrentOpenFailure(existing.failedReason);
      const ledgerJobId = buildNightModeNoticeIdempotencyKey(
        'open',
        params.chatId,
        params.sessionKey,
      );
      const recoverableVersionedLedgerFailure =
        params.transition === 'open' &&
        currentRuntimeJob &&
        (transitionRuntimeVersion === 2 ||
          transitionRuntimeVersion === 3 ||
          transitionRuntimeVersion === 4) &&
        existing.failedReason ===
          `MAX SEND_MESSAGE ledger entry ${ledgerJobId} is no longer executable (${MaxActionLedgerStatus.FAILED_TERMINAL})`;
      const retryablePostExecutionCleanupFailure =
        params.transition === 'open' &&
        currentRuntimeJob &&
        (transitionRuntimeVersion === 3 || transitionRuntimeVersion === 4) &&
        existing.failedReason?.startsWith(
          `${NIGHT_MODE_TRANSITION_POST_EXECUTION_CLEANUP_FAILURE_PREFIX}: `,
        ) === true;
      if (retryablePostExecutionCleanupFailure) {
        const ledgerResolution = await this.resolveMissingBullCatchUp(params, {
          durableRegistryProof: true,
        });
        if (ledgerResolution.kind === 'enqueue') {
          await this.retryFailedTransitionJob(existing, params.jobId);
          return ledgerResolution;
        }
        if (ledgerResolution.kind === 'blocked') {
          return ledgerResolution;
        }
      }
      if (recoverableVersionedLedgerFailure) {
        const recovery = await prepareDefinitivelyRejectedNightModeOpenRetry(this.prisma, {
          chatId: params.chatId,
          sessionKey: params.sessionKey,
          actionableBotIds: this.getActionableBotIds(),
        });
        if (recovery.kind === 'blocked') {
          const reason = `Night mode catch-up cannot safely recover terminal ledger state (${recovery.jobId})`;
          this.logger.warn(
            {
              chatId: params.chatId,
              jobId: params.jobId,
              ledgerJobId: recovery.jobId,
              sessionKey: params.sessionKey,
            },
            'Kept night mode catch-up pending because terminal send provenance was unsafe',
          );
          return {
            kind: 'blocked',
            manualReview: {
              category: recovery.category,
              reason,
              jobId: params.jobId,
              ledgerJobId: recovery.jobId,
              sessionKey: params.sessionKey,
              fingerprint: params.fingerprint,
            },
          };
        }
        await this.retryFailedTransitionJob(existing, params.jobId);
        return { kind: 'enqueue' };
      }
      if (recoverableLegacyOpenFailure) {
        return {
          kind: 'blocked',
          manualReview: {
            category: 'unsafe_prior_provenance',
            reason: `Night mode catch-up has legacy send provenance (${params.jobId})`,
            jobId: params.jobId,
            ledgerJobId: null,
            sessionKey: params.sessionKey,
            fingerprint: params.fingerprint,
          },
        };
      }
      if (
        !legacyPreDispatchNoRouteFailure &&
        !preDispatchRouteQuarantineFailure &&
        !preDispatchLockContentionFailure
      ) {
        this.logger.warn(
          {
            chatId: params.chatId,
            jobId: params.jobId,
            sessionKey: params.sessionKey,
            transitionRuntimeVersion: transitionRuntimeVersion ?? null,
            failedReason: existing.failedReason ?? null,
          },
          'Skipped night mode catch-up after an ambiguous or terminal prior failure',
        );
        return {
          kind: 'blocked',
          manualReview: {
            category: 'unsafe_prior_dispatch',
            reason: `Night mode catch-up is blocked by an unsafe prior failure (${params.jobId})`,
            jobId: params.jobId,
            ledgerJobId: null,
            sessionKey: params.sessionKey,
            fingerprint: params.fingerprint,
          },
        };
      }

      await this.retryFailedTransitionJob(existing, params.jobId);
      return { kind: 'enqueue' };
    } catch (error: unknown) {
      if (this.isBullMqMissingJobRemovalError(error, params.jobId)) {
        return { kind: 'enqueue' };
      }
      this.logger.warn(
        {
          chatId: params.chatId,
          jobId: params.jobId,
          sessionKey: params.sessionKey,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not safely inspect a failed night mode opening job for catch-up',
      );
      if (options.strict === true) {
        throw error;
      }
      return {
        kind: 'blocked',
        manualReview: {
          category: 'failed_job_unclassified',
          reason: `Night mode catch-up inspection failed (${params.jobId})`,
          jobId: params.jobId,
          ledgerJobId: null,
          sessionKey: params.sessionKey,
          fingerprint: params.fingerprint,
        },
      };
    }
  }

  private isRecoverableCurrentOpenFailure(failedReason: string | undefined): boolean {
    const normalized = failedReason?.trim().toLowerCase() ?? '';
    return normalized.includes('user.not.admin') || normalized.includes('user is not an admin');
  }

  private isExactCurrentV4BullEnvelope(
    data: NightModeTransitionJob | undefined,
    params: {
      chatId: string;
      sessionKey: string;
      transition: NightModeTransitionOccurrence['transition'];
      scheduledFor: string;
      fingerprint: string;
    },
  ): boolean {
    return (
      data?.chatId === params.chatId &&
      data.transition === params.transition &&
      data.sessionKey === params.sessionKey &&
      data.scheduledFor === params.scheduledFor &&
      data.scheduleFingerprint === params.fingerprint &&
      data.transitionRuntimeVersion === NIGHT_MODE_TRANSITION_RUNTIME_VERSION &&
      data.recoveryOnly === undefined
    );
  }

  private isExactCurrentV4Registry(
    registry: NightModeScheduledJobRegistryRow | null,
    params: {
      chatId: string;
      jobId: string;
      sessionKey: string;
      transition: NightModeTransitionOccurrence['transition'];
      scheduledFor: string;
      fingerprint: string;
    },
  ): boolean {
    const scheduledForMs = Date.parse(params.scheduledFor);
    return (
      registry?.chat_id === params.chatId &&
      registry.job_id === params.jobId &&
      registry.transition === params.transition &&
      registry.session_key === params.sessionKey &&
      registry.scheduled_for instanceof Date &&
      Number.isFinite(scheduledForMs) &&
      registry.scheduled_for.getTime() === scheduledForMs &&
      registry.schedule_fingerprint === params.fingerprint &&
      registry.runtime_version === NIGHT_MODE_TRANSITION_RUNTIME_VERSION
    );
  }

  private async inspectExactRetryablePreDispatchLedger(params: {
    chatId: string;
    sessionKey: string;
    transition: NightModeTransitionOccurrence['transition'];
  }): Promise<'missing' | 'retryable' | 'unsafe'> {
    if (typeof this.prisma.maxActionLedgerEntry?.findUnique !== 'function') {
      return 'unsafe';
    }
    const ledger = await this.prisma.maxActionLedgerEntry.findUnique({
      where: {
        jobId: buildNightModeNoticeIdempotencyKey(
          params.transition,
          params.chatId,
          params.sessionKey,
        ),
      },
      select: {
        actionType: true,
        chatId: true,
        sourceTag: true,
        status: true,
        ambiguous: true,
        terminal: true,
        dispatchToken: true,
        dispatchStartedAt: true,
        dispatchBotId: true,
        remoteMessageId: true,
      },
    });
    if (!ledger) {
      return 'missing';
    }
    return ledger.actionType === 'SEND_MESSAGE' &&
      ledger.chatId === params.chatId &&
      ledger.sourceTag === NIGHT_MODE_TRANSITION_SOURCE_TAG &&
      (ledger.status === MaxActionLedgerStatus.ENQUEUED ||
        ledger.status === MaxActionLedgerStatus.IN_PROGRESS ||
        ledger.status === MaxActionLedgerStatus.FAILED_RETRYABLE) &&
      !ledger.ambiguous &&
      !ledger.terminal &&
      !ledger.dispatchToken &&
      !ledger.dispatchStartedAt &&
      !ledger.dispatchBotId &&
      !ledger.remoteMessageId
      ? 'retryable'
      : 'unsafe';
  }

  private resolveTransitionOccurrences(
    settings: NightModeTransitionScheduleSettings,
    options: {
      includeCurrentClose?: boolean;
      includeCurrentOpen?: boolean;
      includeFuture?: boolean;
    },
  ): NightModeTransitionOccurrence[] {
    const occurrences =
      options.includeFuture === false ? [] : resolveNextNightModeTransitionOccurrences(settings);
    if (!options.includeCurrentClose && !options.includeCurrentOpen) {
      return occurrences;
    }

    const currentOccurrences = [
      ...(options.includeCurrentClose ? [resolveCurrentNightModeCloseOccurrence(settings)] : []),
      ...(options.includeCurrentOpen ? [resolveCurrentNightModeOpenOccurrence(settings)] : []),
    ].filter((occurrence): occurrence is NightModeTransitionOccurrence => occurrence !== null);

    if (currentOccurrences.length === 0) {
      return occurrences;
    }

    const currentOccurrenceKeys = new Set(
      currentOccurrences.map((occurrence) => `${occurrence.transition}:${occurrence.sessionKey}`),
    );
    return [
      ...currentOccurrences,
      ...occurrences.filter(
        (occurrence) =>
          !currentOccurrenceKeys.has(`${occurrence.transition}:${occurrence.sessionKey}`),
      ),
    ].sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());
  }

  private async runChatQueueMutationSerialized<T>(
    chatId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runChatQueueMutationLocally(chatId, async () => {
      const redisLock = this.getQueueMutationLockApi();
      if (!redisLock) {
        return operation();
      }

      const key = `night-mode-transition-queue-mutation:v1:${chatId}`;
      const deadline = Date.now() + NIGHT_MODE_QUEUE_MUTATION_LOCK_WAIT_MS;
      let token: string | null = null;
      do {
        token = await redisLock.acquireLock(key, NIGHT_MODE_QUEUE_MUTATION_LOCK_TTL_MS);
        if (token) {
          break;
        }
        await this.delay(50);
      } while (Date.now() < deadline);
      if (!token) {
        throw new Error(`Night mode queue mutation lock is busy (${chatId})`);
      }

      const lockToken = token;
      let lockHealthy = true;
      let renewalChain = Promise.resolve();
      const heartbeat = setInterval(() => {
        renewalChain = renewalChain
          .then(async () => {
            if (
              !(await redisLock.renewLock(key, lockToken, NIGHT_MODE_QUEUE_MUTATION_LOCK_TTL_MS))
            ) {
              lockHealthy = false;
            }
          })
          .catch((error: unknown) => {
            lockHealthy = false;
            this.logger.warn(
              {
                chatId,
                error: error instanceof Error ? error.message : String(error),
              },
              'Night mode queue mutation lock renewal failed',
            );
          });
      }, NIGHT_MODE_QUEUE_MUTATION_LOCK_HEARTBEAT_MS);
      heartbeat?.unref?.();
      try {
        const result = await operation();
        clearInterval(heartbeat);
        await renewalChain;
        if (
          !lockHealthy ||
          !(await redisLock.renewLock(key, lockToken, NIGHT_MODE_QUEUE_MUTATION_LOCK_TTL_MS))
        ) {
          throw new Error(`Night mode queue mutation lock was lost (${chatId})`);
        }
        return result;
      } finally {
        clearInterval(heartbeat);
        await renewalChain.catch(() => undefined);
        await redisLock.releaseLock(key, lockToken).catch((error: unknown) => {
          this.logger.warn(
            {
              chatId,
              error: error instanceof Error ? error.message : String(error),
            },
            'Night mode queue mutation lock release failed',
          );
        });
      }
    });
  }

  private async runChatQueueMutationLocally<T>(
    chatId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.localQueueMutationChains.get(chatId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.catch(() => undefined).then(() => current);
    this.localQueueMutationChains.set(chatId, chain);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.localQueueMutationChains.get(chatId) === chain) {
        this.localQueueMutationChains.delete(chatId);
      }
    }
  }

  private getQueueMutationLockApi(): NightModeQueueMutationLockApi | null {
    const redisCounter = this.redisCounter as Partial<RedisCounterService> | undefined;
    return redisCounter &&
      typeof redisCounter.acquireLock === 'function' &&
      typeof redisCounter.renewLock === 'function' &&
      typeof redisCounter.releaseLock === 'function'
      ? (redisCounter as NightModeQueueMutationLockApi)
      : null;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private scheduleBootstrap(delayMs: number): void {
    if (this.shuttingDown || this.startupTimer) {
      return;
    }
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.bootstrapEnabledChats();
    }, delayMs);
    this.startupTimer.unref();
  }

  private requestBootstrapRetry(): void {
    if (this.shuttingDown) {
      return;
    }
    if (this.bootstrapInFlight) {
      this.bootstrapRetryRequested = true;
      return;
    }
    this.scheduleBootstrap(NIGHT_MODE_TRANSITION_BOOTSTRAP_RETRY_MS);
  }

  private async clearChatJobsForChatIds(
    chatIds: readonly string[],
    options: {
      strict?: boolean;
      throwOnActive?: boolean;
      keepJobIds?: ReadonlySet<string>;
      reconcileFence?: NightModeTransitionReconcileFence;
    } = {},
  ): Promise<void> {
    if (!this.queue) {
      return;
    }

    const normalizedChatIds = this.normalizeChatIds(chatIds);
    if (normalizedChatIds.length === 0) {
      return;
    }

    const rows = await this.listScheduledJobRegistryRows(normalizedChatIds);
    const activeJobIds: string[] = [];
    for (const row of rows) {
      if (options.keepJobIds?.has(row.job_id)) {
        continue;
      }
      const job = await this.queue.getJob(row.job_id);
      if (!job) {
        await this.deleteScheduledJobRegistryRow(row.chat_id, row.job_id);
        continue;
      }
      if (typeof job.getState === 'function' && (await job.getState()) === 'active') {
        activeJobIds.push(row.job_id);
        // A fenced durable repair already owns a request. Re-enqueueing that same chat here would
        // increment its generation and revoke the lease that is about to report the active job.
        if (!options.reconcileFence) {
          await this.requestDurableReconcile(row.chat_id);
        }
        continue;
      }
      if (await this.removeJob(job, options)) {
        // FLAG: BullMQ removal is authoritative. The SQL intent is deleted only after the external
        // queue no longer contains the obsolete job, so a crash leaves recoverable registry state.
        await this.deleteScheduledJobRegistryRow(row.chat_id, row.job_id);
      }
    }
    if ((options.throwOnActive ?? options.strict === true) && activeJobIds.length > 0) {
      throw new NightModeTransitionJobsActiveError(activeJobIds);
    }
  }

  private async listScheduledJobRegistryRows(
    chatIds: readonly string[],
  ): Promise<NightModeScheduledJobRegistryRow[]> {
    if (typeof this.prisma.$queryRaw === 'function') {
      return this.prisma.$queryRaw<NightModeScheduledJobRegistryRow[]>(Prisma.sql`
        SELECT
          "chat_id",
          "job_id",
          "transition",
          "session_key",
          "scheduled_for",
          "schedule_fingerprint",
          "runtime_version"
        FROM "night_mode_transition_scheduled_jobs"
        WHERE "chat_id" IN (${Prisma.join(chatIds)})
        ORDER BY "chat_id" ASC, "scheduled_for" ASC, "job_id" ASC
      `);
    }

    const chatIdSet = new Set(chatIds);
    return Array.from(this.fallbackScheduledJobRegistry.values())
      .filter((row) => chatIdSet.has(row.chat_id))
      .sort(
        (left, right) =>
          left.chat_id.localeCompare(right.chat_id) ||
          left.scheduled_for.getTime() - right.scheduled_for.getTime() ||
          left.job_id.localeCompare(right.job_id),
      );
  }

  private async findScheduledJobRegistryRow(
    chatId: string,
    jobId: string,
  ): Promise<NightModeScheduledJobRegistryRow | null> {
    const rows = await this.listScheduledJobRegistryRows([chatId]);
    return rows.find((row) => row.job_id === jobId) ?? null;
  }

  private async upsertScheduledJobRegistryIntent(
    row: NightModeScheduledJobRegistryRow,
    reconcileFence?: NightModeTransitionReconcileFence,
  ): Promise<boolean> {
    if (typeof this.prisma.$executeRaw === 'function') {
      const retained = await this.prisma.$executeRaw(Prisma.sql`
        WITH request_owner AS (
          SELECT
            ${reconcileFence?.generation ?? null}::BIGINT AS "generation",
            ${reconcileFence?.leaseToken ?? null}::TEXT AS "lease_token"
        ), registry_intent AS (
          INSERT INTO "night_mode_transition_scheduled_jobs" (
            "chat_id",
            "job_id",
            "transition",
            "session_key",
            "scheduled_for",
            "schedule_fingerprint",
            "runtime_version",
            "created_at",
            "updated_at"
          )
          VALUES (
            ${row.chat_id},
            ${row.job_id},
            ${row.transition},
            ${row.session_key},
            ${row.scheduled_for},
            ${row.schedule_fingerprint},
            ${row.runtime_version ?? 3},
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
          ON CONFLICT ("chat_id", "job_id") DO UPDATE
          SET
            "transition" = EXCLUDED."transition",
            "session_key" = EXCLUDED."session_key",
            "scheduled_for" = EXCLUDED."scheduled_for",
            "schedule_fingerprint" = EXCLUDED."schedule_fingerprint",
            "runtime_version" = EXCLUDED."runtime_version",
            "updated_at" = CURRENT_TIMESTAMP
          WHERE ROW(
            "night_mode_transition_scheduled_jobs"."transition",
            "night_mode_transition_scheduled_jobs"."session_key",
            "night_mode_transition_scheduled_jobs"."scheduled_for",
            "night_mode_transition_scheduled_jobs"."schedule_fingerprint",
            "night_mode_transition_scheduled_jobs"."runtime_version"
          ) IS DISTINCT FROM ROW(
            EXCLUDED."transition",
            EXCLUDED."session_key",
            EXCLUDED."scheduled_for",
            EXCLUDED."schedule_fingerprint",
            EXCLUDED."runtime_version"
          )
          RETURNING "chat_id"
        )
        INSERT INTO "night_mode_transition_reconcile_requests" (
          "chat_id",
          "generation",
          "first_requested_at",
          "requested_at"
        )
        SELECT "chat_id", 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM registry_intent
        ON CONFLICT ("chat_id") DO UPDATE
        SET
          "generation" = "night_mode_transition_reconcile_requests"."generation" + 1,
          "requested_at" = LEAST(
            "night_mode_transition_reconcile_requests"."requested_at",
            EXCLUDED."requested_at"
          ),
          "lease_token" = NULL,
          "lease_expires_at" = NULL
        WHERE NOT EXISTS (
          SELECT 1
          FROM request_owner owner
          WHERE owner."generation" =
              "night_mode_transition_reconcile_requests"."generation"
            AND owner."lease_token" =
              "night_mode_transition_reconcile_requests"."lease_token"
            AND (
              "night_mode_transition_reconcile_requests"."manual_blocked_at" IS NULL
              OR "night_mode_transition_reconcile_requests"."generation" >
                "night_mode_transition_reconcile_requests"."manual_blocked_generation"
            )
        )
      `);
      return retained > 0;
    }

    this.fallbackScheduledJobRegistry.set(
      this.buildScheduledJobRegistryKey(row.chat_id, row.job_id),
      {
        ...row,
        runtime_version: row.runtime_version ?? 3,
      },
    );
    return false;
  }

  private async deleteScheduledJobRegistryRow(chatId: string, jobId: string): Promise<void> {
    if (typeof this.prisma.$executeRaw === 'function') {
      await this.prisma.$executeRaw(Prisma.sql`
        DELETE FROM "night_mode_transition_scheduled_jobs"
        WHERE "chat_id" = ${chatId}
          AND "job_id" = ${jobId}
      `);
      return;
    }

    this.fallbackScheduledJobRegistry.delete(this.buildScheduledJobRegistryKey(chatId, jobId));
  }

  private async requestDurableReconcile(chatId: string): Promise<void> {
    if (typeof this.prisma.$executeRaw !== 'function') {
      return;
    }
    await this.prisma.$executeRaw(Prisma.sql`
      SELECT enqueue_night_mode_transition_reconcile_request(${chatId})
    `);
  }

  private async retainDurableReconcileAfterQueueFailure(
    chatId: string,
    durableReconcileRetained: boolean,
    reconcileFence?: NightModeTransitionReconcileFence,
  ): Promise<void> {
    if (reconcileFence || durableReconcileRetained) {
      return;
    }
    try {
      await this.requestDurableReconcile(chatId);
    } catch (error: unknown) {
      this.logger.error(
        {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to retain durable night mode reconcile after queue mutation failure',
      );
    }
  }

  private buildScheduledJobRegistryKey(chatId: string, jobId: string): string {
    return `${chatId}\u0000${jobId}`;
  }

  private async promoteFutureTransitionJob(jobId: string, fingerprint: string): Promise<void> {
    if (!this.queue || typeof this.queue.getJob !== 'function') {
      return;
    }
    const existing = await this.queue.getJob(jobId);
    if (
      !existing ||
      existing.data === undefined ||
      existing.data?.transitionRuntimeVersion === NIGHT_MODE_TRANSITION_RUNTIME_VERSION
    ) {
      return;
    }
    if (typeof existing.getState === 'function' && (await existing.getState()) === 'active') {
      return;
    }
    await this.promoteTransitionJob(existing, { jobId, fingerprint });
  }

  private normalizeChatIds(chatIds: readonly string[]): string[] {
    return Array.from(new Set(chatIds.map((item) => item.trim()).filter(Boolean)));
  }

  private async removeJob(
    job: { id?: string; remove(): Promise<void> },
    options: { strict?: boolean } = {},
  ): Promise<boolean> {
    try {
      await job.remove();
      return true;
    } catch (error: unknown) {
      this.logger.debug(
        {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to remove old night mode transition job',
      );
      if (options.strict === true && !this.isBullMqMissingJobRemovalError(error, job.id)) {
        throw error;
      }
      return this.isBullMqMissingJobRemovalError(error, job.id);
    }
  }

  private async retryFailedTransitionJob(
    job: { id?: string; retry?: () => Promise<void> },
    expectedJobId: string,
  ): Promise<void> {
    if (job.id !== expectedJobId || typeof job.retry !== 'function') {
      throw new Error(`Night mode failed job cannot be retried in place (${expectedJobId})`);
    }
    await job.retry();
  }

  private async promoteTransitionJob(
    job: {
      data?: NightModeTransitionJob;
      updateData?: (data: NightModeTransitionJob) => Promise<void>;
    },
    params: { jobId: string; fingerprint: string },
  ): Promise<void> {
    if (!job.data || typeof job.updateData !== 'function') {
      throw new Error(`Night mode future job cannot be promoted in place (${params.jobId})`);
    }
    await job.updateData({
      ...job.data,
      transitionRuntimeVersion: NIGHT_MODE_TRANSITION_RUNTIME_VERSION,
      scheduleFingerprint: params.fingerprint,
    });
  }

  private isBullMqMissingJobRemovalError(error: unknown, jobId: string | undefined): boolean {
    return (
      typeof jobId === 'string' &&
      error instanceof Error &&
      error.message === `Missing key for job ${jobId}. removeJob`
    );
  }

  private readNonNegativeConfigInt(value: unknown, fallback: number): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= 0) {
      return Math.trunc(numericValue);
    }

    return fallback;
  }
}
