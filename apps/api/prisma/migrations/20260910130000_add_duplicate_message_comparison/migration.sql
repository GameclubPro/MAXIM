ALTER TABLE "chat_settings"
ADD COLUMN "duplicate_compare_mode" TEXT NOT NULL DEFAULT 'MESSAGE';

ALTER TABLE "chat_settings"
ADD CONSTRAINT "chat_settings_duplicate_compare_mode_check"
CHECK ("duplicate_compare_mode" IN ('MESSAGE', 'TEXT')) NOT VALID;

ALTER TABLE "chat_settings"
VALIDATE CONSTRAINT "chat_settings_duplicate_compare_mode_check";
