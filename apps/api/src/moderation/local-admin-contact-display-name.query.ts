import { LOCAL_USER_DISPLAY_NAME_EVENT_TYPES } from '../common/local-user-display-name-events';
import { Prisma } from '../prisma/prisma-client';

export function buildLocalAdminContactDisplayNameQuery(chatId: string, userId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT sender_name
    FROM (
      SELECT
        display_name AS sender_name,
        observed_at AS event_at,
        0 AS source_priority
      FROM chat_user_display_names
      WHERE chat_id = ${chatId}
        AND user_id = ${userId}
        AND COALESCE(BTRIM(display_name), '') <> ''

      UNION ALL

      SELECT
        sender_name,
        event_at,
        1 AS source_priority
      FROM chat_membership_activity_events
      WHERE chat_id = ${chatId}
        AND user_id = ${userId}
        AND sender_name IS NOT NULL

      UNION ALL

      SELECT
        NULLIF(BTRIM(normalized_payload->'message'->>'senderName'), '') AS sender_name,
        created_at AS event_at,
        2 AS source_priority
      FROM webhook_events
      WHERE NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') = ${chatId}
        AND NULLIF(BTRIM(normalized_payload->'message'->>'senderId'), '') = ${userId}
        AND NULLIF(BTRIM(normalized_payload->'message'->>'senderName'), '') IS NOT NULL
        AND normalized_payload->>'type' IN (${Prisma.join(LOCAL_USER_DISPLAY_NAME_EVENT_TYPES)})
    ) local_name_events
    ORDER BY source_priority ASC, event_at DESC
    LIMIT 1
  `;
}
