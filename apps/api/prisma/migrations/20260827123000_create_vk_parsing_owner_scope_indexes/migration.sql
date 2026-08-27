CREATE UNIQUE INDEX CONCURRENTLY "vk_parsing_settings_owner_key"
  ON "vk_parsing_settings" ("chat_id", "owner_profile", "owner_bot_id");

CREATE UNIQUE INDEX CONCURRENTLY "vk_parsing_sources_owner_wall_key"
  ON "vk_parsing_sources" (
    "chat_id",
    "owner_profile",
    "owner_bot_id",
    "wall_owner_id"
  );

CREATE UNIQUE INDEX CONCURRENTLY "vk_parsing_posts_owner_vk_post_key"
  ON "vk_parsing_posts" (
    "chat_id",
    "owner_profile",
    "owner_bot_id",
    "vk_owner_id",
    "vk_post_id"
  );

CREATE INDEX CONCURRENTLY "vk_parsing_sources_owner_chat_status_idx"
  ON "vk_parsing_sources" ("owner_profile", "owner_bot_id", "chat_id", "status");

CREATE INDEX CONCURRENTLY "vk_parsing_posts_owner_chat_status_published_idx"
  ON "vk_parsing_posts" (
    "owner_profile",
    "owner_bot_id",
    "chat_id",
    "status",
    "vk_published_at" DESC
  );
