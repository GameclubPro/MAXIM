import { ManagedBroadcastDeliveryStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

export async function cancelManagedBroadcastTargetDeliveries(
  prisma: Pick<PrismaService, 'managedBroadcastDelivery'>,
  broadcastId: string,
  occurrenceIndex: number,
  options: {
    targetChatId: string;
    currentDeliveryId?: string;
    currentDeliveryLockToken?: string;
    lastErrorCode?: string;
    lastError: string;
  },
): Promise<void> {
  const lastError =
    options.lastError.trim() || 'Чат больше недоступен для бота, дальнейшие доставки пропущены.';
  const data = {
    status: ManagedBroadcastDeliveryStatus.CANCELED,
    lockedAt: null,
    lockToken: null,
    lastErrorCode: options.lastErrorCode ?? null,
    lastError,
  } as const;

  if (options.currentDeliveryId) {
    await prisma.managedBroadcastDelivery.updateMany({
      where: {
        id: options.currentDeliveryId,
        ...(options.currentDeliveryLockToken
          ? { lockToken: options.currentDeliveryLockToken }
          : {}),
        status: {
          in: [
            ManagedBroadcastDeliveryStatus.PENDING,
            ManagedBroadcastDeliveryStatus.SENDING,
            ManagedBroadcastDeliveryStatus.FAILED,
          ],
        },
      },
      data,
    });
  }

  await prisma.managedBroadcastDelivery.updateMany({
    where: {
      broadcastId,
      targetChatId: options.targetChatId,
      occurrenceIndex: { gte: occurrenceIndex + 1 },
      status: {
        in: [ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.FAILED],
      },
    },
    data,
  });
}
