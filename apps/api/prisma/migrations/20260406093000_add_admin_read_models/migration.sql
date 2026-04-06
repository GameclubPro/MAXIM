-- CreateTable
CREATE TABLE "chat_membership_activity_events" (
    "id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "bot_id" TEXT,
    "chat_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "user_id" TEXT,
    "sender_name" TEXT,
    "event_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_membership_activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_entity_local_activities" (
    "user_id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT',
    "chat_title" TEXT,
    "source_event_type" TEXT NOT NULL,
    "bot_id" TEXT,
    "last_event_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "managed_entity_local_activities_pkey" PRIMARY KEY ("user_id","chat_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_membership_activity_events_dedupe_key_key"
ON "chat_membership_activity_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "chat_membership_activity_events_chat_id_event_type_event_at_idx"
ON "chat_membership_activity_events"("chat_id", "event_type", "event_at" DESC);

-- CreateIndex
CREATE INDEX "chat_membership_activity_events_chat_id_event_at_idx"
ON "chat_membership_activity_events"("chat_id", "event_at" DESC);

-- CreateIndex
CREATE INDEX "chat_membership_activity_events_chat_id_user_id_event_at_idx"
ON "chat_membership_activity_events"("chat_id", "user_id", "event_at" DESC);

-- CreateIndex
CREATE INDEX "managed_entity_local_act_user_type_event_idx"
ON "managed_entity_local_activities"("user_id", "entity_type", "last_event_at" DESC);

-- CreateIndex
CREATE INDEX "managed_entity_local_activities_chat_id_last_event_at_idx"
ON "managed_entity_local_activities"("chat_id", "last_event_at" DESC);

-- Backfill membership activity projection from webhook_events.
INSERT INTO "chat_membership_activity_events" (
    "id",
    "dedupe_key",
    "bot_id",
    "chat_id",
    "event_type",
    "user_id",
    "sender_name",
    "event_at",
    "created_at"
)
SELECT
    "dedup_key" AS "id",
    "dedup_key",
    "bot_id",
    NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), '') AS "chat_id",
    LOWER(COALESCE(NULLIF(BTRIM("normalized_payload"->>'type'), ''), 'user_added')) AS "event_type",
    NULLIF(BTRIM("normalized_payload"->'message'->>'senderId'), '') AS "user_id",
    NULLIF(BTRIM("normalized_payload"->'message'->>'senderName'), '') AS "sender_name",
    "created_at" AS "event_at",
    "created_at"
FROM "webhook_events"
WHERE NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), '') IS NOT NULL
  AND LOWER(COALESCE(NULLIF(BTRIM("normalized_payload"->>'type'), ''), '')) IN ('user_added', 'user_removed')
ON CONFLICT ("dedupe_key") DO NOTHING;

-- Backfill local managed-entities activity projection from webhook_events.
INSERT INTO "managed_entity_local_activities" (
    "user_id",
    "chat_id",
    "entity_type",
    "chat_title",
    "source_event_type",
    "bot_id",
    "last_event_at",
    "created_at",
    "updated_at"
)
SELECT DISTINCT ON ("user_id", "chat_id")
    "user_id",
    "chat_id",
    "entity_type",
    "chat_title",
    "source_event_type",
    "bot_id",
    "last_event_at",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (
    SELECT
        NULLIF(BTRIM("normalized_payload"->'message'->>'senderId'), '') AS "user_id",
        NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), '') AS "chat_id",
        CASE
            WHEN LOWER(
                COALESCE(
                    NULLIF(BTRIM("normalized_payload"->'message'->>'entityType'), ''),
                    NULLIF(BTRIM("normalized_payload"->'raw'->>'chat_type'), ''),
                    NULLIF(BTRIM("normalized_payload"->'raw'->>'chatType'), ''),
                    NULLIF(BTRIM("normalized_payload"->'raw'->'chat'->>'chat_type'), ''),
                    NULLIF(BTRIM("normalized_payload"->'raw'->'chat'->>'chatType'), ''),
                    CASE
                        WHEN NULLIF(BTRIM("normalized_payload"->'raw'->>'is_channel'), '') = 'true'
                            THEN 'channel'
                        WHEN NULLIF(BTRIM("normalized_payload"->'raw'->>'is_channel'), '') = 'false'
                            THEN 'chat'
                        ELSE NULL
                    END
                )
            ) = 'channel'
                THEN 'CHANNEL'::"ChatEntityType"
            ELSE 'CHAT'::"ChatEntityType"
        END AS "entity_type",
        NULLIF(BTRIM("normalized_payload"->'message'->>'chatTitle'), '') AS "chat_title",
        LOWER(COALESCE(NULLIF(BTRIM("normalized_payload"->>'type'), ''), 'message_created')) AS "source_event_type",
        NULLIF(BTRIM("bot_id"), '') AS "bot_id",
        "created_at" AS "last_event_at"
    FROM "webhook_events"
    WHERE NULLIF(BTRIM("normalized_payload"->'message'->>'senderId'), '') IS NOT NULL
      AND NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), '') IS NOT NULL
      AND LOWER(COALESCE(NULLIF(BTRIM("normalized_payload"->>'type'), ''), '')) IN (
        'message_created',
        'message_callback',
        'bot_started',
        'bot_added'
      )
) AS "projected"
WHERE "user_id" IS NOT NULL
  AND "chat_id" IS NOT NULL
ORDER BY "user_id", "chat_id", "last_event_at" DESC;
