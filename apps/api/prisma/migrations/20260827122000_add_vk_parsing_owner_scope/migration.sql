CREATE TYPE "VkParsingOwnerProfile" AS ENUM ('MAJOR', 'PUBLISHER');

ALTER TABLE "vk_parsing_settings"
  ADD COLUMN "owner_profile" "VkParsingOwnerProfile" NOT NULL DEFAULT 'MAJOR',
  ADD COLUMN "owner_bot_id" TEXT NOT NULL DEFAULT '';

ALTER TABLE "vk_parsing_sources"
  ADD COLUMN "owner_profile" "VkParsingOwnerProfile" NOT NULL DEFAULT 'MAJOR',
  ADD COLUMN "owner_bot_id" TEXT NOT NULL DEFAULT '';

ALTER TABLE "vk_parsing_posts"
  ADD COLUMN "owner_profile" "VkParsingOwnerProfile" NOT NULL DEFAULT 'MAJOR',
  ADD COLUMN "owner_bot_id" TEXT NOT NULL DEFAULT '';

ALTER TABLE "vk_parsing_settings"
  ADD CONSTRAINT "vk_parsing_settings_owner_scope_check" CHECK (
    (
      "owner_profile" = 'MAJOR'::"VkParsingOwnerProfile"
      AND "owner_bot_id" = ''
    )
    OR (
      "owner_profile" = 'PUBLISHER'::"VkParsingOwnerProfile"
      AND BTRIM("owner_bot_id") <> ''
    )
  ) NOT VALID;

ALTER TABLE "vk_parsing_sources"
  ADD CONSTRAINT "vk_parsing_sources_owner_scope_check" CHECK (
    (
      "owner_profile" = 'MAJOR'::"VkParsingOwnerProfile"
      AND "owner_bot_id" = ''
    )
    OR (
      "owner_profile" = 'PUBLISHER'::"VkParsingOwnerProfile"
      AND BTRIM("owner_bot_id") <> ''
    )
  ) NOT VALID;

ALTER TABLE "vk_parsing_posts"
  ADD CONSTRAINT "vk_parsing_posts_owner_scope_check" CHECK (
    (
      "owner_profile" = 'MAJOR'::"VkParsingOwnerProfile"
      AND "owner_bot_id" = ''
    )
    OR (
      "owner_profile" = 'PUBLISHER'::"VkParsingOwnerProfile"
      AND BTRIM("owner_bot_id") <> ''
    )
  ) NOT VALID;

ALTER TABLE "vk_parsing_settings"
  VALIDATE CONSTRAINT "vk_parsing_settings_owner_scope_check";
ALTER TABLE "vk_parsing_sources"
  VALIDATE CONSTRAINT "vk_parsing_sources_owner_scope_check";
ALTER TABLE "vk_parsing_posts"
  VALIDATE CONSTRAINT "vk_parsing_posts_owner_scope_check";
