ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "rules_attach_violations_enabled" BOOLEAN NOT NULL DEFAULT true;

UPDATE "chat_settings"
SET "rules_attach_violations_enabled" = true
WHERE "rules_attach_violations_enabled" IS DISTINCT FROM true;
