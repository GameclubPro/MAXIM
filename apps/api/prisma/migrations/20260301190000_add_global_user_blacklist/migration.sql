ALTER TABLE "chat_settings"
ADD COLUMN IF NOT EXISTS "global_user_blacklist_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "global_user_blacklist" (
  "user_id" TEXT NOT NULL,
  "source_chat_id" TEXT,
  "reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_user_blacklist_pkey" PRIMARY KEY ("user_id")
);
