import type { PublicationListCursorPayload } from '@maxim/contracts/publication';
import {
  ChatEntityType,
  Prisma,
  PublicationAudienceSelection,
  PublicationDispatchProfile,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

export type CurrentRevisionFailedPublicationPageParams = {
  actorUserId: string;
  view: 'current' | 'schedules';
  query: string;
  entityType?: 'chat' | 'channel';
  cursor: PublicationListCursorPayload | null;
  limit: number;
  dispatchProfile?: PublicationDispatchProfile;
  publisherBotId?: string;
};

export type FailedPublicationPageIdentifier = {
  id: string;
  updatedAt: Date;
};

export async function selectCurrentRevisionFailedPublicationPage(
  prisma: PrismaService,
  params: CurrentRevisionFailedPublicationPageParams,
): Promise<FailedPublicationPageIdentifier[]> {
  if (!Number.isSafeInteger(params.limit) || params.limit <= 0) {
    return [];
  }
  const boundedLimit = Math.min(params.limit, 101);
  const scheduleModeFilter =
    params.view === 'current'
      ? Prisma.sql`schedule."mode" = 'NOW'::"PublicationScheduleMode"`
      : Prisma.sql`schedule."mode" IN (
          'ONCE'::"PublicationScheduleMode",
          'SLOTS'::"PublicationScheduleMode",
          'RECURRENCE'::"PublicationScheduleMode"
        )`;
  const searchPattern = `%${params.query}%`;
  const publisherBotId = params.publisherBotId?.trim() ?? '';
  if (
    params.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1 &&
    params.query &&
    !publisherBotId
  ) {
    throw new Error('Publisher bot id is required for PUBLIK_V1 publication search');
  }
  const targetSearchFilter =
    params.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
      ? Prisma.sql`
          EXISTS (
            SELECT 1
            FROM "publication_targets" AS target
            INNER JOIN "managed_bot_chat_catalog" AS catalog
              ON catalog."bot_id" = ${publisherBotId}
              AND catalog."chat_id" = target."target_chat_id"
              AND catalog."entity_type" = target."entity_type"
              AND catalog."status" = 'ACTIVE'
            WHERE target."publication_id" = publication."id"
              AND COALESCE(NULLIF(BTRIM(catalog."title"), ''), catalog."chat_id")
                ILIKE ${searchPattern}
          )
        `
      : Prisma.sql`
          EXISTS (
            SELECT 1
            FROM "publication_targets" AS target
            INNER JOIN "chats" AS chat ON chat."id" = target."target_chat_id"
            WHERE target."publication_id" = publication."id"
              AND chat."title" ILIKE ${searchPattern}
          )
        `;
  const searchFilter = params.query
    ? Prisma.sql`
        AND (
          publication."title" ILIKE ${searchPattern}
          OR EXISTS (
            SELECT 1
            FROM "publication_content_revisions" AS content
            WHERE content."id" = publication."canonical_content_revision_id"
              AND content."text" ILIKE ${searchPattern}
          )
          OR ${targetSearchFilter}
        )
      `
    : Prisma.empty;
  const entityType = params.entityType
    ? params.entityType === 'channel'
      ? ChatEntityType.CHANNEL
      : ChatEntityType.CHAT
    : null;
  const audienceSelection =
    params.entityType === 'channel'
      ? PublicationAudienceSelection.ALL_CHANNELS
      : PublicationAudienceSelection.ALL_CHATS;
  const entityFilter = entityType
    ? Prisma.sql`
        AND (
          publication."audience_selection" =
            'ALL_MANAGED'::"PublicationAudienceSelection"
          OR publication."audience_selection" =
            CAST(${audienceSelection} AS "PublicationAudienceSelection")
          OR EXISTS (
            SELECT 1
            FROM "publication_targets" AS target
            WHERE target."publication_id" = publication."id"
              AND target."entity_type" = CAST(${entityType} AS "ChatEntityType")
          )
        )
      `
    : Prisma.empty;
  const cursorUpdatedAt = params.cursor ? new Date(params.cursor.updatedAt) : null;
  const cursorFilter = params.cursor
    ? Prisma.sql`
        AND (
          publication."updated_at" < ${cursorUpdatedAt}
          OR (
            publication."updated_at" = ${cursorUpdatedAt}
            AND publication."id" < ${params.cursor.id}
          )
        )
      `
    : Prisma.empty;
  const dispatchProfileFilter = params.dispatchProfile
    ? Prisma.sql`
        AND publication."dispatch_profile" =
          CAST(${params.dispatchProfile} AS "PublicationDispatchProfile")
      `
    : Prisma.empty;

  // FLAG: Keep the current schedule revision equality inside this cursor-bound selector.
  // Obsolete failed occurrences are history and must never consume a current/schedules page.
  return prisma.$queryRaw<FailedPublicationPageIdentifier[]>(Prisma.sql`
    SELECT
      publication."id" AS "id",
      publication."updated_at" AS "updatedAt"
    FROM "publications" AS publication
    INNER JOIN "publication_schedules" AS schedule
      ON schedule."publication_id" = publication."id"
    WHERE publication."actor_user_id" = ${params.actorUserId}
      ${dispatchProfileFilter}
      AND publication."lifecycle" IN (
        'ACTIVE'::"PublicationLifecycle",
        'PAUSED'::"PublicationLifecycle",
        'ERROR'::"PublicationLifecycle"
      )
      AND ${scheduleModeFilter}
      AND (
        publication."lifecycle" = 'ERROR'::"PublicationLifecycle"
        OR EXISTS (
          SELECT 1
          FROM "publication_occurrences" AS occurrence
          WHERE occurrence."publication_id" = publication."id"
            AND occurrence."schedule_id" = schedule."id"
            AND occurrence."schedule_revision" = schedule."revision"
            AND (
              occurrence."status" IN (
                'FAILED'::"PublicationOccurrenceStatus",
                'PARTIAL'::"PublicationOccurrenceStatus",
                'AMBIGUOUS'::"PublicationOccurrenceStatus"
              )
              OR EXISTS (
                SELECT 1
                FROM "managed_broadcast_deliveries" AS delivery
                WHERE delivery."publication_occurrence_id" = occurrence."id"
                  AND delivery."status" IN (
                    'FAILED'::"ManagedBroadcastDeliveryStatus",
                    'AMBIGUOUS'::"ManagedBroadcastDeliveryStatus"
                  )
              )
            )
        )
      )
      ${searchFilter}
      ${entityFilter}
      ${cursorFilter}
    ORDER BY publication."updated_at" DESC, publication."id" DESC
    LIMIT ${boundedLimit}
  `);
}
