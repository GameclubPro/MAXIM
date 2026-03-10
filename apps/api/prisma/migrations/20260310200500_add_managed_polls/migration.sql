CREATE TYPE "ManagedPollStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');

CREATE TABLE "managed_polls" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "question" TEXT NOT NULL DEFAULT '',
  "options" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "status" "ManagedPollStatus" NOT NULL DEFAULT 'DRAFT',
  "active_version" INTEGER NOT NULL DEFAULT 0,
  "published_message_id" TEXT,
  "published_url" TEXT,
  "published_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "managed_polls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "managed_polls_chat_id_key" ON "managed_polls"("chat_id");

CREATE TABLE "managed_poll_votes" (
  "id" TEXT NOT NULL,
  "poll_id" TEXT NOT NULL,
  "poll_version" INTEGER NOT NULL,
  "user_id" TEXT NOT NULL,
  "option_index" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "managed_poll_votes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "managed_poll_votes_poll_id_poll_version_user_id_key"
ON "managed_poll_votes"("poll_id", "poll_version", "user_id");

CREATE INDEX "managed_poll_votes_poll_id_poll_version_option_index_idx"
ON "managed_poll_votes"("poll_id", "poll_version", "option_index");

ALTER TABLE "managed_polls"
ADD CONSTRAINT "managed_polls_chat_id_fkey"
FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "managed_poll_votes"
ADD CONSTRAINT "managed_poll_votes_poll_id_fkey"
FOREIGN KEY ("poll_id") REFERENCES "managed_polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
