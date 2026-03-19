ALTER TABLE "chat_settings"
ADD COLUMN "comments_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "comments_admins_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "comments_all_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "comments_chat_broadcasts_enabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "channel_settings"
DROP COLUMN "comments_admins_enabled",
DROP COLUMN "comments_all_enabled",
DROP COLUMN "comments_chat_broadcasts_enabled";
