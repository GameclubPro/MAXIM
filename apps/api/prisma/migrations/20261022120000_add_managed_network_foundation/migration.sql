-- Additive foundation. No historical observations or assignments are rewritten.
ALTER TABLE "channel_settings" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "channel_settings" ADD CONSTRAINT "channel_settings_revision_nonnegative"
  CHECK ("revision" >= 0) NOT VALID;

-- FLAG: All writers, including compatible legacy roles, advance the revision once.
CREATE FUNCTION "advance_channel_settings_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "channel_settings_revision_guard"
BEFORE UPDATE ON "channel_settings"
FOR EACH ROW EXECUTE FUNCTION "advance_channel_settings_revision"();

CREATE TABLE "managed_entity_audience_observations" (
  "chat_id" TEXT NOT NULL,
  "entity_type" "ChatEntityType" NOT NULL,
  "participants_count" INTEGER NOT NULL CHECK ("participants_count" >= 0),
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "source" TEXT NOT NULL,
  CONSTRAINT "managed_entity_audience_observations_pkey" PRIMARY KEY ("chat_id", "entity_type"),
  CONSTRAINT "managed_entity_audience_observations_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "channel_view_observation_states" (
  "channel_post_id" TEXT NOT NULL PRIMARY KEY,
  "baseline_at" TIMESTAMPTZ(6) NOT NULL,
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "observed_views" INTEGER NOT NULL CHECK ("observed_views" >= 0),
  "high_water_views" INTEGER NOT NULL CHECK ("high_water_views" >= "observed_views"),
  "anomaly_at" TIMESTAMPTZ(6),
  "source" TEXT NOT NULL,
  CONSTRAINT "channel_view_observation_states_time_check" CHECK ("observed_at" >= "baseline_at"),
  CONSTRAINT "channel_view_observation_states_channel_post_id_fkey"
    FOREIGN KEY ("channel_post_id") REFERENCES "channel_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "channel_view_observed_intervals" (
  "channel_post_id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "from_at" TIMESTAMPTZ(6) NOT NULL,
  "to_at" TIMESTAMPTZ(6) NOT NULL,
  "delta" BIGINT NOT NULL CHECK ("delta" >= 0),
  "quality" TEXT NOT NULL CHECK ("quality" IN ('ready', 'gap', 'correction')),
  "source" TEXT NOT NULL,
  CONSTRAINT "channel_view_observed_intervals_pkey" PRIMARY KEY ("channel_post_id", "to_at"),
  CONSTRAINT "channel_view_observed_intervals_time_check" CHECK ("to_at" > "from_at"),
  CONSTRAINT "channel_view_observed_intervals_channel_post_id_fkey"
    FOREIGN KEY ("channel_post_id") REFERENCES "channel_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "channel_view_observed_intervals_to_post_idx"
  ON "channel_view_observed_intervals"("to_at", "channel_post_id");
CREATE INDEX "channel_view_observed_intervals_chat_to_post_idx"
  ON "channel_view_observed_intervals"("chat_id", "to_at", "channel_post_id");

CREATE TABLE "channel_view_archive_states" (
  "chat_id" TEXT NOT NULL PRIMARY KEY,
  "cursor_at" TIMESTAMPTZ(6),
  "cursor_signature" TEXT,
  "discovered_from" TIMESTAMPTZ(6),
  "discovery_complete_at" TIMESTAMPTZ(6),
  "last_attempt_at" TIMESTAMPTZ(6),
  "last_success_at" TIMESTAMPTZ(6),
  "full_refresh_at" TIMESTAMPTZ(6),
  "stalled_at" TIMESTAMPTZ(6),
  "observed_post_count" INTEGER NOT NULL DEFAULT 0 CHECK ("observed_post_count" >= 0),
  "first_observed_at" TIMESTAMPTZ(6),
  "last_observed_at" TIMESTAMPTZ(6),
  CONSTRAINT "channel_view_archive_states_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "network_settings_operations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actor_user_id" TEXT NOT NULL,
  "entity_type" "ChatEntityType" NOT NULL,
  "request_hash" TEXT NOT NULL,
  "section" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL,
  "lease_token" TEXT,
  "lease_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "network_settings_operations_status_lease_updated_idx"
  ON "network_settings_operations"("status", "lease_until", "updated_at");
CREATE INDEX "network_settings_operations_actor_created_idx"
  ON "network_settings_operations"("actor_user_id", "created_at");

-- FLAG: COMMITTED target receipts share the exact settings transaction. Recovery
-- executes only deferred cache/schedule followups and never repeats the write.
CREATE TABLE "network_settings_operation_targets" (
  "operation_id" TEXT NOT NULL,
  "entity_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "revision" TEXT NOT NULL,
  "stop_words_revision" INTEGER,
  "failure_code" TEXT,
  "failure_message" TEXT,
  "committed_revision" TEXT,
  "followup" JSONB,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "network_settings_operation_targets_pkey" PRIMARY KEY ("operation_id", "entity_id"),
  CONSTRAINT "network_settings_operation_targets_operation_id_fkey"
    FOREIGN KEY ("operation_id") REFERENCES "network_settings_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "network_settings_operation_targets_status_updated_idx"
  ON "network_settings_operation_targets"("status", "updated_at");
