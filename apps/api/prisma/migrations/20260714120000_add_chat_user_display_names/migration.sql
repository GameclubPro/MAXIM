-- Durable, chat-scoped name snapshots for statistics read models.
-- Keep this independent of webhook retention and chat discovery state.
CREATE TABLE IF NOT EXISTS "chat_user_display_names" (
  "chat_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "source_event_id" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_user_display_names_pkey" PRIMARY KEY ("chat_id", "user_id"),
  CONSTRAINT "chat_user_display_names_display_name_check"
    CHECK (BTRIM("display_name") <> '')
);

CREATE INDEX IF NOT EXISTS "chat_user_display_names_observed_at_idx"
ON "chat_user_display_names"("observed_at");
