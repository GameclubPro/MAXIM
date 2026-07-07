CREATE TABLE "moderation_violation_message_claims" (
  "id" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "rule_code" TEXT NOT NULL,
  "update_type" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "moderation_violation_message_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "moderation_violation_message_claims_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "moderation_violation_message_claims_dedupe_key_key"
ON "moderation_violation_message_claims"("dedupe_key");

CREATE INDEX "moderation_violation_message_claims_chat_user_created_idx"
ON "moderation_violation_message_claims"("chat_id", "user_id", "created_at");

CREATE INDEX "moderation_violation_message_claims_created_at_idx"
ON "moderation_violation_message_claims"("created_at");
