import type { PublicationTargetInput } from '@maxim/contracts/publication';
import {
  ChatEntityType,
  Prisma,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import { buildPublicationCalendarTargetPredicates } from './publication-calendar';
import {
  buildUnsafePublicationExecutionDeliveryWhere,
  throwPublicationExecutionRequiresManualReview,
} from './publication-execution-safety';

export type PublicationCalendarConflictOccurrence = {
  id: string;
  publicationId: string;
  scheduleId: string;
  scheduleRevision: number;
  scheduledAt: Date;
  schedule: {
    revision: number;
  };
  publication: {
    actorUserId: string;
    targets: Array<{
      targetChatId: string;
      entityType: ChatEntityType;
    }>;
  };
};

export type PublicationCalendarConflicts = {
  reservations: Array<{
    broadcastId: string;
    entityType: ChatEntityType;
    targetChatId: string;
    scheduledAt: Date;
  }>;
  occurrences: PublicationCalendarConflictOccurrence[];
};

export async function findPublicationCalendarConflicts(
  client: Pick<
    Prisma.TransactionClient,
    'managedBroadcastCalendarReservation' | 'publicationOccurrence'
  >,
  targets: readonly PublicationTargetInput[],
  slots: Date[],
  excludePublicationId?: string,
): Promise<PublicationCalendarConflicts> {
  const targetPredicates = buildPublicationCalendarTargetPredicates(targets);
  const unsafeDelivery = {
    OR: [
      ...buildUnsafePublicationExecutionDeliveryWhere().OR,
      { lockToken: { not: null } },
      { remoteMessageId: { not: null } },
      { sentAt: { not: null } },
      { legacySentWithoutRemoteId: true },
    ],
  };
  const unsafeEnvelope = {
    OR: [
      { lockedAt: { not: null } },
      { lockToken: { not: null } },
      { sentCount: { gt: 0 } },
      { deliveries: { some: unsafeDelivery } },
    ],
  };
  const activeOccurrence = {
    status: {
      in: [PublicationOccurrenceStatus.SCHEDULED, PublicationOccurrenceStatus.IN_PROGRESS],
    },
    schedule: {
      is: {
        status: { in: [PublicationScheduleStatus.ACTIVE, PublicationScheduleStatus.ERROR] },
      },
    },
    publication: {
      is: {
        lifecycle: { in: [PublicationLifecycle.ACTIVE, PublicationLifecycle.ERROR] },
        targets: { some: { OR: targetPredicates, canceledAt: null } },
      },
    },
  };
  const [reservations, occurrenceCandidates] = await Promise.all([
    client.managedBroadcastCalendarReservation.findMany({
      where: {
        scheduledAt: { in: slots },
        OR: targetPredicates,
        broadcast: {
          is: {
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            // FLAG: Exclude only this parent's untouched reservations. A started or leased
            // envelope remains a conflict even when the caller authorizes replacing slots.
            ...(excludePublicationId
              ? {
                  OR: [
                    { publicationOccurrenceId: null },
                    {
                      publicationOccurrence: {
                        is: { publicationId: { not: excludePublicationId } },
                      },
                    },
                    unsafeEnvelope,
                  ],
                }
              : {}),
          },
        },
      },
      orderBy: { scheduledAt: 'asc' },
      select: {
        broadcastId: true,
        entityType: true,
        targetChatId: true,
        scheduledAt: true,
      },
    }),
    client.publicationOccurrence.findMany({
      where: {
        ...(excludePublicationId
          ? {
              OR: [
                { publicationId: { not: excludePublicationId }, ...activeOccurrence },
                {
                  publicationId: excludePublicationId,
                  OR: [
                    { deliveries: { some: unsafeDelivery } },
                    { legacyBroadcasts: { some: unsafeEnvelope } },
                  ],
                },
              ],
            }
          : activeOccurrence),
        scheduledAt: { in: slots },
        publication: {
          is: {
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            ...(!excludePublicationId ? activeOccurrence.publication.is : {}),
          },
        },
      },
      orderBy: { scheduledAt: 'asc' },
      select: {
        id: true,
        publicationId: true,
        scheduleId: true,
        scheduleRevision: true,
        scheduledAt: true,
        schedule: { select: { revision: true } },
        publication: {
          select: {
            actorUserId: true,
            targets: {
              orderBy: { position: 'asc' },
              select: { targetChatId: true, entityType: true },
            },
          },
        },
      },
    }),
  ]);
  // FLAG: A new schedule revision must never mint a second SEND identity for an already
  // attempted slot. Check retained receipts even after their calendar reservation is gone.
  if (
    excludePublicationId &&
    occurrenceCandidates.some(
      (occurrence: PublicationCalendarConflictOccurrence) =>
        occurrence.publicationId === excludePublicationId,
    )
  ) {
    throwPublicationExecutionRequiresManualReview(
      'Этот запуск уже начал отправку. Выберите другое время и проверьте его доставки.',
    );
  }
  return {
    reservations,
    occurrences: occurrenceCandidates.filter(
      (occurrence: PublicationCalendarConflictOccurrence) =>
        occurrence.scheduleRevision === occurrence.schedule.revision,
    ),
  };
}
