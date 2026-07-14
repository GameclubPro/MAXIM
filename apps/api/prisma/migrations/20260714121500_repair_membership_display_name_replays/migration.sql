-- Keep the incremental name repair resumable and outside schema migrations.
CREATE TABLE IF NOT EXISTS "chat_user_display_name_backfill_states" (
  "chat_id" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL,
  "cursor_event_at" TIMESTAMP(3),
  "cursor_event_id" TEXT,
  "completed_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_user_display_name_backfill_states_pkey"
    PRIMARY KEY ("chat_id", "source_kind")
);

CREATE INDEX IF NOT EXISTS "chat_user_display_name_backfill_state_work_idx"
ON "chat_user_display_name_backfill_states"(
  "source_kind",
  "completed_at",
  "updated_at"
);

-- The source event upsert only changes an empty name to a non-empty one. Re-run
-- the existing projection function so the canonical feed item is repaired too.
-- That function increments rollups only for a newly inserted canonical item.
DROP TRIGGER IF EXISTS "chat_membership_activity_events_rollup_sender_name_update"
ON "chat_membership_activity_events";

CREATE TRIGGER "chat_membership_activity_events_rollup_sender_name_update"
AFTER UPDATE OF "sender_name" ON "chat_membership_activity_events"
FOR EACH ROW
WHEN (
  COALESCE(BTRIM(OLD."sender_name"), '') = ''
  AND COALESCE(BTRIM(NEW."sender_name"), '') <> ''
)
EXECUTE FUNCTION "sync_chat_membership_activity_rollup"();
