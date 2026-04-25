ALTER TABLE "chat_settings"
  ADD COLUMN "invitation_access_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "invitation_access_required_count" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "invitation_access_bot_message_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "invitation_access_bot_message_text" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "invitation_access_warn_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "invitation_access_warn_message_text" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "invitation_access_ban_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "invitation_access_mute_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "invitation_access_mute_duration_hours" INTEGER NOT NULL DEFAULT 6;

CREATE TABLE "chat_invitation_access_progress" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "invited_user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "chat_invitation_access_progress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_invitation_access_progress_chat_id_user_id_key"
  ON "chat_invitation_access_progress"("chat_id", "user_id");

CREATE INDEX "chat_invitation_access_progress_chat_id_completed_at_idx"
  ON "chat_invitation_access_progress"("chat_id", "completed_at");

ALTER TABLE "chat_invitation_access_progress"
  ADD CONSTRAINT "chat_invitation_access_progress_chat_id_fkey"
  FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
