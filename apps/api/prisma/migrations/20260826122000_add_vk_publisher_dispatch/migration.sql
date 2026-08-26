ALTER TABLE "vk_parsing_posts"
  ADD COLUMN "dispatch_profile" "PublicationDispatchProfile" NOT NULL DEFAULT 'LEGACY_ROUTED',
  ADD COLUMN "required_bot_id" TEXT,
  ADD COLUMN "dialog_bot_id" TEXT,
  ADD COLUMN "publish_dialog_context" JSONB,
  ADD COLUMN "publication_policy_revision" INTEGER,
  ADD COLUMN "publish_actor_user_id" TEXT,
  ADD COLUMN "published_bot_id" TEXT,
  ADD COLUMN "dispatch_blocker_code" TEXT,
  ADD COLUMN "dispatch_blocked_at" TIMESTAMP(3),
  ADD COLUMN "rollback_queued_at" TIMESTAMP(3),
  ADD COLUMN "rollback_locked_at" TIMESTAMP(3),
  ADD COLUMN "rollback_deleted_at" TIMESTAMP(3),
  ADD COLUMN "rollback_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rollback_idempotency_key" TEXT,
  ADD COLUMN "rollback_last_error" TEXT;

ALTER TABLE "vk_parsing_posts"
  ADD CONSTRAINT "vk_parsing_posts_dispatch_route_check" CHECK (
    (
      "dispatch_profile" = 'LEGACY_ROUTED'::"PublicationDispatchProfile"
      AND "required_bot_id" IS NULL
      AND "dialog_bot_id" IS NULL
      AND "publish_dialog_context" IS NULL
      AND "publication_policy_revision" IS NULL
    )
    OR (
      "dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
      AND BTRIM(COALESCE("required_bot_id", '')) <> ''
      AND BTRIM(COALESCE("dialog_bot_id", '')) <> ''
      AND "dialog_bot_id" <> "required_bot_id"
      AND COALESCE(
        "is_valid_publisher_dialog_context"("publish_dialog_context", "dialog_bot_id"),
        false
      )
      AND COALESCE("publication_policy_revision", -1) >= 0
    )
  ) NOT VALID,
  ADD CONSTRAINT "vk_parsing_posts_dialog_bot_id_check"
    CHECK ("dialog_bot_id" IS NULL OR BTRIM("dialog_bot_id") <> '') NOT VALID,
  ADD CONSTRAINT "vk_parsing_posts_publish_actor_user_id_check"
    CHECK ("publish_actor_user_id" IS NULL OR BTRIM("publish_actor_user_id") <> '') NOT VALID,
  ADD CONSTRAINT "vk_parsing_posts_published_bot_id_check" CHECK (
    "published_bot_id" IS NULL
    OR (
      BTRIM("published_bot_id") <> ''
      AND (
        "dispatch_profile" <> 'PUBLIK_V1'::"PublicationDispatchProfile"
        OR "published_bot_id" = "required_bot_id"
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT "vk_parsing_posts_dispatch_blocker_check" CHECK (
    ("dispatch_blocker_code" IS NULL AND "dispatch_blocked_at" IS NULL)
    OR (
      BTRIM(COALESCE("dispatch_blocker_code", '')) <> ''
      AND CHAR_LENGTH("dispatch_blocker_code") <= 96
      AND "dispatch_blocked_at" IS NOT NULL
    )
  ) NOT VALID,
  ADD CONSTRAINT "vk_parsing_posts_rollback_attempt_count_check"
    CHECK ("rollback_attempt_count" >= 0) NOT VALID,
  ADD CONSTRAINT "vk_parsing_posts_rollback_state_check" CHECK (
    (
      "rollback_queued_at" IS NULL
      AND "rollback_locked_at" IS NULL
      AND "rollback_idempotency_key" IS NULL
    )
    OR (
      "dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
      AND "rollback_queued_at" IS NOT NULL
      AND BTRIM(COALESCE("rollback_idempotency_key", '')) <> ''
      AND BTRIM(COALESCE("published_message_id", '')) <> ''
      AND COALESCE("published_bot_id", '') = "required_bot_id"
    )
  ) NOT VALID,
  ADD CONSTRAINT "vk_parsing_posts_rollback_deleted_check" CHECK (
    "rollback_deleted_at" IS NULL
    OR (
      "dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
      AND BTRIM(COALESCE("published_message_id", '')) <> ''
      AND COALESCE("published_bot_id", '') = "required_bot_id"
    )
  ) NOT VALID;

ALTER TABLE "vk_parsing_posts"
  VALIDATE CONSTRAINT "vk_parsing_posts_dispatch_route_check",
  VALIDATE CONSTRAINT "vk_parsing_posts_dialog_bot_id_check",
  VALIDATE CONSTRAINT "vk_parsing_posts_publish_actor_user_id_check",
  VALIDATE CONSTRAINT "vk_parsing_posts_published_bot_id_check",
  VALIDATE CONSTRAINT "vk_parsing_posts_dispatch_blocker_check",
  VALIDATE CONSTRAINT "vk_parsing_posts_rollback_attempt_count_check",
  VALIDATE CONSTRAINT "vk_parsing_posts_rollback_state_check",
  VALIDATE CONSTRAINT "vk_parsing_posts_rollback_deleted_check";

CREATE UNIQUE INDEX CONCURRENTLY "vk_parsing_posts_rollback_idempotency_key_key"
ON "vk_parsing_posts"("rollback_idempotency_key");

CREATE INDEX CONCURRENTLY "vk_parsing_posts_dispatch_due_lock_idx"
ON "vk_parsing_posts"("dispatch_profile", "status", "publish_scheduled_at", "publish_locked_at");

CREATE INDEX CONCURRENTLY "vk_parsing_posts_dispatch_rollback_lock_idx"
ON "vk_parsing_posts"("dispatch_profile", "rollback_queued_at", "rollback_locked_at");

CREATE OR REPLACE FUNCTION "guard_vk_publish_intent_dispatch_route"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (
    OLD."publish_idempotency_key" IS NOT NULL
    OR OLD."published_message_id" IS NOT NULL
    OR OLD."rollback_idempotency_key" IS NOT NULL
    OR OLD."rollback_queued_at" IS NOT NULL
    OR OLD."rollback_deleted_at" IS NOT NULL
  ) AND (
    NEW."dispatch_profile" IS DISTINCT FROM OLD."dispatch_profile"
    OR NEW."required_bot_id" IS DISTINCT FROM OLD."required_bot_id"
    OR NEW."dialog_bot_id" IS DISTINCT FROM OLD."dialog_bot_id"
    OR NEW."publish_dialog_context" IS DISTINCT FROM OLD."publish_dialog_context"
    OR NEW."publication_policy_revision" IS DISTINCT FROM OLD."publication_policy_revision"
    OR NEW."publish_actor_user_id" IS DISTINCT FROM OLD."publish_actor_user_id"
  ) THEN
    RAISE EXCEPTION 'active VK publish intent route is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vk_parsing_posts_active_dispatch_route_immutable';
  END IF;

  IF OLD."published_bot_id" IS NOT NULL
    AND NEW."published_bot_id" IS DISTINCT FROM OLD."published_bot_id"
  THEN
    RAISE EXCEPTION 'published VK bot provenance is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vk_parsing_posts_published_bot_id_immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "vk_parsing_posts_dispatch_route_immutable"
BEFORE UPDATE OF
  "dispatch_profile",
  "required_bot_id",
  "dialog_bot_id",
  "publish_dialog_context",
  "publication_policy_revision",
  "publish_actor_user_id",
  "published_bot_id"
ON "vk_parsing_posts"
FOR EACH ROW
EXECUTE FUNCTION "guard_vk_publish_intent_dispatch_route"();
