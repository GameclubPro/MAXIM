import { Prisma, type VkParsingOwnerProfile } from '../prisma/prisma-client';

export type VkSyncLease = {
  id: string;
  chatId: string;
  ownerProfile: VkParsingOwnerProfile;
  ownerBotId: string;
  syncLockedBy: string | null;
  syncAttemptCount: number;
};

export class VkSyncLeaseLostError extends Error {
  constructor() {
    super('VK sync attempt no longer owns an unexpired source lease');
  }
}

export async function lockVkSyncLease(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  lease: VkSyncLease,
): Promise<void> {
  // FLAG: A process identity is not an attempt identity. Lock only the captured generation,
  // using the database clock; callers must finish SQL work before any remote request.
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH locked AS MATERIALIZED (
      SELECT source."id", source."sync_lock_deadline_at"
      FROM "vk_parsing_sources" AS source
      WHERE source."id" = ${lease.id}
        AND source."chat_id" = ${lease.chatId}
        AND source."owner_profile" = ${lease.ownerProfile}::"VkParsingOwnerProfile"
        AND source."owner_bot_id" = ${lease.ownerBotId}
        AND source."status" = 'ACTIVE'
        AND source."import_enabled" = TRUE
        AND source."sync_status" = 'SYNCING'
        AND source."sync_locked_by" = ${lease.syncLockedBy}
        AND source."sync_attempt_count" = ${lease.syncAttemptCount}
      FOR UPDATE OF source
    )
    SELECT "id" FROM locked
    WHERE "sync_lock_deadline_at" > (clock_timestamp() AT TIME ZONE 'UTC')
  `);
  if (rows.length !== 1) throw new VkSyncLeaseLostError();
}
