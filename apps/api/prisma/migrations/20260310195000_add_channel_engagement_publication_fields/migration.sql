ALTER TABLE "channel_settings"
  ADD COLUMN "engagement_message_text" TEXT NOT NULL DEFAULT 'Есть идея или обратная связь? Нажмите кнопку ниже.',
  ADD COLUMN "engagement_published_message_id" TEXT,
  ADD COLUMN "engagement_published_thread_id" TEXT,
  ADD COLUMN "engagement_published_at" TIMESTAMP(3);
