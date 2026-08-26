ALTER TABLE "managed_broadcast_deliveries"
  ADD COLUMN "publisher_dialog_context" JSONB;

ALTER TABLE "managed_broadcast_deliveries"
  ADD CONSTRAINT "managed_broadcast_deliveries_publisher_dialog_context_check" CHECK (
    (
      "dispatch_profile" = 'LEGACY_ROUTED'::"PublicationDispatchProfile"
      AND "publisher_dialog_context" IS NULL
    )
    OR (
      "dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
      AND "publisher_dialog_context" IS NOT NULL
      AND COALESCE(
        "is_valid_publisher_dialog_context"("publisher_dialog_context", "dialog_bot_id"),
        false
      )
    )
  ) NOT VALID;

ALTER TABLE "managed_broadcast_deliveries"
  VALIDATE CONSTRAINT "managed_broadcast_deliveries_publisher_dialog_context_check";

CREATE OR REPLACE FUNCTION "guard_publisher_delivery_route"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW."broadcast_id" IS DISTINCT FROM OLD."broadcast_id"
    OR NEW."publication_occurrence_id" IS DISTINCT FROM OLD."publication_occurrence_id"
    OR NEW."dispatch_profile" IS DISTINCT FROM OLD."dispatch_profile"
    OR NEW."required_bot_id" IS DISTINCT FROM OLD."required_bot_id"
    OR NEW."dialog_bot_id" IS DISTINCT FROM OLD."dialog_bot_id"
    OR NEW."publisher_dialog_context" IS DISTINCT FROM OLD."publisher_dialog_context"
    OR NEW."publication_policy_revision" IS DISTINCT FROM OLD."publication_policy_revision"
  THEN
    RAISE EXCEPTION 'publication delivery route is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'managed_broadcast_deliveries_publisher_route_immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "managed_broadcast_deliveries_publisher_route_immutable"
BEFORE UPDATE OF
  "broadcast_id",
  "publication_occurrence_id",
  "dispatch_profile",
  "required_bot_id",
  "dialog_bot_id",
  "publisher_dialog_context",
  "publication_policy_revision"
ON "managed_broadcast_deliveries"
FOR EACH ROW
EXECUTE FUNCTION "guard_publisher_delivery_route"();
