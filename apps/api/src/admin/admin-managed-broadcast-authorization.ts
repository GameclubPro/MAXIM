import { ForbiddenException, type Logger } from '@nestjs/common';
import type { ManagedEntityType } from '@maxim/contracts';
import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  type ManagedBroadcast,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { mapWithConcurrencyLimit } from './admin-legacy-utils';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import { normalizeManagedBroadcastTargetChatIds } from './admin-managed-broadcast-planner';
import { PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE } from './publication-access-loss-recovery';

const MANAGED_BROADCAST_ACCESS_CHECK_CONCURRENCY = 4;

export async function assertManagedBroadcastTargetAdminAccess(
  context: Pick<AdminManagedBroadcastRuntimeContext, 'assertManagedEntityAdminAccess'>,
  targetChatIds: readonly string[],
  userId: string,
  entityType: ManagedEntityType,
  alreadyCheckedChatIds: readonly string[] = [],
): Promise<void> {
  const checkedChatIds = new Set(alreadyCheckedChatIds);
  const uniqueTargetChatIds = normalizeManagedBroadcastTargetChatIds(targetChatIds).filter(
    (chatId) => !checkedChatIds.has(chatId),
  );
  await mapWithConcurrencyLimit(
    uniqueTargetChatIds,
    MANAGED_BROADCAST_ACCESS_CHECK_CONCURRENCY,
    (chatId) => context.assertManagedEntityAdminAccess(chatId, userId, entityType),
  );
}

export function resolveManagedBroadcastAccessDeniedMessage(error: ForbiddenException): string {
  return error.message.trim() || 'Пользователь больше не является администратором чата.';
}

export async function failManagedBroadcastAfterTargetAccessDenied(options: {
  prisma: PrismaService;
  logger: Logger;
  row: Pick<
    ManagedBroadcast,
    'id' | 'sourceChatId' | 'actorUserId' | 'scheduleMode' | 'lockedAt' | 'lockToken'
  >;
  occurrenceIndex: number;
  failureMessage: string;
  lease: { lockedAt: Date; lockToken: string };
}): Promise<boolean> {
  const updated = await options.prisma.managedBroadcast.updateMany({
    where: {
      id: options.row.id,
      lockedAt: options.lease.lockedAt,
      lockToken: options.lease.lockToken,
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
    return false;
  }

  const terminalData = {
    lockedAt: null,
    lockToken: null,
    lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
    lastError: options.failureMessage,
  } as const;
  await options.prisma.managedBroadcastDelivery.updateMany({
    where: {
      broadcastId: options.row.id,
      occurrenceIndex: options.occurrenceIndex,
      status: {
        in: [ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.FAILED],
      },
    },
    data: { status: ManagedBroadcastDeliveryStatus.CANCELED, ...terminalData },
  });
  await options.prisma.managedBroadcastDelivery.updateMany({
    where: {
      broadcastId: options.row.id,
      occurrenceIndex: { gt: options.occurrenceIndex },
      status: {
        in: [ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.FAILED],
      },
    },
    data: { status: ManagedBroadcastDeliveryStatus.CANCELED, ...terminalData },
  });

  if (options.row.scheduleMode === 'calendar') {
    await options.prisma.managedBroadcastCalendarReservation.deleteMany({
      where: {
        broadcastId: options.row.id,
        occurrenceIndex: { gte: options.occurrenceIndex },
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
  }

  options.logger.warn(
    {
      broadcastId: options.row.id,
      sourceChatId: options.row.sourceChatId,
      actorUserId: options.row.actorUserId,
      occurrenceIndex: options.occurrenceIndex,
      err: options.failureMessage,
    },
    'Managed broadcast was stopped after target admin access was denied',
  );
  return true;
}
