import type { PublicationTargetInput } from '@maxim/contracts/publication';
import { ChatEntityType, Prisma, PublicationDispatchProfile } from '../prisma/prisma-client';

export function buildPublicationCalendarTargetPredicates(
  targets: readonly PublicationTargetInput[],
) {
  return [
    {
      entityType: ChatEntityType.CHAT,
      targetChatId: {
        in: targets.filter((target) => target.entityType === 'chat').map((target) => target.chatId),
      },
    },
    {
      entityType: ChatEntityType.CHANNEL,
      targetChatId: {
        in: targets
          .filter((target) => target.entityType === 'channel')
          .map((target) => target.chatId),
      },
    },
  ];
}

export async function releaseRetiredMajorCalendarSlots(
  tx: Pick<Prisma.TransactionClient, 'managedBroadcastCalendarReservation'>,
  entityType: ChatEntityType,
  targetChatIds: string[],
  scheduledAt: Date,
): Promise<void> {
  // FLAG: Major dispatch is retired. Reclaim only its exact target slots under the
  // caller's calendar lock; keep content, delivery evidence, and Publik reservations.
  await tx.managedBroadcastCalendarReservation.deleteMany({
    where: {
      entityType,
      targetChatId: { in: targetChatIds },
      scheduledAt,
      broadcast: { is: { dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED } },
    },
  });
}
