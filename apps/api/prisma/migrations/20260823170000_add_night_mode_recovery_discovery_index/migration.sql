CREATE INDEX CONCURRENTLY IF NOT EXISTS "max_action_ledger_night_mode_close_recovery_discovery_idx"
ON "max_action_ledger"("completed_at" DESC, "id" DESC)
INCLUDE ("job_id", "chat_id", "remote_message_id", "dispatch_bot_id")
WHERE "terminal" = true
  AND "completed_at" IS NOT NULL
  AND "status" = 'SUCCEEDED'
  AND "ambiguous" = false
  AND "action_type" = 'SEND_MESSAGE'
  AND "source_tag" = 'night_mode_transition'
  AND "remote_message_id" IS NOT NULL
  AND BTRIM("remote_message_id") <> ''
  AND "dispatch_bot_id" IS NOT NULL
  AND BTRIM("dispatch_bot_id") <> ''
  AND "job_id" LIKE 'night-mode:close:%';
