import {
  MAX_API_SOURCE_TAGS,
  normalizeMaxActionIdempotencyKeyPart,
} from '../max/max-client.service';
import { MAX_SEND_FENCE_STALE_MS } from '../max/max-send-ambiguity.util';
import type { Prisma } from '../prisma/prisma-client';

type HandshakeLedgerReader = {
  findFirst(args: {
    where: Prisma.MaxActionLedgerEntryWhereInput;
    select: { id: true; remoteMessageId: true };
  }): Promise<{ id: string; remoteMessageId: string | null } | null>;
};

type HandshakeAutoDeleteInput = {
  chatId: string;
  messageId: string;
  originBotId: string | null | undefined;
  sourceMessageAt: Date | string | null | undefined;
  allowInFlight?: boolean;
};

export async function findManagedHandshakeAutoDeleteOwner(
  reader: HandshakeLedgerReader | null | undefined,
  input: HandshakeAutoDeleteInput,
): Promise<{ id: string; kind: 'managed_handshake' | 'managed_handshake_in_flight' } | null> {
  if (!reader) return null;
  const originBotId = input.originBotId?.trim() || null;
  // FLAG: MAX persists a bot-scoped normalized transport key, not the caller's logical
  // key. Escape LIKE metacharacters so Prisma matches literal transport separators.
  const commandKey = (prefix: string) =>
    `__send_message__${normalizeMaxActionIdempotencyKeyPart(`${prefix}:${input.chatId}`)}_`.replace(
      /[\\%_]/gu,
      '\\$&',
    );
  const scope: Prisma.MaxActionLedgerEntryWhereInput = {
    chatId: input.chatId,
    actionType: 'SEND_MESSAGE',
    sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
    ...(originBotId ? { dispatchBotId: originBotId } : {}),
    OR: [
      { jobId: { contains: commandKey('managed-handshake-start') } },
      { jobId: { contains: commandKey('publisher-handshake-start') } },
    ],
  };
  const select = { id: true, remoteMessageId: true } as const;
  // FLAG: Trust the exact durable send receipt, never connection text alone. This also
  // protects confirmations sent before this guard and already queued for deletion.
  const exact = await reader.findFirst({
    where: { ...scope, remoteMessageId: input.messageId },
    select,
  });
  if (exact) return { id: exact.id, kind: 'managed_handshake' };

  const sourceMessageAt =
    input.sourceMessageAt instanceof Date
      ? input.sourceMessageAt
      : typeof input.sourceMessageAt === 'string'
        ? new Date(input.sourceMessageAt)
        : null;
  if (
    !input.allowInFlight ||
    !originBotId ||
    !sourceMessageAt ||
    !Number.isFinite(sourceMessageAt.getTime())
  )
    return null;

  const timeWindow = {
    gte: new Date(sourceMessageAt.getTime() - MAX_SEND_FENCE_STALE_MS),
    lte: new Date(sourceMessageAt.getTime() + MAX_SEND_FENCE_STALE_MS),
  };
  // FLAG: Use the existing chat/action/updated_at index and a source-time bound.
  // Recheck the exact receipt in this query to close a completion between the two reads.
  const pending = await reader.findFirst({
    where: {
      ...scope,
      updatedAt: timeWindow,
      AND: [
        {
          OR: [
            { remoteMessageId: input.messageId },
            {
              remoteMessageId: null,
              dispatchStartedAt: timeWindow,
              status: { in: ['IN_PROGRESS', 'AMBIGUOUS'] },
            },
          ],
        },
      ],
    },
    select,
  });
  return pending
    ? {
        id: pending.id,
        kind:
          pending.remoteMessageId === input.messageId
            ? 'managed_handshake'
            : 'managed_handshake_in_flight',
      }
    : null;
}
