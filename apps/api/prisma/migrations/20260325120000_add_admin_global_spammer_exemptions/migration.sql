CREATE TABLE IF NOT EXISTS "admin_global_spammer_exemptions" (
  "admin_user_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "source_chat_id" TEXT,
  "reason" TEXT NOT NULL DEFAULT 'MANUAL_UNBAN',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "admin_global_spammer_exemptions_pkey"
    PRIMARY KEY ("admin_user_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "admin_global_spammer_exemptions_user_id_idx"
ON "admin_global_spammer_exemptions"("user_id");
