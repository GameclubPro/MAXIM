ALTER TABLE "chat_settings"
  ADD COLUMN "reports_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reports_threshold" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "reports_aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "reports_delete_mode" TEXT NOT NULL DEFAULT 'MESSAGE',
  ADD COLUMN "reports_mute_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reports_mute_duration_hours" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "reports_revision" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "chat_settings_reports_bounds" CHECK (
    reports_threshold BETWEEN 2 AND 6 AND reports_mute_duration_hours BETWEEN 1 AND 24
    AND reports_delete_mode IN ('MESSAGE', 'HISTORY_24H') AND cardinality(reports_aliases) <= 5
  );

-- FLAG: Every settings writer, including bulk apply, advances the report policy fence.
CREATE FUNCTION maxim_report_policy_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.reports_enabled, NEW.reports_threshold, NEW.reports_aliases,
    NEW.reports_delete_mode, NEW.reports_mute_enabled, NEW.reports_mute_duration_hours)
    IS DISTINCT FROM ROW(OLD.reports_enabled, OLD.reports_threshold, OLD.reports_aliases,
    OLD.reports_delete_mode, OLD.reports_mute_enabled, OLD.reports_mute_duration_hours) THEN
    NEW.reports_revision := OLD.reports_revision + 1;
  ELSE
    NEW.reports_revision := OLD.reports_revision;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chat_settings_report_policy_revision BEFORE UPDATE ON "chat_settings"
FOR EACH ROW EXECUTE FUNCTION maxim_report_policy_revision();

CREATE TABLE "chat_report_cases" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "chat_id" TEXT NOT NULL REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "message_id" TEXT NOT NULL, "author_id" TEXT NOT NULL, "origin_bot_id" TEXT NOT NULL,
  "content_hash" TEXT NOT NULL, "content_version" INTEGER NOT NULL DEFAULT 1,
  "policy_revision" INTEGER NOT NULL, "message_created_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL, "threshold" INTEGER NOT NULL,
  "delete_mode" TEXT NOT NULL, "mute_hours" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'COLLECTING', "decided_at" TIMESTAMP(3),
  "mute_processed" BOOLEAN NOT NULL DEFAULT false, "mute_event_id" TEXT,
  "scan_cursor_created_at" TIMESTAMP(3), "scan_cursor_id" TEXT,
  "scan_complete" BOOLEAN NOT NULL DEFAULT false,
  "counter_message_id" TEXT, "counter_send_started_at" TIMESTAMP(3), "counter_text" TEXT,
  "due_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" TEXT, "lease_expires_at" TIMESTAMP(3), "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "chat_report_cases_bounds" CHECK (threshold BETWEEN 2 AND 6
    AND (mute_hours IS NULL OR mute_hours BETWEEN 1 AND 24)
    AND delete_mode IN ('MESSAGE', 'HISTORY_24H'))
);
CREATE UNIQUE INDEX "chat_report_cases_chat_id_message_id_key" ON "chat_report_cases"("chat_id", "message_id");
CREATE INDEX "chat_report_cases_chat_id_created_at_id_idx" ON "chat_report_cases"("chat_id", "created_at" DESC, "id" DESC);
CREATE INDEX "chat_report_cases_due_at_id_idx" ON "chat_report_cases"("due_at", "id");
CREATE TABLE "chat_report_votes" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "case_id" TEXT NOT NULL REFERENCES "chat_report_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "content_version" INTEGER NOT NULL, "chat_id" TEXT NOT NULL, "reporter_id" TEXT NOT NULL,
  "command_message_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "chat_report_votes_case_id_content_version_reporter_id_key" ON "chat_report_votes"("case_id", "content_version", "reporter_id");
CREATE UNIQUE INDEX "chat_report_votes_chat_id_command_message_id_key" ON "chat_report_votes"("chat_id", "command_message_id");
CREATE INDEX "chat_report_votes_chat_id_reporter_id_created_at_idx" ON "chat_report_votes"("chat_id", "reporter_id", "created_at");
CREATE TABLE "chat_report_actions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "case_id" TEXT NOT NULL REFERENCES "chat_report_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "message_id" TEXT NOT NULL, "intent_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "chat_report_actions_case_id_message_id_key" ON "chat_report_actions"("case_id", "message_id");
CREATE INDEX "chat_report_actions_intent_id_idx" ON "chat_report_actions"("intent_id");
