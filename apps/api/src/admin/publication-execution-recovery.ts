import type { Logger } from '@nestjs/common';
import {
  ChatBotMembershipStatus,
  type ManagedBroadcast,
  type ManagedBroadcastDelivery,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
  PublicationDeliveryVerificationSource,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { isMaxActionRouteQuarantinedError } from '../max/max-action-dispatch-error';
import { MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE } from '../max/max-send-route-health';
import { extractMaxErrorStatus } from './admin-legacy-utils';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import {
  MANAGED_BROADCAST_LOCK_STALE_MS,
  type BroadcastOccurrenceResult,
} from './admin.service.support';
import { buildUnsafePublicationExecutionDeliveryWhere } from './publication-execution-safety';
import {
  buildPublicationRouteAdvisoryLockKey,
  hasPublicationDeliveryAutomatedVerificationState,
  PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
  PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA,
  resolvePublicationVerificationNextSendAt,
} from './publication-delivery-verification-state';

export { PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE } from './publication-delivery-verification-state';

export class ManagedBroadcastPublicationExecutionStopped extends Error {
  constructor() {
    super('Managed broadcast publication execution is no longer active');
    this.name = 'ManagedBroadcastPublicationExecutionStopped';
  }
}

const PUBLICATION_ROUTE_RECOVERY_SPACING_MS = 15 * 60_000;
const PUBLICATION_RATE_LIMIT_RETRY_STEP_MS = 60_000;
const PUBLICATION_RATE_LIMIT_MAX_RETRY_AFTER_MS = 60 * 60_000;

class StalePublicationRouteQuarantineDeferralError extends Error {}
class StalePublicationRateLimitDeferralError extends Error {}

function collectPublicationRateLimitErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 4 && current && !visited.has(current); depth += 1) {
    chain.push(current);
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function readPublicationRateLimitRetryAfterMs(error: unknown, nowMs: number): number {
  for (const current of collectPublicationRateLimitErrorChain(error)) {
    const record = current as {
      retryAfterMs?: unknown;
      response?: {
        data?: { retry_after_ms?: unknown; retryAfterMs?: unknown };
        headers?: Record<string, unknown>;
      };
    };
    for (const rawValue of [
      record.retryAfterMs,
      record.response?.data?.retry_after_ms,
      record.response?.data?.retryAfterMs,
    ]) {
      const numeric = Number(rawValue);
      if (Number.isFinite(numeric) && numeric > 0) {
        return Math.min(PUBLICATION_RATE_LIMIT_MAX_RETRY_AFTER_MS, Math.ceil(numeric));
      }
    }

    const headers = record.response?.headers;
    const rawHeader = headers?.['retry-after'] ?? headers?.['Retry-After'];
    const header =
      Array.isArray(rawHeader) && rawHeader.length > 0
        ? String(rawHeader[0])
        : String(rawHeader ?? '');
    if (!header) {
      continue;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(
        PUBLICATION_RATE_LIMIT_MAX_RETRY_AFTER_MS,
        Math.max(1_000, Math.ceil(seconds * 1_000)),
      );
    }
    const retryAtMs = Date.parse(header);
    if (Number.isFinite(retryAtMs)) {
      return Math.min(
        PUBLICATION_RATE_LIMIT_MAX_RETRY_AFTER_MS,
        Math.max(1_000, retryAtMs - nowMs),
      );
    }
  }
  return 0;
}

export function resolvePublicationRateLimitRetryAt(error: unknown, now = new Date()): Date | null {
  const errorChain = collectPublicationRateLimitErrorChain(error);
  const exactExternalRateLimit = errorChain.some(
    (current) => extractMaxErrorStatus(current) === 429,
  );
  const internalPreDispatchRateLimit =
    (error as { managedBroadcastSendStarted?: unknown })?.managedBroadcastSendStarted === false &&
    errorChain.some(
      (current) => (current as { code?: unknown })?.code === 'MAX_API_INTERNAL_RATE_LIMIT',
    );
  const exactPreDispatchCircuitOpen =
    (error as { managedBroadcastSendStarted?: unknown })?.managedBroadcastSendStarted === false &&
    errorChain.some(
      (current) =>
        (current as { code?: unknown; preDispatch?: unknown })?.code === 'MAX_API_CIRCUIT_OPEN' &&
        (current as { preDispatch?: unknown }).preDispatch === true,
    );
  if (!exactExternalRateLimit && !internalPreDispatchRateLimit && !exactPreDispatchCircuitOpen) {
    return null;
  }

  const nowMs = now.getTime();
  const nextMinuteAtMs =
    Math.floor(nowMs / PUBLICATION_RATE_LIMIT_RETRY_STEP_MS) *
      PUBLICATION_RATE_LIMIT_RETRY_STEP_MS +
    PUBLICATION_RATE_LIMIT_RETRY_STEP_MS;
  const retryAfterMs = readPublicationRateLimitRetryAfterMs(error, nowMs);
  const requestedRetryAtMs = Math.max(nextMinuteAtMs, nowMs + retryAfterMs);
  return new Date(
    Math.ceil(requestedRetryAtMs / PUBLICATION_RATE_LIMIT_RETRY_STEP_MS) *
      PUBLICATION_RATE_LIMIT_RETRY_STEP_MS,
  );
}

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
}): Promise<boolean> {
  if (!options.row.publicationOccurrenceId) {
    return true;
  }

  const occurrence = await options.prisma.publicationOccurrence.findUnique({
    where: { id: options.row.publicationOccurrenceId },
    select: {
      status: true,
      scheduleRevision: true,
      contentRevisionId: true,
      publication: { select: { lifecycle: true } },
      schedule: { select: { revision: true, status: true } },
    },
  });
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
    return true;
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

export async function cancelPublicationDeliveryBeforeStoppedDispatch(
  prisma: PrismaService,
  deliveryId: string,
  deliveryLockToken: string,
): Promise<void> {
  // FLAG: This CAS is limited to the delivery claimed by the current worker before MAX dispatch.
  // A concurrent or already-dispatched SENDING delivery must keep its token and persist its result.
  await prisma.managedBroadcastDelivery.updateMany({
    where: {
      id: deliveryId,
      status: ManagedBroadcastDeliveryStatus.SENDING,
      lockToken: deliveryLockToken,
    },
    data: {
      status: ManagedBroadcastDeliveryStatus.CANCELED,
      lockedAt: null,
      lockToken: null,
      lastErrorCode: null,
      lastError: 'Публикация остановлена до отправки.',
    },
  });
}

export async function deferPublicationDeliveryAfterPreDispatchThrottle(options: {
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'logger'>;
  row: Pick<ManagedBroadcast, 'id' | 'publicationOccurrenceId'>;
  delivery: Pick<ManagedBroadcastDelivery, 'id' | 'targetChatId'>;
  reason: 'startup' | 'scheduled' | 'manual_retry' | 'immediate' | 'deadline';
  occurrenceIndex: number;
  broadcastLockToken: string;
  deliveryLockToken: string;
  error: unknown;
}): Promise<Date | null> {
  // FLAG: Recycle only an exact limiter/circuit rejection before HTTP dispatch or an exact HTTP
  // 429, which is definitive. Timeouts, 5xx responses, and other attempted sends remain terminal.
  const occurrenceId = options.row.publicationOccurrenceId;
  const retryAt = resolvePublicationRateLimitRetryAt(options.error);
  if (!occurrenceId || options.reason !== 'deadline' || !retryAt) {
    return null;
  }

  try {
    const deferred = await options.context.prisma.$transaction(async (tx) => {
      const broadcastDeferred = await tx.managedBroadcast.updateMany({
        where: {
          id: options.row.id,
          publicationOccurrenceId: occurrenceId,
          status: ManagedBroadcastStatus.ACTIVE,
          lockToken: options.broadcastLockToken,
        },
        data: { nextSendAt: retryAt, lockedAt: null, lockToken: null },
      });
      if (broadcastDeferred.count !== 1) {
        return false;
      }

      const deliveryDeferred = await tx.managedBroadcastDelivery.updateMany({
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
    'Deferred publication delivery to the next minute after MAX capacity pressure',
  );
  return retryAt;
}

export async function buildCapacityDeferredPublicationOccurrenceResult(options: {
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'logger'>;
  broadcastId: string;
  occurrenceIndex: number;
  deliveryCandidates: ReadonlyArray<Pick<ManagedBroadcastDelivery, 'status' | 'targetChatId'>>;
  sentChatIds: string[];
  failedChatIds: string[];
  firstSendError: unknown;
  nextSendAt: Date;
}): Promise<BroadcastOccurrenceResult> {
  let deliveries: Array<Pick<ManagedBroadcastDelivery, 'status' | 'targetChatId'>> | null = null;
  try {
    deliveries = await options.context.prisma.managedBroadcastDelivery.findMany({
      where: {
        broadcastId: options.broadcastId,
        occurrenceIndex: options.occurrenceIndex,
      },
      select: { status: true, targetChatId: true },
      orderBy: [{ targetChatId: 'asc' }],
    });
  } catch (error: unknown) {
    options.context.logger.warn(
      {
        broadcastId: options.broadcastId,
        occurrenceIndex: options.occurrenceIndex,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to read publication delivery snapshot after MAX capacity deferral',
    );
  }

  const terminalChatIds = new Set([...options.sentChatIds, ...options.failedChatIds]);
  const byStatus = (statuses: ManagedBroadcastDeliveryStatus[]): string[] =>
    deliveries
      ? deliveries
          .filter((delivery) => statuses.includes(delivery.status))
          .map((delivery) => delivery.targetChatId)
      : [];
  return {
    status: ManagedBroadcastStatus.ACTIVE,
    currentOccurrence: options.occurrenceIndex,
    sentChatIds: deliveries ? byStatus([ManagedBroadcastDeliveryStatus.SENT]) : options.sentChatIds,
    failedChatIds: deliveries
      ? byStatus([
          ManagedBroadcastDeliveryStatus.FAILED,
          ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          ManagedBroadcastDeliveryStatus.CANCELED,
        ])
      : options.failedChatIds,
    pendingChatIds: deliveries
      ? byStatus([ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.SENDING])
      : [
          ...new Set(
            options.deliveryCandidates
              .filter(
                (delivery) =>
                  delivery.status === ManagedBroadcastDeliveryStatus.PENDING &&
                  !terminalChatIds.has(delivery.targetChatId),
              )
              .map((delivery) => delivery.targetChatId),
          ),
        ],
    canRetry: false,
    firstSendError: options.firstSendError,
    nextSendAt: options.nextSendAt,
  };
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
