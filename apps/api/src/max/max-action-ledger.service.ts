import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { randomUUID } from 'node:crypto';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  MaxActionLedgerStatus,
  Prisma,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { buildMaxActionNoExecutableRouteMessage } from './max-action-dispatch-error';
import { buildNightModeNoticeIdempotencyKey } from './max-action-idempotency.util';
import { MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE } from './max-action-pre-dispatch-guard';
import type { MaxActionJob, MaxActionType } from './max-client.service';
import {
  hasMaxInsufficientRightsMessage,
  wasMaxMemberMutationAttempted,
} from './max-member-error.util';

const IRREVERSIBLE_ACTION_TYPES: ReadonlySet<MaxActionType> = new Set([
  'SEND_MESSAGE',
  'KICK_MEMBER',
  'BAN_MEMBER',
]);
const EXECUTABLE_LEDGER_STATUSES: ReadonlySet<MaxActionLedgerStatus> = new Set([
  MaxActionLedgerStatus.ENQUEUED,
  MaxActionLedgerStatus.IN_PROGRESS,
  MaxActionLedgerStatus.FAILED_RETRYABLE,
]);
const SUCCEEDED_DELETE_OWNERSHIP_LOOKUP_LIMIT = 20;
const CRASH_FENCED_MEMBER_ACTION_TYPES: ReadonlySet<MaxActionType> = new Set([
  'KICK_MEMBER',
  'BAN_MEMBER',
]);
export const MAX_MEMBER_ACTION_PRE_DISPATCH_RETRY_ERROR_CODES = [
  'max_api_circuit_open',
  'max_api_internal_rate_limit',
  'max_api_external_rate_limit',
  'moderation_sanction_state_lock_lease_lost',
  'moderation_sanction_state_lock_unavailable',
  MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
] as const;
const MEMBER_ACTION_PRE_DISPATCH_RETRY_ERROR_CODES: ReadonlySet<string> = new Set(
  MAX_MEMBER_ACTION_PRE_DISPATCH_RETRY_ERROR_CODES,
);
const MANAGED_BROADCAST_SEND_JOB_PREFIX = 'managed-broadcast:send:';
const LEGACY_PRE_DISPATCH_WATCHDOG_ERROR_CODE = 'ledger.watchdog.pre_dispatch_orphan';
const LEGACY_PRE_DISPATCH_WATCHDOG_ERROR =
  'Pre-dispatch MAX SEND_MESSAGE ledger entry has no retained dispatch fence; BullMQ states missing. The action was not requeued.';
const LEGACY_MANAGED_BROADCAST_UPLOAD_ERROR =
  'не удалось загрузить видео: max upload payload is missing';
const MAX_MEMBER_ACTION_FAILURE_ERROR_CODES = {
  ALREADY_DELETED: 'max_member_already_deleted',
  ALREADY_DELETED_OR_INSUFFICIENT_RIGHTS: 'max_member_already_deleted_or_insufficient_rights',
  INSUFFICIENT_RIGHTS: 'max_member_insufficient_rights',
  KICK_FAILED: 'max_kick_member_failed',
  BAN_FAILED: 'max_ban_member_failed',
} as const;
const NIGHT_MODE_TRANSITION_SOURCE_TAG = 'night_mode_transition';
const NIGHT_MODE_OPEN_ACCESS_RECOVERY_MARKER =
  'Night mode open retry prepared after a definitive access rejection';

type MaxActionLedgerMutation = {
  status: MaxActionLedgerStatus;
  ambiguous: boolean;
  terminal: boolean;
  enqueuedAt?: Date | null;
  firstAttemptAt?: Date | null;
  lastAttemptAt?: Date | null;
  completedAt?: Date | null;
  lastStatusCode?: number | null;
  lastErrorCode?: string | null;
  lastError?: string | null;
  incrementAttempt?: boolean;
};

type MaxActionLedgerFailureOptions = {
  exhausted?: boolean;
};

type MaxActionLedgerExecutionState = {
  status: MaxActionLedgerStatus;
  ambiguous: boolean;
  terminal: boolean;
  attemptCount: number;
  firstAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  lastStatusCode: number | null;
  lastErrorCode: string | null;
  lastError: string | null;
  dispatchToken: string | null;
  dispatchStartedAt: Date | null;
  dispatchBotId: string | null;
  remoteMessageId: string | null;
};

export type MaxSendDispatchClaim =
  | {
      kind: 'claimed';
      dispatchToken: string;
    }
  | {
      kind: 'recovered';
      remoteMessageId: string;
      dispatchBotId: string | null;
      completedAt: Date | null;
    };

export type MaxCompletedSendDispatch = {
  remoteMessageId: string;
  dispatchBotId: string | null;
  completedAt: Date | null;
};

export type ExactCompletedNightModeCloseNoticeDispatch = {
  jobId: string;
  remoteMessageId: string;
  dispatchBotId: string;
};

export type NightModeCloseNoticeLedgerLookup =
  | { kind: 'missing'; jobId: string }
  | { kind: 'mismatch'; jobId: string }
  | ({ kind: 'completed' } & ExactCompletedNightModeCloseNoticeDispatch);

export const MAX_SEND_LEDGER_PREPARATION_ERROR_CODES = {
  MISSING_ROW: 'MAX_SEND_LEDGER_PREPARATION_MISSING_ROW',
  TERMINAL_OR_AMBIGUOUS: 'MAX_SEND_LEDGER_PREPARATION_TERMINAL_OR_AMBIGUOUS',
  DISPATCH_FENCE_EXISTS: 'MAX_SEND_LEDGER_PREPARATION_DISPATCH_FENCE_EXISTS',
  ALREADY_COMPLETED: 'MAX_SEND_LEDGER_PREPARATION_ALREADY_COMPLETED',
  UNEXPECTED_STATE: 'MAX_SEND_LEDGER_PREPARATION_UNEXPECTED_STATE',
} as const;

export type MaxSendLedgerPreparationErrorCode =
  (typeof MAX_SEND_LEDGER_PREPARATION_ERROR_CODES)[keyof typeof MAX_SEND_LEDGER_PREPARATION_ERROR_CODES];

type MaxSendDispatchLedgerFinalizedError = Error & {
  maxSendDispatchLedgerFinalized?: boolean;
};

type MaxSendDispatchState = {
  status: MaxActionLedgerStatus;
  ambiguous: boolean;
  terminal: boolean;
  dispatchToken: string | null;
  dispatchStartedAt: Date | null;
  dispatchBotId: string | null;
  remoteMessageId: string | null;
  completedAt: Date | null;
};

type MaxSendLedgerPreparationFailure = {
  code: MaxSendLedgerPreparationErrorCode;
  message: string;
  preserveExistingLedger: boolean;
};

type MaxSendLedgerPreparationError = UnrecoverableError & {
  code: MaxSendLedgerPreparationErrorCode;
};

export type NightModeOpenLedgerRecoveryResult =
  | { kind: 'ready'; jobId: string }
  | {
      kind: 'blocked';
      jobId: string;
      category: 'no_fresh_access' | 'unsafe_prior_provenance';
    };

// FLAG: Only a definitive non-delivery with fresh current admin access may become executable
// again. The marker branch makes the PostgreSQL step replayable after a crash before BullMQ repair.
export async function prepareDefinitivelyRejectedNightModeOpenRetry(
  prisma: Pick<PrismaService, '$transaction'>,
  params: {
    chatId: string;
    sessionKey: string;
    actionableBotIds?: readonly string[] | null;
  },
): Promise<NightModeOpenLedgerRecoveryResult> {
  const chatId = params.chatId.trim();
  const sessionKey = params.sessionKey.trim();
  const jobId = buildNightModeNoticeIdempotencyKey('open', chatId, sessionKey);
  const actionableBotIds = Array.from(
    new Set((params.actionableBotIds ?? []).map((botId) => botId.trim()).filter(Boolean)),
  );
  if (!chatId || !sessionKey || actionableBotIds.length === 0) {
    return { kind: 'blocked', jobId, category: 'no_fresh_access' };
  }

  const preparation = await prisma.$transaction(
    async (tx) => {
      const now = new Date();
      const freshAccess = await tx.chatBotMembership.findFirst({
        where: {
          chatId,
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: {
            in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
          },
          botAccessCheckedAt: { not: null },
          botAccessExpiresAt: { gt: now },
          botId: {
            in: actionableBotIds,
          },
        },
        select: { id: true },
      });
      if (!freshAccess) {
        return 'no_fresh_access' as const;
      }

      const result = await tx.maxActionLedgerEntry.updateMany({
        where: {
          jobId,
          actionType: 'SEND_MESSAGE',
          chatId,
          sourceTag: NIGHT_MODE_TRANSITION_SOURCE_TAG,
          ambiguous: false,
          dispatchToken: null,
          dispatchStartedAt: null,
          dispatchBotId: null,
          remoteMessageId: null,
          AND: [
            {
              OR: [
                { lastStatusCode: { in: [403, 404] } },
                {
                  lastStatusCode: null,
                  lastErrorCode: {
                    in: ['access.denied', 'chat.denied', 'chat.not.found'],
                  },
                },
              ],
            },
            {
              OR: [
                {
                  status: MaxActionLedgerStatus.FAILED_TERMINAL,
                  terminal: true,
                  attemptCount: { gte: 1 },
                  firstAttemptAt: { not: null },
                  lastAttemptAt: { not: null },
                  completedAt: { not: null },
                },
                {
                  status: MaxActionLedgerStatus.ENQUEUED,
                  terminal: false,
                  attemptCount: 0,
                  enqueuedAt: { not: null },
                  firstAttemptAt: null,
                  lastAttemptAt: null,
                  completedAt: null,
                  lastError: NIGHT_MODE_OPEN_ACCESS_RECOVERY_MARKER,
                },
              ],
            },
          ],
        },
        data: {
          status: MaxActionLedgerStatus.ENQUEUED,
          ambiguous: false,
          terminal: false,
          attemptCount: 0,
          enqueuedAt: now,
          firstAttemptAt: null,
          lastAttemptAt: null,
          completedAt: null,
          lastError: NIGHT_MODE_OPEN_ACCESS_RECOVERY_MARKER,
          dispatchToken: null,
          dispatchStartedAt: null,
          dispatchBotId: null,
          remoteMessageId: null,
        },
      });
      return result.count === 1 ? ('ready' as const) : ('unsafe_prior_provenance' as const);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  return preparation === 'ready'
    ? { kind: 'ready', jobId }
    : { kind: 'blocked', jobId, category: preparation };
}

export function markMaxSendDispatchLedgerFinalized<T extends Error>(error: T): T {
  (error as T & MaxSendDispatchLedgerFinalizedError).maxSendDispatchLedgerFinalized = true;
  return error;
}

@Injectable()
export class MaxActionLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async hasSucceededDelete(chatId: string, messageId: string): Promise<boolean> {
    const normalizedChatId = this.nullableString(chatId);
    const normalizedMessageId = this.nullableString(messageId);
    if (!normalizedChatId || !normalizedMessageId) {
      return false;
    }

    const rows = await this.prisma.maxActionLedgerEntry.findMany({
      where: {
        chatId: normalizedChatId,
        actionType: 'DELETE_MESSAGE',
        messageId: normalizedMessageId,
        status: MaxActionLedgerStatus.SUCCEEDED,
        updatedAt: {
          gte: new Date(Date.now() - 2 * 60 * 60 * 1_000),
        },
      },
      select: {
        id: true,
        metadata: true,
        sourceTag: true,
      },
      orderBy: {
        updatedAt: 'desc',
      },
      take: SUCCEEDED_DELETE_OWNERSHIP_LOOKUP_LIMIT,
    });
    return rows.some((row) => this.hasVerifiedSendAutoDeleteMetadata(row.metadata, row.sourceTag));
  }

  async hasRecordedVerifiedSendAutoDeleteSuccess(job: MaxActionJob): Promise<boolean> {
    const expected = job.sendAutoDelete;
    const messageId = this.nullableString(job.messageId);
    if (
      job.actionType !== 'DELETE_MESSAGE' ||
      !messageId ||
      !expected ||
      !this.isVerifiedSendAutoDeleteMarker(expected)
    ) {
      return false;
    }

    const row = await this.prisma.maxActionLedgerEntry.findUnique({
      where: { jobId: job.idempotencyKey },
      select: {
        actionType: true,
        chatId: true,
        messageId: true,
        status: true,
        ambiguous: true,
        terminal: true,
        metadata: true,
      },
    });
    if (
      !row ||
      row.actionType !== 'DELETE_MESSAGE' ||
      row.chatId !== job.chatId ||
      row.messageId !== messageId ||
      row.status !== MaxActionLedgerStatus.SUCCEEDED ||
      row.ambiguous ||
      !row.terminal
    ) {
      return false;
    }

    const stored = this.readVerifiedSendAutoDeleteMarker(row.metadata);
    return Boolean(
      stored &&
      stored.version === expected.version &&
      stored.sourceSendJobId === expected.sourceSendJobId &&
      stored.sourceSendCompletedAt === expected.sourceSendCompletedAt &&
      stored.requestedDelayMs === expected.requestedDelayMs &&
      stored.originBotId === expected.originBotId &&
      stored.exactAbsenceVerifiedAt === expected.exactAbsenceVerifiedAt &&
      stored.exactAbsenceVerificationPhase === expected.exactAbsenceVerificationPhase,
    );
  }

  async clearTerminalBanStateAfterUnban(chatId: string, userId: string): Promise<void> {
    const normalizedChatId = this.nullableString(chatId);
    const normalizedUserId = this.nullableString(userId);
    if (!normalizedChatId || !normalizedUserId) {
      return;
    }

    await this.prisma.maxActionLedgerEntry.deleteMany({
      where: {
        chatId: normalizedChatId,
        userId: normalizedUserId,
        actionType: 'BAN_MEMBER',
        terminal: true,
      },
    });
  }

  isIrreversibleAction(actionType: MaxActionType): boolean {
    return IRREVERSIBLE_ACTION_TYPES.has(actionType);
  }

  async assertCanEnqueue(job: MaxActionJob): Promise<void> {
    if (!this.isIrreversibleAction(job.actionType)) {
      return;
    }

    const row = await this.prisma.maxActionLedgerEntry.findUnique({
      where: {
        jobId: job.idempotencyKey,
      },
      select: {
        status: true,
        ambiguous: true,
        terminal: true,
        attemptCount: true,
        firstAttemptAt: true,
        lastAttemptAt: true,
        lastStatusCode: true,
        lastErrorCode: true,
        lastError: true,
        dispatchToken: true,
        dispatchStartedAt: true,
        dispatchBotId: true,
        remoteMessageId: true,
        completedAt: true,
      },
    });

    if (row && this.isLegacyPreDispatchNoRouteSendState(job, row)) {
      if (await this.clearLegacyPreDispatchNoRouteSendState(job)) {
        return;
      }
      throw new UnrecoverableError(
        `Legacy pre-dispatch MAX SEND_MESSAGE ledger entry ${job.idempotencyKey} changed before recovery`,
      );
    }

    if (row && this.isLegacyManagedBroadcastPreDispatchSendState(job, row)) {
      if (await this.clearLegacyManagedBroadcastPreDispatchSendState(job)) {
        return;
      }
      throw new UnrecoverableError(
        `Legacy managed-broadcast pre-dispatch ledger entry ${job.idempotencyKey} changed before recovery`,
      );
    }

    if (row && this.isCrashFencedMemberAction(job.actionType)) {
      if (this.isExecutableCrashFencedMemberState(row)) {
        return;
      }
      throw new UnrecoverableError(
        `Retained MAX ${job.actionType} ledger entry ${job.idempotencyKey} is no longer executable (${row.status})`,
      );
    }

    if (row && this.readCompletedSendDispatchFromState(job, row)) {
      return;
    }

    if (row?.dispatchToken || row?.dispatchStartedAt) {
      throw new UnrecoverableError(
        `Retained unresolved MAX ${job.actionType} dispatch ${job.idempotencyKey} requires manual review before retry`,
      );
    }

    if (job.actionType === 'SEND_MESSAGE' && row?.terminal) {
      throw new UnrecoverableError(
        `Retained terminal MAX SEND_MESSAGE ledger entry ${job.idempotencyKey} has no recoverable remote message id`,
      );
    }

    if (!row?.ambiguous || !row.terminal || row.status !== MaxActionLedgerStatus.AMBIGUOUS) {
      return;
    }

    throw new UnrecoverableError(
      `Retained ambiguous MAX ${job.actionType} ledger entry ${job.idempotencyKey} requires manual review before retry`,
    );
  }

  async assertCanExecute(job: MaxActionJob): Promise<void> {
    const row = await this.prisma.maxActionLedgerEntry.findUnique({
      where: {
        jobId: job.idempotencyKey,
      },
      select: {
        status: true,
        ambiguous: true,
        terminal: true,
        attemptCount: true,
        firstAttemptAt: true,
        lastAttemptAt: true,
        lastStatusCode: true,
        lastErrorCode: true,
        lastError: true,
        dispatchToken: true,
        dispatchStartedAt: true,
        dispatchBotId: true,
        remoteMessageId: true,
        completedAt: true,
      },
    });
    if (!row) {
      return;
    }
    if (this.readCompletedSendDispatchFromState(job, row)) {
      return;
    }

    if (this.isLegacyPreDispatchNoRouteSendState(job, row)) {
      if (await this.clearLegacyPreDispatchNoRouteSendState(job)) {
        return;
      }
      throw new UnrecoverableError(
        `Legacy pre-dispatch MAX SEND_MESSAGE ledger entry ${job.idempotencyKey} changed before recovery`,
      );
    }

    if (this.isLegacyManagedBroadcastPreDispatchSendState(job, row)) {
      if (await this.clearLegacyManagedBroadcastPreDispatchSendState(job)) {
        return;
      }
      throw new UnrecoverableError(
        `Legacy managed-broadcast pre-dispatch ledger entry ${job.idempotencyKey} changed before recovery`,
      );
    }

    if (this.isCrashFencedMemberAction(job.actionType)) {
      if (this.isExecutableCrashFencedMemberState(row)) {
        return;
      }
      throw new UnrecoverableError(
        `MAX ${job.actionType} ledger entry ${job.idempotencyKey} is no longer executable (${row.status})`,
      );
    }

    if (
      !row.terminal &&
      !row.ambiguous &&
      EXECUTABLE_LEDGER_STATUSES.has(row.status) &&
      (job.actionType !== 'SEND_MESSAGE' || (!row.dispatchToken && !row.dispatchStartedAt))
    ) {
      return;
    }

    throw new UnrecoverableError(
      `MAX ${job.actionType} ledger entry ${job.idempotencyKey} is no longer executable (${row.status})`,
    );
  }

  async recordEnqueuedIfAbsent(job: MaxActionJob, enqueuedAt?: Date): Promise<void> {
    const recordedAt = new Date();
    const mutation: MaxActionLedgerMutation = {
      status: MaxActionLedgerStatus.ENQUEUED,
      ambiguous: false,
      terminal: false,
      enqueuedAt: this.normalizeEnqueuedAt(enqueuedAt, recordedAt) ?? recordedAt,
      completedAt: null,
      lastStatusCode: null,
      lastErrorCode: null,
      lastError: null,
    };
    const created = await this.createLedgerIfAbsent(job, mutation);
    if (created) {
      return;
    }

    await this.updateUnattemptedEnqueueState(
      job,
      [MaxActionLedgerStatus.FAILED_RETRYABLE],
      mutation,
    );
  }

  async recordEnqueueFailedIfAbsent(job: MaxActionJob, error: unknown): Promise<void> {
    const mutation: MaxActionLedgerMutation = {
      status: MaxActionLedgerStatus.FAILED_RETRYABLE,
      ambiguous: false,
      terminal: false,
      completedAt: null,
      lastStatusCode: this.extractStatusCode(error),
      lastErrorCode: this.extractPersistedFailureErrorCode(job, error),
      lastError: this.extractErrorMessage(error),
    };
    await this.createLedgerIfAbsent(job, mutation);
  }

  async recordEnqueueAmbiguousIfAbsent(job: MaxActionJob, error: unknown): Promise<void> {
    const mutation: MaxActionLedgerMutation = {
      status: MaxActionLedgerStatus.AMBIGUOUS,
      ambiguous: true,
      terminal: true,
      completedAt: new Date(),
      lastStatusCode: null,
      lastErrorCode: 'queue.enqueue_ambiguous',
      lastError: this.extractErrorMessage(error),
    };
    const created = await this.createLedgerIfAbsent(job, mutation);
    if (created) {
      return;
    }

    await this.updateUnattemptedEnqueueState(
      job,
      [MaxActionLedgerStatus.ENQUEUED, MaxActionLedgerStatus.FAILED_RETRYABLE],
      mutation,
    );
  }

  async hasExecutionEvidenceSince(jobId: string, since: Date): Promise<boolean> {
    const normalizedJobId = this.nullableString(jobId);
    if (!normalizedJobId || !Number.isFinite(since.getTime())) {
      return false;
    }

    const row = await this.prisma.maxActionLedgerEntry.findFirst({
      where: {
        jobId: normalizedJobId,
        OR: [
          { firstAttemptAt: { gte: since } },
          { lastAttemptAt: { gte: since } },
          { dispatchStartedAt: { gte: since } },
        ],
      },
      select: {
        id: true,
      },
    });
    return Boolean(row);
  }

  async recordStarted(job: MaxActionJob, enqueuedAt?: Date): Promise<void> {
    const now = new Date();
    const normalizedEnqueuedAt = this.normalizeEnqueuedAt(enqueuedAt, now);
    const mutation: MaxActionLedgerMutation = {
      status: MaxActionLedgerStatus.IN_PROGRESS,
      ambiguous: false,
      terminal: false,
      ...(normalizedEnqueuedAt ? { enqueuedAt: normalizedEnqueuedAt } : {}),
      firstAttemptAt: now,
      lastAttemptAt: now,
      completedAt: null,
      incrementAttempt: true,
    };
    if (job.actionType === 'SEND_MESSAGE') {
      await this.recordProtectedSendTransition(job, mutation);
      return;
    }
    await this.recordGuardedStart(job, mutation);
  }

  async recordPrepared(job: MaxActionJob): Promise<void> {
    this.assertSendAction(job);
    const prepared = await this.prisma.maxActionLedgerEntry.updateMany({
      where: {
        jobId: job.idempotencyKey,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
        ambiguous: false,
        terminal: false,
      },
      data: this.buildUpdateInput(job),
    });
    if (prepared.count === 1) {
      return;
    }

    const row = await this.readSendDispatchState(job.idempotencyKey);
    if (this.readCompletedSendDispatchFromState(job, row)) {
      return;
    }
    const failure = this.classifyPreparedSendFailure(job.idempotencyKey, row);
    const error = this.createPreparedSendFailureError(failure);
    if (failure.preserveExistingLedger) {
      throw markMaxSendDispatchLedgerFinalized(error);
    }
    throw error;
  }

  async recordSucceeded(job: MaxActionJob): Promise<void> {
    if (
      job.sendAutoDelete &&
      (job.actionType !== 'DELETE_MESSAGE' ||
        !this.isVerifiedSendAutoDeleteMarker(job.sendAutoDelete))
    ) {
      throw new Error(
        `Refusing to mark unverified send-side auto-delete ${job.idempotencyKey} as succeeded`,
      );
    }
    const mutation: MaxActionLedgerMutation = {
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      completedAt: new Date(),
      lastStatusCode: null,
      lastErrorCode: null,
      lastError: null,
    };
    if (job.actionType === 'SEND_MESSAGE') {
      await this.createLedgerIfAbsent(job, mutation);
      await this.prisma.maxActionLedgerEntry.updateMany({
        where: {
          jobId: job.idempotencyKey,
          remoteMessageId: null,
        },
        data: {
          ...this.buildUpdateInput(job),
          ...this.buildPlainMutationInput(mutation),
        },
      });
      return;
    }
    await this.upsert(job, mutation);
  }

  async recordSkipped(job: MaxActionJob, reason: string): Promise<void> {
    await this.upsert(job, {
      status: MaxActionLedgerStatus.SKIPPED,
      ambiguous: false,
      terminal: true,
      completedAt: new Date(),
      lastError: this.truncate(reason),
    });
  }

  async claimSendDispatch(job: MaxActionJob, botId: string): Promise<MaxSendDispatchClaim> {
    this.assertSendAction(job);
    const normalizedBotId = this.nullableString(botId);
    if (!normalizedBotId) {
      throw new Error(`botId is required to claim MAX SEND_MESSAGE dispatch ${job.idempotencyKey}`);
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const dispatchToken = randomUUID();
      const claimed = await this.prisma.maxActionLedgerEntry.updateMany({
        where: {
          jobId: job.idempotencyKey,
          dispatchToken: null,
          dispatchStartedAt: null,
          dispatchBotId: null,
          remoteMessageId: null,
          ambiguous: false,
          terminal: false,
        },
        data: {
          dispatchToken,
          dispatchStartedAt: new Date(),
          dispatchBotId: normalizedBotId,
        },
      });
      if (claimed.count === 1) {
        return {
          kind: 'claimed',
          dispatchToken,
        };
      }

      const row = await this.readSendDispatchState(job.idempotencyKey);
      const completed = this.readCompletedSendDispatchFromState(job, row);
      if (completed) {
        return {
          kind: 'recovered',
          ...completed,
        };
      }

      const error = new UnrecoverableError(
        `Ambiguous MAX SEND_MESSAGE dispatch fence for job ${job.idempotencyKey} requires manual review before retry`,
      );
      if (row?.dispatchToken) {
        const quarantined = await this.recordAmbiguousSendDispatch(job, row.dispatchToken, error);
        if (quarantined) {
          throw markMaxSendDispatchLedgerFinalized(error);
        }
        continue;
      }

      if (row?.ambiguous && row.terminal) {
        throw markMaxSendDispatchLedgerFinalized(error);
      }

      throw error;
    }

    const row = await this.readSendDispatchState(job.idempotencyKey);
    const completed = this.readCompletedSendDispatchFromState(job, row);
    if (completed) {
      return {
        kind: 'recovered',
        ...completed,
      };
    }
    throw new UnrecoverableError(
      `Ambiguous MAX SEND_MESSAGE dispatch fence race for job ${job.idempotencyKey} requires manual review`,
    );
  }

  async completeSendDispatch(
    job: MaxActionJob,
    dispatchToken: string,
    remoteMessageId: string,
  ): Promise<Date | null> {
    this.assertSendAction(job);
    const normalizedToken = this.requireDispatchToken(dispatchToken);
    const normalizedRemoteMessageId = this.nullableString(remoteMessageId);
    if (!normalizedRemoteMessageId) {
      throw new Error(
        `remoteMessageId is required to complete MAX SEND_MESSAGE ${job.idempotencyKey}`,
      );
    }

    const completedAt = new Date();
    let completed: { count: number };
    try {
      completed = await this.prisma.maxActionLedgerEntry.updateMany({
        where: {
          jobId: job.idempotencyKey,
          dispatchToken: normalizedToken,
          remoteMessageId: null,
        },
        data: {
          remoteMessageId: normalizedRemoteMessageId,
          status: MaxActionLedgerStatus.SUCCEEDED,
          ambiguous: false,
          terminal: true,
          completedAt,
          lastStatusCode: null,
          lastErrorCode: null,
          lastError: null,
        },
      });
    } catch (error: unknown) {
      let recovered: MaxCompletedSendDispatch | null;
      try {
        recovered = await this.getCompletedSendDispatchResult(job);
      } catch (recoveryError: unknown) {
        if (recoveryError instanceof UnrecoverableError) {
          throw recoveryError;
        }
        throw error;
      }
      if (recovered?.remoteMessageId === normalizedRemoteMessageId) {
        return recovered.completedAt;
      }
      throw error;
    }
    if (completed.count === 1) {
      return completedAt;
    }

    const row = await this.readSendDispatchState(job.idempotencyKey);
    const recovered = this.readCompletedSendDispatchFromState(job, row);
    if (recovered?.remoteMessageId === normalizedRemoteMessageId) {
      return recovered.completedAt;
    }

    throw new UnrecoverableError(
      `Ambiguous MAX SEND_MESSAGE completion fence for job ${job.idempotencyKey}: remote message id was not persisted`,
    );
  }

  async getCompletedSendDispatch(job: MaxActionJob): Promise<string | null> {
    return (await this.getCompletedSendDispatchResult(job))?.remoteMessageId ?? null;
  }

  async getCompletedSendDispatchResult(
    job: MaxActionJob,
  ): Promise<MaxCompletedSendDispatch | null> {
    if (job.actionType !== 'SEND_MESSAGE') {
      return null;
    }
    const state = await this.readSendDispatchState(job.idempotencyKey);
    return this.readCompletedSendDispatchFromState(job, state);
  }

  // FLAG: Close-event recovery may trust only the raw night-mode ledger identity and the exact
  // accepted MAX result. A generic completed-send lookup does not prove chat/source provenance.
  async inspectCompletedNightModeCloseNoticeDispatch(params: {
    chatId: string;
    sessionKey: string;
  }): Promise<NightModeCloseNoticeLedgerLookup> {
    const chatId = this.nullableString(params.chatId);
    const sessionKey = this.nullableString(params.sessionKey);
    const jobId = buildNightModeNoticeIdempotencyKey('close', chatId ?? '', sessionKey ?? '');
    if (!chatId || !sessionKey) {
      return { kind: 'mismatch', jobId };
    }

    const row = await this.prisma.maxActionLedgerEntry.findUnique({
      where: { jobId },
      select: {
        actionType: true,
        chatId: true,
        sourceTag: true,
        status: true,
        ambiguous: true,
        terminal: true,
        completedAt: true,
        dispatchBotId: true,
        remoteMessageId: true,
      },
    });
    if (!row) {
      return { kind: 'missing', jobId };
    }
    const remoteMessageId = this.nullableString(row.remoteMessageId);
    const dispatchBotId = this.nullableString(row.dispatchBotId);
    if (
      row.actionType !== 'SEND_MESSAGE' ||
      row.chatId !== chatId ||
      row.sourceTag !== NIGHT_MODE_TRANSITION_SOURCE_TAG ||
      row.status !== MaxActionLedgerStatus.SUCCEEDED ||
      row.ambiguous ||
      !row.terminal ||
      !(row.completedAt instanceof Date) ||
      !Number.isFinite(row.completedAt.getTime()) ||
      !remoteMessageId ||
      !dispatchBotId
    ) {
      return { kind: 'mismatch', jobId };
    }

    return {
      kind: 'completed',
      jobId,
      remoteMessageId,
      dispatchBotId,
    };
  }

  async getExactCompletedNightModeCloseNoticeDispatch(params: {
    chatId: string;
    sessionKey: string;
    messageId: string;
    dispatchBotId: string;
  }): Promise<ExactCompletedNightModeCloseNoticeDispatch | null> {
    const chatId = this.nullableString(params.chatId);
    const sessionKey = this.nullableString(params.sessionKey);
    const messageId = this.nullableString(params.messageId);
    const dispatchBotId = this.nullableString(params.dispatchBotId);
    if (!chatId || !sessionKey || !messageId || !dispatchBotId) {
      return null;
    }

    const lookup = await this.inspectCompletedNightModeCloseNoticeDispatch({ chatId, sessionKey });
    if (
      lookup.kind !== 'completed' ||
      lookup.remoteMessageId !== messageId ||
      lookup.dispatchBotId !== dispatchBotId
    ) {
      return null;
    }

    return {
      jobId: lookup.jobId,
      remoteMessageId: lookup.remoteMessageId,
      dispatchBotId: lookup.dispatchBotId,
    };
  }

  async releaseSendDispatch(job: MaxActionJob, dispatchToken: string): Promise<void> {
    this.assertSendAction(job);
    const normalizedToken = this.requireDispatchToken(dispatchToken);
    const released = await this.prisma.maxActionLedgerEntry.updateMany({
      where: {
        jobId: job.idempotencyKey,
        dispatchToken: normalizedToken,
        remoteMessageId: null,
      },
      data: {
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        status: MaxActionLedgerStatus.IN_PROGRESS,
        ambiguous: false,
        terminal: false,
        completedAt: null,
      },
    });
    if (released.count === 1) {
      return;
    }

    const row = await this.readSendDispatchState(job.idempotencyKey);
    if (this.readCompletedSendDispatchFromState(job, row) || !row?.dispatchToken) {
      return;
    }

    throw new Error(
      `MAX SEND_MESSAGE dispatch fence changed before release for ${job.idempotencyKey}`,
    );
  }

  async recordAmbiguousSendDispatch(
    job: MaxActionJob,
    dispatchToken: string,
    error: unknown,
  ): Promise<boolean> {
    this.assertSendAction(job);
    const quarantined = await this.prisma.maxActionLedgerEntry.updateMany({
      where: {
        jobId: job.idempotencyKey,
        dispatchToken: this.requireDispatchToken(dispatchToken),
        remoteMessageId: null,
      },
      data: {
        status: MaxActionLedgerStatus.AMBIGUOUS,
        ambiguous: true,
        terminal: true,
        completedAt: new Date(),
        lastStatusCode: this.extractStatusCode(error),
        lastErrorCode: this.extractErrorCode(error),
        lastError: this.extractErrorMessage(error),
      },
    });
    return quarantined.count === 1;
  }

  async recordFailed(
    job: MaxActionJob,
    error: unknown,
    options: MaxActionLedgerFailureOptions = {},
  ): Promise<void> {
    if (this.isSendDispatchLedgerFinalizedError(error)) {
      return;
    }
    const ambiguous = this.isAmbiguousFailure(job, error);
    const intrinsicallyTerminal = !ambiguous && this.isIntrinsicallyTerminalFailure(job, error);
    const terminal =
      ambiguous ||
      intrinsicallyTerminal ||
      error instanceof UnrecoverableError ||
      options.exhausted === true;
    const mutation: MaxActionLedgerMutation = {
      status: ambiguous
        ? MaxActionLedgerStatus.AMBIGUOUS
        : terminal
          ? error instanceof UnrecoverableError
            ? MaxActionLedgerStatus.FAILED_TERMINAL
            : intrinsicallyTerminal
              ? MaxActionLedgerStatus.FAILED_TERMINAL
              : MaxActionLedgerStatus.FAILED_RETRYABLE
          : MaxActionLedgerStatus.FAILED_RETRYABLE,
      ambiguous,
      terminal,
      completedAt: terminal ? new Date() : null,
      lastStatusCode: this.extractStatusCode(error),
      lastErrorCode: this.extractPersistedFailureErrorCode(job, error),
      lastError: this.extractErrorMessage(error),
    };
    if (job.actionType === 'SEND_MESSAGE') {
      await this.recordProtectedSendFailure(job, mutation);
      return;
    }
    await this.upsert(job, mutation);
  }

  private async upsert(job: MaxActionJob, mutation: MaxActionLedgerMutation): Promise<void> {
    const create = this.buildCreateInput(job);
    await this.prisma.maxActionLedgerEntry.upsert({
      where: {
        jobId: job.idempotencyKey,
      },
      create: {
        ...create,
        ...this.buildPlainMutationInput(mutation),
        attemptCount: mutation.incrementAttempt ? Math.max(1, job.attempt) : create.attemptCount,
      },
      update: {
        ...this.buildUpdateInput(job),
        ...this.buildPlainMutationInput(mutation),
        ...(mutation.incrementAttempt ? { attemptCount: { increment: 1 } } : {}),
      },
    });
  }

  // FLAG: A BullMQ retry must not revive a terminal or ambiguous ledger outcome.
  private async recordGuardedStart(
    job: MaxActionJob,
    mutation: MaxActionLedgerMutation,
  ): Promise<void> {
    if (await this.updateExecutableStart(job, mutation)) {
      return;
    }

    const created = await this.prisma.maxActionLedgerEntry.createMany({
      data: [
        {
          ...this.buildCreateInput(job),
          ...this.buildPlainMutationInput(mutation),
          attemptCount: Math.max(1, job.attempt),
        },
      ],
      skipDuplicates: true,
    });
    if (created.count > 0 || (await this.updateExecutableStart(job, mutation))) {
      return;
    }

    await this.assertCanExecute(job);
    throw new UnrecoverableError(
      `MAX ${job.actionType} ledger entry ${job.idempotencyKey} changed before execution claim`,
    );
  }

  private async updateExecutableStart(
    job: MaxActionJob,
    mutation: MaxActionLedgerMutation,
  ): Promise<boolean> {
    const where: Prisma.MaxActionLedgerEntryWhereInput = {
      jobId: job.idempotencyKey,
      ...(this.isCrashFencedMemberAction(job.actionType)
        ? {
            OR: [
              { status: MaxActionLedgerStatus.ENQUEUED },
              {
                status: MaxActionLedgerStatus.FAILED_RETRYABLE,
                OR: [
                  {
                    lastErrorCode: {
                      in: [...MAX_MEMBER_ACTION_PRE_DISPATCH_RETRY_ERROR_CODES],
                    },
                  },
                  {
                    attemptCount: 0,
                    firstAttemptAt: null,
                    lastAttemptAt: null,
                    dispatchToken: null,
                    dispatchStartedAt: null,
                    dispatchBotId: null,
                    remoteMessageId: null,
                  },
                ],
              },
            ],
          }
        : {
            status: {
              in: [
                MaxActionLedgerStatus.ENQUEUED,
                MaxActionLedgerStatus.IN_PROGRESS,
                MaxActionLedgerStatus.FAILED_RETRYABLE,
              ],
            },
          }),
      ambiguous: false,
      terminal: false,
    };
    return this.updateStartedRowPreservingFirstAttempt(job, mutation, where);
  }

  private isCrashFencedMemberAction(actionType: MaxActionType): boolean {
    return CRASH_FENCED_MEMBER_ACTION_TYPES.has(actionType);
  }

  private isLegacyPreDispatchNoRouteSendState(
    job: MaxActionJob,
    row: MaxActionLedgerExecutionState,
  ): boolean {
    return (
      job.actionType === 'SEND_MESSAGE' &&
      row.status === MaxActionLedgerStatus.FAILED_TERMINAL &&
      row.ambiguous === false &&
      row.terminal === true &&
      row.lastStatusCode == null &&
      row.lastErrorCode == null &&
      row.lastError === buildMaxActionNoExecutableRouteMessage('SEND_MESSAGE', job.chatId) &&
      row.dispatchToken == null &&
      row.dispatchStartedAt == null &&
      row.dispatchBotId == null &&
      row.remoteMessageId == null
    );
  }

  private async clearLegacyPreDispatchNoRouteSendState(job: MaxActionJob): Promise<boolean> {
    const result = await this.prisma.maxActionLedgerEntry.deleteMany({
      where: {
        jobId: job.idempotencyKey,
        actionType: 'SEND_MESSAGE',
        chatId: job.chatId,
        status: MaxActionLedgerStatus.FAILED_TERMINAL,
        ambiguous: false,
        terminal: true,
        lastStatusCode: null,
        lastErrorCode: null,
        lastError: buildMaxActionNoExecutableRouteMessage('SEND_MESSAGE', job.chatId),
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      },
    });
    return result.count === 1;
  }

  // FLAG: Only historical managed-broadcast failures that prove MAX dispatch never started may clear.
  private isLegacyManagedBroadcastPreDispatchSendState(
    job: MaxActionJob,
    row: MaxActionLedgerExecutionState,
  ): boolean {
    if (
      job.actionType !== 'SEND_MESSAGE' ||
      !job.idempotencyKey.startsWith(MANAGED_BROADCAST_SEND_JOB_PREFIX) ||
      row.status !== MaxActionLedgerStatus.FAILED_TERMINAL ||
      row.ambiguous !== false ||
      row.terminal !== true ||
      row.lastStatusCode != null ||
      row.dispatchToken != null ||
      row.dispatchStartedAt != null ||
      row.dispatchBotId != null ||
      row.remoteMessageId != null
    ) {
      return false;
    }

    const lastError = row.lastError?.trim() ?? '';
    return (
      (row.lastErrorCode == null &&
        lastError.toLowerCase() === LEGACY_MANAGED_BROADCAST_UPLOAD_ERROR) ||
      (row.lastErrorCode === LEGACY_PRE_DISPATCH_WATCHDOG_ERROR_CODE &&
        lastError === LEGACY_PRE_DISPATCH_WATCHDOG_ERROR)
    );
  }

  private async clearLegacyManagedBroadcastPreDispatchSendState(
    job: MaxActionJob,
  ): Promise<boolean> {
    const result = await this.prisma.maxActionLedgerEntry.deleteMany({
      where: {
        jobId: job.idempotencyKey,
        actionType: 'SEND_MESSAGE',
        chatId: job.chatId,
        status: MaxActionLedgerStatus.FAILED_TERMINAL,
        ambiguous: false,
        terminal: true,
        lastStatusCode: null,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
        OR: [
          {
            lastErrorCode: null,
            lastError: {
              equals: LEGACY_MANAGED_BROADCAST_UPLOAD_ERROR,
              mode: 'insensitive',
            },
          },
          {
            lastErrorCode: LEGACY_PRE_DISPATCH_WATCHDOG_ERROR_CODE,
            lastError: LEGACY_PRE_DISPATCH_WATCHDOG_ERROR,
          },
        ],
      },
    });
    return result.count === 1;
  }

  private isExecutableCrashFencedMemberState(row: MaxActionLedgerExecutionState): boolean {
    if (row.terminal || row.ambiguous) {
      return false;
    }
    if (row.status === MaxActionLedgerStatus.ENQUEUED) {
      return true;
    }
    if (row.status !== MaxActionLedgerStatus.FAILED_RETRYABLE) {
      return false;
    }

    const errorCode = row.lastErrorCode?.trim().toLowerCase() ?? '';
    if (MEMBER_ACTION_PRE_DISPATCH_RETRY_ERROR_CODES.has(errorCode)) {
      return true;
    }

    return (
      row.attemptCount === 0 &&
      row.firstAttemptAt == null &&
      row.lastAttemptAt == null &&
      row.dispatchToken == null &&
      row.dispatchStartedAt == null &&
      row.dispatchBotId == null &&
      row.remoteMessageId == null
    );
  }

  private async recordProtectedSendTransition(
    job: MaxActionJob,
    mutation: MaxActionLedgerMutation,
  ): Promise<void> {
    await this.createLedgerIfAbsent(job, mutation);
    const updated = await this.updateStartedRowPreservingFirstAttempt(job, mutation, {
      jobId: job.idempotencyKey,
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: null,
      ambiguous: false,
      terminal: false,
    });
    if (updated) {
      return;
    }

    if (await this.getCompletedSendDispatchResult(job)) {
      return;
    }
    await this.assertCanExecute(job);
    throw new UnrecoverableError(
      `MAX SEND_MESSAGE ledger entry ${job.idempotencyKey} changed before execution claim`,
    );
  }

  private async recordProtectedSendFailure(
    job: MaxActionJob,
    mutation: MaxActionLedgerMutation,
  ): Promise<void> {
    await this.createLedgerIfAbsent(job, mutation);
    await this.prisma.maxActionLedgerEntry.updateMany({
      where: {
        jobId: job.idempotencyKey,
        remoteMessageId: null,
        ambiguous: false,
        terminal: false,
      },
      data: {
        ...this.buildUpdateInput(job),
        ...this.buildPlainMutationInput(mutation),
      },
    });
  }

  private async createLedgerIfAbsent(
    job: MaxActionJob,
    mutation?: MaxActionLedgerMutation,
  ): Promise<boolean> {
    const result = await this.prisma.maxActionLedgerEntry.createMany({
      data: [
        {
          ...this.buildCreateInput(job),
          ...(mutation ? this.buildPlainMutationInput(mutation) : {}),
        },
      ],
      skipDuplicates: true,
    });
    return result.count > 0;
  }

  // FLAG: Enqueue reconciliation must never cross evidence that a worker started execution.
  private async updateUnattemptedEnqueueState(
    job: MaxActionJob,
    statuses: readonly MaxActionLedgerStatus[],
    mutation: MaxActionLedgerMutation,
  ): Promise<void> {
    await this.prisma.maxActionLedgerEntry.updateMany({
      where: {
        jobId: job.idempotencyKey,
        status: { in: [...statuses] },
        ambiguous: false,
        terminal: false,
        attemptCount: 0,
        firstAttemptAt: null,
        lastAttemptAt: null,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
        completedAt: null,
      },
      data: {
        ...this.buildUpdateInput(job),
        ...this.buildPlainMutationInput(mutation),
      },
    });
  }

  private buildPlainMutationInput(
    mutation: MaxActionLedgerMutation,
  ): Omit<Prisma.MaxActionLedgerEntryCreateInput, 'id' | 'jobId' | 'actionType' | 'chatId'> {
    return {
      status: mutation.status,
      ambiguous: mutation.ambiguous,
      terminal: mutation.terminal,
      ...(mutation.enqueuedAt !== undefined ? { enqueuedAt: mutation.enqueuedAt } : {}),
      ...(mutation.firstAttemptAt !== undefined ? { firstAttemptAt: mutation.firstAttemptAt } : {}),
      ...(mutation.lastAttemptAt !== undefined ? { lastAttemptAt: mutation.lastAttemptAt } : {}),
      ...(mutation.completedAt !== undefined ? { completedAt: mutation.completedAt } : {}),
      ...(mutation.lastStatusCode !== undefined ? { lastStatusCode: mutation.lastStatusCode } : {}),
      ...(mutation.lastErrorCode !== undefined ? { lastErrorCode: mutation.lastErrorCode } : {}),
      ...(mutation.lastError !== undefined ? { lastError: mutation.lastError } : {}),
    };
  }

  private buildCreateInput(job: MaxActionJob): Prisma.MaxActionLedgerEntryCreateInput {
    return {
      jobId: job.idempotencyKey,
      actionType: job.actionType,
      chatId: job.chatId,
      botId: this.nullableString(job.botId),
      messageId: this.nullableString(job.messageId),
      userId: this.nullableString(job.userId),
      sourceTag: this.nullableString(job.sourceTag),
      trafficClass: this.nullableString(job.trafficClass),
      actionHealthLane: this.nullableString(job.actionHealthLane),
      attemptCount: 0,
      metadata: this.buildMetadata(job),
    };
  }

  private buildUpdateInput(job: MaxActionJob): Prisma.MaxActionLedgerEntryUpdateManyMutationInput {
    return {
      actionType: job.actionType,
      chatId: job.chatId,
      botId: this.nullableString(job.botId),
      messageId: this.nullableString(job.messageId),
      userId: this.nullableString(job.userId),
      sourceTag: this.nullableString(job.sourceTag),
      trafficClass: this.nullableString(job.trafficClass),
      actionHealthLane: this.nullableString(job.actionHealthLane),
      metadata: this.buildMetadata(job),
    };
  }

  private buildMetadata(job: MaxActionJob): Prisma.InputJsonObject {
    return {
      createdAt: job.createdAt,
      scheduledFor: job.scheduledFor ?? null,
      hasText: typeof job.text === 'string',
      textLength: typeof job.text === 'string' ? job.text.length : 0,
      hasOptions: Boolean(job.options),
      optionKeys:
        job.options && typeof job.options === 'object'
          ? Object.keys(job.options).sort().slice(0, 20)
          : [],
      autoDeleteDelayMs:
        typeof job.autoDeleteDelayMs === 'number' && Number.isFinite(job.autoDeleteDelayMs)
          ? Math.trunc(job.autoDeleteDelayMs)
          : null,
      sendAutoDelete: job.sendAutoDelete ?? null,
      ignoreFailureMetricStatuses: Array.isArray(job.ignoreFailureMetricStatuses)
        ? job.ignoreFailureMetricStatuses
        : [],
      candidateBotIds: Array.isArray(job.candidateBotIds) ? job.candidateBotIds : [],
      attemptedBotIds: Array.isArray(job.attemptedBotIds) ? job.attemptedBotIds : [],
      routing: job.routing
        ? {
            purpose: job.routing.purpose,
            primaryBotId: job.routing.primaryBotId ?? null,
            reason: job.routing.reason ?? null,
            action: job.routing.action ?? null,
            routingVersion: job.routing.routingVersion ?? null,
            sendRouteHalfOpenProbe: job.routing.sendRouteHalfOpenProbe ?? null,
            requiredBotId: job.routing.requiredBotId ?? null,
          }
        : null,
      ledgerContext: job.ledgerContext ?? null,
    };
  }

  private hasVerifiedSendAutoDeleteMetadata(metadata: unknown, sourceTag: string | null): boolean {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return sourceTag !== 'moderation_notice';
    }
    const row = metadata as Record<string, unknown>;
    if (!Object.hasOwn(row, 'sendAutoDelete') || row.sendAutoDelete === null) {
      return sourceTag !== 'moderation_notice';
    }
    return this.readVerifiedSendAutoDeleteMarker(metadata) !== null;
  }

  private readVerifiedSendAutoDeleteMarker(metadata: unknown): Record<string, unknown> | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }
    const marker = (metadata as Record<string, unknown>).sendAutoDelete;
    return this.isVerifiedSendAutoDeleteMarker(marker) ? (marker as Record<string, unknown>) : null;
  }

  private isVerifiedSendAutoDeleteMarker(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const marker = value as Record<string, unknown>;
    const sourceSendCompletedAt = marker.sourceSendCompletedAt;
    return (
      marker.version === 1 &&
      typeof marker.sourceSendJobId === 'string' &&
      marker.sourceSendJobId.trim().length > 0 &&
      (sourceSendCompletedAt === null ||
        (typeof sourceSendCompletedAt === 'string' &&
          Number.isFinite(Date.parse(sourceSendCompletedAt)))) &&
      typeof marker.requestedDelayMs === 'number' &&
      Number.isFinite(marker.requestedDelayMs) &&
      marker.requestedDelayMs > 0 &&
      typeof marker.originBotId === 'string' &&
      marker.originBotId.trim().length > 0 &&
      typeof marker.exactAbsenceVerifiedAt === 'string' &&
      Number.isFinite(Date.parse(marker.exactAbsenceVerifiedAt)) &&
      (marker.exactAbsenceVerificationPhase === 'preflight' ||
        marker.exactAbsenceVerificationPhase === 'post_delete')
    );
  }

  private async updateStartedRowPreservingFirstAttempt(
    job: MaxActionJob,
    mutation: MaxActionLedgerMutation,
    where: Prisma.MaxActionLedgerEntryWhereInput,
  ): Promise<boolean> {
    const firstAttempt = await this.prisma.maxActionLedgerEntry.updateMany({
      where: {
        ...where,
        firstAttemptAt: null,
      },
      data: {
        ...this.buildUpdateInput(job),
        ...this.buildPlainMutationInput(mutation),
        ...(mutation.incrementAttempt ? { attemptCount: { increment: 1 } } : {}),
      },
    });
    if (firstAttempt.count === 1) {
      return true;
    }

    const retryMutation = { ...mutation };
    delete retryMutation.firstAttemptAt;
    const retry = await this.prisma.maxActionLedgerEntry.updateMany({
      where: {
        ...where,
        firstAttemptAt: { not: null },
      },
      data: {
        ...this.buildUpdateInput(job),
        ...this.buildPlainMutationInput(retryMutation),
        ...(mutation.incrementAttempt ? { attemptCount: { increment: 1 } } : {}),
      },
    });
    return retry.count === 1;
  }

  private normalizeEnqueuedAt(value: Date | undefined, upperBound: Date): Date | undefined {
    if (!(value instanceof Date)) {
      return undefined;
    }
    const timestamp = value.getTime();
    if (!Number.isFinite(timestamp)) {
      return undefined;
    }
    return new Date(Math.min(timestamp, upperBound.getTime()));
  }

  private isAmbiguousFailure(job: MaxActionJob, error: unknown): boolean {
    const statusCode = this.extractStatusCode(error);
    return (
      this.extractErrorMessage(error).includes('ambiguous max') ||
      (this.isCrashFencedMemberAction(job.actionType) &&
        wasMaxMemberMutationAttempted(error) &&
        statusCode !== null &&
        statusCode >= 500 &&
        statusCode <= 599)
    );
  }

  private isIntrinsicallyTerminalFailure(job: MaxActionJob, error: unknown): boolean {
    const statusCode = this.extractStatusCode(error);
    const errorCode = this.extractErrorCode(error);
    const message = this.extractErrorMessage(error);
    if (statusCode === 404 || errorCode === 'chat.not.found') {
      return true;
    }
    if (
      (job.actionType === 'KICK_MEMBER' ||
        job.actionType === 'BAN_MEMBER' ||
        job.actionType === 'UNBAN_MEMBER') &&
      statusCode === 200 &&
      (message.includes('already deleted') ||
        message.includes('already been deleted') ||
        hasMaxInsufficientRightsMessage(message))
    ) {
      return true;
    }
    return job.actionType === 'SEND_MESSAGE' && message.includes('max upload payload is missing');
  }

  private isSendDispatchLedgerFinalizedError(error: unknown): boolean {
    return (
      Boolean(error) &&
      typeof error === 'object' &&
      (error as MaxSendDispatchLedgerFinalizedError).maxSendDispatchLedgerFinalized === true
    );
  }

  private assertSendAction(job: MaxActionJob): void {
    if (job.actionType !== 'SEND_MESSAGE') {
      throw new Error(`Dispatch fence is only valid for SEND_MESSAGE, received ${job.actionType}`);
    }
  }

  private requireDispatchToken(value: string): string {
    const normalized = this.nullableString(value);
    if (!normalized) {
      throw new Error('dispatchToken is required for MAX SEND_MESSAGE dispatch fence');
    }
    return normalized;
  }

  private classifyPreparedSendFailure(
    jobId: string,
    row: MaxSendDispatchState | null,
  ): MaxSendLedgerPreparationFailure {
    if (!row) {
      return {
        code: MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.MISSING_ROW,
        message: `MAX SEND_MESSAGE ledger row is missing before dispatch ${jobId}`,
        preserveExistingLedger: false,
      };
    }

    if (row.remoteMessageId != null) {
      return {
        code: MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.ALREADY_COMPLETED,
        message: `MAX SEND_MESSAGE ledger entry ${jobId} already has a remote message id; refusing another dispatch`,
        preserveExistingLedger: true,
      };
    }

    if (
      row.terminal ||
      row.ambiguous ||
      row.status === MaxActionLedgerStatus.SUCCEEDED ||
      row.status === MaxActionLedgerStatus.SKIPPED ||
      row.status === MaxActionLedgerStatus.AMBIGUOUS ||
      row.status === MaxActionLedgerStatus.FAILED_TERMINAL
    ) {
      return {
        code: MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.TERMINAL_OR_AMBIGUOUS,
        message: `MAX SEND_MESSAGE ledger entry ${jobId} is terminal or ambiguous before dispatch`,
        preserveExistingLedger: true,
      };
    }

    if (row.dispatchToken != null || row.dispatchStartedAt != null || row.dispatchBotId != null) {
      return {
        code: MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.DISPATCH_FENCE_EXISTS,
        message: `MAX SEND_MESSAGE ledger entry ${jobId} already has a dispatch fence; refusing another dispatch`,
        preserveExistingLedger: true,
      };
    }

    return {
      code: MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.UNEXPECTED_STATE,
      message: `MAX SEND_MESSAGE ledger entry ${jobId} is in an unexpected state before dispatch`,
      preserveExistingLedger: false,
    };
  }

  private createPreparedSendFailureError(
    failure: MaxSendLedgerPreparationFailure,
  ): MaxSendLedgerPreparationError {
    const error = new UnrecoverableError(failure.message) as MaxSendLedgerPreparationError;
    error.code = failure.code;
    return error;
  }

  private readCompletedSendDispatchFromState(
    job: MaxActionJob,
    state: Pick<MaxSendDispatchState, 'dispatchBotId' | 'remoteMessageId' | 'completedAt'> | null,
  ): MaxCompletedSendDispatch | null {
    if (job.actionType !== 'SEND_MESSAGE') {
      return null;
    }
    const remoteMessageId = this.nullableString(state?.remoteMessageId);
    if (!remoteMessageId) {
      return null;
    }

    const dispatchBotId = this.nullableString(state?.dispatchBotId);
    const requiredBotId = this.nullableString(job.routing?.requiredBotId);
    if (requiredBotId && dispatchBotId !== requiredBotId) {
      throw new UnrecoverableError(
        `Completed MAX SEND_MESSAGE ${job.idempotencyKey} is not bound to required bot ${requiredBotId}`,
      );
    }
    return {
      remoteMessageId,
      dispatchBotId,
      completedAt: state?.completedAt ?? null,
    };
  }

  private async readSendDispatchState(jobId: string): Promise<MaxSendDispatchState | null> {
    return this.prisma.maxActionLedgerEntry.findUnique({
      where: {
        jobId,
      },
      select: {
        status: true,
        ambiguous: true,
        terminal: true,
        dispatchToken: true,
        dispatchStartedAt: true,
        dispatchBotId: true,
        remoteMessageId: true,
        completedAt: true,
      },
    });
  }

  private extractStatusCode(error: unknown): number | null {
    const value = (error as { response?: { status?: unknown } })?.response?.status;
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
  }

  private extractErrorCode(error: unknown): string | null {
    const value = (error as { response?: { data?: { code?: unknown } }; code?: unknown })?.response
      ?.data?.code;
    if (typeof value === 'string' && value.trim().length > 0) {
      return this.truncate(value.trim().toLowerCase(), 128);
    }

    const directCode = (error as { code?: unknown })?.code;
    return typeof directCode === 'string' && directCode.trim().length > 0
      ? this.truncate(directCode.trim().toLowerCase(), 128)
      : null;
  }

  private extractPersistedFailureErrorCode(job: MaxActionJob, error: unknown): string | null {
    if (this.isCrashFencedMemberAction(job.actionType) && this.extractStatusCode(error) === 429) {
      return 'max_api_external_rate_limit';
    }
    const structuredCode = this.extractErrorCode(error);
    if (structuredCode) {
      return structuredCode;
    }
    if (!this.isCrashFencedMemberAction(job.actionType)) {
      return null;
    }

    const message = this.extractErrorMessage(error);
    const alreadyDeleted =
      message.includes('already deleted') || message.includes('already been deleted');
    const insufficientRights = hasMaxInsufficientRightsMessage(message);
    if (alreadyDeleted && insufficientRights) {
      return MAX_MEMBER_ACTION_FAILURE_ERROR_CODES.ALREADY_DELETED_OR_INSUFFICIENT_RIGHTS;
    }
    if (alreadyDeleted) {
      return MAX_MEMBER_ACTION_FAILURE_ERROR_CODES.ALREADY_DELETED;
    }
    if (insufficientRights) {
      return MAX_MEMBER_ACTION_FAILURE_ERROR_CODES.INSUFFICIENT_RIGHTS;
    }
    const statusCode = this.extractStatusCode(error);
    if (statusCode !== null) {
      return this.truncate(`max_http_${statusCode}`, 128);
    }
    return job.actionType === 'KICK_MEMBER'
      ? MAX_MEMBER_ACTION_FAILURE_ERROR_CODES.KICK_FAILED
      : MAX_MEMBER_ACTION_FAILURE_ERROR_CODES.BAN_FAILED;
  }

  private extractErrorMessage(error: unknown): string {
    const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response
      ?.data?.message;
    if (typeof responseMessage === 'string' && responseMessage.trim().length > 0) {
      return this.truncate(responseMessage.trim().toLowerCase());
    }

    if (error instanceof Error && error.message.trim().length > 0) {
      return this.truncate(error.message.trim().toLowerCase());
    }

    return this.truncate(String(error).trim().toLowerCase());
  }

  private nullableString(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private truncate(value: string, maxLength = 2_000): string {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }
}
