ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "remove_bots_from_group_enabled" BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'chat_settings'
      AND column_name = 'delete_bots_messages_enabled'
  ) THEN
    EXECUTE '
      UPDATE "chat_settings"
      SET "remove_bots_from_group_enabled" = COALESCE("delete_bots_messages_enabled", false)
      WHERE "remove_bots_from_group_enabled" = false
    ';
  END IF;
END $$;
