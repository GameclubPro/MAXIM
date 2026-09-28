import {
  publicationScheduleInputSchema,
  type PublicationScheduleInput,
} from '@maxim/contracts/publication';
import { ConflictException } from '@nestjs/common';
import {
  ManagedBroadcastDeliveryStatus,
  Prisma,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { publicationBackgroundAccess } from './publication-background-access';
import {
  PUBLISHER_MISSED_WINDOW_BLOCKER_CODE,
  PUBLISHER_EXPLICIT_RETRY_CODE,
} from './publication-dispatch-issue';
import { isTransientPublicationPrismaError } from './publication-prisma-retry';
import {
  PublicationPublisherRoutingService,
  type ResolvedPublicationTarget,
} from './publication-publisher-routing.service';

const PUBLICATION_EXECUTION_HORIZON_MS = 5 * 60_000;

class PublicationOccurrenceFailureFenceLostError extends Error {}

export type PublicationOccurrenceDispatchScope = {
  publicationId?: string;
  occurrenceId?: string;
  dispatchProfile?: PublicationDispatchProfile;
  notBefore?: Date;
};

const PUBLISHER_PUBLICATION_WAKE_MODES = [
  PublicationScheduleMode.NOW,
  PublicationScheduleMode.ONCE,
  PublicationScheduleMode.SLOTS,
  PublicationScheduleMode.RECURRENCE,
];

export function buildPublisherPublicationWakeDispatch(
  publicationId: string,
  options: { allowPastScheduled: boolean; occurrenceId?: string },
  now: Date,
  pastGraceMs: number,
): {
  scheduleModes: PublicationScheduleMode[];
  scope: PublicationOccurrenceDispatchScope;
} {
  const normalizedPublicationId = publicationId.trim();
  const occurrenceId = options.occurrenceId?.trim();
  if (!normalizedPublicationId || options.allowPastScheduled !== Boolean(occurrenceId)) {
    throw new Error('Publisher publication wakeup scope is invalid');
  }
  return {
    scheduleModes: PUBLISHER_PUBLICATION_WAKE_MODES,
    scope: {
      publicationId: normalizedPublicationId,
      occurrenceId,
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      ...(options.allowPastScheduled ? {} : { notBefore: new Date(now.getTime() - pastGraceMs) }),
    },
  };
}

type PublicationOccurrenceDispatchContext = {
  prisma: PrismaService;
  publisherRouting: PublicationPublisherRoutingService;
  logger: {
    warn(context: Record<string, unknown>, message: string): void;
  };
  resolveTargets: (publication: any) => Promise<ResolvedPublicationTarget[]>;
  createExecution: (
    occurrence: any,
    targets: ResolvedPublicationTarget[],
    schedule: PublicationScheduleInput,
  ) => Promise<void>;
  lockCalendar: (tx: Prisma.TransactionClient) => Promise<void>;
  cancelFutureWork: (
    tx: Prisma.TransactionClient,
    publicationId: string,
    now: Date,
  ) => Promise<void>;
};

export async function dispatchScheduledPublicationOccurrences(
  context: PublicationOccurrenceDispatchContext,
  limit: number,
  scheduleModes?: PublicationScheduleMode[],
  scope: PublicationOccurrenceDispatchScope = {},
): Promise<void> {
  if (scope.dispatchProfile && scope.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1) {
    return;
  }
  const now = new Date();
  const horizon = new Date(now.getTime() + PUBLICATION_EXECUTION_HORIZON_MS);
  const blockedRetryBefore = context.publisherRouting.blockedRetryBefore(now);
  if (!Number.isSafeInteger(limit) || limit <= 0) return;
  const boundedLimit = Math.min(limit, 50);
  const where: Prisma.PublicationOccurrenceWhereInput = {
    ...(scope.publicationId ? { publicationId: scope.publicationId } : {}),
    ...(scope.occurrenceId ? { id: scope.occurrenceId } : {}),
    dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
    status: PublicationOccurrenceStatus.SCHEDULED,
    scheduledAt: { lte: horizon, ...(scope.notBefore ? { gte: scope.notBefore } : {}) },
    publication: {
      is: {
        lifecycle: PublicationLifecycle.ACTIVE,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      },
    },
    schedule: {
      is: {
        status: PublicationScheduleStatus.ACTIVE,
        ...(scheduleModes ? { mode: { in: scheduleModes } } : {}),
      },
    },
    legacyBroadcasts: { none: {} },
  };
  const include = {
    schedule: true,
    contentRevision: true,
    publication: {
      include: {
        targets: { orderBy: { position: 'asc' } },
      },
    },
  } satisfies Prisma.PublicationOccurrenceInclude;
  // FLAG: Unready historical schedules must not occupy every materialization slot. Reserve a
  // small recovery share, and keep both reads bounded and sequential on the shared database.
  const ready = await context.prisma.publicationOccurrence.findMany({
    where: { ...where, dispatchBlockerCode: null },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    take: boundedLimit,
    include,
  });
  const recoveryReservation = boundedLimit > 1 ? Math.min(2, Math.ceil(boundedLimit / 5)) : 0;
  const recoveryLimit = Math.max(recoveryReservation, boundedLimit - ready.length);
  const blocked =
    recoveryLimit > 0
      ? await context.prisma.publicationOccurrence.findMany({
          where: {
            ...where,
            dispatchBlockerCode: { not: null },
            OR: [
              { dispatchBlockerCode: PUBLISHER_EXPLICIT_RETRY_CODE },
              { dispatchBlockedAt: null },
              { dispatchBlockedAt: { lte: blockedRetryBefore } },
            ],
          },
          orderBy: [{ dispatchBlockedAt: 'asc' }, { scheduledAt: 'asc' }, { id: 'asc' }],
          take: recoveryLimit,
          include,
        })
      : [];
  const occurrences = [...ready.slice(0, boundedLimit - blocked.length), ...blocked];

  for (const occurrence of occurrences) {
    try {
      if (occurrence.scheduleRevision !== occurrence.schedule.revision) {
        await context.prisma.publicationOccurrence.updateMany({
          where: {
            id: occurrence.id,
            scheduleRevision: occurrence.scheduleRevision,
            status: PublicationOccurrenceStatus.SCHEDULED,
            deliveries: {
              none: {
                status: {
                  in: [
                    ManagedBroadcastDeliveryStatus.SENDING,
                    ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                  ],
                },
              },
            },
          },
          data: { status: PublicationOccurrenceStatus.CANCELED },
        });
        continue;
      }
      if (
        !(
          occurrence.dispatchBlockerCode === PUBLISHER_EXPLICIT_RETRY_CODE &&
          occurrence.dispatchBlockedAt &&
          occurrence.dispatchBlockedAt.getTime() >= now.getTime() - PUBLICATION_EXECUTION_HORIZON_MS
        ) &&
        (occurrence.schedule.mode === PublicationScheduleMode.ONCE ||
          occurrence.schedule.mode === PublicationScheduleMode.SLOTS ||
          occurrence.schedule.mode === PublicationScheduleMode.RECURRENCE) &&
        occurrence.scheduledAt.getTime() < now.getTime() - PUBLICATION_EXECUTION_HORIZON_MS
      ) {
        // FLAG: Returning access cannot authorize catch-up sends. Only an explicit author
        // retry may execute a missed one-off slot; recurrence continues with future slots.
        await context.prisma.$transaction(async (tx) => {
          await context.lockCalendar(tx);
          await tx.publicationOccurrence.updateMany({
            where: {
              id: occurrence.id,
              status: PublicationOccurrenceStatus.SCHEDULED,
              scheduleRevision: occurrence.scheduleRevision,
              dispatchBlockerCode: occurrence.dispatchBlockerCode ?? null,
              dispatchBlockedAt: occurrence.dispatchBlockedAt ?? null,
              dispatchFirstBlockedAt: occurrence.dispatchFirstBlockedAt ?? null,
              schedule: {
                is: {
                  revision: occurrence.scheduleRevision,
                  status: PublicationScheduleStatus.ACTIVE,
                },
              },
              publication: { is: { lifecycle: PublicationLifecycle.ACTIVE } },
              legacyBroadcasts: { none: {} },
              deliveries: { none: {} },
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
              dispatchBlockedAt: now,
              dispatchFirstBlockedAt: occurrence.dispatchFirstBlockedAt ?? now,
            },
          });
        });
        continue;
      }
      const targets = await publicationBackgroundAccess.execution(
        () => context.resolveTargets(occurrence.publication),
        context.logger,
        occurrence,
      );
      if (targets === null) continue;
      if (targets.length === 0) {
        throw new Error('Нет доступных чатов или каналов для публикации.');
      }
      const scheduleRule = publicationScheduleInputSchema.parse(occurrence.schedule.rule);
      await context.createExecution(occurrence, targets, scheduleRule);
    } catch (error: unknown) {
      if (isTransientPublicationPrismaError(error)) {
        throw error;
      }
      if (await context.publisherRouting.deferOccurrenceIfBlocked(occurrence, error)) {
        continue;
      }
      const message =
        error instanceof ConflictException
          ? 'В выбранное время уже запланирована другая публикация.'
          : error instanceof Error
            ? error.message
            : String(error);
      let transitioned = false;
      try {
        transitioned = await context.prisma.$transaction(async (tx) => {
          await context.lockCalendar(tx);
          // FLAG: This occurrence CAS decides the preparation race. A worker that observes an
          // already-materialized or revised occurrence must not stop the shared schedule.
          const failedOccurrence = await tx.publicationOccurrence.updateMany({
            where: {
              id: occurrence.id,
              publicationId: occurrence.publicationId,
              scheduleId: occurrence.scheduleId,
              scheduleRevision: occurrence.scheduleRevision,
              contentRevisionId: occurrence.contentRevisionId,
              status: PublicationOccurrenceStatus.SCHEDULED,
              legacyBroadcasts: { none: {} },
            },
            data: { status: PublicationOccurrenceStatus.FAILED },
          });
          if (failedOccurrence.count === 0) {
            return false;
          }

          const failedSchedule = await tx.publicationSchedule.updateMany({
            where: {
              id: occurrence.scheduleId,
              publicationId: occurrence.publicationId,
              revision: occurrence.scheduleRevision,
              status: PublicationScheduleStatus.ACTIVE,
            },
            data: {
              status: PublicationScheduleStatus.ERROR,
              nextMaterializeAt: null,
              lastError: message,
            },
          });
          if (failedSchedule.count === 0) {
            throw new PublicationOccurrenceFailureFenceLostError();
          }

          const failedPublication = await tx.publication.updateMany({
            where: {
              id: occurrence.publicationId,
              lifecycle: PublicationLifecycle.ACTIVE,
            },
            data: { lifecycle: PublicationLifecycle.ERROR },
          });
          if (failedPublication.count === 0) {
            throw new PublicationOccurrenceFailureFenceLostError();
          }
          await context.cancelFutureWork(tx, occurrence.publicationId, new Date());
          return true;
        });
      } catch (transitionError: unknown) {
        if (transitionError instanceof PublicationOccurrenceFailureFenceLostError) {
          continue;
        }
        throw transitionError;
      }
      if (!transitioned) {
        continue;
      }
      context.logger.warn(
        { occurrenceId: occurrence.id, publicationId: occurrence.publicationId, err: message },
        'Failed to prepare publication execution',
      );
    }
  }
}
