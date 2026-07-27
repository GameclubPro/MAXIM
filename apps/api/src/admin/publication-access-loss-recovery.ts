import {
  buildMaxActionNoExecutableRouteMessage,
  MAX_ACTION_NO_EXECUTABLE_ROUTE_ERROR_CODE,
} from '../max/max-action-dispatch-error';
import { PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE } from '../max/managed-entity-access-loss.constants';
import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  buildUnsafePublicationExecutionDeliveryWhere,
  deleteUnstartedPublicationExecutionBroadcasts,
} from './publication-execution-safety';

export type PublicationAccessLossOccurrenceSnapshot = {
  id: string;
  publicationId: string;
  scheduleId: string;
  status: PublicationOccurrenceStatus;
  updatedAt: Date;
  scheduleRevision: number;
  contentRevisionId: string;
};

class StalePublicationAccessLossRecoveryError extends Error {}

const PUBLICATION_EXECUTION_REVIEW_MESSAGE =
  'Публикация уже начала отправку. Проверьте доставки отдельно.';

export { PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE } from '../max/managed-entity-access-loss.constants';

export function findFullPublicationRouteOutageTarget(
  deliveries: ReadonlyArray<{
    status: ManagedBroadcastDeliveryStatus;
    targetChatId: string;
    lastError: string | null;
    lastErrorCode?: string | null;
  }>,
): string | null {
  if (
    deliveries.length === 0 ||
    !deliveries.every((delivery) => {
      const terminalRouteFailure =
        delivery.status === ManagedBroadcastDeliveryStatus.FAILED ||
        delivery.status === ManagedBroadcastDeliveryStatus.CANCELED;
      if (!terminalRouteFailure) {
        return false;
      }
      if (
        delivery.lastErrorCode === MAX_ACTION_NO_EXECUTABLE_ROUTE_ERROR_CODE ||
        delivery.lastErrorCode === PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE
      ) {
        return true;
      }
      return (
        delivery.status === ManagedBroadcastDeliveryStatus.FAILED &&
        delivery.lastError ===
          buildMaxActionNoExecutableRouteMessage('SEND_MESSAGE', delivery.targetChatId)
      );
    })
  ) {
    return null;
  }
  return deliveries[0]!.targetChatId;
}

export async function rollupPublicationOccurrenceWithRouteOutageRecovery(
  prisma: PrismaService,
  occurrence: PublicationAccessLossOccurrenceSnapshot,
  status: PublicationOccurrenceStatus,
  deliveries: Parameters<typeof findFullPublicationRouteOutageTarget>[0],
): Promise<void> {
  if (status === occurrence.status) {
    return;
  }
  const routeOutageTarget = findFullPublicationRouteOutageTarget(deliveries);
  if (routeOutageTarget) {
    await rollupAndPausePublicationAfterRouteOutage(prisma, occurrence, status, routeOutageTarget);
    return;
  }
  await prisma.publicationOccurrence.updateMany({
    where: {
      id: occurrence.id,
      status: occurrence.status,
      updatedAt: occurrence.updatedAt,
      scheduleId: occurrence.scheduleId,
      scheduleRevision: occurrence.scheduleRevision,
      contentRevisionId: occurrence.contentRevisionId,
    },
    data: { status },
  });
}

export async function deleteUnstartedPublicationExecutionEnvelopes(
  tx: Prisma.TransactionClient,
  publicationId: string,
  options: {
    scheduledAfter?: Date;
    excludeOccurrenceId?: string;
    scheduleId?: string;
    scheduleRevision?: number;
  } = {},
): Promise<void> {
  const broadcasts = await tx.managedBroadcast.findMany({
    where: {
      publicationOccurrence: {
        is: {
          publicationId,
          ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
          ...(options.scheduleRevision !== undefined
            ? { scheduleRevision: options.scheduleRevision }
            : {}),
          ...(options.scheduledAfter ? { scheduledAt: { gt: options.scheduledAfter } } : {}),
          ...(options.excludeOccurrenceId ? { id: { not: options.excludeOccurrenceId } } : {}),
        },
      },
      status: ManagedBroadcastStatus.ACTIVE,
      sentCount: 0,
      deliveries: {
        none: buildUnsafePublicationExecutionDeliveryWhere(),
      },
    },
    select: { id: true, lockedAt: true, lockToken: true },
  });
  await deleteUnstartedPublicationExecutionBroadcasts(
    tx,
    broadcasts,
    PUBLICATION_EXECUTION_REVIEW_MESSAGE,
  );
}

export async function rollupAndPausePublicationAfterRouteOutage(
  prisma: PrismaService,
  occurrence: PublicationAccessLossOccurrenceSnapshot,
  status: PublicationOccurrenceStatus,
  targetChatId: string,
): Promise<void> {
  const lastError =
    `Нет доступного бота с правом отправки в ${targetChatId}. ` +
    'Верните боту права администратора и возобновите публикацию.';

  try {
    // FLAG: The occurrence rollup, future-envelope deletion, and pause must commit atomically.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext('publication-calendar'))
      `);
      const rolledUp = await tx.publicationOccurrence.updateMany({
        where: {
          id: occurrence.id,
          status: occurrence.status,
          updatedAt: occurrence.updatedAt,
          scheduleId: occurrence.scheduleId,
          scheduleRevision: occurrence.scheduleRevision,
          contentRevisionId: occurrence.contentRevisionId,
        },
        data: { status },
      });
      if (rolledUp.count === 0) {
        return;
      }

      const [futureOccurrenceCount, schedule, currentTargetCount] = await Promise.all([
        tx.publicationOccurrence.count({
          where: {
            publicationId: occurrence.publicationId,
            scheduleId: occurrence.scheduleId,
            scheduleRevision: occurrence.scheduleRevision,
            id: { not: occurrence.id },
            status: PublicationOccurrenceStatus.SCHEDULED,
          },
        }),
        tx.publicationSchedule.findUnique({
          where: { publicationId: occurrence.publicationId },
          select: { id: true, revision: true, status: true, nextMaterializeAt: true },
        }),
        tx.publicationTarget.count({
          where: {
            publicationId: occurrence.publicationId,
            targetChatId,
          },
        }),
      ]);
      if (
        schedule?.id !== occurrence.scheduleId ||
        schedule.revision !== occurrence.scheduleRevision ||
        schedule?.status !== PublicationScheduleStatus.ACTIVE ||
        currentTargetCount === 0 ||
        (futureOccurrenceCount === 0 && schedule.nextMaterializeAt === null)
      ) {
        return;
      }

      const paused = await tx.publication.updateMany({
        where: {
          id: occurrence.publicationId,
          lifecycle: PublicationLifecycle.ACTIVE,
          targets: { some: { targetChatId } },
        },
        data: { lifecycle: PublicationLifecycle.PAUSED },
      });
      if (paused.count === 0) {
        return;
      }

      await deleteUnstartedPublicationExecutionEnvelopes(tx, occurrence.publicationId, {
        excludeOccurrenceId: occurrence.id,
        scheduleId: occurrence.scheduleId,
        scheduleRevision: occurrence.scheduleRevision,
      });
      const pausedSchedule = await tx.publicationSchedule.updateMany({
        where: {
          publicationId: occurrence.publicationId,
          id: occurrence.scheduleId,
          revision: occurrence.scheduleRevision,
          status: PublicationScheduleStatus.ACTIVE,
        },
        data: {
          status: PublicationScheduleStatus.PAUSED,
          nextMaterializeAt: null,
          lastError,
        },
      });
      if (pausedSchedule.count === 0) {
        throw new StalePublicationAccessLossRecoveryError();
      }
    });
  } catch (error: unknown) {
    if (!(error instanceof StalePublicationAccessLossRecoveryError)) {
      throw error;
    }
  }
}
