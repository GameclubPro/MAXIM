ALTER TABLE "vk_parsing_settings"
ADD COLUMN "append_channel_link_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "channel_link_text" TEXT NOT NULL DEFAULT 'Подписаться на канал';

ALTER TABLE "vk_parsing_posts"
ADD COLUMN "text_format" TEXT NOT NULL DEFAULT 'plain',
ADD COLUMN "manual_content_edited_at" TIMESTAMP(3);
