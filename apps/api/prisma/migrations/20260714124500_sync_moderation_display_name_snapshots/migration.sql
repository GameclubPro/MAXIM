-- Manual and fanout moderation can know a participant name without a matching
-- webhook sender record. Keep the shared, chat-scoped snapshot current at the
-- read-model boundary so every moderation writer is covered.
CREATE OR REPLACE FUNCTION "sync_chat_user_display_name_from_moderation_feed"()
RETURNS TRIGGER AS $$
DECLARE
  normalized_display_name TEXT;
BEGIN
  normalized_display_name := NULLIF(LEFT(BTRIM(NEW."user_display_name"), 256), '');
  IF normalized_display_name IS NULL
    OR COALESCE(BTRIM(NEW."chat_id"), '') = ''
    OR COALESCE(BTRIM(NEW."user_id"), '') = '' THEN
    RETURN NEW;
  END IF;

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
  VALUES (
    NEW."chat_id",
    NEW."user_id",
    normalized_display_name,
    NEW."created_at",
    NEW."id",
    'moderation_feed',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
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
    );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "chat_moderation_feed_items_display_name_snapshot"
ON "chat_moderation_feed_items";

CREATE TRIGGER "chat_moderation_feed_items_display_name_snapshot"
AFTER INSERT OR UPDATE OF "chat_id", "user_id", "user_display_name", "created_at"
ON "chat_moderation_feed_items"
FOR EACH ROW
WHEN (
  COALESCE(BTRIM(NEW."user_display_name"), '') <> ''
  AND COALESCE(BTRIM(NEW."chat_id"), '') <> ''
  AND COALESCE(BTRIM(NEW."user_id"), '') <> ''
)
EXECUTE FUNCTION "sync_chat_user_display_name_from_moderation_feed"();
