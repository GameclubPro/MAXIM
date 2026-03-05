-- Create enum for managed entity type (chat/channel)
CREATE TYPE "ChatEntityType" AS ENUM ('CHAT', 'CHANNEL');

-- Add entity type to existing chats
ALTER TABLE "chats"
ADD COLUMN "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT';

-- Store channel-only settings separately from group chats
CREATE TABLE "channel_settings" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "post_suggestions_enabled" BOOLEAN NOT NULL DEFAULT false,
  "post_suggestions_text" TEXT NOT NULL DEFAULT '',
  "post_suggestions_button_enabled" BOOLEAN NOT NULL DEFAULT false,
  "post_suggestions_button_text" TEXT NOT NULL DEFAULT 'Предложить пост',
  "post_suggestions_button_url" TEXT NOT NULL DEFAULT '',
  "comments_enabled" BOOLEAN NOT NULL DEFAULT true,
  "comments_moderation_enabled" BOOLEAN NOT NULL DEFAULT false,
  "comments_slow_mode_seconds" INTEGER NOT NULL DEFAULT 0,
  "comments_message_text" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "channel_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "channel_settings_chat_id_key" ON "channel_settings"("chat_id");

ALTER TABLE "channel_settings"
ADD CONSTRAINT "channel_settings_chat_id_fkey"
FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
