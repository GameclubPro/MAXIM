import { Injectable } from '@nestjs/common';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  MANAGED_ENTITIES_LOCAL_ACTIVITY_EVENT_TYPES,
  MANAGED_ENTITIES_LOCAL_ACTIVITY_LOOKBACK_MS,
  type ManagedEntitiesDiscoverySnapshot,
  type ManagedEntityTypeFilter,
} from './admin.service.support';
import { isPrivateDirectChatId } from '../common/chat-id.util';

type CandidateRow = {
  chat_id: string | null;
  chat_title: string | null;
  chat_type: string | null;
  created_at: Date;
};

type CandidateReadClient = Pick<PrismaService, '$queryRaw'>;
type CandidateEntityType = Exclude<ManagedEntityTypeFilter, 'all'>;

const WEBHOOK_FALLBACK_MIN_SCAN_LIMIT = 200;
const WEBHOOK_FALLBACK_MAX_SCAN_LIMIT = 5_000;
const WEBHOOK_FALLBACK_SCAN_LIMIT_MULTIPLIER = 100;

@Injectable()
export class ManagedEntityCandidateSyncService {
  async loadLocalDiscoverySnapshot(
    prisma: CandidateReadClient,
    userId: string,
    entityType: ManagedEntityTypeFilter,
    options: { limit: number; now?: Date } = { limit: 50 },
  ): Promise<ManagedEntitiesDiscoverySnapshot> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return [];
    }

    const limit = Math.max(1, Math.trunc(options.limit));
    const webhookFallbackScanLimit = Math.min(
      WEBHOOK_FALLBACK_MAX_SCAN_LIMIT,
      Math.max(WEBHOOK_FALLBACK_MIN_SCAN_LIMIT, limit * WEBHOOK_FALLBACK_SCAN_LIMIT_MULTIPLIER),
    );
    const now = options.now ?? new Date();
    const lookbackFrom = new Date(now.getTime() - MANAGED_ENTITIES_LOCAL_ACTIVITY_LOOKBACK_MS);
    const requestedEntityType = this.resolveRequestedEntityType(entityType);
    const rows = await prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT
        activities.chat_id,
        COALESCE(NULLIF(BTRIM(activities.chat_title), ''), chats.title) AS chat_title,
        COALESCE(
          CASE activities.entity_type
            WHEN 'CHANNEL' THEN 'channel'
            ELSE 'chat'
          END,
          CASE chats.entity_type
            WHEN 'CHANNEL' THEN 'channel'
            ELSE 'chat'
          END
        ) AS chat_type,
        activities.last_event_at AS created_at
      FROM managed_entity_local_activities AS activities
      LEFT JOIN chats ON chats.id = activities.chat_id
      WHERE activities.user_id = ${normalizedUserId}
        AND activities.last_event_at >= ${lookbackFrom}
        ${this.buildEntityTypeSqlFilter(
          Prisma.sql`activities.entity_type`,
          Prisma.sql`chats.entity_type`,
          requestedEntityType,
        )}
      ORDER BY activities.last_event_at DESC
      LIMIT ${limit}
    `);

    const sourceRows =
      rows.length > 0
        ? rows
        : await this.loadLocalDiscoverySnapshotFromWebhookEvents(
            prisma,
            normalizedUserId,
            lookbackFrom,
            limit,
            webhookFallbackScanLimit,
            requestedEntityType,
          );

    return this.toDiscoverySnapshot(sourceRows, entityType, limit);
  }

  private async loadLocalDiscoverySnapshotFromWebhookEvents(
    prisma: CandidateReadClient,
    normalizedUserId: string,
    lookbackFrom: Date,
    limit: number,
    scanLimit: number,
    requestedEntityType: CandidateEntityType | null,
  ): Promise<CandidateRow[]> {
    return prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
      WITH recent_events AS (
        SELECT
          NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') AS chat_id,
          NULLIF(BTRIM(normalized_payload->'message'->>'chatTitle'), '') AS chat_title,
          LOWER(
            COALESCE(
              NULLIF(BTRIM(normalized_payload->'raw'->>'chat_type'), ''),
              NULLIF(BTRIM(normalized_payload->'raw'->>'chatType'), ''),
              NULLIF(BTRIM(normalized_payload->'raw'->'chat'->>'chat_type'), ''),
              NULLIF(BTRIM(normalized_payload->'raw'->'chat'->>'chatType'), ''),
              CASE
                WHEN NULLIF(BTRIM(normalized_payload->'raw'->>'is_channel'), '') = 'true'
                  THEN 'channel'
                WHEN NULLIF(BTRIM(normalized_payload->'raw'->>'is_channel'), '') = 'false'
                  THEN 'chat'
                ELSE NULL
              END
            )
          ) AS chat_type,
          created_at
        FROM webhook_events
        WHERE normalized_payload->'message'->>'senderId' = ${normalizedUserId}
          AND NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') IS NOT NULL
          AND normalized_payload->>'type' IN (${Prisma.join(
            MANAGED_ENTITIES_LOCAL_ACTIVITY_EVENT_TYPES,
          )})
          AND created_at >= ${lookbackFrom}
        ORDER BY created_at DESC
        LIMIT ${scanLimit}
      ),
      local_candidates AS (
        SELECT DISTINCT ON (chat_id)
          chat_id,
          chat_title,
          chat_type,
          created_at
        FROM recent_events
        WHERE chat_id IS NOT NULL
        ORDER BY chat_id, created_at DESC
      )
      SELECT
        local_candidates.chat_id,
        COALESCE(local_candidates.chat_title, chats.title) AS chat_title,
        COALESCE(
          local_candidates.chat_type,
          CASE chats.entity_type
            WHEN 'CHANNEL' THEN 'channel'
            ELSE 'chat'
          END
        ) AS chat_type,
        local_candidates.created_at
      FROM local_candidates
      LEFT JOIN chats ON chats.id = local_candidates.chat_id
      WHERE local_candidates.chat_id IS NOT NULL
        ${this.buildFallbackEntityTypeSqlFilter(
          Prisma.sql`local_candidates.chat_type`,
          Prisma.sql`chats.entity_type`,
          requestedEntityType,
        )}
      ORDER BY local_candidates.created_at DESC
      LIMIT ${limit}
    `);
  }

  private toDiscoverySnapshot(
    rows: readonly CandidateRow[],
    entityType: ManagedEntityTypeFilter,
    limit: number,
  ): ManagedEntitiesDiscoverySnapshot {
    const snapshot: ManagedEntitiesDiscoverySnapshot = [];
    for (const row of rows.slice(0, limit)) {
      const chatId = this.readTrimmedString(row.chat_id);
      if (!chatId) {
        continue;
      }

      const hintedEntityType = this.normalizeEntityType(row.chat_type) ?? 'chat';
      if (hintedEntityType === 'chat' && isPrivateDirectChatId(chatId)) {
        continue;
      }
      if (entityType !== 'all' && hintedEntityType !== entityType) {
        continue;
      }

      snapshot.push({
        chatId,
        title: this.readTrimmedString(row.chat_title) ?? chatId,
        lastEventTime: row.created_at instanceof Date ? row.created_at.getTime() : 0,
        entityType: hintedEntityType,
        link: null,
        avatarUrl: null,
      });
    }

    return snapshot;
  }

  private normalizeEntityType(value: string | null): Exclude<ManagedEntityTypeFilter, 'all'> | null {
    const normalized = value?.trim().toLowerCase();
    if (normalized === 'channel') {
      return 'channel';
    }
    if (normalized === 'chat') {
      return 'chat';
    }
    return null;
  }

  private resolveRequestedEntityType(entityType: ManagedEntityTypeFilter): CandidateEntityType | null {
    return entityType === 'chat' || entityType === 'channel' ? entityType : null;
  }

  private buildEntityTypeSqlFilter(
    primaryColumn: Prisma.Sql,
    fallbackColumn: Prisma.Sql,
    entityType: CandidateEntityType | null,
  ): Prisma.Sql {
    if (!entityType) {
      return Prisma.empty;
    }

    const prismaEntityType = entityType === 'channel' ? 'CHANNEL' : 'CHAT';
    return Prisma.sql`
      AND COALESCE(${primaryColumn}, ${fallbackColumn}, 'CHAT'::"ChatEntityType") = ${prismaEntityType}::"ChatEntityType"
    `;
  }

  private buildFallbackEntityTypeSqlFilter(
    primaryColumn: Prisma.Sql,
    fallbackColumn: Prisma.Sql,
    entityType: CandidateEntityType | null,
  ): Prisma.Sql {
    if (!entityType) {
      return Prisma.empty;
    }

    const fallbackEntityType = entityType === 'channel' ? 'CHANNEL' : 'CHAT';
    return Prisma.sql`
      AND COALESCE(
        ${primaryColumn},
        CASE ${fallbackColumn}
          WHEN 'CHANNEL' THEN 'channel'
          ELSE 'chat'
        END,
        'chat'
      ) = ${entityType}
      AND COALESCE(${fallbackColumn}, ${fallbackEntityType}::"ChatEntityType") = ${fallbackEntityType}::"ChatEntityType"
    `;
  }

  private readTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }
}
