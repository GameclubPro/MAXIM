ALTER TABLE "chat_settings"
  ADD COLUMN "slow_mode_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "slow_mode_interval_seconds" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "media_message_cooldown_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "media_message_cooldown_seconds" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "sticker_messages_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "traffic_policy_revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "traffic_policy_effective_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "chat_settings"
  ADD CONSTRAINT "chat_settings_traffic_intervals_check" CHECK (
    "slow_mode_interval_seconds" BETWEEN 10 AND 86400
    AND "media_message_cooldown_seconds" BETWEEN 10 AND 86400
    AND "traffic_policy_revision" >= 0
  ) NOT VALID;

-- FLAG: Every settings writer, including bulk/private controls, invalidates pending
-- traffic decisions on a policy change. Clients cannot choose or rewind the revision.
CREATE FUNCTION "advance_chat_traffic_policy_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."traffic_policy_revision" := 0;
    NEW."traffic_policy_effective_at" := CURRENT_TIMESTAMP;
  ELSIF ROW(
    NEW."slow_mode_enabled", NEW."slow_mode_interval_seconds",
    NEW."media_message_cooldown_enabled", NEW."media_message_cooldown_seconds",
    NEW."sticker_messages_enabled"
  ) IS DISTINCT FROM ROW(
    OLD."slow_mode_enabled", OLD."slow_mode_interval_seconds",
    OLD."media_message_cooldown_enabled", OLD."media_message_cooldown_seconds",
    OLD."sticker_messages_enabled"
  ) THEN
    NEW."traffic_policy_revision" := OLD."traffic_policy_revision" + 1;
    NEW."traffic_policy_effective_at" := CURRENT_TIMESTAMP;
  ELSE
    NEW."traffic_policy_revision" := OLD."traffic_policy_revision";
    NEW."traffic_policy_effective_at" := OLD."traffic_policy_effective_at";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "chat_settings_traffic_policy_revision_trigger"
BEFORE INSERT OR UPDATE ON "chat_settings"
FOR EACH ROW EXECUTE FUNCTION "advance_chat_traffic_policy_revision"();
