import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

const BATCH_SIZE = 250;
const ARCHIVE_DAYS = 365;
type ScanResult = { scanned: bigint; removed: bigint; lastAt: Date | null; lastId: string | null };

export class SanctionHistoryRetention {
  private cursor: { createdAt: Date; id: string } | null = null;

  async cleanup(prisma: PrismaService, now: Date, remainingBudget = BATCH_SIZE): Promise<number> {
    const batchSize = Math.min(BATCH_SIZE, Math.max(0, Math.trunc(remainingBudget)));
    if (!batchSize) return 0;
    const cutoff = new Date(now.getTime() - ARCHIVE_DAYS * 86_400_000);
    const rows = await prisma.$queryRaw<ScanResult[]>(Prisma.sql`
      WITH candidates AS MATERIALIZED (
        SELECT event.id, event.chat_id, event.user_id, event.created_at
        FROM moderation_events event
        WHERE (event.action IN ('MUTE', 'BAN') OR event.rule_code IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN', 'SANCTION_STATE_FENCE'))
          AND event.created_at < ${cutoff}
          ${this.cursor ? Prisma.sql`AND (event.created_at, event.id) > (${this.cursor.createdAt}, ${this.cursor.id})` : Prisma.empty}
        ORDER BY event.created_at ASC, event.id ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ), expired AS MATERIALIZED (
        SELECT candidate.id FROM candidates candidate
        WHERE EXISTS (
          SELECT 1 FROM moderation_events later
          WHERE later.chat_id = candidate.chat_id AND later.user_id = candidate.user_id
            AND (later.action IN ('MUTE', 'BAN') OR later.rule_code IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN'))
            AND (later.created_at, later.id) > (candidate.created_at, candidate.id)
            AND later.created_at < ${cutoff}
        )
      ), removed AS (
        DELETE FROM moderation_events target USING expired WHERE target.id = expired.id RETURNING target.id
      ), removed_feed AS (
        DELETE FROM chat_moderation_feed_items target USING removed WHERE target.id = removed.id RETURNING target.id
      )
      SELECT (SELECT count(*) FROM candidates) AS scanned,
        (SELECT count(*) FROM removed) AS removed,
        (SELECT created_at FROM candidates ORDER BY created_at DESC, id DESC LIMIT 1) AS "lastAt",
        (SELECT id FROM candidates ORDER BY created_at DESC, id DESC LIMIT 1) AS "lastId"
    `);
    const result = rows[0];
    // FLAG: Keep the newest state and its later fences, including expired mute/release tombstones.
    // Advancing across protected rows bounds each tick without starving later eligible history.
    this.cursor =
      result && Number(result.scanned) === batchSize && result.lastAt && result.lastId
        ? { createdAt: result.lastAt, id: result.lastId }
        : null;
    return Number(result?.removed ?? 0);
  }
}
