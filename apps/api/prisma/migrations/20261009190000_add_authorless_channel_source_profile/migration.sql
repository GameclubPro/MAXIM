-- FLAG: Authorless channels use a distinct immutable profile and real NULL user.
-- No existing evidence is scrubbed, relabelled, settled or replayed by this migration.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE "webhook_source_abandonments"
  ADD COLUMN "source_profile" TEXT NOT NULL DEFAULT 'HUMAN_CHAT_V1',
  ALTER COLUMN "subject_user_id" DROP NOT NULL,
  ADD CONSTRAINT "webhook_source_abandonments_profile_user_check" CHECK (
    ("source_profile" = 'HUMAN_CHAT_V1' AND "subject_user_id" IS NOT NULL) OR
    ("source_profile" = 'CHANNEL_AUTHORLESS_V1' AND "subject_user_id" IS NULL));
ALTER TABLE "webhook_source_child_holds"
  DROP CONSTRAINT "webhook_source_child_holds_kind_check",
  ADD CONSTRAINT "webhook_source_child_holds_kind_check"
    CHECK ("kind" IN ('MAX_ACTION', 'SPAMMER_OBSERVATION', 'CHANNEL_AUTO_POST'));

CREATE OR REPLACE FUNCTION "guard_source_abandonment_row"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cert_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Source abandonment evidence is permanent and immutable'; END IF;
  IF TG_TABLE_NAME = 'webhook_source_abandonments' THEN
    cert_id := NEW."certificate_id";
    IF NEW."source_profile" = 'CHANNEL_AUTHORLESS_V1' AND NOT EXISTS (
      SELECT 1 FROM "webhook_events" e WHERE e."id" = NEW."owner_webhook_event_id"
        AND e."raw_payload" = e."normalized_payload"->'raw'
        AND e."raw_payload"->>'update_type' IN ('message_created', 'message_edited')
        AND e."raw_payload"->>'update_type' = e."normalized_payload"->>'type'
        AND e."raw_payload"->'message'->'recipient'->>'chat_type' = 'channel'
        AND e."normalized_payload"->'message'->>'entityType' = 'channel'
        AND NOT (e."raw_payload"->'message' ? 'sender')
        AND e."normalized_payload"->'message'->'senderId' = '""'::jsonb
        AND e."raw_payload"->'message'->'recipient'->>'chat_id' = NEW."chat_id"
        AND e."raw_payload"->'message'->'body'->>'mid' = NEW."message_id"
        AND e."normalized_payload"->'message'->>'chatId' = NEW."chat_id"
        AND e."normalized_payload"->'message'->>'messageId' = NEW."message_id"
        AND e."bot_id" = e."normalized_payload"->>'botId'
        AND e."semantic_key" = NEW."semantic_key"
    ) THEN RAISE EXCEPTION 'Authorless channel source requires retained exact original evidence'; END IF;
  ELSE
    SELECT "certificate_id" INTO STRICT cert_id FROM "webhook_source_abandonments" WHERE "id" = NEW."abandonment_id";
    IF NEW."kind" = 'CHANNEL_AUTO_POST' AND NOT EXISTS (
      SELECT 1 FROM "webhook_source_abandonments" a
      JOIN "channel_auto_post_attach_markers" m ON m."chat_id" = a."chat_id" AND m."message_id" = a."message_id"
      WHERE a."id" = NEW."abandonment_id" AND a."source_profile" = 'CHANNEL_AUTHORLESS_V1'
        AND m."id" = NEW."child_key"
    ) THEN RAISE EXCEPTION 'Channel marker hold requires exact source marker'; END IF;
  END IF;
  PERFORM "id" FROM "webhook_source_abandonment_certificates" WHERE "id" = cert_id AND "sealed_at" IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source hold requires exact unsealed certificate'; END IF;
  RETURN NEW;
END $$;

-- FLAG: Preserve uncertain dispatch markers verbatim. This also refuses a newly
-- created marker or a move into a held source, before and after certificate seal.
CREATE FUNCTION "guard_source_channel_auto_post_marker"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND (
    EXISTS (SELECT 1 FROM "webhook_source_abandonments" WHERE "chat_id" = OLD."chat_id" AND "message_id" = OLD."message_id") OR
    EXISTS (SELECT 1 FROM "webhook_source_child_holds" WHERE "kind" = 'CHANNEL_AUTO_POST' AND "child_key" = OLD."id")
  ) THEN RAISE EXCEPTION 'Held channel marker evidence is permanent and immutable'; END IF;
  IF TG_OP <> 'DELETE' AND EXISTS (
    SELECT 1 FROM "webhook_source_abandonments" WHERE "chat_id" = NEW."chat_id" AND "message_id" = NEW."message_id"
  ) THEN RAISE EXCEPTION 'Held channel source cannot acquire or change a marker'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "source_channel_auto_post_marker_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "channel_auto_post_attach_markers"
  FOR EACH ROW EXECUTE FUNCTION "guard_source_channel_auto_post_marker"();
COMMIT;
