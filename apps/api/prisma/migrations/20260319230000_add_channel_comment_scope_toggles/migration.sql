ALTER TABLE "channel_settings"
ADD COLUMN "comments_admins_enabled" BOOLEAN,
ADD COLUMN "comments_all_enabled" BOOLEAN,
ADD COLUMN "comments_chat_broadcasts_enabled" BOOLEAN;

UPDATE "channel_settings"
SET
  "comments_admins_enabled" = FALSE,
  "comments_all_enabled" = "comments_enabled",
  "comments_chat_broadcasts_enabled" = "comments_enabled";

ALTER TABLE "channel_settings"
ALTER COLUMN "comments_admins_enabled" SET NOT NULL,
ALTER COLUMN "comments_admins_enabled" SET DEFAULT TRUE,
ALTER COLUMN "comments_all_enabled" SET NOT NULL,
ALTER COLUMN "comments_all_enabled" SET DEFAULT FALSE,
ALTER COLUMN "comments_chat_broadcasts_enabled" SET NOT NULL,
ALTER COLUMN "comments_chat_broadcasts_enabled" SET DEFAULT FALSE;
