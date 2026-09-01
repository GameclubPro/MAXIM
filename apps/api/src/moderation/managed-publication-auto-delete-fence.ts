import {
  ManagedBroadcastDeliveryStatus,
  type ChatEntityType,
  type Prisma,
} from '../prisma/prisma-client';
import { MAX_SEND_FENCE_STALE_MS } from '../max/max-send-ambiguity.util';

type ManagedPublicationAutoDeleteFenceInput = {
  targetChatId: string;
  messageId: string;
  originBotId: string;
  entityType: ChatEntityType;
  sourceMessageAt: Date | string | null | undefined;
  now?: Date;
};

function readValidDate(value: Date | string | null | undefined): Date | null {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function buildManagedPublicationAutoDeleteFenceWhere(
  input: ManagedPublicationAutoDeleteFenceInput,
): Prisma.ManagedBroadcastDeliveryWhereInput {
  const now = input.now ?? new Date(Date.now());
  const sourceMessageAt = readValidDate(input.sourceMessageAt);
  const unresolvedSendStates: Prisma.ManagedBroadcastDeliveryWhereInput[] = [
    {
      status: ManagedBroadcastDeliveryStatus.SENDING,
      lockedAt: { gt: new Date(now.getTime() - MAX_SEND_FENCE_STALE_MS) },
    },
  ];
  if (sourceMessageAt) {
    unresolvedSendStates.push({
      status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
      updatedAt: {
        gte: new Date(sourceMessageAt.getTime() - MAX_SEND_FENCE_STALE_MS),
        lte: new Date(sourceMessageAt.getTime() + MAX_SEND_FENCE_STALE_MS),
      },
    });
  }

  return {
    targetChatId: input.targetChatId,
    OR: [
      { remoteMessageId: input.messageId },
      {
        botId: input.originBotId,
        remoteMessageId: null,
        broadcast: { is: { entityType: input.entityType } },
        OR: unresolvedSendStates,
      },
    ],
  };
}
