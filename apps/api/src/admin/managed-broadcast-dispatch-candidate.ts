import { ServiceUnavailableException } from '@nestjs/common';
import { ManagedBroadcastDeliveryStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

export async function persistManagedBroadcastDispatchCandidate(
  prisma: Pick<PrismaService, 'managedBroadcastDelivery'>,
  deliveryId: string,
  lockToken: string,
  botId: string,
): Promise<void> {
  const persistedCandidate = await prisma.managedBroadcastDelivery.updateMany({
    where: {
      id: deliveryId,
      status: ManagedBroadcastDeliveryStatus.SENDING,
      lockToken,
    },
    data: { botId },
  });
  if (persistedCandidate.count === 0) {
    throw new ServiceUnavailableException(
      'Managed broadcast delivery lock was lost before MAX dispatch',
    );
  }
}
