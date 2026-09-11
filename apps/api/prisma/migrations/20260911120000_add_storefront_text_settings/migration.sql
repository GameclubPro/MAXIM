BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "chat_settings"
  ADD COLUMN "karavan_storefront_message_text" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "karavan_storefront_open_button_text" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "karavan_storefront_catalog_button_text" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "karavan_storefront_create_button_text" TEXT NOT NULL DEFAULT '';

COMMIT;
