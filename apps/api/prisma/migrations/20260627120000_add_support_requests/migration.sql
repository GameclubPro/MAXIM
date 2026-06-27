CREATE TABLE IF NOT EXISTS "support_requests" (
  "id" TEXT NOT NULL,
  "bot_id" TEXT,
  "private_chat_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "user_name" TEXT,
  "message_id" TEXT,
  "text" TEXT NOT NULL DEFAULT '',
  "attachments" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'NEW',
  "source" TEXT NOT NULL DEFAULT 'PRIVATE_BOT',
  "closed_at" TIMESTAMP(3),
  "closed_by_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "support_requests_status_created_at_idx"
  ON "support_requests"("status", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "support_requests_user_created_at_idx"
  ON "support_requests"("user_id", "created_at" DESC);
