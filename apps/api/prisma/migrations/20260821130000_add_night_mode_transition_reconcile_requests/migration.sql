CREATE TABLE "night_mode_transition_reconcile_requests" (
  "chat_id" TEXT NOT NULL,
  "generation" BIGINT NOT NULL DEFAULT 1,
  "first_requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" TIMESTAMP(3),
  "last_error_code" TEXT,
  "last_error_at" TIMESTAMP(3),
  "last_error" TEXT,
  "lease_token" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "manual_blocked_at" TIMESTAMP(3),
  "manual_blocked_reason" TEXT,
  "manual_blocked_category" TEXT,
  "manual_blocked_job_id" TEXT,
  "manual_blocked_ledger_job_id" TEXT,
  "manual_blocked_session_key" TEXT,
  "manual_blocked_fingerprint" TEXT,
  "manual_blocked_generation" BIGINT,

  CONSTRAINT "night_mode_transition_reconcile_requests_pkey" PRIMARY KEY ("chat_id"),
  CONSTRAINT "night_mode_transition_reconcile_manual_block_check" CHECK (
    (
      "manual_blocked_at" IS NULL
      AND "manual_blocked_reason" IS NULL
      AND "manual_blocked_category" IS NULL
      AND "manual_blocked_job_id" IS NULL
      AND "manual_blocked_ledger_job_id" IS NULL
      AND "manual_blocked_session_key" IS NULL
      AND "manual_blocked_fingerprint" IS NULL
      AND "manual_blocked_generation" IS NULL
    )
    OR (
      "manual_blocked_at" IS NOT NULL
      AND "manual_blocked_reason" IS NOT NULL
      AND "manual_blocked_category" IN (
        'unsafe_prior_dispatch',
        'unsafe_prior_provenance',
        'no_fresh_access',
        'failed_job_unclassified'
      )
      AND "manual_blocked_job_id" IS NOT NULL
      AND "manual_blocked_session_key" IS NOT NULL
      AND "manual_blocked_fingerprint" IS NOT NULL
      AND "manual_blocked_generation" IS NOT NULL
    )
  )
);

CREATE INDEX "night_mode_transition_reconcile_due_idx"
  ON "night_mode_transition_reconcile_requests"("requested_at", "lease_expires_at", "chat_id")
  WHERE "manual_blocked_at" IS NULL OR "generation" > "manual_blocked_generation";

CREATE INDEX "night_mode_transition_reconcile_manual_idx"
  ON "night_mode_transition_reconcile_requests"(
    "manual_blocked_at",
    "manual_blocked_category",
    "chat_id"
  )
  WHERE "manual_blocked_at" IS NOT NULL;

CREATE INDEX "night_mode_transition_reconcile_stale_lease_idx"
  ON "night_mode_transition_reconcile_requests"("lease_expires_at", "chat_id")
  WHERE
    ("manual_blocked_at" IS NULL OR "generation" > "manual_blocked_generation")
    AND "lease_token" IS NOT NULL;

CREATE TABLE "night_mode_transition_scheduled_jobs" (
  "chat_id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "transition" TEXT NOT NULL,
  "session_key" TEXT NOT NULL,
  "scheduled_for" TIMESTAMP(3) NOT NULL,
  "schedule_fingerprint" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "night_mode_transition_scheduled_jobs_pkey" PRIMARY KEY ("chat_id", "job_id"),
  CONSTRAINT "night_mode_transition_scheduled_jobs_transition_check"
    CHECK ("transition" IN ('open', 'close'))
);

CREATE INDEX "night_mode_transition_scheduled_jobs_chat_due_idx"
  ON "night_mode_transition_scheduled_jobs"("chat_id", "scheduled_for", "job_id");

CREATE INDEX "night_mode_transition_scheduled_jobs_due_idx"
  ON "night_mode_transition_scheduled_jobs"("scheduled_for", "chat_id", "job_id");

CREATE OR REPLACE FUNCTION enqueue_night_mode_transition_reconcile_request(
  target_chat_id TEXT,
  clear_manual_scope TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF target_chat_id IS NULL OR BTRIM(target_chat_id) = '' THEN
    RETURN;
  END IF;

  INSERT INTO "night_mode_transition_reconcile_requests" (
    "chat_id",
    "generation",
    "first_requested_at",
    "requested_at"
  )
  VALUES (target_chat_id, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT ("chat_id") DO UPDATE
  SET
    "generation" = "night_mode_transition_reconcile_requests"."generation" + 1,
    "first_requested_at" = CASE
      WHEN clear_manual_scope = 'no_fresh_access'
        AND "night_mode_transition_reconcile_requests"."manual_blocked_category" =
          'no_fresh_access' THEN EXCLUDED."first_requested_at"
      ELSE "night_mode_transition_reconcile_requests"."first_requested_at"
    END,
    "requested_at" = LEAST(
      "night_mode_transition_reconcile_requests"."requested_at",
      EXCLUDED."requested_at"
    ),
    "lease_token" = NULL,
    "lease_expires_at" = NULL,
    "attempt_count" = CASE
      WHEN clear_manual_scope = 'no_fresh_access'
        AND "night_mode_transition_reconcile_requests"."manual_blocked_category" =
          'no_fresh_access' THEN 0
      ELSE "night_mode_transition_reconcile_requests"."attempt_count"
    END,
    "last_attempt_at" = CASE
      WHEN clear_manual_scope = 'no_fresh_access'
        AND "night_mode_transition_reconcile_requests"."manual_blocked_category" =
          'no_fresh_access' THEN NULL
      ELSE "night_mode_transition_reconcile_requests"."last_attempt_at"
    END,
    "last_error_code" = CASE
      WHEN clear_manual_scope = 'no_fresh_access'
        AND "night_mode_transition_reconcile_requests"."manual_blocked_category" =
          'no_fresh_access' THEN NULL
      ELSE "night_mode_transition_reconcile_requests"."last_error_code"
    END,
    "last_error_at" = CASE
      WHEN clear_manual_scope = 'no_fresh_access'
        AND "night_mode_transition_reconcile_requests"."manual_blocked_category" =
          'no_fresh_access' THEN NULL
      ELSE "night_mode_transition_reconcile_requests"."last_error_at"
    END,
    "last_error" = CASE
      WHEN clear_manual_scope = 'no_fresh_access'
        AND "night_mode_transition_reconcile_requests"."manual_blocked_category" =
          'no_fresh_access' THEN NULL
      ELSE "night_mode_transition_reconcile_requests"."last_error"
    END,
    "manual_blocked_at" = CASE
      WHEN clear_manual_scope = 'no_fresh_access'
        AND "night_mode_transition_reconcile_requests"."manual_blocked_category" =
          'no_fresh_access' THEN NULL
      ELSE "night_mode_transition_reconcile_requests"."manual_blocked_at"
    END,
    "manual_blocked_reason" = CASE
      WHEN clear_manual_scope = 'no_fresh_access'
        AND "night_mode_transition_reconcile_requests"."manual_blocked_category" =
          'no_fresh_access' THEN NULL
      ELSE "night_mode_transition_reconcile_requests"."manual_blocked_reason"
    END,
    "manual_blocked_category" = CASE
      WHEN clear_manual_scope = 'no_fresh_access'
        AND "night_mode_transition_reconcile_requests"."manual_blocked_category" =
          'no_fresh_access' THEN NULL
      ELSE "night_mode_transition_reconcile_requests"."manual_blocked_category"
    END,
    "manual_blocked_job_id" = CASE
      WHEN clear_manual_scope = 'no_fresh_access'
        AND "night_mode_transition_reconcile_requests"."manual_blocked_category" =
          'no_fresh_access' THEN NULL
      ELSE "night_mode_transition_reconcile_requests"."manual_blocked_job_id"
    END,
    "manual_blocked_ledger_job_id" = CASE
      WHEN clear_manual_scope = 'no_fresh_access'
        AND "night_mode_transition_reconcile_requests"."manual_blocked_category" =
          'no_fresh_access' THEN NULL
      ELSE "night_mode_transition_reconcile_requests"."manual_blocked_ledger_job_id"
    END,
    "manual_blocked_session_key" = CASE
      WHEN clear_manual_scope = 'no_fresh_access'
        AND "night_mode_transition_reconcile_requests"."manual_blocked_category" =
          'no_fresh_access' THEN NULL
      ELSE "night_mode_transition_reconcile_requests"."manual_blocked_session_key"
    END,
    "manual_blocked_fingerprint" = CASE
      WHEN clear_manual_scope = 'no_fresh_access'
        AND "night_mode_transition_reconcile_requests"."manual_blocked_category" =
          'no_fresh_access' THEN NULL
      ELSE "night_mode_transition_reconcile_requests"."manual_blocked_fingerprint"
    END,
    "manual_blocked_generation" = CASE
      WHEN clear_manual_scope = 'no_fresh_access'
        AND "night_mode_transition_reconcile_requests"."manual_blocked_category" =
          'no_fresh_access' THEN NULL
      ELSE "night_mode_transition_reconcile_requests"."manual_blocked_generation"
    END;
END;
$$;

CREATE OR REPLACE FUNCTION enqueue_night_mode_transition_reconcile_from_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM enqueue_night_mode_transition_reconcile_request(OLD."chat_id");
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM enqueue_night_mode_transition_reconcile_request(NEW."chat_id");
    RETURN NEW;
  END IF;

  IF ROW(
    NEW."chat_id",
    NEW."night_mode_enabled",
    NEW."night_mode_start_time_minutes",
    NEW."night_mode_end_time_minutes",
    NEW."night_mode_timezone",
    NEW."night_mode_bot_message_enabled",
    NEW."night_mode_bot_message_text",
    NEW."night_mode_comments_enabled",
    NEW."night_mode_open_message_enabled",
    NEW."night_mode_open_message_text",
    NEW."night_mode_bot_button_enabled",
    NEW."night_mode_bot_button_url",
    NEW."night_mode_bot_button_text",
    NEW."night_mode_bot_buttons",
    NEW."night_mode_rules_button_enabled",
    NEW."night_mode_force_close_enabled",
    NEW."night_mode_force_close_forever",
    NEW."night_mode_force_close_hours",
    NEW."night_mode_force_close_days",
    NEW."night_mode_force_close_until",
    NEW."comments_enabled",
    NEW."bot_speech_style",
    NEW."bot_speech_media"
  ) IS DISTINCT FROM ROW(
    OLD."chat_id",
    OLD."night_mode_enabled",
    OLD."night_mode_start_time_minutes",
    OLD."night_mode_end_time_minutes",
    OLD."night_mode_timezone",
    OLD."night_mode_bot_message_enabled",
    OLD."night_mode_bot_message_text",
    OLD."night_mode_comments_enabled",
    OLD."night_mode_open_message_enabled",
    OLD."night_mode_open_message_text",
    OLD."night_mode_bot_button_enabled",
    OLD."night_mode_bot_button_url",
    OLD."night_mode_bot_button_text",
    OLD."night_mode_bot_buttons",
    OLD."night_mode_rules_button_enabled",
    OLD."night_mode_force_close_enabled",
    OLD."night_mode_force_close_forever",
    OLD."night_mode_force_close_hours",
    OLD."night_mode_force_close_days",
    OLD."night_mode_force_close_until",
    OLD."comments_enabled",
    OLD."bot_speech_style",
    OLD."bot_speech_media"
  ) THEN
    PERFORM enqueue_night_mode_transition_reconcile_request(NEW."chat_id");
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."chat_id" IS DISTINCT FROM OLD."chat_id" THEN
    PERFORM enqueue_night_mode_transition_reconcile_request(OLD."chat_id");
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER chat_settings_enqueue_night_mode_transition_reconcile
AFTER INSERT OR DELETE OR UPDATE OF
  "chat_id",
  "night_mode_enabled",
  "night_mode_start_time_minutes",
  "night_mode_end_time_minutes",
  "night_mode_timezone",
  "night_mode_bot_message_enabled",
  "night_mode_bot_message_text",
  "night_mode_comments_enabled",
  "night_mode_open_message_enabled",
  "night_mode_open_message_text",
  "night_mode_bot_button_enabled",
  "night_mode_bot_button_url",
  "night_mode_bot_button_text",
  "night_mode_bot_buttons",
  "night_mode_rules_button_enabled",
  "night_mode_force_close_enabled",
  "night_mode_force_close_forever",
  "night_mode_force_close_hours",
  "night_mode_force_close_days",
  "night_mode_force_close_until",
  "comments_enabled",
  "bot_speech_style",
  "bot_speech_media"
ON "chat_settings"
FOR EACH ROW
EXECUTE FUNCTION enqueue_night_mode_transition_reconcile_from_settings();

CREATE OR REPLACE FUNCTION enqueue_night_mode_transition_reconcile_from_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1
      FROM "chat_settings" settings
      WHERE settings."chat_id" = OLD."chat_id"
        AND settings."night_mode_enabled" = TRUE
    ) THEN
      PERFORM enqueue_night_mode_transition_reconcile_request(OLD."chat_id");
    END IF;
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "chat_settings" settings
    WHERE settings."chat_id" = NEW."chat_id"
      AND settings."night_mode_enabled" = TRUE
  ) THEN
    IF TG_OP = 'INSERT' THEN
      IF (
        NEW."status" = 'ACTIVE'
        AND NEW."bot_access_state" IN ('CONFIRMED_ADMIN', 'CONFIRMED_OWNER')
        AND NEW."bot_access_expires_at" > CURRENT_TIMESTAMP
      ) THEN
        PERFORM enqueue_night_mode_transition_reconcile_request(
          NEW."chat_id",
          'no_fresh_access'
        );
      ELSE
        PERFORM enqueue_night_mode_transition_reconcile_request(NEW."chat_id");
      END IF;
    ELSIF (
      NEW."status" = 'ACTIVE'
      AND NEW."bot_access_state" IN ('CONFIRMED_ADMIN', 'CONFIRMED_OWNER')
      AND NEW."bot_access_expires_at" > CURRENT_TIMESTAMP
      AND NOT (
        OLD."status" = 'ACTIVE'
        AND OLD."bot_access_state" IN ('CONFIRMED_ADMIN', 'CONFIRMED_OWNER')
        AND OLD."bot_access_expires_at" > CURRENT_TIMESTAMP
      )
    ) THEN
      PERFORM enqueue_night_mode_transition_reconcile_request(
        NEW."chat_id",
        'no_fresh_access'
      );
    ELSIF ROW(
      NEW."chat_id",
      NEW."bot_id",
      NEW."status",
      NEW."bot_access_state"
    ) IS DISTINCT FROM ROW(
      OLD."chat_id",
      OLD."bot_id",
      OLD."status",
      OLD."bot_access_state"
    ) THEN
      PERFORM enqueue_night_mode_transition_reconcile_request(NEW."chat_id");
    ELSIF (
      NEW."status" = 'ACTIVE'
      AND NEW."bot_access_state" IN ('CONFIRMED_ADMIN', 'CONFIRMED_OWNER')
      AND NEW."bot_access_expires_at" > CURRENT_TIMESTAMP
    ) IS DISTINCT FROM (
      OLD."status" = 'ACTIVE'
      AND OLD."bot_access_state" IN ('CONFIRMED_ADMIN', 'CONFIRMED_OWNER')
      AND OLD."bot_access_expires_at" > CURRENT_TIMESTAMP
    ) THEN
      PERFORM enqueue_night_mode_transition_reconcile_request(NEW."chat_id");
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."chat_id" IS DISTINCT FROM OLD."chat_id" THEN
    IF EXISTS (
      SELECT 1
      FROM "chat_settings" settings
      WHERE settings."chat_id" = OLD."chat_id"
        AND settings."night_mode_enabled" = TRUE
    ) THEN
      PERFORM enqueue_night_mode_transition_reconcile_request(OLD."chat_id");
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER chat_bot_memberships_enqueue_night_mode_transition_reconcile
AFTER INSERT OR DELETE OR UPDATE OF
  "chat_id",
  "bot_id",
  "status",
  "bot_access_state",
  "bot_access_expires_at"
ON "chat_bot_memberships"
FOR EACH ROW
EXECUTE FUNCTION enqueue_night_mode_transition_reconcile_from_membership();

CREATE OR REPLACE FUNCTION enqueue_night_mode_transition_reconcile_from_chat()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_settings" settings
    WHERE settings."chat_id" = NEW."id"
      AND settings."night_mode_enabled" = TRUE
  ) THEN
    IF TG_OP = 'UPDATE' AND NEW."entity_type" IS DISTINCT FROM OLD."entity_type" THEN
      PERFORM enqueue_night_mode_transition_reconcile_request(NEW."id");
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER chats_enqueue_night_mode_transition_reconcile
AFTER UPDATE OF "entity_type" ON "chats"
FOR EACH ROW
EXECUTE FUNCTION enqueue_night_mode_transition_reconcile_from_chat();

INSERT INTO "night_mode_transition_reconcile_requests" (
  "chat_id",
  "generation",
  "requested_at"
)
SELECT settings."chat_id", 1, CURRENT_TIMESTAMP
FROM "chat_settings" settings
WHERE settings."night_mode_enabled" = TRUE
ON CONFLICT ("chat_id") DO NOTHING;
