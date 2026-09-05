#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

AUDIT_MODE="${1:-all}"
AUDIT_WALL_TIMEOUT_SEC="${MAXIM_POSTGRES_AUDIT_WALL_TIMEOUT_SEC:-8}"
AUDIT_LOCK_FILE=/tmp/maxim-postgres-audit.lock
QUEUE_SAMPLE_CAP=2000
MONITOR_SAMPLE_CAP=2000
DUPLICATE_SETTINGS_SAMPLE_CAP=5000
DUPLICATE_EVENT_SAMPLE_CAP=5000
DUPLICATE_INTENT_SAMPLE_CAP_PER_STATUS=500
DUPLICATE_REASON_SAMPLE_CAP_PER_INTENT=32
POSTGRES_AUDIT_ROLE=maxim_audit
LEGACY_DEFAULT_DB_AUDIT_HELPER="$ROOT_DIR/infra/scripts/legacy-default-webhook-db-audit.mjs"
LEGACY_DEFAULT_SNAPSHOT_PATH=''
AUDIT_SQL_FILE=''
AUDIT_STDERR_FILE=''
AUDIT_BACKEND_MAY_EXIST=0
POSTGRES_AUDIT_APP_NAME="maxim-bounded-audit-$(date -u +%Y%m%dT%H%M%SZ)-${BASHPID}-${RANDOM}"
POSTGRES_AUDIT_OPTIONS='-c default_transaction_read_only=on -c statement_timeout=2500ms -c lock_timeout=250ms -c idle_in_transaction_session_timeout=4s -c idle_session_timeout=60s -c max_parallel_workers_per_gather=0 -c enable_seqscan=off -c enable_bitmapscan=off -c jit=off -c work_mem=1MB'

usage() {
  cat <<'USAGE' >&2
Usage:
  ./infra/scripts/vps-postgres-audit.sh [queue|activity|duplicate|all]

The monitor-only mode is reserved for vps-monitor-readonly.sh:
  ./infra/scripts/vps-postgres-audit.sh monitor-signals <window-minutes>
USAGE
}

is_integer_between() {
  local value="$1"
  local minimum="$2"
  local maximum="$3"

  [[ "$value" =~ ^[1-9][0-9]*$ ]] && ((value >= minimum && value <= maximum))
}

if ! is_integer_between "$AUDIT_WALL_TIMEOUT_SEC" 1 8; then
  echo "MAXIM_POSTGRES_AUDIT_WALL_TIMEOUT_SEC must be an integer between 1 and 8." >&2
  exit 2
fi

if [[ ! "$POSTGRES_AUDIT_APP_NAME" =~ ^[A-Za-z0-9-]+$ ]] ||
  ((${#POSTGRES_AUDIT_APP_NAME} > 63)); then
  echo "Could not construct a safe PostgreSQL audit application name." >&2
  exit 1
fi

for required_command in docker flock timeout; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "$required_command is required for bounded PostgreSQL audits." >&2
    exit 1
  fi
done

exec {AUDIT_LOCK_FD}>>"$AUDIT_LOCK_FILE"
if ! flock -n "$AUDIT_LOCK_FD"; then
  echo "Another bounded PostgreSQL audit is already running." >&2
  exit 75
fi

SIGNAL_WINDOW_MIN=''
case "$AUDIT_MODE" in
  queue|activity|duplicate|all)
    if [[ $# -gt 1 ]]; then
      usage
      exit 2
    fi
    ;;
  monitor-signals)
    if [[ $# -ne 2 ]] || ! is_integer_between "$2" 1 1440; then
      echo "monitor-signals window must be an integer between 1 and 1440 minutes." >&2
      usage
      exit 2
    fi
    SIGNAL_WINDOW_MIN="$2"
    ;;
  legacy-default-webhook-jobs)
    if [[ "${MAXIM_INTERNAL_LEGACY_DEFAULT_WEBHOOK_AUDIT:-}" != "1" || $# -ne 2 ||
          "$2" != /* || ! -f "$LEGACY_DEFAULT_DB_AUDIT_HELPER" ]]; then
      echo "Internal legacy default webhook audit invocation is invalid." >&2
      exit 2
    fi
    LEGACY_DEFAULT_SNAPSHOT_PATH="$2"
    node "$LEGACY_DEFAULT_DB_AUDIT_HELPER" \
      validate-snapshot "$LEGACY_DEFAULT_SNAPSHOT_PATH" >/dev/null
    ;;
  *)
    echo "Unknown PostgreSQL audit mode: $AUDIT_MODE" >&2
    usage
    exit 2
    ;;
esac

emit_prelude() {
  cat <<'SQL'
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT CASE
  WHEN session_user = 'maxim_audit'
    AND current_user = 'maxim_audit'
    AND current_setting('default_transaction_read_only') = 'on'
    AND current_setting('max_parallel_workers_per_gather')::integer = 0
    AND current_setting('enable_seqscan') = 'off'
    AND current_setting('enable_bitmapscan') = 'off'
    AND pg_size_bytes(current_setting('work_mem')) <= 1048576
    AND pg_size_bytes(current_setting('temp_file_limit')) BETWEEN 0 AND 8388608
    AND EXISTS (
      SELECT 1
      FROM pg_roles
      WHERE rolname = 'maxim_audit'
        AND rolcanlogin
        AND NOT rolsuper
        AND NOT rolcreatedb
        AND NOT rolcreaterole
        AND NOT rolreplication
        AND NOT rolbypassrls
        AND rolinherit
        AND rolconnlimit = 1
    )
    AND pg_has_role('maxim_audit', 'pg_read_all_stats', 'member')
    AND NOT pg_has_role('maxim_audit', 'pg_read_all_data', 'member')
    AND 1 = (
      SELECT count(*)
      FROM pg_auth_members memberships
      JOIN pg_roles granted_role ON granted_role.oid = memberships.roleid
      JOIN pg_roles member_role ON member_role.oid = memberships.member
      WHERE member_role.rolname = 'maxim_audit'
        AND granted_role.rolname = 'pg_read_all_stats'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_auth_members memberships
      JOIN pg_roles granted_role ON granted_role.oid = memberships.roleid
      JOIN pg_roles member_role ON member_role.oid = memberships.member
      WHERE member_role.rolname = 'maxim_audit'
        AND granted_role.rolname <> 'pg_read_all_stats'
    )
    AND has_schema_privilege('maxim_audit', 'public', 'USAGE')
    AND NOT has_schema_privilege('maxim_audit', 'public', 'CREATE')
    AND has_table_privilege('maxim_audit', 'public.webhook_events', 'SELECT')
    AND has_table_privilege('maxim_audit', 'public.moderation_events', 'SELECT')
    AND NOT has_table_privilege('maxim_audit', 'public.chat_settings', 'SELECT')
    AND NOT has_table_privilege('maxim_audit', 'public.moderation_delete_intents', 'SELECT')
    AND NOT has_table_privilege(
      'maxim_audit',
      'public.moderation_delete_intent_reasons',
      'SELECT'
    )
    AND 2 = (
      SELECT count(*)
      FROM information_schema.role_table_grants
      WHERE grantee = 'maxim_audit'
        AND table_schema = 'public'
        AND table_name IN ('webhook_events', 'moderation_events')
        AND privilege_type = 'SELECT'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.role_table_grants
      WHERE grantee = 'maxim_audit'
        AND NOT (
          table_schema = 'public'
          AND table_name IN ('webhook_events', 'moderation_events')
          AND privilege_type = 'SELECT'
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.role_column_grants
      WHERE grantee = 'maxim_audit'
        AND table_schema = 'public'
        AND table_name IN (
          'chat_settings',
          'moderation_delete_intents',
          'moderation_delete_intent_reasons'
        )
        AND NOT (
          privilege_type = 'SELECT'
          AND (
            (
              table_name = 'chat_settings'
              AND column_name IN (
                'id',
                'anti_duplicate_enabled',
                'duplicate_photo_enabled',
                'duplicate_detection_preset',
                'duplicate_photo_match_preset',
                'duplicate_photo_scope'
              )
            )
            OR (
              table_name = 'moderation_delete_intents'
              AND column_name IN ('id', 'status', 'updated_at')
            )
            OR (
              table_name = 'moderation_delete_intent_reasons'
              AND column_name IN ('intent_id', 'reason_key', 'rule_code')
            )
          )
        )
    )
    AND (
      0 = (
        SELECT count(DISTINCT (table_name, column_name, privilege_type))
        FROM information_schema.role_column_grants
        WHERE grantee = 'maxim_audit'
          AND table_schema = 'public'
          AND table_name IN (
            'chat_settings',
            'moderation_delete_intents',
            'moderation_delete_intent_reasons'
          )
      )
      OR (
        12 = (
          SELECT count(DISTINCT (table_name, column_name, privilege_type))
          FROM information_schema.role_column_grants
          WHERE grantee = 'maxim_audit'
            AND table_schema = 'public'
            AND table_name IN (
              'chat_settings',
              'moderation_delete_intents',
              'moderation_delete_intent_reasons'
            )
            AND privilege_type = 'SELECT'
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_class restricted_relation
      JOIN pg_namespace restricted_namespace
        ON restricted_namespace.oid = restricted_relation.relnamespace
      JOIN pg_attribute restricted_attribute
        ON restricted_attribute.attrelid = restricted_relation.oid
      WHERE restricted_namespace.nspname = 'public'
        AND restricted_relation.relname IN (
          'chat_settings',
          'moderation_delete_intents',
          'moderation_delete_intent_reasons'
        )
        AND restricted_attribute.attnum > 0
        AND NOT restricted_attribute.attisdropped
        AND has_column_privilege(
          'maxim_audit',
          restricted_relation.oid,
          restricted_attribute.attnum,
          'SELECT'
        )
        AND NOT (
          (
            restricted_relation.relname = 'chat_settings'
            AND restricted_attribute.attname IN (
              'id',
              'anti_duplicate_enabled',
              'duplicate_photo_enabled',
              'duplicate_detection_preset',
              'duplicate_photo_match_preset',
              'duplicate_photo_scope'
            )
          )
          OR (
            restricted_relation.relname = 'moderation_delete_intents'
            AND restricted_attribute.attname IN ('id', 'status', 'updated_at')
          )
          OR (
            restricted_relation.relname = 'moderation_delete_intent_reasons'
            AND restricted_attribute.attname IN ('intent_id', 'reason_key', 'rule_code')
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname !~ '^pg_toast'
        AND (
          (
            NOT (
              namespace.nspname = 'public'
              AND relation.relname IN (
                'webhook_events',
                'moderation_events',
                'chat_settings',
                'moderation_delete_intents',
                'moderation_delete_intent_reasons'
              )
            )
            AND (
              has_table_privilege('maxim_audit', relation.oid, 'SELECT')
              OR EXISTS (
                SELECT 1
                FROM pg_attribute attribute
                WHERE attribute.attrelid = relation.oid
                  AND attribute.attnum > 0
                  AND NOT attribute.attisdropped
                  AND has_column_privilege(
                    'maxim_audit',
                    relation.oid,
                    attribute.attnum,
                    'SELECT'
                  )
              )
            )
          )
          OR has_table_privilege(
            'maxim_audit',
            relation.oid,
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          )
          OR EXISTS (
            SELECT 1
            FROM pg_attribute attribute
            WHERE attribute.attrelid = relation.oid
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND has_column_privilege(
                'maxim_audit',
                relation.oid,
                attribute.attnum,
                'INSERT,UPDATE,REFERENCES'
              )
          )
        )
    ) THEN 'true'
  ELSE 'false'
END AS audit_session_ready \gset
\if :audit_session_ready
\else
\echo 'The hardened maxim_audit session invariant is missing; refusing production diagnostics.'
\quit 4
\endif
SQL
}

emit_queue_audit() {
  cat <<SQL
SELECT CASE
  WHEN to_regclass('public.webhook_events_status_created_at_idx') IS NOT NULL THEN 'true'
  ELSE 'false'
END AS queue_audit_index_ready \gset
\if :queue_audit_index_ready
WITH queue_statuses(status) AS (
  VALUES
    ('RECEIVED'::"WebhookStatus"),
    ('QUEUED'::"WebhookStatus"),
    ('FAILED'::"WebhookStatus")
), bounded_events AS MATERIALIZED (
  SELECT queue_statuses.status, sample.created_at
  FROM queue_statuses
  LEFT JOIN LATERAL (
    SELECT webhook_events.created_at
    FROM webhook_events
    WHERE webhook_events.status = queue_statuses.status
    ORDER BY webhook_events.created_at ASC
    LIMIT $((QUEUE_SAMPLE_CAP + 1))
  ) AS sample ON TRUE
), summary AS (
  SELECT
    status,
    count(created_at)::bigint AS sampled_count,
    min(created_at) AS oldest_created_at
  FROM bounded_events
  GROUP BY status
)
SELECT json_build_object(
  'schema_version', 1,
  'audit', 'webhook_queue',
  'sample_cap_per_status', $QUEUE_SAMPLE_CAP,
  'rows', json_agg(
    json_build_object(
      'status', status::text,
      'count_lower_bound', least(sampled_count, $QUEUE_SAMPLE_CAP),
      'saturated', sampled_count > $QUEUE_SAMPLE_CAP,
      'oldest_age_seconds', CASE
        WHEN oldest_created_at IS NULL THEN 0
        ELSE greatest(
          0,
          floor(extract(epoch FROM clock_timestamp() - oldest_created_at))::bigint
        )
      END
    )
    ORDER BY status::text
  )
)::text
FROM summary;
\else
\echo 'Required queue audit index is missing; refusing an unindexed production scan.'
\quit 3
\endif
SQL
}

emit_activity_audit() {
  cat <<'SQL'
WITH classified_activity AS MATERIALIZED (
  SELECT
    CASE
      WHEN application_name LIKE 'maxim-postgres-backup-%' THEN 'scheduled_backup'
      WHEN application_name LIKE 'maxim-live-backup-%' THEN 'live_backup'
      WHEN application_name LIKE 'maxim-bounded-audit-%' THEN 'bounded_audit'
      WHEN application_name = '' THEN 'unspecified'
      ELSE 'other'
    END AS workload,
    backend_type,
    coalesce(state, 'unknown') AS state,
    coalesce(wait_event_type, 'none') AS wait_event_type,
    coalesce(wait_event, 'none') AS wait_event,
    CASE
      WHEN state = 'active' AND query_start IS NOT NULL
        THEN greatest(0, floor(extract(epoch FROM clock_timestamp() - query_start))::bigint)
      ELSE 0
    END AS active_query_age_seconds,
    CASE
      WHEN xact_start IS NOT NULL
        THEN greatest(0, floor(extract(epoch FROM clock_timestamp() - xact_start))::bigint)
      ELSE 0
    END AS transaction_age_seconds
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND pid <> pg_backend_pid()
), grouped_activity AS MATERIALIZED (
  SELECT
    workload,
    backend_type,
    state,
    wait_event_type,
    wait_event,
    count(*)::bigint AS sessions,
    max(active_query_age_seconds) AS oldest_active_query_seconds,
    max(transaction_age_seconds) AS oldest_transaction_seconds
  FROM classified_activity
  GROUP BY workload, backend_type, state, wait_event_type, wait_event
  ORDER BY sessions DESC, workload, backend_type, state, wait_event_type, wait_event
  LIMIT 64
)
SELECT json_build_object(
  'schema_version', 1,
  'audit', 'postgres_activity',
  'rows', coalesce(
    json_agg(
      json_build_object(
        'workload', workload,
        'backend_type', backend_type,
        'state', state,
        'wait_event_type', wait_event_type,
        'wait_event', wait_event,
        'sessions', sessions,
        'oldest_active_query_seconds', oldest_active_query_seconds,
        'oldest_transaction_seconds', oldest_transaction_seconds
      )
      ORDER BY sessions DESC, workload, backend_type, state, wait_event_type, wait_event
    ),
    '[]'::json
  )
)::text
FROM grouped_activity;
SQL
}

emit_monitor_signals_audit() {
  cat <<SQL
SELECT CASE
  WHEN to_regclass('public.webhook_events_status_created_at_idx') IS NOT NULL
    AND to_regclass('public.moderation_events_created_at_idx') IS NOT NULL THEN 'true'
  ELSE 'false'
END AS monitor_audit_indexes_ready \gset
\if :monitor_audit_indexes_ready
WITH webhook_statuses(status) AS (
  VALUES
    ('RECEIVED'::"WebhookStatus"),
    ('QUEUED'::"WebhookStatus"),
    ('PROCESSED'::"WebhookStatus"),
    ('DUPLICATE'::"WebhookStatus"),
    ('FAILED'::"WebhookStatus")
), recent_webhooks AS MATERIALIZED (
  SELECT webhook_statuses.status, sample.created_at
  FROM webhook_statuses
  LEFT JOIN LATERAL (
    SELECT webhook_events.created_at
    FROM webhook_events
    WHERE webhook_events.status = webhook_statuses.status
      AND webhook_events.created_at >= statement_timestamp() - make_interval(mins => $SIGNAL_WINDOW_MIN)
    ORDER BY webhook_events.created_at DESC
    LIMIT $((MONITOR_SAMPLE_CAP + 1))
  ) AS sample ON TRUE
), webhook_summary AS (
  SELECT
    status,
    count(created_at)::bigint AS sampled_count,
    max(created_at) AS newest_created_at
  FROM recent_webhooks
  GROUP BY status
)
SELECT json_build_object(
  'schema_version', 1,
  'audit', 'recent_webhook_statuses',
  'window_minutes', $SIGNAL_WINDOW_MIN,
  'sample_cap_per_status', $MONITOR_SAMPLE_CAP,
  'rows', json_agg(
    json_build_object(
      'status', status::text,
      'count_lower_bound', least(sampled_count, $MONITOR_SAMPLE_CAP),
      'saturated', sampled_count > $MONITOR_SAMPLE_CAP,
      'newest_age_seconds', CASE
        WHEN newest_created_at IS NULL THEN 0
        ELSE greatest(
          0,
          floor(extract(epoch FROM clock_timestamp() - newest_created_at))::bigint
        )
      END
    )
    ORDER BY status::text
  )
)::text
FROM webhook_summary;

WITH moderation_sample AS MATERIALIZED (
  SELECT id, chat_id, rule_code, message_id, metadata, created_at
  FROM moderation_events
  WHERE created_at >= statement_timestamp() - make_interval(mins => $SIGNAL_WINDOW_MIN)
  ORDER BY created_at DESC
  LIMIT $((MONITOR_SAMPLE_CAP + 1))
), sample_state AS (
  SELECT count(*)::bigint AS sampled_count
  FROM moderation_sample
), bounded_moderation AS MATERIALIZED (
  SELECT id, chat_id, rule_code, message_id, metadata, created_at
  FROM moderation_sample
  ORDER BY created_at DESC
  LIMIT $MONITOR_SAMPLE_CAP
), close_events AS (
  SELECT
    id,
    chat_id,
    metadata->>'sessionKey' AS session_key,
    message_id,
    created_at,
    row_number() OVER (
      PARTITION BY chat_id, metadata->>'sessionKey'
      ORDER BY created_at DESC, id DESC
    ) AS newest_rank,
    count(*) OVER (PARTITION BY chat_id, metadata->>'sessionKey') AS group_count
  FROM bounded_moderation
  WHERE rule_code = 'NIGHT_MODE_CLOSE_NOTICE'
    AND metadata->>'sessionKey' IS NOT NULL
), unrecovered_extras AS (
  SELECT close_events.id, close_events.chat_id, close_events.session_key
  FROM close_events
  WHERE group_count > 1
    AND newest_rank > 1
    AND NOT EXISTS (
      SELECT 1
      FROM bounded_moderation recovery
      WHERE recovery.chat_id = close_events.chat_id
        AND recovery.rule_code = 'NIGHT_MODE_CLOSE_NOTICE_RECOVERY_DELETE'
        AND recovery.created_at >= close_events.created_at
        AND (
          recovery.message_id = close_events.message_id
          OR recovery.metadata->>'originalEventId' = close_events.id
        )
    )
), night_mode_summary AS (
  SELECT
    rule_code,
    count(*)::bigint AS events,
    count(DISTINCT (chat_id, metadata->>'sessionKey'))::bigint AS chat_sessions
  FROM bounded_moderation
  WHERE rule_code IN (
    'NIGHT_MODE_CLOSE_NOTICE',
    'NIGHT_MODE_OPEN_NOTICE',
    'NIGHT_MODE_CLOSE_NOTICE_RECOVERY_DELETE'
  )
  GROUP BY rule_code
), duplicate_summary AS (
  SELECT
    count(DISTINCT (chat_id, session_key))::bigint AS duplicate_groups,
    count(*)::bigint AS duplicate_extra_events
  FROM unrecovered_extras
)
SELECT json_build_object(
  'schema_version', 1,
  'audit', 'recent_night_mode_signals',
  'window_minutes', $SIGNAL_WINDOW_MIN,
  'sample_cap', $MONITOR_SAMPLE_CAP,
  'sample_saturated', sample_state.sampled_count > $MONITOR_SAMPLE_CAP,
  'duplicate_groups_in_sample', duplicate_summary.duplicate_groups,
  'duplicate_extra_events_in_sample', duplicate_summary.duplicate_extra_events,
  'rows', coalesce(
    (
      SELECT json_agg(
        json_build_object(
          'rule_code', rule_code,
          'events', events,
          'chat_sessions', chat_sessions
        )
        ORDER BY rule_code
      )
      FROM night_mode_summary
    ),
    '[]'::json
  )
)::text
FROM sample_state
CROSS JOIN duplicate_summary;
\else
\echo 'Required monitor audit indexes are missing; refusing an unindexed production scan.'
\quit 3
\endif
SQL
}

emit_duplicate_audit() {
  cat <<SQL
WITH required_duplicate_indexes(
  index_name,
  table_name,
  key_columns,
  is_unique,
  is_primary
) AS (
  VALUES
    (
      'chat_settings_pkey',
      'chat_settings',
      ARRAY['id']::text[],
      true,
      true
    ),
    (
      'moderation_events_created_at_idx',
      'moderation_events',
      ARRAY['created_at']::text[],
      false,
      false
    ),
    (
      'moderation_delete_intents_retention_idx',
      'moderation_delete_intents',
      ARRAY['status', 'updated_at']::text[],
      false,
      false
    ),
    (
      'moderation_delete_intent_reasons_intent_reason_key',
      'moderation_delete_intent_reasons',
      ARRAY['intent_id', 'reason_key']::text[],
      true,
      false
    )
), exact_duplicate_indexes AS (
  SELECT required_duplicate_indexes.index_name
  FROM required_duplicate_indexes
  JOIN pg_namespace index_namespace
    ON index_namespace.nspname = 'public'
  JOIN pg_class index_relation
    ON index_relation.relnamespace = index_namespace.oid
    AND index_relation.relname = required_duplicate_indexes.index_name
  JOIN pg_index index_definition
    ON index_definition.indexrelid = index_relation.oid
  JOIN pg_class table_relation
    ON table_relation.oid = index_definition.indrelid
    AND table_relation.relname = required_duplicate_indexes.table_name
  JOIN pg_namespace table_namespace
    ON table_namespace.oid = table_relation.relnamespace
    AND table_namespace.nspname = 'public'
  JOIN pg_am access_method
    ON access_method.oid = index_relation.relam
    AND access_method.amname = 'btree'
  WHERE index_relation.relkind = 'i'
    AND table_relation.relkind IN ('r', 'p')
    AND index_definition.indisvalid
    AND index_definition.indisready
    AND index_definition.indislive
    AND NOT index_definition.indcheckxmin
    AND index_definition.indisunique = required_duplicate_indexes.is_unique
    AND index_definition.indisprimary = required_duplicate_indexes.is_primary
    AND NOT index_definition.indisexclusion
    AND index_definition.indimmediate
    AND index_definition.indexprs IS NULL
    AND index_definition.indpred IS NULL
    AND index_definition.indnatts = cardinality(required_duplicate_indexes.key_columns)
    AND index_definition.indnkeyatts = cardinality(required_duplicate_indexes.key_columns)
    AND 0 = ALL(index_definition.indoption)
    AND ARRAY(
      SELECT pg_get_indexdef(
        index_definition.indexrelid,
        key_position,
        false
      )
      FROM generate_series(1, index_definition.indnkeyatts) AS key_position
      ORDER BY key_position
    ) = required_duplicate_indexes.key_columns
)
SELECT CASE
  WHEN 12 = (
    SELECT count(DISTINCT (table_name, column_name, privilege_type))
    FROM information_schema.role_column_grants
    WHERE grantee = 'maxim_audit'
      AND table_schema = 'public'
      AND table_name IN (
        'chat_settings',
        'moderation_delete_intents',
        'moderation_delete_intent_reasons'
      )
      AND privilege_type = 'SELECT'
  )
    AND 4 = (SELECT count(*) FROM exact_duplicate_indexes) THEN 'true'
  ELSE 'false'
END AS duplicate_audit_ready \gset
\if :duplicate_audit_ready
WITH settings_sample_plus AS MATERIALIZED (
  SELECT
    id,
    anti_duplicate_enabled,
    duplicate_photo_enabled,
    duplicate_detection_preset,
    duplicate_photo_match_preset,
    duplicate_photo_scope
  FROM chat_settings
  ORDER BY id ASC
  LIMIT $((DUPLICATE_SETTINGS_SAMPLE_CAP + 1))
), settings_sample AS MATERIALIZED (
  SELECT *
  FROM settings_sample_plus
  ORDER BY id ASC
  LIMIT $DUPLICATE_SETTINGS_SAMPLE_CAP
), settings_state AS (
  SELECT
    count(*)::bigint AS sampled_count,
    (SELECT count(*) FROM settings_sample_plus) > $DUPLICATE_SETTINGS_SAMPLE_CAP
      AS sample_saturated,
    count(*) FILTER (WHERE anti_duplicate_enabled)::bigint AS text_enabled,
    count(*) FILTER (WHERE duplicate_photo_enabled)::bigint AS photo_toggle_enabled,
    count(*) FILTER (
      WHERE anti_duplicate_enabled AND duplicate_photo_enabled
    )::bigint AS photo_effective_enabled,
    count(*) FILTER (
      WHERE duplicate_photo_enabled AND NOT anti_duplicate_enabled
    )::bigint AS photo_enabled_without_text
  FROM settings_sample
), text_presets AS (
  SELECT duplicate_detection_preset::text AS preset, count(*)::bigint AS settings_count
  FROM settings_sample
  WHERE anti_duplicate_enabled
  GROUP BY duplicate_detection_preset
), photo_presets AS (
  SELECT
    duplicate_photo_match_preset::text AS preset,
    duplicate_photo_scope::text AS scope,
    count(*)::bigint AS settings_count
  FROM settings_sample
  WHERE anti_duplicate_enabled
    AND duplicate_photo_enabled
  GROUP BY duplicate_photo_match_preset, duplicate_photo_scope
)
SELECT json_build_object(
  'schema_version', 1,
  'audit', 'duplicate_settings',
  'sample_cap', $DUPLICATE_SETTINGS_SAMPLE_CAP,
  'sampled_count', settings_state.sampled_count,
  'sample_saturated', settings_state.sample_saturated,
  'complete', NOT settings_state.sample_saturated,
  'text_enabled_count_lower_bound', settings_state.text_enabled,
  'photo_toggle_enabled_count_lower_bound', settings_state.photo_toggle_enabled,
  'photo_effective_enabled_count_lower_bound', settings_state.photo_effective_enabled,
  'photo_enabled_without_text_count_lower_bound', settings_state.photo_enabled_without_text,
  'text_presets', coalesce(
    (
      SELECT json_agg(
        json_build_object('preset', preset, 'count_lower_bound', settings_count)
        ORDER BY preset
      )
      FROM text_presets
    ),
    '[]'::json
  ),
  'photo_presets', coalesce(
    (
      SELECT json_agg(
        json_build_object(
          'preset', preset,
          'scope', scope,
          'count_lower_bound', settings_count
        )
        ORDER BY preset, scope
      )
      FROM photo_presets
    ),
    '[]'::json
  )
)::text
FROM settings_state;

WITH event_sample_plus AS MATERIALIZED (
  SELECT rule_code, action, created_at
  FROM moderation_events
  WHERE created_at >= statement_timestamp() - make_interval(mins => 1440)
  ORDER BY created_at DESC
  LIMIT $((DUPLICATE_EVENT_SAMPLE_CAP + 1))
), event_sample AS MATERIALIZED (
  SELECT *
  FROM event_sample_plus
  ORDER BY created_at DESC
  LIMIT $DUPLICATE_EVENT_SAMPLE_CAP
), event_sample_state AS (
  SELECT
    count(*)::bigint AS candidate_count,
    count(*) > $DUPLICATE_EVENT_SAMPLE_CAP AS sample_saturated
  FROM event_sample_plus
), event_sample_bounds AS (
  SELECT min(created_at) AS oldest_created_at
  FROM event_sample
), audit_windows(window_minutes) AS (
  VALUES (60), (1440)
), event_windows AS (
  SELECT
    audit_windows.window_minutes,
    count(event_sample.created_at) FILTER (
      WHERE event_sample.rule_code IN (
        'DUPLICATE_DELETE',
        'DUPLICATE_WARN',
        'DUPLICATE_MUTE',
        'DUPLICATE_BAN'
      )
    )::bigint AS count_lower_bound,
    count(event_sample.created_at) FILTER (
      WHERE left(event_sample.rule_code, 10) = 'DUPLICATE_'
        AND event_sample.rule_code NOT IN (
          'DUPLICATE_DELETE',
          'DUPLICATE_WARN',
          'DUPLICATE_MUTE',
          'DUPLICATE_BAN'
        )
    )::bigint AS unrecognized_rule_count,
    count(event_sample.created_at)::bigint AS sampled_rows,
    event_sample_state.sample_saturated
      AND event_sample_bounds.oldest_created_at >=
        statement_timestamp() - make_interval(mins => audit_windows.window_minutes)
      AS sample_saturated,
    (
      NOT event_sample_state.sample_saturated
      OR event_sample_bounds.oldest_created_at <
        statement_timestamp() - make_interval(mins => audit_windows.window_minutes)
    ) AS complete
  FROM audit_windows
  CROSS JOIN event_sample_state
  CROSS JOIN event_sample_bounds
  LEFT JOIN event_sample
    ON event_sample.created_at >=
      statement_timestamp() - make_interval(mins => audit_windows.window_minutes)
  GROUP BY
    audit_windows.window_minutes,
    event_sample_state.sample_saturated,
    event_sample_bounds.oldest_created_at
), event_rows AS (
  SELECT
    audit_windows.window_minutes,
    event_sample.rule_code,
    event_sample.action::text AS action,
    count(*)::bigint AS count_lower_bound
  FROM audit_windows
  JOIN event_sample
    ON event_sample.created_at >=
      statement_timestamp() - make_interval(mins => audit_windows.window_minutes)
  WHERE event_sample.rule_code IN (
    'DUPLICATE_DELETE',
    'DUPLICATE_WARN',
    'DUPLICATE_MUTE',
    'DUPLICATE_BAN'
  )
  GROUP BY audit_windows.window_minutes, event_sample.rule_code, event_sample.action
)
SELECT json_build_object(
  'schema_version', 1,
  'audit', 'recent_duplicate_moderation',
  'sample_cap', $DUPLICATE_EVENT_SAMPLE_CAP,
  'windows', coalesce(
    (
      SELECT json_agg(
        json_build_object(
          'window_minutes', window_minutes,
          'sampled_rows', sampled_rows,
          'count_lower_bound', count_lower_bound,
          'unrecognized_rule_count', unrecognized_rule_count,
          'sample_saturated', sample_saturated,
          'complete', complete
        )
        ORDER BY window_minutes
      )
      FROM event_windows
    ),
    '[]'::json
  ),
  'rows', coalesce(
    (
      SELECT json_agg(
        json_build_object(
          'window_minutes', window_minutes,
          'rule_code', rule_code,
          'action', action,
          'count_lower_bound', count_lower_bound
        )
        ORDER BY window_minutes, rule_code, action
      )
      FROM event_rows
    ),
    '[]'::json
  )
)::text;

WITH intent_statuses(status_order, status) AS (
  VALUES
    (1, 'OBSERVED'::"ModerationDeleteIntentStatus"),
    (2, 'PENDING'::"ModerationDeleteIntentStatus"),
    (3, 'IN_PROGRESS'::"ModerationDeleteIntentStatus"),
    (4, 'RETRYABLE'::"ModerationDeleteIntentStatus"),
    (5, 'WAITING_CAPABILITY'::"ModerationDeleteIntentStatus"),
    (6, 'AMBIGUOUS'::"ModerationDeleteIntentStatus"),
    (7, 'SUCCEEDED'::"ModerationDeleteIntentStatus"),
    (8, 'ALREADY_ABSENT'::"ModerationDeleteIntentStatus"),
    (9, 'EXPIRED'::"ModerationDeleteIntentStatus"),
    (10, 'FAILED_TERMINAL'::"ModerationDeleteIntentStatus")
), intent_sample_plus AS MATERIALIZED (
  SELECT intent_statuses.status_order, recent.id, recent.status, recent.updated_at
  FROM intent_statuses
  CROSS JOIN LATERAL (
    SELECT id, status, updated_at
    FROM moderation_delete_intents
    WHERE status = intent_statuses.status
      AND updated_at >= statement_timestamp() - make_interval(mins => 1440)
    ORDER BY updated_at DESC
    LIMIT $((DUPLICATE_INTENT_SAMPLE_CAP_PER_STATUS + 1))
  ) AS recent
), ranked_intents AS MATERIALIZED (
  SELECT
    intent_sample_plus.*,
    row_number() OVER (
      PARTITION BY status
      ORDER BY updated_at DESC
    ) AS sample_rank
  FROM intent_sample_plus
), intent_sample AS MATERIALIZED (
  SELECT status_order, id, status, updated_at
  FROM ranked_intents
  WHERE sample_rank <= $DUPLICATE_INTENT_SAMPLE_CAP_PER_STATUS
), intent_sample_counts AS (
  SELECT status, count(*)::bigint AS candidate_count
  FROM intent_sample_plus
  GROUP BY status
), intent_status_state AS (
  SELECT
    intent_statuses.status_order,
    intent_statuses.status,
    coalesce(intent_sample_counts.candidate_count, 0)::bigint AS candidate_count,
    min(intent_sample.updated_at) AS oldest_updated_at
  FROM intent_statuses
  LEFT JOIN intent_sample_counts ON intent_sample_counts.status = intent_statuses.status
  LEFT JOIN intent_sample ON intent_sample.status = intent_statuses.status
  GROUP BY
    intent_statuses.status_order,
    intent_statuses.status,
    intent_sample_counts.candidate_count
), intent_reason_summary AS MATERIALIZED (
  SELECT
    intent_sample.status,
    intent_sample.updated_at,
    coalesce(reason_sample.has_duplicate, false) AS has_duplicate,
    coalesce(reason_sample.sample_saturated, false) AS sample_saturated
  FROM intent_sample
  LEFT JOIN LATERAL (
    SELECT
      bool_or(bounded_reason.rule_code = 'DUPLICATE_DELETE') AS has_duplicate,
      count(*) > $DUPLICATE_REASON_SAMPLE_CAP_PER_INTENT AS sample_saturated
    FROM (
      SELECT reason_key, rule_code
      FROM moderation_delete_intent_reasons
      WHERE intent_id = intent_sample.id
      ORDER BY reason_key ASC
      LIMIT $((DUPLICATE_REASON_SAMPLE_CAP_PER_INTENT + 1))
    ) AS bounded_reason
  ) AS reason_sample ON TRUE
), audit_windows(window_minutes) AS (
  VALUES (60), (1440)
), intent_rows AS (
  SELECT
    audit_windows.window_minutes,
    intent_status_state.status_order,
    intent_status_state.status::text AS status,
    count(intent_reason_summary.updated_at)::bigint AS sampled_intents,
    count(intent_reason_summary.updated_at) FILTER (
      WHERE intent_reason_summary.has_duplicate
    )::bigint AS count_lower_bound,
    count(intent_reason_summary.updated_at) FILTER (
      WHERE intent_reason_summary.sample_saturated
    )::bigint AS saturated_reason_intents,
    intent_status_state.candidate_count > $DUPLICATE_INTENT_SAMPLE_CAP_PER_STATUS
      AND intent_status_state.oldest_updated_at >=
        statement_timestamp() - make_interval(mins => audit_windows.window_minutes)
      AS sample_saturated,
    (
      intent_status_state.candidate_count <= $DUPLICATE_INTENT_SAMPLE_CAP_PER_STATUS
      OR intent_status_state.oldest_updated_at <
        statement_timestamp() - make_interval(mins => audit_windows.window_minutes)
    ) AND count(intent_reason_summary.updated_at) FILTER (
      WHERE intent_reason_summary.sample_saturated
    ) = 0 AS complete
  FROM audit_windows
  CROSS JOIN intent_status_state
  LEFT JOIN intent_reason_summary
    ON intent_reason_summary.status = intent_status_state.status
    AND intent_reason_summary.updated_at >=
      statement_timestamp() - make_interval(mins => audit_windows.window_minutes)
  GROUP BY
    audit_windows.window_minutes,
    intent_status_state.status_order,
    intent_status_state.status,
    intent_status_state.candidate_count,
    intent_status_state.oldest_updated_at
)
SELECT json_build_object(
  'schema_version', 1,
  'audit', 'recent_duplicate_delete_intents',
  'window_basis', 'updated_at',
  'sample_cap_per_status', $DUPLICATE_INTENT_SAMPLE_CAP_PER_STATUS,
  'reason_sample_cap_per_intent', $DUPLICATE_REASON_SAMPLE_CAP_PER_INTENT,
  'rows', json_agg(
    json_build_object(
      'window_minutes', window_minutes,
      'status', status,
      'sampled_intents', sampled_intents,
      'count_lower_bound', count_lower_bound,
      'saturated_reason_intents', saturated_reason_intents,
      'sample_saturated', sample_saturated,
      'complete', complete
    )
    ORDER BY window_minutes, status_order
  )
)::text
FROM intent_rows;
\else
\echo 'Duplicate audit column grants or required indexes are missing; run the reviewed audit-role provision step.'
\quit 4
\endif
SQL
}

emit_legacy_default_webhook_audit() {
  node "$LEGACY_DEFAULT_DB_AUDIT_HELPER" emit-sql "$LEGACY_DEFAULT_SNAPSHOT_PATH"
}

emit_sql() {
  emit_prelude
  case "$AUDIT_MODE" in
    queue)
      emit_queue_audit
      ;;
    activity)
      emit_activity_audit
      ;;
    duplicate)
      emit_duplicate_audit
      ;;
    all)
      emit_queue_audit
      emit_activity_audit
      emit_duplicate_audit
      ;;
    monitor-signals)
      emit_monitor_signals_audit
      ;;
    legacy-default-webhook-jobs)
      emit_legacy_default_webhook_audit
      ;;
  esac
  printf '%s\n' 'COMMIT;'
}

prepare_audit_sql() {
  local temp_root="${TMPDIR:-/tmp}"

  if [[ "$temp_root" != /* || ! -d "$temp_root" || "$temp_root" == *$'\n'* ]]; then
    echo "TMPDIR must be an existing absolute directory." >&2
    return 1
  fi
  AUDIT_SQL_FILE="$(mktemp "$temp_root/maxim-postgres-audit-sql.XXXXXXXX")" || {
    echo "Could not create the private PostgreSQL audit input." >&2
    return 1
  }
  chmod 0600 "$AUDIT_SQL_FILE"
  if ! emit_sql >"$AUDIT_SQL_FILE"; then
    echo "Could not generate the bounded PostgreSQL audit." >&2
    return 1
  fi
  if [[ ! -s "$AUDIT_SQL_FILE" || -L "$AUDIT_SQL_FILE" ]]; then
    echo "Generated PostgreSQL audit input is invalid." >&2
    return 1
  fi
  if [[ "$AUDIT_MODE" == "legacy-default-webhook-jobs" ]]; then
    AUDIT_STDERR_FILE="$(mktemp "$temp_root/maxim-postgres-audit-stderr.XXXXXXXX")" || {
      echo "Could not create the private PostgreSQL audit diagnostics file." >&2
      return 1
    }
    chmod 0600 "$AUDIT_STDERR_FILE"
  fi
}

psql_command=(
  docker compose --env-file .env -p infra -f infra/docker-compose.yml
  exec -T
  -e "PGAPPNAME=$POSTGRES_AUDIT_APP_NAME"
  -e "PGOPTIONS=$POSTGRES_AUDIT_OPTIONS"
  postgres
  psql -X --no-password -qAt -v ON_ERROR_STOP=1 -v ECHO=none -v VERBOSITY=terse -v SHOW_CONTEXT=never
  -U "$POSTGRES_AUDIT_ROLE" -d maxim
)

# Reached through the EXIT/signal cleanup path.
# shellcheck disable=SC2317,SC2329
cleanup_backend() {
  local cleanup_sql

  cleanup_sql="$(cat <<SQL
WITH candidate AS MATERIALIZED (
  SELECT pid, backend_start
  FROM pg_stat_activity
  WHERE application_name = '$POSTGRES_AUDIT_APP_NAME'
    AND pid <> pg_backend_pid()
  ORDER BY pid, backend_start
  LIMIT 2
), singleton AS (
  SELECT min(pid) AS pid, min(backend_start) AS backend_start
  FROM candidate
  HAVING count(*) = 1
)
SELECT pg_terminate_backend(live.pid)
FROM singleton
JOIN pg_stat_activity live
  ON live.pid = singleton.pid
  AND live.backend_start = singleton.backend_start
  AND live.application_name = '$POSTGRES_AUDIT_APP_NAME'
SQL
)"
  timeout --signal=TERM --kill-after=1s 4s \
    docker compose --env-file .env -p infra -f infra/docker-compose.yml \
    exec -T \
    -e PGAPPNAME=maxim-bounded-audit-cleanup \
    -e 'PGOPTIONS=-c statement_timeout=2s -c lock_timeout=250ms -c idle_session_timeout=10s -c max_parallel_workers_per_gather=0 -c jit=off' \
    postgres \
      psql -X --no-password -qAt -v ON_ERROR_STOP=1 \
      -U maxim -d maxim -c "$cleanup_sql" \
    >/dev/null 2>&1 || true
}

AUDIT_PROCESS_PID=''

# Reached through the EXIT/signal cleanup path.
# shellcheck disable=SC2317,SC2329
terminate_local_audit() {
  local pid="$AUDIT_PROCESS_PID"

  if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]]; then
    return 0
  fi
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 0.05
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  wait "$pid" 2>/dev/null || true
  AUDIT_PROCESS_PID=''
}

# Invoked indirectly by the shell traps below.
# shellcheck disable=SC2317,SC2329
cleanup() {
  local status=$?

  trap - EXIT HUP INT TERM
  terminate_local_audit
  if [[ "$AUDIT_BACKEND_MAY_EXIST" -eq 1 ]]; then
    cleanup_backend
  fi
  if [[ -n "$AUDIT_SQL_FILE" && -f "$AUDIT_SQL_FILE" && ! -L "$AUDIT_SQL_FILE" ]]; then
    rm -f -- "$AUDIT_SQL_FILE"
  fi
  AUDIT_SQL_FILE=''
  if [[ -n "$AUDIT_STDERR_FILE" && -f "$AUDIT_STDERR_FILE" && ! -L "$AUDIT_STDERR_FILE" ]]; then
    rm -f -- "$AUDIT_STDERR_FILE"
  fi
  AUDIT_STDERR_FILE=''
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

prepare_audit_sql
AUDIT_BACKEND_MAY_EXIST=1
if [[ "$AUDIT_MODE" == "legacy-default-webhook-jobs" ]]; then
  timeout --signal=TERM --kill-after=2s \
    "$AUDIT_WALL_TIMEOUT_SEC" "${psql_command[@]}" <"$AUDIT_SQL_FILE" \
    2>"$AUDIT_STDERR_FILE" &
else
  timeout --signal=TERM --kill-after=2s \
    "$AUDIT_WALL_TIMEOUT_SEC" "${psql_command[@]}" <"$AUDIT_SQL_FILE" &
fi
AUDIT_PROCESS_PID=$!
set +e
wait "$AUDIT_PROCESS_PID"
status=$?
set -e
AUDIT_PROCESS_PID=''

if [[ "$status" -eq 124 ]]; then
  echo "Bounded PostgreSQL audit exceeded ${AUDIT_WALL_TIMEOUT_SEC}s and was terminated." >&2
elif [[ "$status" -ne 0 && "$AUDIT_MODE" == "legacy-default-webhook-jobs" ]]; then
  echo "Bounded legacy default webhook database audit failed closed." >&2
fi
exit "$status"
