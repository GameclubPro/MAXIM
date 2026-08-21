ALTER TABLE "night_mode_transition_reconcile_requests"
  ADD COLUMN "manual_acknowledged_at" TIMESTAMP(3),
  ADD CONSTRAINT "night_mode_transition_reconcile_ack_check" CHECK (
    "manual_acknowledged_at" IS NULL
    OR "manual_blocked_at" IS NOT NULL
  );

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
    END,
    "manual_acknowledged_at" = CASE
      WHEN clear_manual_scope = 'no_fresh_access'
        AND "night_mode_transition_reconcile_requests"."manual_blocked_category" =
          'no_fresh_access' THEN NULL
      ELSE "night_mode_transition_reconcile_requests"."manual_acknowledged_at"
    END;
END;
$$;
