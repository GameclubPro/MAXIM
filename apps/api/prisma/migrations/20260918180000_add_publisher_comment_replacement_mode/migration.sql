SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "publisher_entity_settings"
ADD COLUMN "chat_comments_replace_original_enabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "chat_auto_comment_attach_markers"
ADD COLUMN "publisher_source_content_hash" TEXT;
