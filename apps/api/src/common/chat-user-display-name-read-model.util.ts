import { Prisma } from '../prisma/prisma-client';

export const CHAT_USER_DISPLAY_NAME_MAX_LENGTH = 256;

export type ChatUserDisplayNameObservation = {
  chatId: string;
  userId: string;
  displayName: string;
  observedAt: Date;
  sourceEventId: string;
  sourceKind: string;
};

export function buildChatUserDisplayNameUpsert(
  observations: readonly ChatUserDisplayNameObservation[],
): Prisma.Sql | null {
  const normalized = dedupeChatUserDisplayNameObservations(observations);
  if (normalized.length === 0) {
    return null;
  }

  return buildChatUserDisplayNameWrite(
    normalized,
    Prisma.sql`
      ON CONFLICT ("chat_id", "user_id") DO UPDATE SET
        "display_name" = EXCLUDED."display_name",
        "observed_at" = EXCLUDED."observed_at",
        "source_event_id" = EXCLUDED."source_event_id",
        "source_kind" = EXCLUDED."source_kind",
        "updated_at" = CURRENT_TIMESTAMP
      WHERE
        EXCLUDED."observed_at" > "chat_user_display_names"."observed_at"
        OR (
          EXCLUDED."observed_at" = "chat_user_display_names"."observed_at"
          AND EXCLUDED."source_event_id" > "chat_user_display_names"."source_event_id"
        )
    `,
  );
}

// Use this for observations whose timestamp came from ingress rather than MAX.
// They may populate an empty snapshot, but must never reorder known history.
export function buildChatUserDisplayNameInsertIfAbsent(
  observations: readonly ChatUserDisplayNameObservation[],
): Prisma.Sql | null {
  const normalized = dedupeChatUserDisplayNameObservations(observations);
  if (normalized.length === 0) {
    return null;
  }

  return buildChatUserDisplayNameWrite(
    normalized,
    Prisma.sql`ON CONFLICT ("chat_id", "user_id") DO NOTHING`,
  );
}

function buildChatUserDisplayNameWrite(
  observations: readonly ChatUserDisplayNameObservation[],
  conflictClause: Prisma.Sql,
): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "chat_user_display_names" (
      "chat_id",
      "user_id",
      "display_name",
      "observed_at",
      "source_event_id",
      "source_kind",
      "created_at",
      "updated_at"
    )
    VALUES ${Prisma.join(
      observations.map(
        (observation) => Prisma.sql`(
          ${observation.chatId},
          ${observation.userId},
          ${observation.displayName},
          ${observation.observedAt},
          ${observation.sourceEventId},
          ${observation.sourceKind},
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )`,
      ),
    )}
    ${conflictClause}
  `;
}

export function normalizeChatUserDisplayNameObservation(
  observation: ChatUserDisplayNameObservation,
): ChatUserDisplayNameObservation | null {
  const chatId = observation.chatId.trim();
  const userId = observation.userId.trim();
  const displayName = observation.displayName.trim().slice(0, CHAT_USER_DISPLAY_NAME_MAX_LENGTH);
  const sourceEventId = observation.sourceEventId.trim();
  const sourceKind = observation.sourceKind.trim();
  if (
    !chatId ||
    !userId ||
    !displayName ||
    !sourceEventId ||
    !sourceKind ||
    !Number.isFinite(observation.observedAt.getTime())
  ) {
    return null;
  }

  return {
    chatId,
    userId,
    displayName,
    observedAt: observation.observedAt,
    sourceEventId,
    sourceKind,
  };
}

function dedupeChatUserDisplayNameObservations(
  observations: readonly ChatUserDisplayNameObservation[],
): ChatUserDisplayNameObservation[] {
  const byUser = new Map<string, ChatUserDisplayNameObservation>();
  for (const candidate of observations) {
    const normalized = normalizeChatUserDisplayNameObservation(candidate);
    if (!normalized) {
      continue;
    }

    const key = `${normalized.chatId}\u0000${normalized.userId}`;
    const previous = byUser.get(key);
    if (!previous || compareObservations(previous, normalized) < 0) {
      byUser.set(key, normalized);
    }
  }

  return [...byUser.values()];
}

function compareObservations(
  left: ChatUserDisplayNameObservation,
  right: ChatUserDisplayNameObservation,
): number {
  const observedAtDifference = left.observedAt.getTime() - right.observedAt.getTime();
  if (observedAtDifference !== 0) {
    return observedAtDifference;
  }

  if (left.sourceEventId === right.sourceEventId) {
    return 0;
  }

  return left.sourceEventId < right.sourceEventId ? -1 : 1;
}
