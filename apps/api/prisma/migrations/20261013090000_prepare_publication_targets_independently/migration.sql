-- FLAG: A pending context is intent, never SEND authority. Existing v1 contexts stay immutable.
-- Add the relaxed constraint before removing the old one. NOT VALID avoids a retained-history
-- scan: every previously valid row satisfies its unchanged v1 branch; new writes are checked.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION "is_pending_publisher_dialog_context"(context JSONB, expected_bot TEXT, expected_chat TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT COALESCE(
    jsonb_typeof(context) = 'object'
    AND octet_length(context::text) <= 65536
    AND context->'version' = '0'::jsonb
    AND context->>'preparation' = 'pending'
    AND context->>'dialogBotId' = expected_bot
    AND context->>'chatId' = expected_chat
    AND context->>'entityType' IN ('chat', 'channel')
    AND jsonb_typeof(context->'customButtons') = 'array'
    AND jsonb_array_length(CASE WHEN jsonb_typeof(context->'customButtons') = 'array'
      THEN context->'customButtons' ELSE '[]'::jsonb END) <= 8,
    false
  );
$$;

ALTER TABLE "managed_broadcast_deliveries"
  ADD CONSTRAINT "managed_broadcast_deliveries_prepared_context_check" CHECK (
    ("dispatch_profile" = 'LEGACY_ROUTED' AND "publisher_dialog_context" IS NULL)
    OR ("dispatch_profile" = 'PUBLIK_V1' AND (
      COALESCE("is_valid_publisher_dialog_context"("publisher_dialog_context", "dialog_bot_id"), false)
      OR ("status" IN ('PENDING', 'FAILED', 'CANCELED') AND "attempt_count" = 0
        AND "remote_message_id" IS NULL AND "sent_at" IS NULL AND NOT "legacy_sent_without_remote_id"
        AND "is_pending_publisher_dialog_context"("publisher_dialog_context", "dialog_bot_id", "target_chat_id"))
    ))
  ) NOT VALID;

CREATE OR REPLACE FUNCTION "guard_publisher_delivery_route"()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW."broadcast_id" IS DISTINCT FROM OLD."broadcast_id"
    OR NEW."publication_occurrence_id" IS DISTINCT FROM OLD."publication_occurrence_id"
    OR NEW."dispatch_profile" IS DISTINCT FROM OLD."dispatch_profile"
    OR NEW."required_bot_id" IS DISTINCT FROM OLD."required_bot_id"
    OR NEW."dialog_bot_id" IS DISTINCT FROM OLD."dialog_bot_id"
    OR NEW."publication_policy_revision" IS DISTINCT FROM OLD."publication_policy_revision"
    OR (NEW."publisher_dialog_context" IS DISTINCT FROM OLD."publisher_dialog_context" AND NOT (
      OLD."dispatch_profile" = 'PUBLIK_V1'
      AND OLD."status" = 'PENDING' AND NEW."status" = 'PENDING'
      AND OLD."attempt_count" = 0 AND NEW."attempt_count" = 0
      AND OLD."remote_message_id" IS NULL AND NEW."remote_message_id" IS NULL
      AND OLD."sent_at" IS NULL AND NEW."sent_at" IS NULL
      AND NOT OLD."legacy_sent_without_remote_id" AND NOT NEW."legacy_sent_without_remote_id"
      AND NEW."target_chat_id" = OLD."target_chat_id"
      AND NEW."content_revision_id" IS NOT DISTINCT FROM OLD."content_revision_id"
      AND public."is_pending_publisher_dialog_context"(OLD."publisher_dialog_context", OLD."dialog_bot_id", OLD."target_chat_id")
      AND COALESCE(public."is_valid_publisher_dialog_context"(NEW."publisher_dialog_context", NEW."dialog_bot_id"), false)
    ))
  THEN
    RAISE EXCEPTION 'publication delivery route is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'managed_broadcast_deliveries_publisher_route_immutable';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "managed_broadcast_deliveries"
  DROP CONSTRAINT "managed_broadcast_deliveries_publisher_dialog_context_check";
COMMIT;
