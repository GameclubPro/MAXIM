import type { Logger } from '@nestjs/common';
import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  type ManagedBroadcast,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { normalizeBroadcastScheduleMode } from './admin.service.support';

export async function failManagedBroadcastAfterFatalProcessingError(options: {
  prisma: PrismaService;
  logger: Logger;
  row: Pick<ManagedBroadcast, 'id' | 'sourceChatId' | 'actorUserId' | 'scheduleMode'>;
  occurrenceIndex: number;
  failureMessage: string;
  lease?: { lockedAt: Date; lockToken: string };
}): Promise<void> {
  const updated = await options.prisma.managedBroadcast.updateMany({
    where: {
      id: options.row.id,
      ...(options.lease
        ? { lockedAt: options.lease.lockedAt, lockToken: options.lease.lockToken }
        : {}),
      status: {
        in: [
          ManagedBroadcastStatus.ACTIVE,
          ManagedBroadcastStatus.PARTIAL,
          ManagedBroadcastStatus.FAILED,
        ],
      },
    },
    data: {
      status: ManagedBroadcastStatus.FAILED,
      lastError: options.failureMessage,
      nextSendAt: null,
      lockedAt: null,
      lockToken: null,
    },
  });
  if (updated.count === 0) {
    return;
  }

  await options.prisma.managedBroadcastDelivery.updateMany({
    where: {
      broadcastId: options.row.id,
      occurrenceIndex: options.occurrenceIndex,
      status: {
        in: [
          ManagedBroadcastDeliveryStatus.PENDING,
          ManagedBroadcastDeliveryStatus.SENDING,
          ManagedBroadcastDeliveryStatus.FAILED,
        ],
      },
    },
    data: {
      status: ManagedBroadcastDeliveryStatus.FAILED,
      lockedAt: null,
      lockToken: null,
      lastError: options.failureMessage,
    },
  });
  await options.prisma.managedBroadcastDelivery.updateMany({
    where: {
      broadcastId: options.row.id,
      occurrenceIndex: { gt: options.occurrenceIndex },
      status: {
        in: [
          ManagedBroadcastDeliveryStatus.PENDING,
          ManagedBroadcastDeliveryStatus.SENDING,
          ManagedBroadcastDeliveryStatus.FAILED,
        ],
      },
    },
    data: {
      status: ManagedBroadcastDeliveryStatus.CANCELED,
      lockedAt: null,
      lockToken: null,
      lastError: options.failureMessage,
    },
  });

  if (normalizeBroadcastScheduleMode(options.row.scheduleMode) === 'calendar') {
    await options.prisma.managedBroadcastCalendarReservation.deleteMany({
      where: {
        broadcastId: options.row.id,
        occurrenceIndex: { gt: options.occurrenceIndex },
      },
    });
    await options.prisma.managedBroadcastOccurrence.updateMany({
      where: { broadcastId: options.row.id, occurrenceIndex: options.occurrenceIndex },
      data: { status: ManagedBroadcastStatus.FAILED },
    });
    await options.prisma.managedBroadcastOccurrence.updateMany({
      where: { broadcastId: options.row.id, occurrenceIndex: { gt: options.occurrenceIndex } },
      data: { status: ManagedBroadcastStatus.CANCELED },
    });
    await options.prisma.managedBroadcastOccurrence.deleteMany({
      where: { broadcastId: options.row.id, occurrenceIndex: { gt: options.occurrenceIndex } },
    });
  }

  options.logger.warn(
    {
      broadcastId: options.row.id,
      sourceChatId: options.row.sourceChatId,
      actorUserId: options.row.actorUserId,
      occurrenceIndex: options.occurrenceIndex,
      err: options.failureMessage,
    },
    'Managed broadcast was stopped after a fatal processing error',
  );
}
