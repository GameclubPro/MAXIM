CREATE TYPE "ManagedPollStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');
CREATE TYPE "ManagedPollVisibility" AS ENUM ('ANONYMOUS', 'OPEN');

CREATE TABLE "managed_polls" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "status" "ManagedPollStatus" NOT NULL DEFAULT 'DRAFT',
  "visibility" "ManagedPollVisibility" NOT NULL DEFAULT 'ANONYMOUS',
  "identity_salt" TEXT NOT NULL,
  "render_revision" INTEGER NOT NULL DEFAULT 0,
  "rendered_revision" INTEGER NOT NULL DEFAULT 0,
  "publication_message_id" TEXT,
  "publication_bot_id" TEXT,
  "publication_url" TEXT,
  "published_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "locked_at" TIMESTAMP(3),
  "lock_token" TEXT,
  "last_error" TEXT,
  "last_render_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "managed_polls_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "managed_polls_question_length_check"
    CHECK (char_length(btrim("question")) BETWEEN 1 AND 280),
  CONSTRAINT "managed_polls_identity_salt_length_check"
    CHECK (char_length("identity_salt") BETWEEN 32 AND 128),
  CONSTRAINT "managed_polls_render_revision_check" CHECK ("render_revision" >= 0),
  CONSTRAINT "managed_polls_rendered_revision_check"
    CHECK ("rendered_revision" >= 0 AND "rendered_revision" <= "render_revision")
);

CREATE TABLE "managed_poll_options" (
  "id" TEXT NOT NULL,
  "poll_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "managed_poll_options_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "managed_poll_options_position_check" CHECK ("position" BETWEEN 0 AND 5),
  CONSTRAINT "managed_poll_options_text_length_check"
    CHECK (char_length(btrim("text")) BETWEEN 1 AND 80)
);

CREATE TABLE "managed_poll_voters" (
  "id" TEXT NOT NULL,
  "poll_id" TEXT NOT NULL,
  "identity_hash" TEXT NOT NULL,
  "user_id" TEXT,
  "display_name" TEXT,
  "username" TEXT,
  "last_event_at" TIMESTAMP(3),
  "recent_event_hashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "managed_poll_voters_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "managed_poll_voters_identity_hash_check"
    CHECK (char_length(btrim("identity_hash")) BETWEEN 1 AND 128)
);

CREATE TABLE "managed_poll_votes" (
  "id" TEXT NOT NULL,
  "poll_id" TEXT NOT NULL,
  "voter_id" TEXT NOT NULL,
  "option_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "managed_poll_votes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "managed_polls_chat_status_created_at_idx"
  ON "managed_polls"("chat_id", "status", "created_at" DESC);
CREATE INDEX "managed_polls_chat_created_at_idx"
  ON "managed_polls"("chat_id", "created_at" DESC);
CREATE INDEX "managed_polls_status_locked_at_idx"
  ON "managed_polls"("status", "locked_at");
CREATE UNIQUE INDEX "managed_polls_chat_current_key"
  ON "managed_polls"("chat_id")
  WHERE "status" IN ('DRAFT', 'ACTIVE');

CREATE UNIQUE INDEX "managed_poll_options_poll_id_id_key"
  ON "managed_poll_options"("poll_id", "id");
CREATE UNIQUE INDEX "managed_poll_options_poll_id_position_key"
  ON "managed_poll_options"("poll_id", "position");

CREATE UNIQUE INDEX "managed_poll_voters_poll_id_id_key"
  ON "managed_poll_voters"("poll_id", "id");
CREATE UNIQUE INDEX "managed_poll_voters_poll_id_identity_hash_key"
  ON "managed_poll_voters"("poll_id", "identity_hash");

CREATE UNIQUE INDEX "managed_poll_votes_poll_id_voter_id_key"
  ON "managed_poll_votes"("poll_id", "voter_id");
CREATE INDEX "managed_poll_votes_poll_id_option_id_idx"
  ON "managed_poll_votes"("poll_id", "option_id");

ALTER TABLE "managed_polls"
  ADD CONSTRAINT "managed_polls_chat_id_fkey"
  FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "managed_poll_options"
  ADD CONSTRAINT "managed_poll_options_poll_id_fkey"
  FOREIGN KEY ("poll_id") REFERENCES "managed_polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "managed_poll_voters"
  ADD CONSTRAINT "managed_poll_voters_poll_id_fkey"
  FOREIGN KEY ("poll_id") REFERENCES "managed_polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "managed_poll_votes"
  ADD CONSTRAINT "managed_poll_votes_poll_id_fkey"
  FOREIGN KEY ("poll_id") REFERENCES "managed_polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "managed_poll_votes"
  ADD CONSTRAINT "managed_poll_votes_poll_id_voter_id_fkey"
  FOREIGN KEY ("poll_id", "voter_id")
  REFERENCES "managed_poll_voters"("poll_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "managed_poll_votes"
  ADD CONSTRAINT "managed_poll_votes_poll_id_option_id_fkey"
  FOREIGN KEY ("poll_id", "option_id")
  REFERENCES "managed_poll_options"("poll_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
