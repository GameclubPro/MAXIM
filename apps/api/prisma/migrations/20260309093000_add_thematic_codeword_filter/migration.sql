ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "thematic_codeword_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "thematic_codeword" TEXT NOT NULL DEFAULT '';
