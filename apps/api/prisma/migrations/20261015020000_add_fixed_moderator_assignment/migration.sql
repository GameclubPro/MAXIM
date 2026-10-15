SET lock_timeout = '5s';

ALTER TABLE "chats" ADD COLUMN "fixed_moderator_bot_id" TEXT;

CREATE TABLE "managed_moderator_assignments" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "bot_id" TEXT NOT NULL,
  "previous_bot_id" TEXT,
  "expected_routing_version" INTEGER NOT NULL,
  "routing_version" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "managed_moderator_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "managed_moderator_assignments_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "managed_moderator_assignments_chat_created_idx"
  ON "managed_moderator_assignments"("chat_id", "created_at");
