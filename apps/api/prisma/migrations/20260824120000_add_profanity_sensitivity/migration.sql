CREATE TYPE "ProfanitySensitivity" AS ENUM ('CORE_ONLY', 'BALANCED', 'STRICT');

ALTER TABLE "chat_settings"
  ADD COLUMN "profanity_sensitivity" "ProfanitySensitivity" NOT NULL DEFAULT 'BALANCED';
