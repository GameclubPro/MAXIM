ALTER TABLE "chat_rules"
  ADD COLUMN IF NOT EXISTS "auto_text_enabled" BOOLEAN NOT NULL DEFAULT false;

UPDATE "chat_rules"
SET "auto_text_enabled" = false
WHERE "auto_text_enabled" IS NULL;
