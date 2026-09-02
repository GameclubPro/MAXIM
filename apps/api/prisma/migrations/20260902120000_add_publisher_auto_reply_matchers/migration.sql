BEGIN;

CREATE TYPE "PublisherAutoReplyMatchKind" AS ENUM (
  'EXACT_FULL',
  'EXACT_CONTEXT',
  'FUZZY_FULL',
  'FUZZY_CONTEXT'
);

ALTER TABLE "publisher_entity_settings"
  ADD COLUMN "auto_reply_config_revision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "publisher_entity_settings"
  ADD CONSTRAINT "publisher_entity_settings_auto_reply_config_revision_check"
  CHECK ("auto_reply_config_revision" >= 0) NOT VALID;

ALTER TABLE "publisher_entity_settings"
  VALIDATE CONSTRAINT "publisher_entity_settings_auto_reply_config_revision_check";

ALTER TABLE "publisher_auto_reply_rules"
  ADD COLUMN "match_in_context" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "fuzzy_match" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "publisher_auto_reply_rules_id_chat_id_key"
  ON "publisher_auto_reply_rules"("id", "chat_id");

CREATE TABLE "publisher_auto_reply_triggers" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "rule_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "phrase" TEXT NOT NULL,
  "normalized_phrase" TEXT NOT NULL,
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "publisher_auto_reply_triggers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publisher_auto_reply_triggers_values_check" CHECK (
    "position" BETWEEN 0 AND 9
    AND BTRIM("phrase") <> ''
    AND CHAR_LENGTH("phrase") <= 80
    AND BTRIM("normalized_phrase") <> ''
    AND CHAR_LENGTH("normalized_phrase") <= 80
  ),
  CONSTRAINT "publisher_auto_reply_triggers_rule_chat_fkey"
    FOREIGN KEY ("rule_id", "chat_id")
    REFERENCES "publisher_auto_reply_rules"("id", "chat_id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "publisher_auto_reply_triggers" (
  "id",
  "chat_id",
  "rule_id",
  "position",
  "phrase",
  "normalized_phrase",
  "archived_at",
  "created_at"
)
SELECT
  'primary:' || rules."id",
  rules."chat_id",
  rules."id",
  0,
  rules."phrase",
  rules."normalized_phrase",
  rules."archived_at",
  rules."created_at"
FROM "publisher_auto_reply_rules" AS rules;

DO $migration$
DECLARE
  missing_primary_count BIGINT;
BEGIN
  SELECT COUNT(*)
  INTO missing_primary_count
  FROM "publisher_auto_reply_rules" AS rules
  LEFT JOIN "publisher_auto_reply_triggers" AS triggers
    ON triggers."rule_id" = rules."id"
    AND triggers."chat_id" = rules."chat_id"
    AND triggers."position" = 0
    AND triggers."phrase" = rules."phrase"
    AND triggers."normalized_phrase" = rules."normalized_phrase"
    AND triggers."archived_at" IS NOT DISTINCT FROM rules."archived_at"
  WHERE triggers."id" IS NULL;

  IF missing_primary_count <> 0 THEN
    RAISE EXCEPTION
      'Publisher auto-reply trigger backfill missed % primary rows',
      missing_primary_count;
  END IF;
END;
$migration$;

CREATE UNIQUE INDEX "publisher_auto_reply_triggers_rule_position_key"
  ON "publisher_auto_reply_triggers"("rule_id", "position");
CREATE UNIQUE INDEX "publisher_auto_reply_triggers_rule_normalized_phrase_key"
  ON "publisher_auto_reply_triggers"("rule_id", "normalized_phrase");
CREATE UNIQUE INDEX "publisher_auto_reply_triggers_active_phrase_key"
  ON "publisher_auto_reply_triggers"("chat_id", "normalized_phrase")
  WHERE "archived_at" IS NULL;
CREATE INDEX "publisher_auto_reply_triggers_chat_rule_position_idx"
  ON "publisher_auto_reply_triggers"("chat_id", "rule_id", "position");

CREATE OR REPLACE FUNCTION "guard_publisher_auto_reply_trigger_parent"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  parent_chat_id TEXT;
  parent_archived_at TIMESTAMP(3);
BEGIN
  SELECT rules."chat_id", rules."archived_at"
  INTO parent_chat_id, parent_archived_at
  FROM "publisher_auto_reply_rules" AS rules
  WHERE rules."id" = NEW."rule_id"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Publisher auto-reply rule % does not exist',
      NEW."rule_id"
      USING ERRCODE = '23503';
  END IF;

  NEW."chat_id" := parent_chat_id;
  NEW."archived_at" := parent_archived_at;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "publisher_auto_reply_triggers_parent_guard"
BEFORE INSERT OR UPDATE OF "rule_id", "chat_id", "archived_at"
ON "publisher_auto_reply_triggers"
FOR EACH ROW
EXECUTE FUNCTION "guard_publisher_auto_reply_trigger_parent"();

CREATE OR REPLACE FUNCTION "sync_publisher_auto_reply_primary_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE "publisher_auto_reply_triggers"
  SET
    "chat_id" = NEW."chat_id",
    "archived_at" = NEW."archived_at"
  WHERE "rule_id" = NEW."id"
    AND "position" <> 0
    AND (
      "chat_id" IS DISTINCT FROM NEW."chat_id"
      OR "archived_at" IS DISTINCT FROM NEW."archived_at"
    );

  INSERT INTO "publisher_auto_reply_triggers" (
    "id",
    "chat_id",
    "rule_id",
    "position",
    "phrase",
    "normalized_phrase",
    "archived_at",
    "created_at"
  )
  VALUES (
    'primary:' || NEW."id",
    NEW."chat_id",
    NEW."id",
    0,
    NEW."phrase",
    NEW."normalized_phrase",
    NEW."archived_at",
    NEW."created_at"
  )
  ON CONFLICT ("rule_id", "position") DO UPDATE
  SET
    "chat_id" = EXCLUDED."chat_id",
    "phrase" = EXCLUDED."phrase",
    "normalized_phrase" = EXCLUDED."normalized_phrase",
    "archived_at" = EXCLUDED."archived_at";

  RETURN NEW;
END;
$function$;

CREATE TRIGGER "publisher_auto_reply_rules_primary_trigger_sync"
AFTER INSERT OR UPDATE OF "chat_id", "phrase", "normalized_phrase", "archived_at"
ON "publisher_auto_reply_rules"
FOR EACH ROW
EXECUTE FUNCTION "sync_publisher_auto_reply_primary_trigger"();

ALTER TABLE "publisher_auto_reply_deliveries"
  ADD COLUMN "matched_trigger_id" TEXT,
  ADD COLUMN "match_kind" "PublisherAutoReplyMatchKind" NOT NULL DEFAULT 'EXACT_FULL',
  ADD COLUMN "distance" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "matcher_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "auto_reply_config_revision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "publisher_auto_reply_deliveries"
  ADD CONSTRAINT "publisher_auto_reply_deliveries_match_snapshot_check" CHECK (
    "distance" >= 0
    AND "matcher_version" >= 1
    AND "auto_reply_config_revision" >= 0
  ) NOT VALID;

ALTER TABLE "publisher_auto_reply_deliveries"
  VALIDATE CONSTRAINT "publisher_auto_reply_deliveries_match_snapshot_check";

ALTER TABLE "publisher_auto_reply_deliveries"
  ADD CONSTRAINT "publisher_auto_reply_deliveries_matched_trigger_id_fkey"
  FOREIGN KEY ("matched_trigger_id")
  REFERENCES "publisher_auto_reply_triggers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "publisher_auto_reply_deliveries_matched_trigger_idx"
  ON "publisher_auto_reply_deliveries"("matched_trigger_id");

ALTER TABLE "publisher_auto_reply_authoring_sessions"
  ADD COLUMN "trigger_phrases" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "match_in_context" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "fuzzy_match" BOOLEAN NOT NULL DEFAULT false;

UPDATE "publisher_auto_reply_authoring_sessions"
SET "trigger_phrases" = jsonb_build_array("phrase")
WHERE "phrase" IS NOT NULL;

ALTER TABLE "publisher_auto_reply_authoring_sessions"
  ADD CONSTRAINT "publisher_auto_reply_authoring_sessions_trigger_phrases_check" CHECK (
    JSONB_TYPEOF("trigger_phrases") = 'array'
    AND JSONB_ARRAY_LENGTH("trigger_phrases") <= 10
  ) NOT VALID;

ALTER TABLE "publisher_auto_reply_authoring_sessions"
  VALIDATE CONSTRAINT "publisher_auto_reply_authoring_sessions_trigger_phrases_check";

ALTER TABLE "publisher_auto_reply_authoring_messages"
  DROP CONSTRAINT "publisher_auto_reply_authoring_messages_values_check",
  ADD CONSTRAINT "publisher_auto_reply_authoring_messages_values_check" CHECK (
    BTRIM("publisher_bot_id") <> ''
    AND BTRIM("message_id") <> ''
    AND "kind" IN ('PHRASE', 'CONTENT', 'CALLBACK')
    AND "stage_revision" >= 0
  );

COMMIT;
