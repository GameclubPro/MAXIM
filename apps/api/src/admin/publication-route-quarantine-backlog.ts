import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleStatus,
  type Prisma,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE } from './publication-delivery-verification-state';

type PublicationRouteQuarantineBacklogClient = Pick<
  PrismaService,
  'managedBroadcast' | 'managedBroadcastDelivery'
>;

export async function releasePublicationRouteQuarantineBacklog(
  prisma: PublicationRouteQuarantineBacklogClient,
  targetChatId: string,
  releaseAt: Date,
): Promise<{ wokenBroadcastCount: number; releasedDeliveryCount: number }> {
  const publicationBacklogWhere = {
    publicationOccurrenceId: { not: null },
    status: ManagedBroadcastStatus.ACTIVE,
    lockToken: null,
    publicationOccurrence: {
      is: {
        status: {
          in: [PublicationOccurrenceStatus.SCHEDULED, PublicationOccurrenceStatus.IN_PROGRESS],
        },
        publication: { lifecycle: PublicationLifecycle.ACTIVE },
        schedule: { status: PublicationScheduleStatus.ACTIVE },
      },
    },
    deliveries: {
      some: {
        targetChatId,
        status: ManagedBroadcastDeliveryStatus.PENDING,
        lastErrorCode: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
      },
    },
  } satisfies Prisma.ManagedBroadcastWhereInput;
  const wokenBroadcasts = await prisma.managedBroadcast.updateMany({
    where: {
      ...publicationBacklogWhere,
      OR: [{ nextSendAt: null }, { nextSendAt: { gt: releaseAt } }],
    },
    data: { nextSendAt: releaseAt },
  });
  const releasedDeliveries = await prisma.managedBroadcastDelivery.updateMany({
    where: {
      targetChatId,
      status: ManagedBroadcastDeliveryStatus.PENDING,
      lastErrorCode: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
      broadcast: {
        is: {
          publicationOccurrenceId: { not: null },
          status: ManagedBroadcastStatus.ACTIVE,
          lockToken: null,
          publicationOccurrence: {
            is: {
              status: {
                in: [
                  PublicationOccurrenceStatus.SCHEDULED,
                  PublicationOccurrenceStatus.IN_PROGRESS,
                ],
              },
              publication: { lifecycle: PublicationLifecycle.ACTIVE },
              schedule: { status: PublicationScheduleStatus.ACTIVE },
            },
          },
        },
      },
    },
    data: { lastErrorCode: null, lastError: null },
  });
  return {
    wokenBroadcastCount: wokenBroadcasts.count,
    releasedDeliveryCount: releasedDeliveries.count,
  };
}
