ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "bot_speech_media" JSONB NOT NULL DEFAULT '{}';
