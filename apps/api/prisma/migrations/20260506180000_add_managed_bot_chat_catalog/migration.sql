CREATE TABLE "managed_bot_chat_catalog" (
    "bot_id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT',
    "title" TEXT,
    "link" TEXT,
    "avatar_url" TEXT,
    "last_event_time" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT 'max_chats',
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_bot_chat_catalog_pkey" PRIMARY KEY ("bot_id","chat_id")
);

CREATE INDEX "managed_bot_chat_catalog_chat_status_idx" ON "managed_bot_chat_catalog"("chat_id", "status");
CREATE INDEX "managed_bot_chat_catalog_bot_type_status_seen_idx" ON "managed_bot_chat_catalog"("bot_id", "entity_type", "status", "last_seen_at" DESC);
