CREATE TYPE "PublicationDispatchProfile" AS ENUM ('LEGACY_ROUTED', 'PUBLIK_V1');

CREATE TABLE "publisher_entity_bindings" (
  "chat_id" TEXT NOT NULL,
  "publisher_bot_id" TEXT NOT NULL,
  "status" "ChatBotMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "capabilities" JSONB NOT NULL DEFAULT '[]',
  "permissions_snapshot" JSONB,
  "bot_access_state" "ChatBotAccessState" NOT NULL DEFAULT 'UNKNOWN',
  "bot_access_checked_at" TIMESTAMP(3),
  "bot_access_expires_at" TIMESTAMP(3),
  "bot_access_source" TEXT,
  "bot_access_last_error_code" TEXT,
  "permissions_hash" TEXT,
  "send_route_failure_count" INTEGER NOT NULL DEFAULT 0,
  "send_route_quarantined_until" TIMESTAMP(3),
  "send_route_last_failure_at" TIMESTAMP(3),
  "send_route_last_failure_code" TEXT,
  "send_route_last_success_at" TIMESTAMP(3),
  "last_seen_at" TIMESTAMP(3),
  "last_webhook_at" TIMESTAMP(3),
  "lifecycle_event_at" TIMESTAMP(3),
  "lifecycle_event_type" TEXT,
  "lifecycle_source" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "publisher_entity_bindings_pkey" PRIMARY KEY ("chat_id"),
  CONSTRAINT "publisher_entity_bindings_bot_id_check"
    CHECK (BTRIM("publisher_bot_id") <> ''),
  CONSTRAINT "publisher_entity_bindings_capabilities_check"
    CHECK (JSONB_TYPEOF("capabilities") = 'array'),
  CONSTRAINT "publisher_entity_bindings_failure_count_check"
    CHECK ("send_route_failure_count" >= 0)
);

CREATE INDEX "publisher_entity_bindings_bot_status_idx"
ON "publisher_entity_bindings"("publisher_bot_id", "status");

CREATE INDEX "publisher_entity_bindings_access_checked_idx"
ON "publisher_entity_bindings"("bot_access_state", "bot_access_checked_at" DESC);

CREATE INDEX "publisher_entity_bindings_status_quarantine_idx"
ON "publisher_entity_bindings"("status", "send_route_quarantined_until");

CREATE TABLE "managed_entity_publication_policies" (
  "chat_id" TEXT NOT NULL,
  "publik_enabled" BOOLEAN NOT NULL DEFAULT true,
  "suggestions_via_publik" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updated_by_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "managed_entity_publication_policies_pkey" PRIMARY KEY ("chat_id"),
  CONSTRAINT "managed_entity_publication_policies_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "managed_entity_publication_policies_actor_check"
    CHECK ("updated_by_user_id" IS NULL OR BTRIM("updated_by_user_id") <> '')
);

CREATE INDEX "managed_entity_publication_policies_enabled_updated_idx"
ON "managed_entity_publication_policies"("publik_enabled", "updated_at" DESC);

-- Publik workers never own main-bot tokens. Persisted dialog buttons must therefore be prepared
-- and signed by a main-bot process before a publisher job can exist.
CREATE OR REPLACE FUNCTION "is_valid_publisher_dialog_context"(
  context JSONB,
  expected_dialog_bot_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  button_row JSONB;
  button JSONB;
BEGIN
  IF context IS NULL
    OR expected_dialog_bot_id IS NULL
    OR BTRIM(expected_dialog_bot_id) = ''
    OR JSONB_TYPEOF(context) <> 'object'
    OR context->'version' IS DISTINCT FROM '1'::JSONB
    OR BTRIM(COALESCE(context->>'dialogBotId', '')) = ''
    OR context->>'dialogBotId' IS DISTINCT FROM expected_dialog_bot_id
    OR JSONB_TYPEOF(context->'buttons') <> 'array'
    OR OCTET_LENGTH(context::TEXT) > 65536
  THEN
    RETURN FALSE;
  END IF;

  FOR button_row IN SELECT value FROM JSONB_ARRAY_ELEMENTS(context->'buttons') LOOP
    IF JSONB_TYPEOF(button_row) <> 'array' THEN
      RETURN FALSE;
    END IF;
    IF JSONB_ARRAY_LENGTH(button_row) = 0 THEN
      RETURN FALSE;
    END IF;
    FOR button IN SELECT value FROM JSONB_ARRAY_ELEMENTS(button_row) LOOP
      IF JSONB_TYPEOF(button) <> 'object' THEN
        RETURN FALSE;
      END IF;
    END LOOP;
  END LOOP;

  RETURN TRUE;
END;
$$;

ALTER TABLE "publications"
  ADD COLUMN "dispatch_profile" "PublicationDispatchProfile" NOT NULL DEFAULT 'LEGACY_ROUTED',
  ADD COLUMN "required_bot_id" TEXT;

ALTER TABLE "publication_occurrences"
  ADD COLUMN "dispatch_profile" "PublicationDispatchProfile" NOT NULL DEFAULT 'LEGACY_ROUTED',
  ADD COLUMN "required_bot_id" TEXT,
  ADD COLUMN "dispatch_blocker_code" TEXT,
  ADD COLUMN "dispatch_blocked_at" TIMESTAMP(3);

ALTER TABLE "managed_broadcasts"
  ADD COLUMN "dispatch_profile" "PublicationDispatchProfile" NOT NULL DEFAULT 'LEGACY_ROUTED',
  ADD COLUMN "required_bot_id" TEXT;

ALTER TABLE "managed_broadcast_deliveries"
  ADD COLUMN "dispatch_profile" "PublicationDispatchProfile" NOT NULL DEFAULT 'LEGACY_ROUTED',
  ADD COLUMN "required_bot_id" TEXT,
  ADD COLUMN "dialog_bot_id" TEXT,
  ADD COLUMN "publication_policy_revision" INTEGER,
  ADD COLUMN "dispatch_blocker_code" TEXT,
  ADD COLUMN "dispatch_blocked_at" TIMESTAMP(3);

ALTER TABLE "publications"
  ADD CONSTRAINT "publications_dispatch_route_check" CHECK (
    (
      "dispatch_profile" = 'LEGACY_ROUTED'::"PublicationDispatchProfile"
      AND "required_bot_id" IS NULL
    )
    OR (
      "dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
      AND BTRIM(COALESCE("required_bot_id", '')) <> ''
    )
  ) NOT VALID;

ALTER TABLE "publications"
  VALIDATE CONSTRAINT "publications_dispatch_route_check";

ALTER TABLE "publication_occurrences"
  ADD CONSTRAINT "publication_occurrences_dispatch_route_check" CHECK (
    (
      "dispatch_profile" = 'LEGACY_ROUTED'::"PublicationDispatchProfile"
      AND "required_bot_id" IS NULL
    )
    OR (
      "dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
      AND BTRIM(COALESCE("required_bot_id", '')) <> ''
    )
  ) NOT VALID,
  ADD CONSTRAINT "publication_occurrences_dispatch_blocker_check" CHECK (
    ("dispatch_blocker_code" IS NULL AND "dispatch_blocked_at" IS NULL)
    OR (
      BTRIM(COALESCE("dispatch_blocker_code", '')) <> ''
      AND CHAR_LENGTH("dispatch_blocker_code") <= 96
      AND "dispatch_blocked_at" IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE "publication_occurrences"
  VALIDATE CONSTRAINT "publication_occurrences_dispatch_route_check",
  VALIDATE CONSTRAINT "publication_occurrences_dispatch_blocker_check";

ALTER TABLE "managed_broadcasts"
  ADD CONSTRAINT "managed_broadcasts_dispatch_route_check" CHECK (
    (
      "dispatch_profile" = 'LEGACY_ROUTED'::"PublicationDispatchProfile"
      AND "required_bot_id" IS NULL
    )
    OR (
      "dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
      AND "publication_occurrence_id" IS NOT NULL
      AND BTRIM(COALESCE("required_bot_id", '')) <> ''
    )
  ) NOT VALID;

ALTER TABLE "managed_broadcasts"
  VALIDATE CONSTRAINT "managed_broadcasts_dispatch_route_check";

ALTER TABLE "managed_broadcast_deliveries"
  ADD CONSTRAINT "managed_broadcast_deliveries_dispatch_route_check" CHECK (
    (
      "dispatch_profile" = 'LEGACY_ROUTED'::"PublicationDispatchProfile"
      AND "required_bot_id" IS NULL
    )
    OR (
      "dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
      AND "publication_occurrence_id" IS NOT NULL
      AND BTRIM(COALESCE("required_bot_id", '')) <> ''
      AND BTRIM(COALESCE("dialog_bot_id", '')) <> ''
      AND "dialog_bot_id" <> "required_bot_id"
      AND COALESCE("publication_policy_revision", -1) >= 0
      AND ("bot_id" IS NULL OR "bot_id" = "required_bot_id")
    )
  ) NOT VALID,
  ADD CONSTRAINT "managed_broadcast_deliveries_policy_revision_check"
    CHECK ("publication_policy_revision" IS NULL OR "publication_policy_revision" >= 0) NOT VALID,
  ADD CONSTRAINT "managed_broadcast_deliveries_dialog_bot_id_check"
    CHECK ("dialog_bot_id" IS NULL OR BTRIM("dialog_bot_id") <> '') NOT VALID,
  ADD CONSTRAINT "managed_broadcast_deliveries_dispatch_blocker_check" CHECK (
    ("dispatch_blocker_code" IS NULL AND "dispatch_blocked_at" IS NULL)
    OR (
      BTRIM(COALESCE("dispatch_blocker_code", '')) <> ''
      AND CHAR_LENGTH("dispatch_blocker_code") <= 96
      AND "dispatch_blocked_at" IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE "managed_broadcast_deliveries"
  VALIDATE CONSTRAINT "managed_broadcast_deliveries_dispatch_route_check",
  VALIDATE CONSTRAINT "managed_broadcast_deliveries_policy_revision_check",
  VALIDATE CONSTRAINT "managed_broadcast_deliveries_dialog_bot_id_check",
  VALIDATE CONSTRAINT "managed_broadcast_deliveries_dispatch_blocker_check";

ALTER TABLE "publisher_entity_bindings"
  ADD CONSTRAINT "publisher_entity_bindings_chat_id_fkey"
  FOREIGN KEY ("chat_id") REFERENCES "chats"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "managed_entity_publication_policies"
  ADD CONSTRAINT "managed_entity_publication_policies_chat_id_fkey"
  FOREIGN KEY ("chat_id") REFERENCES "chats"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A root owns one immutable route. Every execution envelope derives its route from its parent,
-- including inserts produced by a mixed-version writer that still supplies legacy defaults.
CREATE OR REPLACE FUNCTION "guard_publication_dispatch_route"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW."dispatch_profile" IS DISTINCT FROM OLD."dispatch_profile"
    OR NEW."required_bot_id" IS DISTINCT FROM OLD."required_bot_id"
  THEN
    RAISE EXCEPTION 'publication dispatch route is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'publications_dispatch_route_immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "publications_dispatch_route_immutable"
BEFORE UPDATE OF "dispatch_profile", "required_bot_id"
ON "publications"
FOR EACH ROW
EXECUTE FUNCTION "guard_publication_dispatch_route"();

CREATE OR REPLACE FUNCTION "set_publication_occurrence_dispatch_route"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."publication_id" IS DISTINCT FROM OLD."publication_id" THEN
    RAISE EXCEPTION 'publication occurrence parent is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'publication_occurrences_publication_id_immutable';
  END IF;

  SELECT publication."dispatch_profile", publication."required_bot_id"
  INTO NEW."dispatch_profile", NEW."required_bot_id"
  FROM public."publications" AS publication
  WHERE publication."id" = NEW."publication_id";

  RETURN NEW;
END;
$$;

CREATE TRIGGER "publication_occurrences_dispatch_route_fill"
BEFORE INSERT OR UPDATE OF "publication_id", "dispatch_profile", "required_bot_id"
ON "publication_occurrences"
FOR EACH ROW
EXECUTE FUNCTION "set_publication_occurrence_dispatch_route"();

CREATE OR REPLACE FUNCTION "set_publication_broadcast_dispatch_route"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW."publication_occurrence_id" IS DISTINCT FROM OLD."publication_occurrence_id"
  THEN
    RAISE EXCEPTION 'managed broadcast publication occurrence is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'managed_broadcasts_publication_occurrence_id_immutable';
  END IF;

  IF NEW."publication_occurrence_id" IS NOT NULL THEN
    SELECT occurrence."dispatch_profile", occurrence."required_bot_id"
    INTO NEW."dispatch_profile", NEW."required_bot_id"
    FROM public."publication_occurrences" AS occurrence
    WHERE occurrence."id" = NEW."publication_occurrence_id";
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "managed_broadcasts_dispatch_route_fill"
BEFORE INSERT OR UPDATE OF "publication_occurrence_id", "dispatch_profile", "required_bot_id"
ON "managed_broadcasts"
FOR EACH ROW
EXECUTE FUNCTION "set_publication_broadcast_dispatch_route"();

CREATE OR REPLACE FUNCTION "set_publication_delivery_dispatch_route"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  SELECT
    broadcast."dispatch_profile",
    broadcast."required_bot_id",
    broadcast."publication_occurrence_id"
  INTO
    NEW."dispatch_profile",
    NEW."required_bot_id",
    NEW."publication_occurrence_id"
  FROM public."managed_broadcasts" AS broadcast
  WHERE broadcast."id" = NEW."broadcast_id";

  RETURN NEW;
END;
$$;

CREATE TRIGGER "managed_broadcast_deliveries_dispatch_route_fill"
BEFORE INSERT OR UPDATE OF
  "broadcast_id",
  "publication_occurrence_id",
  "dispatch_profile",
  "required_bot_id"
ON "managed_broadcast_deliveries"
FOR EACH ROW
EXECUTE FUNCTION "set_publication_delivery_dispatch_route"();
