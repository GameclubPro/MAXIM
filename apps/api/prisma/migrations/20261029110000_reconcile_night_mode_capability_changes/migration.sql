-- FLAG: Match the chat-only capability boundary in night-mode-transition-eligibility.util.ts.
-- This pure projection excludes freshness timestamps and permission ordering, so passive
-- refreshes cannot revoke an in-flight reconcile lease or churn an unchanged schedule.
CREATE FUNCTION night_mode_membership_capabilities_allow_transition(snapshot JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH permissions AS (
    SELECT ARRAY_AGG(DISTINCT REGEXP_REPLACE(LOWER(REGEXP_REPLACE(value #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g')), '[[:space:]-]+', '_', 'g')) AS names
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(snapshot -> 'permissions') = 'array'
        THEN snapshot -> 'permissions' ELSE '[]'::JSONB END
    ) permission(value)
    WHERE jsonb_typeof(value) = 'string'
  )
  SELECT CASE
    WHEN snapshot IS NULL OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN TRUE
    WHEN NOT COALESCE(snapshot -> 'isAdmin' = 'true'::JSONB, FALSE)
      AND NOT COALESCE(snapshot -> 'isOwner' = 'true'::JSONB, FALSE) THEN FALSE
    WHEN snapshot ? 'activationCapabilityCeiling' AND (
      jsonb_typeof(snapshot -> 'activationCapabilityCeiling') IS DISTINCT FROM 'array'
      OR NOT (snapshot -> 'activationCapabilityCeiling') @>
        '["moderation","delete_message","send_message"]'::JSONB
    ) THEN FALSE
    WHEN snapshot -> 'permissionsKnown' IS DISTINCT FROM 'true'::JSONB THEN TRUE
    ELSE COALESCE(
      names && ARRAY['read_all_messages', 'can_read_all_messages']
      AND names && ARRAY['write', 'can_write', 'post_edit_delete_message',
        'post_edit_delete_messages', 'can_post_edit_delete_message', 'can_post_edit_delete_messages']
      AND names && ARRAY['write', 'can_write', 'send_messages', 'can_send_messages',
        'post_edit_delete_message', 'post_edit_delete_messages'], FALSE)
  END
  FROM permissions;
$$;

CREATE FUNCTION enqueue_night_mode_transition_reconcile_from_capabilities()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_eligible BOOLEAN;
  new_eligible BOOLEAN;
BEGIN
  -- FLAG: The existing membership trigger owns status, identity and freshness transitions.
  -- This additive trigger closes only the capability/source-only commit-to-callback gap.
  IF ROW(NEW."chat_id", NEW."bot_id", NEW."status", NEW."bot_access_state") IS DISTINCT FROM
     ROW(OLD."chat_id", OLD."bot_id", OLD."status", OLD."bot_access_state")
    OR (NEW."status" = 'ACTIVE'
        AND NEW."bot_access_state" IN ('CONFIRMED_ADMIN', 'CONFIRMED_OWNER')
        AND NEW."bot_access_expires_at" > CURRENT_TIMESTAMP) IS DISTINCT FROM
       (OLD."status" = 'ACTIVE'
        AND OLD."bot_access_state" IN ('CONFIRMED_ADMIN', 'CONFIRMED_OWNER')
        AND OLD."bot_access_expires_at" > CURRENT_TIMESTAMP)
    OR NEW."status" <> 'ACTIVE'
    OR NEW."bot_access_state" NOT IN ('UNKNOWN', 'STALE', 'CONFIRMED_ADMIN', 'CONFIRMED_OWNER')
  THEN
    RETURN NEW;
  END IF;

  old_eligible := OLD."bot_access_source" IS DISTINCT FROM 'major_explicit_activation_pending'
    AND night_mode_membership_capabilities_allow_transition(OLD."permissions_snapshot");
  new_eligible := NEW."bot_access_source" IS DISTINCT FROM 'major_explicit_activation_pending'
    AND night_mode_membership_capabilities_allow_transition(NEW."permissions_snapshot");

  IF old_eligible IS DISTINCT FROM new_eligible AND EXISTS (
    SELECT 1 FROM "chat_settings" settings
    JOIN "chats" chat ON chat."id" = settings."chat_id"
    WHERE settings."chat_id" = NEW."chat_id"
      AND settings."night_mode_enabled" = TRUE AND chat."entity_type" = 'CHAT'
  ) THEN
    PERFORM enqueue_night_mode_transition_reconcile_request(
      NEW."chat_id",
      CASE WHEN new_eligible
        AND NEW."bot_access_state" IN ('CONFIRMED_ADMIN', 'CONFIRMED_OWNER')
        AND NEW."bot_access_expires_at" > CURRENT_TIMESTAMP
        THEN 'no_fresh_access' ELSE NULL END
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER chat_bot_memberships_enqueue_night_mode_capability_reconcile
AFTER UPDATE OF "permissions_snapshot", "bot_access_source" ON "chat_bot_memberships"
FOR EACH ROW EXECUTE FUNCTION enqueue_night_mode_transition_reconcile_from_capabilities();
