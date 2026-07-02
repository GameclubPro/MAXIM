CREATE INDEX IF NOT EXISTS "chats_entity_type_updated_id_idx"
  ON "chats"("entity_type", "updated_at" DESC, "id");

CREATE INDEX IF NOT EXISTS "chat_admin_allowlist_user_chat_idx"
  ON "chat_admin_allowlist"("user_id", "chat_id");

CREATE INDEX IF NOT EXISTS "managed_entity_local_act_source_event_idx"
  ON "managed_entity_local_activities"("source_event_type", "last_event_at" DESC, "chat_id");

CREATE INDEX IF NOT EXISTS "audit_logs_chat_action_created_at_idx"
  ON "audit_logs"("chat_id", "action", "created_at");

CREATE INDEX IF NOT EXISTS "channel_posts_chat_latest_views_published_idx"
  ON "channel_posts"("chat_id", "latest_views" DESC, "published_at" DESC);
