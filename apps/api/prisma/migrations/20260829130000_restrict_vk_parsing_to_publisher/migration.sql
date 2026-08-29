ALTER TABLE "vk_parsing_settings"
  ALTER COLUMN "owner_profile" DROP DEFAULT,
  ALTER COLUMN "owner_bot_id" DROP DEFAULT,
  ADD CONSTRAINT "vk_parsing_settings_publisher_only_check" CHECK (
    "owner_profile" = 'PUBLISHER'::"VkParsingOwnerProfile"
    AND BTRIM("owner_bot_id") <> ''
  ) NOT VALID;

ALTER TABLE "vk_parsing_sources"
  ALTER COLUMN "owner_profile" DROP DEFAULT,
  ALTER COLUMN "owner_bot_id" DROP DEFAULT,
  ADD CONSTRAINT "vk_parsing_sources_publisher_only_check" CHECK (
    "owner_profile" = 'PUBLISHER'::"VkParsingOwnerProfile"
    AND BTRIM("owner_bot_id") <> ''
  ) NOT VALID;

ALTER TABLE "vk_parsing_posts"
  ALTER COLUMN "owner_profile" DROP DEFAULT,
  ALTER COLUMN "owner_bot_id" DROP DEFAULT,
  ADD CONSTRAINT "vk_parsing_posts_publisher_only_check" CHECK (
    "owner_profile" = 'PUBLISHER'::"VkParsingOwnerProfile"
    AND BTRIM("owner_bot_id") <> ''
  ) NOT VALID;

DELETE FROM "vk_parsing_posts" AS posts
WHERE posts."owner_profile" = 'MAJOR'::"VkParsingOwnerProfile";

DELETE FROM "vk_parsing_posts" AS posts
USING "vk_parsing_sources" AS sources
WHERE posts."source_id" = sources."id"
  AND sources."owner_profile" = 'MAJOR'::"VkParsingOwnerProfile";

DELETE FROM "vk_parsing_sources"
WHERE "owner_profile" = 'MAJOR'::"VkParsingOwnerProfile";

DELETE FROM "vk_parsing_settings"
WHERE "owner_profile" = 'MAJOR'::"VkParsingOwnerProfile";

ALTER TABLE "vk_parsing_settings"
  VALIDATE CONSTRAINT "vk_parsing_settings_publisher_only_check";
ALTER TABLE "vk_parsing_sources"
  VALIDATE CONSTRAINT "vk_parsing_sources_publisher_only_check";
ALTER TABLE "vk_parsing_posts"
  VALIDATE CONSTRAINT "vk_parsing_posts_publisher_only_check";

ALTER TABLE "vk_parsing_settings"
  DROP CONSTRAINT "vk_parsing_settings_owner_scope_check";
ALTER TABLE "vk_parsing_settings"
  RENAME CONSTRAINT "vk_parsing_settings_publisher_only_check"
  TO "vk_parsing_settings_owner_scope_check";

ALTER TABLE "vk_parsing_sources"
  DROP CONSTRAINT "vk_parsing_sources_owner_scope_check";
ALTER TABLE "vk_parsing_sources"
  RENAME CONSTRAINT "vk_parsing_sources_publisher_only_check"
  TO "vk_parsing_sources_owner_scope_check";

ALTER TABLE "vk_parsing_posts"
  DROP CONSTRAINT "vk_parsing_posts_owner_scope_check";
ALTER TABLE "vk_parsing_posts"
  RENAME CONSTRAINT "vk_parsing_posts_publisher_only_check"
  TO "vk_parsing_posts_owner_scope_check";
