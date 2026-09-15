BEGIN;

ALTER TABLE "vk_parsing_sources" ADD COLUMN "bot_review_enabled_at" TIMESTAMP(3);
ALTER TABLE "vk_parsing_settings"
  ADD COLUMN "bot_review_recipient_user_id" TEXT,
  ADD COLUMN "bot_review_paused" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "vk_bot_review_inboxes" (
  "bot_id" TEXT NOT NULL CHECK (btrim("bot_id") <> ''),
  "user_id" TEXT NOT NULL CHECK ("user_id" ~ '^[1-9][0-9]{0,30}$'),
  "private_chat_id" TEXT NOT NULL CHECK ("private_chat_id" ~ '^[1-9][0-9]{0,30}$'),
  "confirmed_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vk_bot_review_inboxes_pkey" PRIMARY KEY ("bot_id", "user_id")
);

CREATE TABLE "vk_bot_reviews" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "post_id" TEXT NOT NULL REFERENCES "vk_parsing_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "recipient_user_id" TEXT NOT NULL CHECK ("recipient_user_id" ~ '^[1-9][0-9]{0,30}$'),
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "status" TEXT NOT NULL DEFAULT 'PENDING'
    CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  "delivery_state" TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK ("delivery_state" IN ('QUEUED', 'PREPARING', 'CONTENT_SENDING', 'CONTENT_SENT', 'CONTROL_SENDING', 'DELIVERED', 'AMBIGUOUS', 'ERROR')),
  "snapshot" JSONB,
  "fingerprint" TEXT,
  "private_chat_id" TEXT,
  "content_message_id" TEXT,
  "control_message_id" TEXT,
  "attempt_started_at" TIMESTAMP(3),
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "presentation_key" TEXT,
  "decided_at" TIMESTAMP(3),
  "decided_by_user_id" TEXT,
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vk_bot_reviews_post_id_key" UNIQUE ("post_id")
);

CREATE INDEX "vk_bot_reviews_due_idx" ON "vk_bot_reviews" ("delivery_state", "next_attempt_at", "id");
CREATE INDEX "vk_bot_reviews_recipient_pending_idx"
  ON "vk_bot_reviews" ("recipient_user_id", "status", "delivery_state");

COMMIT;
