BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "chat_settings"
  ADD COLUMN "duplicate_policy_revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "duplicate_history_revision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "chat_settings"
  ADD CONSTRAINT "chat_settings_duplicate_revisions_check" CHECK (
    "duplicate_policy_revision" >= 0 AND "duplicate_history_revision" >= 0
  ) NOT VALID;

-- FLAG: Every writer invalidates old action authority. Matching changes start fresh
-- history; sanction-only changes preserve it. Clients cannot choose either revision.
CREATE FUNCTION "chat_duplicate_policy_signature"(settings "chat_settings") RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH flow AS (
    SELECT
      CASE
        WHEN settings."duplicate_warn_enabled" THEN settings."duplicate_warn_window_sec"
        WHEN settings."duplicate_mute_enabled" THEN settings."duplicate_mute_window_sec"
        WHEN settings."duplicate_ban_enabled" THEN settings."duplicate_ban_window_sec"
        ELSE settings."duplicate_warn_window_sec"
      END AS interval_sec,
      CASE
        WHEN settings."duplicate_warn_enabled" THEN settings."duplicate_warn_max_count"
        WHEN settings."duplicate_mute_enabled" THEN settings."duplicate_mute_max_count"
        WHEN settings."duplicate_ban_enabled" THEN settings."duplicate_ban_max_count"
        ELSE settings."duplicate_warn_max_count"
      END AS first_threshold,
      CASE WHEN settings."duplicate_bot_message_enabled" THEN 2 ELSE 1 END AS base_offset,
      settings."duplicate_warn_enabled"::integer
        + settings."duplicate_mute_enabled"::integer
        + settings."duplicate_ban_enabled"::integer AS enabled_actions
  )
  SELECT jsonb_build_object(
    'history', jsonb_build_object(
      'enabled', settings."anti_duplicate_enabled",
      'comparison', settings."duplicate_compare_mode",
      'image_scope', CASE WHEN settings."duplicate_compare_mode" <> 'TEXT'
        THEN settings."duplicate_photo_scope"::text ELSE NULL END,
      'text_policy', CASE
        WHEN settings."duplicate_detection_preset" = 'STRICT'
          THEN jsonb_build_array(true, true, false, false, true)
        WHEN settings."duplicate_detection_preset" = 'CUSTOM'
          THEN jsonb_build_array(false, false, settings."duplicate_ignore_links_enabled",
            settings."duplicate_ignore_phones_enabled", settings."duplicate_near_match_enabled")
        ELSE jsonb_build_array(false, false, false, false, false)
      END,
      'schedule', CASE WHEN settings."duplicate_window_mode" = 'DAILY'
        THEN jsonb_build_array('DAILY', settings."duplicate_start_time_minutes",
          settings."duplicate_end_time_minutes", lower(btrim(settings."duplicate_timezone")))
        ELSE jsonb_build_array('INTERVAL') END,
      'window_seconds', CASE WHEN settings."duplicate_window_mode" = 'DAILY'
        THEN ((settings."duplicate_end_time_minutes" - settings."duplicate_start_time_minutes"
          + 1440) % 1440) * 60
        ELSE flow.interval_sec END,
      'allowed_count', greatest(0, least(
        greatest(0, 20 - flow.base_offset - greatest(0, flow.enabled_actions - 1)),
        flow.first_threshold - flow.base_offset
      ))
    ),
    'actions', jsonb_build_object(
      'explanation', settings."duplicate_bot_message_enabled",
      'warn', settings."duplicate_warn_enabled",
      'mute', settings."duplicate_mute_enabled",
      'ban', settings."duplicate_ban_enabled",
      'mute_hours', CASE WHEN settings."duplicate_mute_enabled"
        THEN settings."duplicate_mute_duration_hours" ELSE NULL END
    )
  ) FROM flow;
$$;

CREATE FUNCTION "advance_chat_duplicate_policy_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_signature jsonb;
  new_signature jsonb;
  history_changed BOOLEAN;
  actions_changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."duplicate_policy_revision" := 0;
    NEW."duplicate_history_revision" := 0;
    RETURN NEW;
  END IF;

  old_signature := "chat_duplicate_policy_signature"(OLD);
  new_signature := "chat_duplicate_policy_signature"(NEW);
  history_changed := old_signature->'history' IS DISTINCT FROM new_signature->'history';
  actions_changed := history_changed OR
    old_signature->'actions' IS DISTINCT FROM new_signature->'actions';

  NEW."duplicate_history_revision" := OLD."duplicate_history_revision" + CASE WHEN history_changed THEN 1 ELSE 0 END;
  NEW."duplicate_policy_revision" := OLD."duplicate_policy_revision" + CASE WHEN actions_changed THEN 1 ELSE 0 END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "chat_settings_duplicate_policy_revision_trigger"
BEFORE INSERT OR UPDATE ON "chat_settings"
FOR EACH ROW EXECUTE FUNCTION "advance_chat_duplicate_policy_revision"();
COMMIT;
