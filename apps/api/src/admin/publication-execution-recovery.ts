import { resolvePublicationCapacityRetry } from './publication-capacity-retry';
export { resolvePublicationRateLimitRetryAt } from './publication-capacity-retry';
import { ConflictException, type Logger } from '@nestjs/common';
import {
  ChatBotMembershipStatus,
  type ManagedBroadcast,
  type ManagedBroadcastDelivery,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
  PublicationDispatchProfile,
  PublicationDeliveryVerificationSource,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { isMaxActionRouteQuarantinedError } from '../max/max-action-dispatch-error';
import { MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE } from '../max/max-send-route-health';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import { MANAGED_BROADCAST_LOCK_STALE_MS } from './admin.service.support';
import { buildUnsafePublicationExecutionDeliveryWhere } from './publication-execution-safety';
import {
  buildPublicationDeliveryVerificationScheduledData,
  buildPublicationRouteAdvisoryLockKey,
  hasPublicationDeliveryAutomatedVerificationState,
  PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
  PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA,
  resolvePublicationOccurrenceRollupStatus,
  resolvePublicationVerificationNextSendAt,
} from './publication-delivery-verification-state';
import { isTransientPublicationPrismaError } from './publication-prisma-retry';
import {
  isPublicationOccurrenceWindowClosed,
  readPublicationLatePolicy,
  resolvePublicationDeliveryDeadline,
} from './publication-late-policy';
import { PUBLISHER_MISSED_WINDOW_BLOCKER_CODE } from './publication-dispatch-issue';
import {
  recordPublicationDispatchOutcome,
  type PublicationExecutionTiming,
} from './publication-delivery-timing';

export { PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE } from './publication-delivery-verification-state';
export { cancelPublicationDeliveryBeforeStoppedDispatch } from './publication-stopped-dispatch-cleanup';

export class ManagedBroadcastPublicationExecutionStopped extends Error {
  constructor() {
    super('Managed broadcast publication execution is no longer active');
    this.name = 'ManagedBroadcastPublicationExecutionStopped';
  }
}

const PUBLICATION_ROUTE_RECOVERY_SPACING_MS = 15 * 60_000;
const PUBLICATION_PRISMA_RETRY_DELAY_MS = 1_000;

class StalePublicationRouteQuarantineDeferralError extends Error {}

class StalePublicationRateLimitDeferralError extends Error {}
class StalePublicationPrismaDeferralError extends Error {}

export function selectManagedBroadcastDeliveryCandidates<
  T extends Pick<
    ManagedBroadcastDelivery,
    'lastErrorCode' | 'status' | 'targetChatId' | 'updatedAt'
  >,
>(deliveries: readonly T[], isPublicationExecution: boolean): T[] {
  const pending = deliveries.filter(
    (delivery) => delivery.status === ManagedBroadcastDeliveryStatus.PENDING,
  );
  if (!isPublicationExecution) {
    return pending;
  }
  const ready = pending.filter(
    (delivery) => delivery.lastErrorCode !== PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
  );
  if (ready.length > 0) {
    return ready;
  }
  return [...pending].sort((left, right) => {
    const updatedAtDifference = left.updatedAt.getTime() - right.updatedAt.getTime();
    return updatedAtDifference || left.targetChatId.localeCompare(right.targetChatId);
  });
}

export async function ensureManagedBroadcastPublicationExecutionActive(options: {
  prisma: PrismaService;
  row: Pick<
    ManagedBroadcast,
    'id' | 'lockToken' | 'publicationOccurrenceId' | 'publicationContentRevisionId'
  >;
  occurrenceIndex: number;
  reconcileStaleDeliveries?: () => Promise<void>;
  onOccurrenceScheduledAt?: (scheduledAt: Date, timing?: PublicationExecutionTiming) => void;
  logger?: Pick<Logger, 'log'>;
  preDispatchClaim?: { id: string; lockToken: string; attemptCount: number };
  activeDeliveryClaim?: {
    id: string;
    lockToken: string;
    attemptCount: number;
    sendAttemptStarted: boolean;
  };
}): Promise<boolean> {
  if (!options.row.publicationOccurrenceId) {
    return true;
  }

  const occurrence = await options.prisma.publicationOccurrence.findUnique({
    where: { id: options.row.publicationOccurrenceId },
    select: {
      status: true,
      scheduledAt: true,
      createdAt: true,
      scheduleRevision: true,
      contentRevisionId: true,
      dispatchBlockerCode: true,
      dispatchBlockedAt: true,
      dispatchFirstBlockedAt: true,
      retryAuthorizedAt: true,
      retryExpiresAt: true,
      deliveryDeadlineAt: true,
      publication: { select: { lifecycle: true } },
      schedule: { select: { id: true, revision: true, status: true, mode: true, rule: true } },
    },
  });
  if (occurrence) {
    options.onOccurrenceScheduledAt?.(occurrence.scheduledAt, {
      mode: occurrence.schedule.mode,
      intentCreatedAt: occurrence.createdAt,
      deadlineAt: resolvePublicationDeliveryDeadline(occurrence),
    });
  }
  const executionStateActive = Boolean(
    occurrence &&
    occurrence.publication.lifecycle === PublicationLifecycle.ACTIVE &&
    occurrence.schedule.status === PublicationScheduleStatus.ACTIVE &&
    occurrence.schedule.revision === occurrence.scheduleRevision &&
    (occurrence.status === PublicationOccurrenceStatus.SCHEDULED ||
      occurrence.status === PublicationOccurrenceStatus.IN_PROGRESS),
  );
  if (
    executionStateActive &&
    occurrence &&
    occurrence.contentRevisionId !== options.row.publicationContentRevisionId
  ) {
    // FLAG: A stale worker may release only its own broadcast lease here. It must never reset
    // delivery locks because a newer worker may already own and be sending that delivery.
    await options.prisma.managedBroadcast.updateMany({
      where: { id: options.row.id, lockToken: options.row.lockToken },
      data: { lockedAt: null, lockToken: null },
    });
    return false;
  }
  if (executionStateActive) {
    if (!occurrence || !(await isPublicationOccurrenceWindowClosed(options.prisma, occurrence)))
      return true;
    const preDispatchClaim = options.activeDeliveryClaim
      ? options.activeDeliveryClaim.sendAttemptStarted
        ? undefined
        : {
            ...options.activeDeliveryClaim,
            attemptCount: options.activeDeliveryClaim.attemptCount + 1,
          }
      : options.preDispatchClaim;
    const attemptWhere: Prisma.ManagedBroadcastDeliveryWhereInput = {
      publicationOccurrenceId: options.row.publicationOccurrenceId,
      OR: [
        { attemptCount: { gt: 0 } },
        { remoteMessageId: { not: null } },
        { legacySentWithoutRemoteId: true },
        {
          status: {
            in: [
              ManagedBroadcastDeliveryStatus.SENDING,
              ManagedBroadcastDeliveryStatus.SENT,
              ManagedBroadcastDeliveryStatus.AMBIGUOUS,
            ],
          },
        },
      ],
      // FLAG: Only this worker's first pre-dispatch claim is not evidence of a prior send.
      // Other SENDING rows and attempts without receipts must remain crash-fenced.
      ...(preDispatchClaim?.attemptCount === 1
        ? {
            NOT: {
              id: preDispatchClaim.id,
              lockToken: preDispatchClaim.lockToken,
              attemptCount: 1,
              status: ManagedBroadcastDeliveryStatus.SENDING,
              remoteMessageId: null,
              legacySentWithoutRemoteId: false,
            },
          }
        : {}),
    };
    if (await options.prisma.managedBroadcastDelivery.count({ where: attemptWhere })) {
      if (
        !readPublicationLatePolicy(occurrence.schedule.rule) &&
        !occurrence.deliveryDeadlineAt &&
        !occurrence.retryExpiresAt
      )
        return true;
      // FLAG: New author deadlines apply per recipient. Preserve confirmed/uncertain
      // effects and expire only claimable targets, including this exact pre-HTTP
      // claim. Calendar serialization prevents a changed revision from being expired.
      return options.prisma.$transaction(async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('publication-calendar'))`,
        );
        const fenced = await tx.publicationOccurrence.updateMany({
          where: {
            id: options.row.publicationOccurrenceId!,
            status: occurrence.status,
            scheduleRevision: occurrence.scheduleRevision,
            contentRevisionId: occurrence.contentRevisionId,
            retryAuthorizedAt: occurrence.retryAuthorizedAt,
            retryExpiresAt: occurrence.retryExpiresAt,
            deliveryDeadlineAt: occurrence.deliveryDeadlineAt,
            schedule: {
              is: {
                revision: occurrence.scheduleRevision,
                status: PublicationScheduleStatus.ACTIVE,
              },
            },
            publication: { is: { lifecycle: PublicationLifecycle.ACTIVE } },
          },
          data: {
            dispatchBlockerCode: PUBLISHER_MISSED_WINDOW_BLOCKER_CODE,
            dispatchBlockedAt: new Date(),
          },
        });
        if (fenced.count !== 1) return false;
        await tx.managedBroadcastDelivery.updateMany({
          where: {
            publicationOccurrenceId: options.row.publicationOccurrenceId!,
            status: ManagedBroadcastDeliveryStatus.PENDING,
            remoteMessageId: null,
            sentAt: null,
            legacySentWithoutRemoteId: false,
          },
          data: {
            status: ManagedBroadcastDeliveryStatus.FAILED,
            lastErrorCode: PUBLISHER_MISSED_WINDOW_BLOCKER_CODE,
            lastError: 'Истёк выбранный автором срок отправки.',
            dispatchBlockerCode: null,
            dispatchBlockedAt: null,
          },
        });
        if (preDispatchClaim) {
          await tx.managedBroadcastDelivery.updateMany({
            where: {
              id: preDispatchClaim.id,
              lockToken: preDispatchClaim.lockToken,
              status: ManagedBroadcastDeliveryStatus.SENDING,
              attemptCount: preDispatchClaim.attemptCount,
              remoteMessageId: null,
              sentAt: null,
              legacySentWithoutRemoteId: false,
            },
            data: {
              status: ManagedBroadcastDeliveryStatus.FAILED,
              attemptCount: { decrement: 1 },
              lockToken: null,
              lockedAt: null,
              lastErrorCode: PUBLISHER_MISSED_WINDOW_BLOCKER_CODE,
              lastError: 'Истёк выбранный автором срок отправки.',
            },
          });
          return false;
        }
        return true;
      });
    }
    // FLAG: The occurrence fence spans chat/channel envelopes. Preserve partial deliveries
    // and stop only a never-attempted scheduled occurrence, even after early materialization.
    const expired = await options.prisma.publicationOccurrence.updateMany({
      where: {
        id: options.row.publicationOccurrenceId,
        status: occurrence.status,
        scheduleRevision: occurrence.scheduleRevision,
        contentRevisionId: occurrence.contentRevisionId,
        dispatchBlockerCode: occurrence.dispatchBlockerCode,
        dispatchBlockedAt: occurrence.dispatchBlockedAt,
        retryAuthorizedAt: occurrence.retryAuthorizedAt,
        retryExpiresAt: occurrence.retryExpiresAt,
        deliveryDeadlineAt: occurrence.deliveryDeadlineAt,
        publication: { is: { lifecycle: PublicationLifecycle.ACTIVE } },
        schedule: {
          is: {
            revision: occurrence.scheduleRevision,
            status: PublicationScheduleStatus.ACTIVE,
          },
        },
        deliveries: { none: attemptWhere },
      },
      data: {
        status:
          occurrence.schedule.mode === PublicationScheduleMode.RECURRENCE
            ? PublicationOccurrenceStatus.CANCELED
            : PublicationOccurrenceStatus.FAILED,
        dispatchBlockerCode:
          occurrence.schedule.mode === PublicationScheduleMode.RECURRENCE
            ? 'PUBLISHER_WINDOW_EXPIRED'
            : PUBLISHER_MISSED_WINDOW_BLOCKER_CODE,
        dispatchBlockedAt: new Date(),
        dispatchFirstBlockedAt: occurrence.dispatchFirstBlockedAt ?? new Date(),
      },
    });
    if (expired.count === 0) {
      await options.prisma.managedBroadcast.updateMany({
        where: { id: options.row.id, lockToken: options.row.lockToken },
        data: { lockedAt: null, lockToken: null },
      });
      return false;
    }
    if (options.logger) {
      recordPublicationDispatchOutcome(options.logger, {
        mode: occurrence.schedule.mode,
        scope: 'occurrence',
        outcome: 'missed_window',
      });
    }
  }

  if (options.reconcileStaleDeliveries) {
    // FLAG: Resolve an old in-flight send from the durable ledger before stopping its envelope.
    // A fresh SENDING row is preserved below so the owning worker can persist the MAX result.
    await options.reconcileStaleDeliveries();
  }

  await options.prisma.$transaction(async (tx) => {
    if (!options.row.lockToken) {
      return;
    }
    const leaseRenewed = await tx.managedBroadcast.updateMany({
      where: { id: options.row.id, lockToken: options.row.lockToken },
      data: { lockedAt: new Date() },
    });
    if (leaseRenewed.count === 0) {
      return;
    }

    // FLAG: Cancel claimable rows before checking SENDING. The competing delivery claim and this
    // update serialize on the row, so either the claim is preserved or its pre-dispatch CAS fails.
    await tx.managedBroadcastDelivery.updateMany({
      where: {
        broadcastId: options.row.id,
        occurrenceIndex: options.occurrenceIndex,
        status: {
          in: [ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.FAILED],
        },
      },
      data: {
        status: ManagedBroadcastDeliveryStatus.CANCELED,
        lockedAt: null,
        lockToken: null,
        lastError: 'Публикация остановлена до отправки.',
      },
    });

    const sending = await tx.managedBroadcastDelivery.count({
      where: {
        broadcastId: options.row.id,
        occurrenceIndex: options.occurrenceIndex,
        status: ManagedBroadcastDeliveryStatus.SENDING,
      },
    });
    if (sending > 0) {
      await tx.managedBroadcast.updateMany({
        where: { id: options.row.id, lockToken: options.row.lockToken },
        data: { lockedAt: null, lockToken: null },
      });
      return;
    }

    await tx.managedBroadcastCalendarReservation.deleteMany({
      where: { broadcastId: options.row.id, occurrenceIndex: options.occurrenceIndex },
    });
    const deleted = await tx.managedBroadcast.deleteMany({
      where: {
        id: options.row.id,
        lockToken: options.row.lockToken,
        sentCount: 0,
        deliveries: { none: buildUnsafePublicationExecutionDeliveryWhere() },
      },
    });
    if (deleted.count > 0) {
      return;
    }
    await tx.managedBroadcast.updateMany({
      where: { id: options.row.id, lockToken: options.row.lockToken },
      data: {
        status: ManagedBroadcastStatus.CANCELED,
        nextSendAt: null,
        lockedAt: null,
        lockToken: null,
        lastError: 'Публикация остановлена до завершения доставки.',
      },
    });
  });
  return false;
}

export async function deferClaimedPublicationEnvelopeAfterTransientPrismaError(options: {
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'logger'>;
  broadcastId: string;
  broadcastLockToken: string;
  error: unknown;
}): Promise<Date | null> {
  if (!isTransientPublicationPrismaError(options.error)) {
    return null;
  }

  const retryAt = new Date(Date.now() + PUBLICATION_PRISMA_RETRY_DELAY_MS);
  const deferred = await options.context.prisma.managedBroadcast.updateMany({
    where: {
      id: options.broadcastId,
      publicationOccurrenceId: { not: null },
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      status: ManagedBroadcastStatus.ACTIVE,
      lockToken: options.broadcastLockToken,
    },
    data: {
      nextSendAt: retryAt,
      lockedAt: null,
      lockToken: null,
      lastError: null,
    },
  });
  if (deferred.count !== 1) {
    return null;
  }

  options.context.logger.warn(
    {
      broadcastId: options.broadcastId,
      retryAt: retryAt.toISOString(),
      err: options.error instanceof Error ? options.error.message : String(options.error),
    },
    'Released a claimed publication envelope after a transient database failure',
  );
  return retryAt;
}

export async function deferPublicationAfterPreDispatchPrismaError(options: {
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'logger'>;
  row: Pick<ManagedBroadcast, 'id' | 'publicationOccurrenceId' | 'status'>;
  occurrenceIndex: number;
  broadcastLockToken: string;
  delivery?: Pick<ManagedBroadcastDelivery, 'attemptCount' | 'id' | 'targetChatId'> & {
    lockToken: string;
  };
  sendAttemptStarted: boolean;
  error: unknown;
}): Promise<Date | null> {
  // FLAG: Only a transient database failure proven to precede MAX dispatch may recycle the exact
  // delivery claim. A send-attempt marker, remote id, foreign token, or terminal envelope fences it.
  if (
    !options.row.publicationOccurrenceId ||
    options.row.status !== ManagedBroadcastStatus.ACTIVE ||
    options.sendAttemptStarted ||
    (options.error as { managedBroadcastSendStarted?: unknown })?.managedBroadcastSendStarted ===
      true ||
    !isTransientPublicationPrismaError(options.error)
  ) {
    return null;
  }

  const retryAt = new Date(Date.now() + PUBLICATION_PRISMA_RETRY_DELAY_MS);
  try {
    const deferred = await options.context.prisma.$transaction(async (tx) => {
      if (options.delivery) {
        const resetDelivery = await tx.managedBroadcastDelivery.updateMany({
          where: {
            id: options.delivery.id,
            broadcastId: options.row.id,
            occurrenceIndex: options.occurrenceIndex,
            status: ManagedBroadcastDeliveryStatus.SENDING,
            attemptCount: options.delivery.attemptCount + 1,
            remoteMessageId: null,
            lockToken: options.delivery.lockToken,
          },
          data: {
            status: ManagedBroadcastDeliveryStatus.PENDING,
            attemptCount: { decrement: 1 },
            botId: null,
            remoteMessageId: null,
            ...PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA,
            legacySentWithoutRemoteId: false,
            sentAt: null,
            lockedAt: null,
            lockToken: null,
            lastErrorCode: null,
            lastError: null,
            dispatchBlockerCode: null,
            dispatchBlockedAt: null,
          },
        });
        if (resetDelivery.count !== 1) {
          const untouchedDelivery = await tx.managedBroadcastDelivery.count({
            where: {
              id: options.delivery.id,
              broadcastId: options.row.id,
              occurrenceIndex: options.occurrenceIndex,
              status: ManagedBroadcastDeliveryStatus.PENDING,
              attemptCount: options.delivery.attemptCount,
              remoteMessageId: null,
              lockedAt: null,
              lockToken: null,
            },
          });
          if (untouchedDelivery !== 1) {
            throw new StalePublicationPrismaDeferralError();
          }
        }
      }

      const broadcastDeferred = await tx.managedBroadcast.updateMany({
        where: {
          id: options.row.id,
          publicationOccurrenceId: options.row.publicationOccurrenceId,
          status: ManagedBroadcastStatus.ACTIVE,
          lockToken: options.broadcastLockToken,
        },
        data: {
          nextSendAt: retryAt,
          lockedAt: null,
          lockToken: null,
          lastError: null,
        },
      });
      if (broadcastDeferred.count !== 1) {
        throw new StalePublicationPrismaDeferralError();
      }
      return true;
    });
    if (!deferred) {
      return null;
    }
  } catch (error: unknown) {
    if (error instanceof StalePublicationPrismaDeferralError) {
      return null;
    }
    throw error;
  }

  options.context.logger.warn(
    {
      broadcastId: options.row.id,
      occurrenceIndex: options.occurrenceIndex,
      deliveryId: options.delivery?.id ?? null,
      targetChatId: options.delivery?.targetChatId ?? null,
      retryAt: retryAt.toISOString(),
      err: options.error instanceof Error ? options.error.message : String(options.error),
    },
    'Deferred publication execution after a transient pre-dispatch database failure',
  );
  return retryAt;
}

export async function settlePublicationDeliveryAfterAttemptPersistenceError(options: {
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'logger'>;
  broadcastId: string;
  occurrenceIndex: number;
  delivery: Pick<ManagedBroadcastDelivery, 'attemptCount' | 'id' | 'targetChatId'> & {
    lockToken: string;
  };
  botId: string | null;
  remoteMessageId: string;
  sentAt: Date;
  responseTargetMismatch: string | null;
  error: unknown;
}): Promise<'sent' | 'ambiguous' | 'lost'> {
  const status = options.responseTargetMismatch
    ? ManagedBroadcastDeliveryStatus.AMBIGUOUS
    : ManagedBroadcastDeliveryStatus.SENT;
  const settled = await options.context.prisma.managedBroadcastDelivery.updateMany({
    where: {
      id: options.delivery.id,
      broadcastId: options.broadcastId,
      occurrenceIndex: options.occurrenceIndex,
      status: ManagedBroadcastDeliveryStatus.SENDING,
      attemptCount: options.delivery.attemptCount + 1,
      lockToken: options.delivery.lockToken,
    },
    data: {
      status,
      botId: options.botId,
      remoteMessageId: options.remoteMessageId,
      ...(status === ManagedBroadcastDeliveryStatus.SENT
        ? buildPublicationDeliveryVerificationScheduledData(options.sentAt)
        : PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA),
      legacySentWithoutRemoteId: false,
      sentAt: options.sentAt,
      lockedAt: null,
      lockToken: null,
      lastErrorCode: null,
      lastError: options.responseTargetMismatch,
    },
  });
  if (settled.count !== 1) {
    return 'lost';
  }

  options.context.logger.warn(
    {
      broadcastId: options.broadcastId,
      occurrenceIndex: options.occurrenceIndex,
      deliveryId: options.delivery.id,
      targetChatId: options.delivery.targetChatId,
      remoteMessageId: options.remoteMessageId,
      status,
      err: options.error instanceof Error ? options.error.message : String(options.error),
    },
    'Recovered a known MAX response after publication delivery persistence failed',
  );
  return status === ManagedBroadcastDeliveryStatus.SENT ? 'sent' : 'ambiguous';
}

export async function deferPublicationDeliveryAfterPreDispatchThrottle(options: {
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'logger'>;
  row: Pick<ManagedBroadcast, 'id' | 'publicationOccurrenceId'>;
  delivery: Pick<ManagedBroadcastDelivery, 'id' | 'targetChatId' | 'attemptCount'> &
    Partial<
      Pick<
        ManagedBroadcastDelivery,
        'capacityDeferralCount' | 'rateLimitDeferralCount' | 'firstDeferredAt'
      >
    >;
  reason: 'startup' | 'scheduled' | 'manual_retry' | 'immediate' | 'deadline';
  occurrenceIndex: number;
  broadcastLockToken: string;
  deliveryLockToken: string;
  sendAttemptStarted?: boolean;
  error: unknown;
}): Promise<Date | null> {
  // FLAG: Recycle only an exact limiter/circuit rejection before HTTP dispatch or an exact HTTP
  // 429, which is definitive. Timeouts, 5xx responses, and other attempted sends remain terminal.
  const occurrenceId = options.row.publicationOccurrenceId;
  const now = new Date();
  const decision = resolvePublicationCapacityRetry(
    options.error,
    now,
    options.delivery.rateLimitDeferralCount ?? 0,
    Math.random(),
  );
  if (!occurrenceId || !decision) return null;
  const externalRateLimit = decision.reason === 'max_rate_limit';
  if (!externalRateLimit && options.sendAttemptStarted !== false) return null;
  const retryAt = decision.retryAt;
  const undoClaim = options.sendAttemptStarted === false && !externalRateLimit;

  try {
    const deferred = await options.context.prisma.$transaction(async (tx) => {
      const broadcastDeferred = await tx.managedBroadcast.updateMany({
        where: {
          id: options.row.id,
          publicationOccurrenceId: occurrenceId,
          status: ManagedBroadcastStatus.ACTIVE,
          lockToken: options.broadcastLockToken,
        },
        data: { nextSendAt: now },
      });
      if (broadcastDeferred.count !== 1) {
        return false;
      }

      const deliveryDeferred = await tx.managedBroadcastDelivery.updateMany({
        where: {
          id: options.delivery.id,
          status: ManagedBroadcastDeliveryStatus.SENDING,
          lockToken: options.deliveryLockToken,
          attemptCount: options.delivery.attemptCount + 1,
          remoteMessageId: null,
          sentAt: null,
        },
        data: {
          status: ManagedBroadcastDeliveryStatus.PENDING,
          nextAttemptAt: retryAt,
          waitReason: decision.reason,
          capacityDeferralCount: { increment: 1 },
          ...(externalRateLimit ? { rateLimitDeferralCount: { increment: 1 } } : {}),
          firstDeferredAt: options.delivery.firstDeferredAt ?? now,
          lastDeferredAt: now,
          ...(undoClaim ? { attemptCount: { decrement: 1 } } : {}),
          botId: null,
          remoteMessageId: null,
          ...PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA,
          legacySentWithoutRemoteId: false,
          sentAt: null,
          lockedAt: null,
          lockToken: null,
          lastErrorCode: null,
          lastError: null,
        },
      });
      if (deliveryDeferred.count !== 1) {
        throw new StalePublicationRateLimitDeferralError();
      }
      return true;
    });
    if (!deferred) {
      return null;
    }
  } catch (error: unknown) {
    if (error instanceof StalePublicationRateLimitDeferralError) {
      return null;
    }
    throw error;
  }

  options.context.logger.warn(
    {
      broadcastId: options.row.id,
      occurrenceIndex: options.occurrenceIndex,
      deliveryId: options.delivery.id,
      targetChatId: options.delivery.targetChatId,
      retryAt: retryAt.toISOString(),
      err: options.error instanceof Error ? options.error.message : String(options.error),
    },
    'Deferred publication recipient until MAX capacity is available',
  );
  return retryAt;
}

export async function deferPublicationDeliveryAfterRouteQuarantine(options: {
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'logger'>;
  row: Pick<ManagedBroadcast, 'id' | 'publicationOccurrenceId'>;
  delivery: Pick<ManagedBroadcastDelivery, 'id' | 'targetChatId'>;
  occurrenceIndex: number;
  broadcastLockToken: string;
  deliveryLockToken: string;
  error: unknown;
}): Promise<Date | null> {
  if (!options.row.publicationOccurrenceId || !isMaxActionRouteQuarantinedError(options.error)) {
    return null;
  }

  const quarantineError = options.error;
  const now = new Date();
  const requestedRetryAt = new Date(Math.max(now.getTime(), quarantineError.retryAt.getTime()));
  try {
    const deferredUntil = await options.context.prisma.$transaction(async (tx) => {
      // FLAG: Serialize reservations per target so an opened route gets one canary at a time.
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${buildPublicationRouteAdvisoryLockKey(options.delivery.targetChatId)}))`,
      );
      const quarantinedCandidateBotIds = Array.from(
        new Set(
          quarantineError.quarantinedCandidateBotIds.map((botId) => botId.trim()).filter(Boolean),
        ),
      );
      const routeStillQuarantined =
        quarantinedCandidateBotIds.length > 0 &&
        (await tx.chatBotMembership.count({
          where: {
            chatId: options.delivery.targetChatId,
            botId: { in: quarantinedCandidateBotIds },
            status: ChatBotMembershipStatus.ACTIVE,
            OR: [
              { sendRouteQuarantinedUntil: { gt: now } },
              {
                sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
                sendRouteFailureCount: { gte: 2 },
              },
            ],
          },
        })) > 0;
      const latestReservation = routeStillQuarantined
        ? await tx.managedBroadcast.aggregate({
            where: {
              id: { not: options.row.id },
              publicationOccurrenceId: { not: null },
              status: ManagedBroadcastStatus.ACTIVE,
              nextSendAt: { gt: now },
              deliveries: {
                some: {
                  targetChatId: options.delivery.targetChatId,
                  status: ManagedBroadcastDeliveryStatus.PENDING,
                  lastErrorCode: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
                },
              },
            },
            _max: { nextSendAt: true },
          })
        : { _max: { nextSendAt: null } };
      const latestReservedAt = latestReservation._max.nextSendAt;
      const reservedAt = routeStillQuarantined
        ? new Date(
            Math.max(
              requestedRetryAt.getTime(),
              latestReservedAt
                ? latestReservedAt.getTime() + PUBLICATION_ROUTE_RECOVERY_SPACING_MS
                : 0,
            ),
          )
        : now;
      const deferredBroadcast = await tx.managedBroadcast.updateMany({
        where: {
          id: options.row.id,
          publicationOccurrenceId: options.row.publicationOccurrenceId,
          status: ManagedBroadcastStatus.ACTIVE,
          lockToken: options.broadcastLockToken,
        },
        data: { nextSendAt: reservedAt },
      });
      if (deferredBroadcast.count !== 1) {
        return null;
      }
      const deferredDelivery = await tx.managedBroadcastDelivery.updateMany({
        where: {
          id: options.delivery.id,
          status: ManagedBroadcastDeliveryStatus.SENDING,
          lockToken: options.deliveryLockToken,
          attemptCount: { gt: 0 },
        },
        data: {
          status: ManagedBroadcastDeliveryStatus.PENDING,
          attemptCount: { decrement: 1 },
          botId: null,
          remoteMessageId: null,
          ...PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA,
          legacySentWithoutRemoteId: false,
          sentAt: null,
          lockedAt: null,
          lockToken: null,
          lastErrorCode: routeStillQuarantined
            ? PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE
            : null,
          lastError: routeStillQuarantined
            ? 'Маршрут отправки временно изолирован после исчезновения сообщения.'
            : null,
        },
      });
      if (deferredDelivery.count !== 1) {
        throw new StalePublicationRouteQuarantineDeferralError();
      }
      return { reservedAt, routeStillQuarantined };
    });
    if (!deferredUntil) {
      return null;
    }
    options.context.logger.warn(
      {
        broadcastId: options.row.id,
        occurrenceIndex: options.occurrenceIndex,
        deliveryId: options.delivery.id,
        targetChatId: options.delivery.targetChatId,
        quarantinedBotIds: quarantineError.quarantinedCandidateBotIds,
        retryAt: deferredUntil.reservedAt.toISOString(),
        routeStillQuarantined: deferredUntil.routeStillQuarantined,
      },
      deferredUntil.routeStillQuarantined
        ? 'Deferred publication delivery behind the send-route quarantine circuit'
        : 'Requeued publication delivery after a stale send-route quarantine outcome',
    );
    return deferredUntil.reservedAt;
  } catch (error: unknown) {
    if (error instanceof StalePublicationRouteQuarantineDeferralError) {
      return null;
    }
    throw error;
  }
}

export async function deferManagedBroadcastWithFreshDeliveryLocks(
  prisma: PrismaService,
  broadcastId: string,
  occurrenceIndex: number,
  leaseLockToken: string,
): Promise<boolean> {
  const staleLockBefore = new Date(Date.now() - MANAGED_BROADCAST_LOCK_STALE_MS);
  const inFlightCount = await prisma.managedBroadcastDelivery.count({
    where: {
      broadcastId,
      occurrenceIndex,
      status: ManagedBroadcastDeliveryStatus.SENDING,
      lockedAt: { gte: staleLockBefore },
    },
  });
  if (inFlightCount === 0) {
    return false;
  }

  await prisma.managedBroadcast.updateMany({
    where: { id: broadcastId, lockToken: leaseLockToken },
    data: { lockedAt: null, lockToken: null },
  });
  return true;
}

export async function reconcileOrphanedPublicationOccurrences(options: {
  prisma: PrismaService;
  logger: Logger;
  limit: number;
  maxBatch: number;
  staleBefore: Date;
}): Promise<void> {
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
    return;
  }
  const boundedLimit = Math.min(options.limit, options.maxBatch);
  // FLAG: An old IN_PROGRESS occurrence without any execution envelope must never be put back
  // into SCHEDULED automatically. Only the explicit retry flow may authorize a late send.
  const rows = await options.prisma.$queryRaw<
    Array<{ id: string; status: PublicationOccurrenceStatus }>
  >(Prisma.sql`
    WITH "orphan_candidates" AS (
      SELECT
        po."id",
        CASE
          WHEN po."schedule_revision" <> ps."revision"
            OR ps."status" IN (
              'DRAFT'::"PublicationScheduleStatus",
              'PAUSED'::"PublicationScheduleStatus",
              'COMPLETED'::"PublicationScheduleStatus",
              'CANCELED'::"PublicationScheduleStatus"
            )
            OR p."lifecycle" IN (
              'DRAFT'::"PublicationLifecycle",
              'PAUSED'::"PublicationLifecycle",
              'COMPLETED'::"PublicationLifecycle",
              'CANCELED'::"PublicationLifecycle"
            )
          THEN 'CANCELED'::"PublicationOccurrenceStatus"
          ELSE 'FAILED'::"PublicationOccurrenceStatus"
        END AS "next_status"
      FROM "publication_occurrences" AS po
      INNER JOIN "publication_schedules" AS ps ON ps."id" = po."schedule_id"
      INNER JOIN "publications" AS p ON p."id" = po."publication_id"
      WHERE po."status" = 'IN_PROGRESS'::"PublicationOccurrenceStatus"
        AND po."scheduled_at" < ${options.staleBefore}
        AND po."legacy_broadcast_id" IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "managed_broadcasts" AS mb
          WHERE mb."publication_occurrence_id" = po."id"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "managed_broadcast_deliveries" AS d
          WHERE d."publication_occurrence_id" = po."id"
        )
      ORDER BY po."scheduled_at" ASC, po."id" ASC
      LIMIT ${boundedLimit}
      FOR UPDATE OF po SKIP LOCKED
    )
    UPDATE "publication_occurrences" AS po
    SET
      "status" = candidate."next_status",
      "updated_at" = CURRENT_TIMESTAMP
    FROM "orphan_candidates" AS candidate
    WHERE po."id" = candidate."id"
      AND po."status" = 'IN_PROGRESS'::"PublicationOccurrenceStatus"
    RETURNING po."id", po."status"
  `);
  if (rows.length === 0) {
    return;
  }

  options.logger.warn(
    {
      recovered: rows.length,
      canceled: rows.filter((row) => row.status === PublicationOccurrenceStatus.CANCELED).length,
      failed: rows.filter((row) => row.status === PublicationOccurrenceStatus.FAILED).length,
      cutoff: options.staleBefore.toISOString(),
    },
    'Reconciled publication occurrences without execution envelopes',
  );
}

export async function recordPublicationDeliveryResolution(
  tx: Prisma.TransactionClient,
  params: {
    delivery: {
      id: string;
      targetChatId: string;
      status: ManagedBroadcastDeliveryStatus;
      remoteMessageId: string | null;
    };
    actorUserId: string;
    publicationId: string;
    occurrenceId: string;
    requestId: string;
    resolution: 'mark_sent' | 'mark_failed';
  },
): Promise<void> {
  const { delivery, actorUserId, ...decision } = params;
  await tx.auditLog.create({
    data: {
      chatId: delivery.targetChatId,
      actorUserId,
      action: 'PUBLICATION_DELIVERY_RESOLVED',
      payload: {
        ...decision,
        deliveryId: delivery.id,
        previousStatus: delivery.status,
        hadRemoteMessageId: delivery.remoteMessageId !== null,
      },
    },
  });
}

export async function syncPublicationBroadcastAfterDeliveryResolution(
  tx: any,
  broadcastId: string,
  occurrenceIndex: number,
): Promise<void> {
  type DeliveryResolutionRow = {
    status: ManagedBroadcastDeliveryStatus;
    sentAt: Date | null;
    remoteMessageId: string | null;
    remoteMessageVerifiedAt: Date | null;
    remoteMessageVerificationAttemptCount: number;
    remoteMessageVerificationAbsentCount: number;
    remoteMessageVerificationPresentCount: number;
    remoteMessageVerificationAttemptedAt: Date | null;
    remoteMessageVerificationNextAt: Date | null;
    remoteMessageVerificationSource: PublicationDeliveryVerificationSource | null;
    lastErrorCode: string | null;
  };
  const deliveries: DeliveryResolutionRow[] = await tx.managedBroadcastDelivery.findMany({
    where: { broadcastId, occurrenceIndex },
    select: {
      status: true,
      sentAt: true,
      remoteMessageId: true,
      remoteMessageVerifiedAt: true,
      remoteMessageVerificationAttemptCount: true,
      remoteMessageVerificationAbsentCount: true,
      remoteMessageVerificationPresentCount: true,
      remoteMessageVerificationAttemptedAt: true,
      remoteMessageVerificationNextAt: true,
      remoteMessageVerificationSource: true,
      lastErrorCode: true,
    },
  });
  if (deliveries.length === 0) {
    return;
  }
  const unresolved = deliveries.some((delivery) =>
    new Set<ManagedBroadcastDeliveryStatus>([
      ManagedBroadcastDeliveryStatus.SENDING,
      ManagedBroadcastDeliveryStatus.AMBIGUOUS,
    ]).has(delivery.status),
  );
  if (unresolved) {
    return;
  }
  const hasPending = deliveries.some(
    (delivery) => delivery.status === ManagedBroadcastDeliveryStatus.PENDING,
  );
  const hasReadyPending = deliveries.some(
    (delivery) =>
      delivery.status === ManagedBroadcastDeliveryStatus.PENDING &&
      delivery.lastErrorCode !== PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
  );
  const unverified = deliveries.filter(
    (delivery) =>
      delivery.status === ManagedBroadcastDeliveryStatus.SENT &&
      delivery.remoteMessageId !== null &&
      delivery.remoteMessageVerifiedAt === null &&
      hasPublicationDeliveryAutomatedVerificationState(delivery),
  );
  if (hasPending || unverified.length > 0) {
    const verificationNextAt =
      unverified.length > 0 ? resolvePublicationVerificationNextSendAt(unverified, false) : null;
    let nextSendAt = hasReadyPending ? new Date() : verificationNextAt;
    if (hasPending && !hasReadyPending) {
      const current = await tx.managedBroadcast.findUnique({
        where: { id: broadcastId },
        select: { nextSendAt: true },
      });
      if (current?.nextSendAt && (!nextSendAt || current.nextSendAt < nextSendAt)) {
        nextSendAt = current.nextSendAt;
      }
    }
    nextSendAt ??= new Date();
    await tx.managedBroadcast.updateMany({
      where: { id: broadcastId, status: { not: ManagedBroadcastStatus.CANCELED } },
      data: {
        status: ManagedBroadcastStatus.ACTIVE,
        nextSendAt,
        lockedAt: null,
        lockToken: null,
        lastError: null,
      },
    });
    return;
  }

  const sent = deliveries.filter(
    (delivery) => delivery.status === ManagedBroadcastDeliveryStatus.SENT,
  ).length;
  const failed = deliveries.length - sent;
  const status =
    failed === 0
      ? ManagedBroadcastStatus.COMPLETED
      : sent > 0
        ? ManagedBroadcastStatus.PARTIAL
        : ManagedBroadcastStatus.FAILED;
  await tx.managedBroadcast.updateMany({
    where: { id: broadcastId, status: { not: ManagedBroadcastStatus.CANCELED } },
    data: {
      status,
      ...(status === ManagedBroadcastStatus.COMPLETED
        ? { sentCount: occurrenceIndex, nextSendAt: null, lastError: null }
        : { lastError: 'Не все получатели получили публикацию.' }),
      lockedAt: null,
      lockToken: null,
    },
  });
  if (status === ManagedBroadcastStatus.COMPLETED) {
    await tx.managedBroadcastCalendarReservation.deleteMany({
      where: { broadcastId, occurrenceIndex },
    });
    await tx.managedBroadcastOccurrence.updateMany({
      where: { broadcastId, occurrenceIndex },
      data: { status: ManagedBroadcastStatus.COMPLETED },
    });
  }
}

export async function syncResolvedPublicationOccurrence(
  tx: Prisma.TransactionClient,
  occurrenceId: string,
): Promise<void> {
  const occurrence = await tx.publicationOccurrence.findUnique({
    where: { id: occurrenceId },
    select: {
      id: true,
      publicationId: true,
      status: true,
      updatedAt: true,
      scheduleId: true,
      scheduleRevision: true,
      contentRevisionId: true,
      scheduledAt: true,
      publication: { select: { lifecycle: true } },
      schedule: { select: { revision: true, status: true } },
      legacyBroadcasts: {
        select: {
          status: true,
          deliveries: {
            select: {
              status: true,
              remoteMessageId: true,
              remoteMessageVerifiedAt: true,
              remoteMessageVerificationAttemptCount: true,
              remoteMessageVerificationAbsentCount: true,
              remoteMessageVerificationPresentCount: true,
              remoteMessageVerificationAttemptedAt: true,
              remoteMessageVerificationNextAt: true,
              remoteMessageVerificationSource: true,
            },
          },
        },
      },
    },
  });
  if (!occurrence || occurrence.status === PublicationOccurrenceStatus.CANCELED) {
    return;
  }
  const deliveries = occurrence.legacyBroadcasts.flatMap((broadcast) => broadcast.deliveries);
  if (deliveries.length === 0) {
    return;
  }
  const nextStatus = resolvePublicationOccurrenceRollupStatus(
    occurrence.legacyBroadcasts,
    occurrence.scheduledAt,
  );
  const runnable =
    nextStatus === PublicationOccurrenceStatus.SCHEDULED ||
    nextStatus === PublicationOccurrenceStatus.IN_PROGRESS;
  const canReactivateParents =
    runnable &&
    (occurrence.publication.lifecycle === PublicationLifecycle.ACTIVE ||
      occurrence.publication.lifecycle === PublicationLifecycle.ERROR) &&
    (occurrence.schedule.status === PublicationScheduleStatus.ACTIVE ||
      occurrence.schedule.status === PublicationScheduleStatus.ERROR);
  const throwConflict = (): never => {
    throw new ConflictException('Запуск публикации уже изменился. Обновите экран и повторите.');
  };

  // FLAG: A manual delivery decision, its envelope rollup, and its occurrence rollup are one
  // commit. Run the CAS even for an unchanged status so its row lock fences concurrent rollups.
  const updated = await tx.publicationOccurrence.updateMany({
    where: {
      id: occurrence.id,
      publicationId: occurrence.publicationId,
      status: occurrence.status,
      updatedAt: occurrence.updatedAt,
      scheduleId: occurrence.scheduleId,
      scheduleRevision: occurrence.scheduleRevision,
      contentRevisionId: occurrence.contentRevisionId,
      publication: { is: { lifecycle: occurrence.publication.lifecycle } },
      schedule: {
        is: {
          revision: occurrence.schedule.revision,
          status: occurrence.schedule.status,
        },
      },
    },
    data: { status: nextStatus },
  });
  if (updated.count !== 1) {
    throwConflict();
  }
  if (!canReactivateParents) {
    return;
  }
  if (occurrence.schedule.revision !== occurrence.scheduleRevision) {
    throwConflict();
  }

  const activatedPublication = await tx.publication.updateMany({
    where: {
      id: occurrence.publicationId,
      lifecycle: occurrence.publication.lifecycle,
      schedule: {
        is: {
          id: occurrence.scheduleId,
          revision: occurrence.scheduleRevision,
          status: occurrence.schedule.status,
        },
      },
    },
    data: { lifecycle: PublicationLifecycle.ACTIVE },
  });
  if (activatedPublication.count !== 1) {
    throwConflict();
  }
  const activatedSchedule = await tx.publicationSchedule.updateMany({
    where: {
      id: occurrence.scheduleId,
      publicationId: occurrence.publicationId,
      revision: occurrence.scheduleRevision,
      status: occurrence.schedule.status,
      publication: {
        is: {
          id: occurrence.publicationId,
          lifecycle: PublicationLifecycle.ACTIVE,
        },
      },
    },
    data: { status: PublicationScheduleStatus.ACTIVE, lastError: null },
  });
  if (activatedSchedule.count !== 1) {
    throwConflict();
  }
}
