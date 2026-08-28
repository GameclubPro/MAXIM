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
POSTGRES_AUDIT_ROLE=maxim_audit
POSTGRES_AUDIT_APP_NAME="maxim-bounded-audit-$(date -u +%Y%m%dT%H%M%SZ)-${BASHPID}-${RANDOM}"
POSTGRES_AUDIT_OPTIONS='-c default_transaction_read_only=on -c statement_timeout=2500ms -c lock_timeout=250ms -c idle_in_transaction_session_timeout=4s -c idle_session_timeout=60s -c max_parallel_workers_per_gather=0 -c enable_seqscan=off -c jit=off -c work_mem=1MB'

usage() {
  cat <<'USAGE' >&2
Usage:
  ./infra/scripts/vps-postgres-audit.sh [queue|activity|all]

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
  queue|activity|all)
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
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname !~ '^pg_toast'
        AND (
          (
            NOT (
              namespace.nspname = 'public'
              AND relation.relname IN ('webhook_events', 'moderation_events')
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

emit_sql() {
  emit_prelude
  case "$AUDIT_MODE" in
    queue)
      emit_queue_audit
      ;;
    activity)
      emit_activity_audit
      ;;
    all)
      emit_queue_audit
      emit_activity_audit
      ;;
    monitor-signals)
      emit_monitor_signals_audit
      ;;
  esac
  printf '%s\n' 'COMMIT;'
}

psql_command=(
  docker compose --env-file .env -p infra -f infra/docker-compose.yml
  exec -T
  -e "PGAPPNAME=$POSTGRES_AUDIT_APP_NAME"
  -e "PGOPTIONS=$POSTGRES_AUDIT_OPTIONS"
  postgres
  psql -X --no-password -qAt -v ON_ERROR_STOP=1
  -U "$POSTGRES_AUDIT_ROLE" -d maxim
)

# Reached through the EXIT/signal cleanup path.
# shellcheck disable=SC2329
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
# shellcheck disable=SC2329
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
# shellcheck disable=SC2329
cleanup() {
  local status=$?

  trap - EXIT HUP INT TERM
  terminate_local_audit
  cleanup_backend
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

timeout --signal=TERM --kill-after=2s \
  "$AUDIT_WALL_TIMEOUT_SEC" "${psql_command[@]}" < <(emit_sql) &
AUDIT_PROCESS_PID=$!
set +e
wait "$AUDIT_PROCESS_PID"
status=$?
set -e
AUDIT_PROCESS_PID=''

if [[ "$status" -eq 124 ]]; then
  echo "Bounded PostgreSQL audit exceeded ${AUDIT_WALL_TIMEOUT_SEC}s and was terminated." >&2
fi
exit "$status"
