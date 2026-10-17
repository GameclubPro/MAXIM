DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CommercialAdsSensitivity') THEN
    CREATE TYPE "CommercialAdsSensitivity" AS ENUM ('BALANCED', 'STRICT');
  END IF;
END
$$;

ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "commercial_ads_sensitivity" "CommercialAdsSensitivity" NOT NULL DEFAULT 'BALANCED',
  ADD COLUMN IF NOT EXISTS "commercial_ads_warn_threshold" INTEGER NOT NULL DEFAULT 45,
  ADD COLUMN IF NOT EXISTS "commercial_ads_delete_threshold" INTEGER NOT NULL DEFAULT 65,
  ADD COLUMN IF NOT EXISTS "commercial_ads_repeat_window_sec" INTEGER NOT NULL DEFAULT 86400,
  ADD COLUMN IF NOT EXISTS "commercial_ads_low_confidence_log_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "commercial_ads_warn_first_enabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "chat_commercial_allowlist" (
  "chat_id" TEXT NOT NULL,
  "phrase" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_commercial_allowlist_pkey" PRIMARY KEY ("chat_id", "phrase"),
  CONSTRAINT "chat_commercial_allowlist_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "chat_commercial_stoplist" (
  "chat_id" TEXT NOT NULL,
  "phrase" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_commercial_stoplist_pkey" PRIMARY KEY ("chat_id", "phrase"),
  CONSTRAINT "chat_commercial_stoplist_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "chat_commercial_allowlist_chat_id_idx"
  ON "chat_commercial_allowlist"("chat_id");

CREATE INDEX IF NOT EXISTS "chat_commercial_stoplist_chat_id_idx"
  ON "chat_commercial_stoplist"("chat_id");
