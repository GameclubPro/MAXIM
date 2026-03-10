ALTER TABLE "channel_settings"
  ADD COLUMN IF NOT EXISTS "comments_block_links_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "comments_anti_spam_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "comments_limit_two_in_row_enabled" BOOLEAN NOT NULL DEFAULT true;

UPDATE "channel_settings"
SET
  "comments_block_links_enabled" = true,
  "comments_anti_spam_enabled" = true,
  "comments_limit_two_in_row_enabled" = true
WHERE
  "comments_block_links_enabled" IS DISTINCT FROM true
  OR "comments_anti_spam_enabled" IS DISTINCT FROM true
  OR "comments_limit_two_in_row_enabled" IS DISTINCT FROM true;
