ALTER TABLE "chat_settings"
ALTER COLUMN "karavan_storefront_enabled" SET DEFAULT true;

UPDATE "chat_settings"
SET "karavan_storefront_enabled" = true
WHERE "karavan_storefront_enabled" = false;
