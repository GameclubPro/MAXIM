ALTER TABLE "chat_settings"
  ALTER COLUMN "delete_bot_messages_delay_minutes" TYPE DOUBLE PRECISION
  USING "delete_bot_messages_delay_minutes"::double precision;

ALTER TABLE "chat_settings"
  ALTER COLUMN "delete_bot_messages_delay_minutes" SET DEFAULT 2;
