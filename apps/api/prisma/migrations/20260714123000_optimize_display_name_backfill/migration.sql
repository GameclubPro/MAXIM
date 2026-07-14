-- Moderation names are sparse. Keep the resumable backfill on a small partial
-- index rather than walking every nameless moderation row for each chat.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_moderation_feed_items_chat_named_created_id_idx"
ON "chat_moderation_feed_items"("chat_id", "created_at" DESC, "id" DESC)
WHERE COALESCE(BTRIM("user_display_name"), '') <> '';
