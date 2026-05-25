CREATE TABLE IF NOT EXISTS "vk_parsing_sources" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "owner_id" INTEGER NOT NULL,
  "wall_owner_id" INTEGER NOT NULL,
  "screen_name" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "last_sync_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "vk_parsing_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vk_parsing_sources_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "vk_parsing_posts" (
  "id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "vk_owner_id" INTEGER NOT NULL,
  "vk_post_id" INTEGER NOT NULL,
  "vk_published_at" TIMESTAMP(3),
  "text" TEXT NOT NULL DEFAULT '',
  "url" TEXT NOT NULL,
  "photo_urls" JSONB NOT NULL DEFAULT '[]',
  "link_urls" JSONB NOT NULL DEFAULT '[]',
  "attachments" JSONB NOT NULL DEFAULT '[]',
  "raw" JSONB,
  "status" TEXT NOT NULL DEFAULT 'NEW',
  "published_message_id" TEXT,
  "published_url" TEXT,
  "published_at_max" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "vk_parsing_posts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vk_parsing_posts_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "vk_parsing_posts_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "vk_parsing_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "vk_parsing_sources_chat_wall_owner_key"
  ON "vk_parsing_sources"("chat_id", "wall_owner_id");

CREATE INDEX IF NOT EXISTS "vk_parsing_sources_chat_status_idx"
  ON "vk_parsing_sources"("chat_id", "status");

CREATE INDEX IF NOT EXISTS "vk_parsing_sources_status_last_sync_at_idx"
  ON "vk_parsing_sources"("status", "last_sync_at");

CREATE UNIQUE INDEX IF NOT EXISTS "vk_parsing_posts_chat_vk_post_key"
  ON "vk_parsing_posts"("chat_id", "vk_owner_id", "vk_post_id");

CREATE INDEX IF NOT EXISTS "vk_parsing_posts_source_published_at_idx"
  ON "vk_parsing_posts"("source_id", "vk_published_at" DESC);

CREATE INDEX IF NOT EXISTS "vk_parsing_posts_chat_status_published_idx"
  ON "vk_parsing_posts"("chat_id", "status", "vk_published_at" DESC);
