CREATE TYPE "ChatRoutingState" AS ENUM ('READY', 'NO_ELIGIBLE_BOT');

ALTER TABLE "chats"
  ADD COLUMN "routing_state" "ChatRoutingState" NOT NULL DEFAULT 'READY';

ALTER TABLE "chats"
  ALTER COLUMN "routing_state" SET DEFAULT 'NO_ELIGIBLE_BOT';

CREATE INDEX "chats_routing_state_entity_type_idx"
  ON "chats"("routing_state", "entity_type");

CREATE TABLE "chat_routing_reconcile_requests" (
  "chat_id" TEXT NOT NULL,
  "generation" BIGINT NOT NULL DEFAULT 1,
  "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" TEXT,
  "lease_expires_at" TIMESTAMPTZ,

  CONSTRAINT "chat_routing_reconcile_requests_pkey" PRIMARY KEY ("chat_id")
);

CREATE INDEX "chat_routing_reconcile_requests_due_lease_chat_idx"
  ON "chat_routing_reconcile_requests"("requested_at", "lease_expires_at", "chat_id");

CREATE OR REPLACE FUNCTION enqueue_chat_routing_reconcile_request(target_chat_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF target_chat_id IS NULL OR BTRIM(target_chat_id) = '' THEN
    RETURN;
  END IF;

  INSERT INTO "chat_routing_reconcile_requests" (
    "chat_id",
    "generation",
    "requested_at"
  )
  VALUES (target_chat_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT ("chat_id") DO UPDATE
  SET
    "generation" = "chat_routing_reconcile_requests"."generation" + 1,
    "requested_at" = LEAST(
      "chat_routing_reconcile_requests"."requested_at",
      EXCLUDED."requested_at"
    ),
    "lease_token" = NULL,
    "lease_expires_at" = NULL;
END;
$$;

CREATE OR REPLACE FUNCTION sync_chat_routing_state_from_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM enqueue_chat_routing_reconcile_request(OLD."chat_id");
    RETURN OLD;
  END IF;

  PERFORM enqueue_chat_routing_reconcile_request(NEW."chat_id");
  IF TG_OP = 'UPDATE' AND NEW."chat_id" IS DISTINCT FROM OLD."chat_id" THEN
    PERFORM enqueue_chat_routing_reconcile_request(OLD."chat_id");
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_bot_memberships_sync_routing_state ON "chat_bot_memberships";

CREATE TRIGGER chat_bot_memberships_sync_routing_state
AFTER INSERT OR DELETE OR UPDATE OF
  "chat_id",
  "role",
  "status",
  "capabilities",
  "bot_access_state",
  "bot_access_checked_at",
  "bot_access_expires_at",
  "permissions_snapshot",
  "permissions_hash"
ON "chat_bot_memberships"
FOR EACH ROW
EXECUTE FUNCTION sync_chat_routing_state_from_membership();

CREATE OR REPLACE FUNCTION bump_chat_routing_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."primary_bot_id" IS DISTINCT FROM OLD."primary_bot_id"
     OR NEW."bot_id" IS DISTINCT FROM OLD."bot_id"
     OR NEW."routing_state" IS DISTINCT FROM OLD."routing_state" THEN
    IF NEW."routing_version" IS NOT DISTINCT FROM OLD."routing_version" THEN
      NEW."routing_version" := OLD."routing_version" + 1;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chats_bump_routing_version ON "chats";

CREATE TRIGGER chats_bump_routing_version
BEFORE UPDATE OF "primary_bot_id", "bot_id", "routing_state" ON "chats"
FOR EACH ROW
EXECUTE FUNCTION bump_chat_routing_version();
