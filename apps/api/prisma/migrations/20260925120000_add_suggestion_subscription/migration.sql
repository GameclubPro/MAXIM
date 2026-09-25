SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "channel_settings"
  ADD COLUMN "post_suggestions_require_subscription" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "post_suggestions_delete_on_unsubscribe" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "publisher_entity_settings"
  ADD COLUMN "channel_suggestions_require_subscription" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "channel_suggestions_delete_on_unsubscribe" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "managed_broadcast_deliveries" ADD COLUMN "subscription_delete_id" TEXT;
ALTER TABLE "moderation_delete_intents" ADD COLUMN "suggestion_subscription_id" TEXT;

CREATE TABLE "suggestion_subscription_watches" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "chat_id" TEXT NOT NULL,
  "author_user_id" TEXT NOT NULL,
  "profile" TEXT NOT NULL CHECK ("profile" IN ('moderation', 'publisher')),
  "bot_id" TEXT NOT NULL,
  "next_check_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "missing_since" TIMESTAMP(3),
  "checked_at" TIMESTAMP(3),
  "lease_token" TEXT,
  "lease_until" TIMESTAMP(3),
  "publication_cursor" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "suggestion_subscription_watch_owner_key"
  ON "suggestion_subscription_watches" ("chat_id", "author_user_id", "profile", "bot_id");
CREATE INDEX "suggestion_subscription_watch_due_idx"
  ON "suggestion_subscription_watches" ("profile", "next_check_at", "id");

CREATE TABLE "suggestion_subscription_publications" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "watch_id" TEXT NOT NULL REFERENCES "suggestion_subscription_watches" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "publication_id" TEXT,
  "message_id" TEXT,
  "delivery_id" TEXT,
  "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMP(3),
  "delete_intent_id" TEXT
);
CREATE INDEX "suggestion_subscription_publications_watch_idx"
  ON "suggestion_subscription_publications" ("watch_id", "deleted_at", "id");
CREATE INDEX "suggestion_subscription_publications_publication_idx"
  ON "suggestion_subscription_publications" ("publication_id");
