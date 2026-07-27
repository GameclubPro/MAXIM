import { ChatBotMembershipStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

export const MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE = 'PUBLICATION_MESSAGE_DISAPPEARED' as const;
export const MAX_SEND_ROUTE_QUARANTINE_MS = 6 * 60 * 60_000;

type MaxSendRouteHealthPrisma = Pick<PrismaService, 'chatBotMembership'>;

type MaxSendRouteHealthObservation = {
  chatId: string;
  botId: string | null;
  sentAt: Date;
  observedAt: Date;
};

export async function recordMaxSendRouteDisappearance(
  prisma: MaxSendRouteHealthPrisma,
  observation: MaxSendRouteHealthObservation,
): Promise<boolean> {
  const botId = observation.botId?.trim();
  if (!botId || typeof prisma.chatBotMembership?.updateMany !== 'function') {
    return false;
  }

  const updated = await prisma.chatBotMembership.updateMany({
    where: {
      chatId: observation.chatId,
      botId,
      status: ChatBotMembershipStatus.ACTIVE,
      AND: [
        {
          OR: [
            { sendRouteLastSuccessAt: null },
            { sendRouteLastSuccessAt: { lt: observation.sentAt } },
          ],
        },
        {
          OR: [
            { sendRouteLastFailureAt: null },
            { sendRouteLastFailureAt: { lt: observation.sentAt } },
          ],
        },
      ],
    },
    data: {
      sendRouteFailureCount: { increment: 1 },
      sendRouteQuarantinedUntil: new Date(
        observation.observedAt.getTime() + MAX_SEND_ROUTE_QUARANTINE_MS,
      ),
      sendRouteLastFailureAt: observation.sentAt,
      sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
    },
  });
  return updated.count > 0;
}

export async function recordMaxSendRouteStableSuccess(
  prisma: MaxSendRouteHealthPrisma,
  observation: MaxSendRouteHealthObservation,
): Promise<boolean> {
  const botId = observation.botId?.trim();
  if (!botId || typeof prisma.chatBotMembership?.updateMany !== 'function') {
    return false;
  }

  const updated = await prisma.chatBotMembership.updateMany({
    where: {
      chatId: observation.chatId,
      botId,
      status: ChatBotMembershipStatus.ACTIVE,
      AND: [
        {
          OR: [
            { sendRouteLastSuccessAt: null },
            { sendRouteLastSuccessAt: { lt: observation.sentAt } },
          ],
        },
        {
          OR: [
            { sendRouteLastFailureAt: null },
            { sendRouteLastFailureAt: { lte: observation.sentAt } },
          ],
        },
      ],
    },
    data: {
      sendRouteFailureCount: 0,
      sendRouteQuarantinedUntil: null,
      sendRouteLastFailureCode: null,
      sendRouteLastSuccessAt: observation.sentAt,
    },
  });
  return updated.count > 0;
}
