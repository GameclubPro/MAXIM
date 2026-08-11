BEGIN;

DROP TRIGGER "chat_settings_link_policy_recovery_baseline" ON "chat_settings";

ALTER TABLE "chat_settings"
  ALTER COLUMN "link_policy_effective_at" SET DATA TYPE TIMESTAMP(3)
  USING ("link_policy_effective_at" AT TIME ZONE 'UTC');

ALTER TABLE "moderation_link_history_scan_states"
  ALTER COLUMN "policy_effective_at" SET DATA TYPE TIMESTAMP(3)
    USING ("policy_effective_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "discovery_cursor_at" SET DATA TYPE TIMESTAMP(3)
    USING ("discovery_cursor_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "repair_cursor_at" SET DATA TYPE TIMESTAMP(3)
    USING ("repair_cursor_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "window_lower_at" SET DATA TYPE TIMESTAMP(3)
    USING ("window_lower_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "window_upper_at" SET DATA TYPE TIMESTAMP(3)
    USING ("window_upper_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "continuation_from_at" SET DATA TYPE TIMESTAMP(3)
    USING ("continuation_from_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "next_scan_at" SET DATA TYPE TIMESTAMP(3)
    USING ("next_scan_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "last_successful_scan_at" SET DATA TYPE TIMESTAMP(3)
    USING ("last_successful_scan_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "last_error_at" SET DATA TYPE TIMESTAMP(3)
    USING ("last_error_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "lease_expires_at" SET DATA TYPE TIMESTAMP(3)
    USING ("lease_expires_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3)
    USING ("created_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "updated_at" DROP DEFAULT,
  ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3)
    USING ("updated_at" AT TIME ZONE 'UTC');

CREATE TRIGGER "chat_settings_link_policy_recovery_baseline"
BEFORE INSERT OR UPDATE OF "link_policy", "link_policy_revision", "link_policy_effective_at"
ON "chat_settings"
FOR EACH ROW
EXECUTE FUNCTION "set_link_policy_recovery_baseline"();

COMMIT;
