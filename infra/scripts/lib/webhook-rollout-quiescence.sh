#!/usr/bin/env bash

MAXIM_WEBHOOK_ROLLOUT_CONTROL_HELPER="${MAXIM_WEBHOOK_ROLLOUT_CONTROL_HELPER:-$ROOT_DIR/infra/scripts/webhook-queue-rollout-control.cjs}"
MAXIM_WEBHOOK_ROLLOUT_DRAIN_TIMEOUT_SEC="${MAXIM_WEBHOOK_ROLLOUT_DRAIN_TIMEOUT_SEC:-960}"
MAXIM_WEBHOOK_ROLLOUT_CONTROL_TIMEOUT_SEC="${MAXIM_WEBHOOK_ROLLOUT_CONTROL_TIMEOUT_SEC:-30}"
MAXIM_WEBHOOK_ROLLOUT_STOP_TIMEOUT_SEC="${MAXIM_WEBHOOK_ROLLOUT_STOP_TIMEOUT_SEC:-30}"
MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE="${MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE:-0}"
MAXIM_WEBHOOK_ROLLOUT_OWNER_TOKEN="${MAXIM_WEBHOOK_ROLLOUT_OWNER_TOKEN:-}"
MAXIM_WEBHOOK_QUEUES_MAY_BE_PAUSED=0
MAXIM_WEBHOOK_STALE_TIMEOUT_QUARANTINES_FENCED=0

MAXIM_WEBHOOK_PENDING_TIMEOUT_QUARANTINE_PREFIX='WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'

MAXIM_WEBHOOK_MODERATION_SERVICES=(
  "api-moderation"
  "api-moderation-critical"
  "api-moderation-join"
  "api-moderation-realtime-b"
  "api-moderation-realtime-c"
  "api-moderation-realtime-d"
  "api-moderation-background"
)

maxim_webhook_rollout_validate_positive_int() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$name must be a positive integer." >&2
    return 1
  fi
}

maxim_webhook_rollout_require_helper() {
  if [[ ! -s "$MAXIM_WEBHOOK_ROLLOUT_CONTROL_HELPER" ]]; then
    echo "Missing webhook rollout queue control helper." >&2
    return 1
  fi
  command -v timeout >/dev/null 2>&1 || {
    echo "timeout is required for webhook rollout queue control." >&2
    return 1
  }
  maxim_webhook_rollout_validate_positive_int \
    MAXIM_WEBHOOK_ROLLOUT_DRAIN_TIMEOUT_SEC \
    "$MAXIM_WEBHOOK_ROLLOUT_DRAIN_TIMEOUT_SEC"
  maxim_webhook_rollout_validate_positive_int \
    MAXIM_WEBHOOK_ROLLOUT_CONTROL_TIMEOUT_SEC \
    "$MAXIM_WEBHOOK_ROLLOUT_CONTROL_TIMEOUT_SEC"
  maxim_webhook_rollout_validate_positive_int \
    MAXIM_WEBHOOK_ROLLOUT_STOP_TIMEOUT_SEC \
    "$MAXIM_WEBHOOK_ROLLOUT_STOP_TIMEOUT_SEC"
  if [[ "$MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE" != "0" && \
        "$MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE" != "1" ]]; then
    echo "MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE must be 0 or 1." >&2
    return 1
  fi
}

maxim_webhook_rollout_ensure_owner_token() {
  local random_hex

  if [[ -z "$MAXIM_WEBHOOK_ROLLOUT_OWNER_TOKEN" ]]; then
    if ! random_hex="$(node -e \
      "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"; then
      echo "Could not generate a webhook rollout owner token." >&2
      return 1
    fi
    MAXIM_WEBHOOK_ROLLOUT_OWNER_TOKEN="rollout:$random_hex"
  fi
  if [[ ! "$MAXIM_WEBHOOK_ROLLOUT_OWNER_TOKEN" =~ ^rollout:[0-9a-f]{64}$ ]]; then
    echo "Webhook rollout owner token is invalid." >&2
    return 1
  fi
}

maxim_webhook_rollout_control() {
  local compose_args_var="$1"
  local action="$2"
  local timeout_sec="$3"
  local drain_timeout_sec="${4:-$MAXIM_WEBHOOK_ROLLOUT_DRAIN_TIMEOUT_SEC}"
  local -n compose_args_ref="$compose_args_var"
  local command=(
    docker compose "${compose_args_ref[@]}" run --rm --no-deps --pull never -T
    -e "MAXIM_WEBHOOK_ROLLOUT_OWNER_TOKEN=$MAXIM_WEBHOOK_ROLLOUT_OWNER_TOKEN"
  )
  if [[ "$action" == "wait-drained" ]]; then
    command+=(
      -e "MAXIM_WEBHOOK_ROLLOUT_DRAIN_TIMEOUT_MS=$((drain_timeout_sec * 1000))"
    )
  elif [[ "$action" == "pause" && "$MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE" == "1" ]]; then
    command+=(-e MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1)
  fi
  command+=(api-admin node - "$action")
  timeout --foreground --kill-after=5s "${timeout_sec}s" \
    "${command[@]}" <"$MAXIM_WEBHOOK_ROLLOUT_CONTROL_HELPER"
}

maxim_webhook_rollout_verify_services_stopped() {
  local compose_args_var="$1"
  shift
  local -n compose_args_ref="$compose_args_var"
  local service
  local running_ids
  for service in "$@"; do
    if ! running_ids="$(
      docker compose "${compose_args_ref[@]}" ps --status running -q "$service" 2>/dev/null
    )"; then
      echo "Could not inspect webhook rollout service state: $service" >&2
      return 1
    fi
    if [[ -n "$running_ids" ]]; then
      echo "Webhook rollout service did not stop: $service" >&2
      return 1
    fi
  done
}

maxim_webhook_rollout_has_pending_timeout_quarantine() {
  local compose_args_var="$1"
  local -n compose_args_ref="$compose_args_var"
  local pending

  if ! pending="$(
    timeout --foreground --kill-after=5s "${MAXIM_WEBHOOK_ROLLOUT_CONTROL_TIMEOUT_SEC}s" \
      docker compose "${compose_args_ref[@]}" exec -T postgres \
psql -X -v ON_ERROR_STOP=1 -U maxim -d maxim -Atq <<SQL
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'webhook_events'::regclass
    AND attname = 'timeout_quarantine_expires_at'
    AND NOT attisdropped
) THEN 'true' ELSE 'false' END AS has_timeout_quarantine_column \gset
\if :has_timeout_quarantine_column
SELECT CASE
-- FLAG: A future lease can still own detached work. Expired and pre-lease markers remain replay
-- fences, but rollout may classify them separately before proving every moderation owner stopped.
WHEN EXISTS (
  SELECT 1
  FROM "webhook_events"
  WHERE "status" = 'FAILED'
    AND LEFT(COALESCE("error_message", ''), 37) = '${MAXIM_WEBHOOK_PENDING_TIMEOUT_QUARANTINE_PREFIX}'
    AND "timeout_quarantine_expires_at" IS NOT NULL
    AND "timeout_quarantine_expires_at" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
  LIMIT 1
) THEN 1
WHEN EXISTS (
  SELECT 1
  FROM "webhook_events"
  WHERE "status" = 'FAILED'
    AND LEFT(COALESCE("error_message", ''), 37) = '${MAXIM_WEBHOOK_PENDING_TIMEOUT_QUARANTINE_PREFIX}'
    AND "timeout_quarantine_expires_at" IS NOT NULL
    AND "timeout_quarantine_expires_at" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
  LIMIT 1
) THEN 2
WHEN EXISTS (
  SELECT 1
  FROM "webhook_events"
  WHERE "status" = 'FAILED'
    AND LEFT(COALESCE("error_message", ''), 37) = '${MAXIM_WEBHOOK_PENDING_TIMEOUT_QUARANTINE_PREFIX}'
    AND "timeout_quarantine_expires_at" IS NULL
  LIMIT 1
) THEN 2
ELSE 0 END;
\else
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM "webhook_events"
  WHERE "status" = 'FAILED'
    AND LEFT(COALESCE("error_message", ''), 37) = '${MAXIM_WEBHOOK_PENDING_TIMEOUT_QUARANTINE_PREFIX}'
  LIMIT 1
  ) THEN 2 ELSE 0 END;
\endif
SQL
  )"; then
    echo "Could not query pending webhook timeout quarantine state." >&2
    return 2
  fi

  case "$pending" in
    0) return 1 ;;
    1) return 0 ;;
    2) return 3 ;;
    *)
      echo "Postgres returned an invalid webhook timeout quarantine state." >&2
      return 2
      ;;
  esac
}

maxim_webhook_assert_api_rollout_quiescence() {
  local compose_args_var="$1"
  local deadline_at=$((SECONDS + MAXIM_WEBHOOK_ROLLOUT_DRAIN_TIMEOUT_SEC))
  local remaining_sec
  local state

  while true; do
    remaining_sec=$((deadline_at - SECONDS))
    if [[ "$remaining_sec" -le 0 ]]; then
      echo "Active or detached webhook executions did not settle before the rollout deadline." >&2
      return 1
    fi
    maxim_webhook_rollout_control \
      "$compose_args_var" wait-drained "$((remaining_sec + 10))" "$remaining_sec" >/dev/null

    if maxim_webhook_rollout_has_pending_timeout_quarantine "$compose_args_var"; then
      state=0
    else
      state=$?
    fi
    if [[ "$state" -eq 3 && "$MAXIM_WEBHOOK_STALE_TIMEOUT_QUARANTINES_FENCED" -eq 1 ]]; then
      state=1
    fi
    if [[ "$state" -ne 0 ]]; then
      if [[ "$state" -ne 1 && "$state" -ne 3 ]]; then
        return "$state"
      fi

      remaining_sec=$((deadline_at - SECONDS))
      if [[ "$remaining_sec" -le 0 ]]; then
        echo "Active or detached webhook executions did not settle before the rollout deadline." >&2
        return 1
      fi
      maxim_webhook_rollout_control \
        "$compose_args_var" wait-drained "$((remaining_sec + 10))" "$remaining_sec" >/dev/null
      if maxim_webhook_rollout_has_pending_timeout_quarantine "$compose_args_var"; then
        state=0
      else
        state=$?
      fi
      if [[ "$state" -eq 3 && "$MAXIM_WEBHOOK_STALE_TIMEOUT_QUARANTINES_FENCED" -eq 1 ]]; then
        state=1
      fi
      if [[ "$state" -eq 1 ]]; then
        return 0
      fi
      if [[ "$state" -eq 3 ]]; then
        return 3
      fi
      if [[ "$state" -ne 0 ]]; then
        return "$state"
      fi
    fi
    if [[ "$SECONDS" -ge "$deadline_at" ]]; then
      echo "Active or detached webhook executions did not settle before the rollout deadline." >&2
      return 1
    fi
    sleep 1
  done
}

maxim_webhook_quiesce_for_api_rollout() {
  local compose_args_var="$1"
  local -n compose_args_ref="$compose_args_var"
  local quiescence_state
  maxim_webhook_rollout_require_helper
  maxim_webhook_rollout_ensure_owner_token

  # FLAG: A failed or partial pause is operationally ambiguous. Keep warning until an exact-version
  # fence explicitly resumes every queue.
  MAXIM_WEBHOOK_QUEUES_MAY_BE_PAUSED=1
  maxim_webhook_rollout_control \
    "$compose_args_var" pause "$MAXIM_WEBHOOK_ROLLOUT_CONTROL_TIMEOUT_SEC" >/dev/null
  echo "Webhook queues paused globally for the API version transition."

  docker compose "${compose_args_ref[@]}" stop \
    -t "$MAXIM_WEBHOOK_ROLLOUT_STOP_TIMEOUT_SEC" api-enqueue >/dev/null
  maxim_webhook_rollout_verify_services_stopped "$compose_args_var" api-enqueue

  if maxim_webhook_assert_api_rollout_quiescence "$compose_args_var"; then
    quiescence_state=0
  else
    quiescence_state=$?
    if [[ "$quiescence_state" -ne 3 ]]; then
      return "$quiescence_state"
    fi
    echo "Stale timeout quarantine markers require a stopped-worker rollout fence."
  fi

  docker compose "${compose_args_ref[@]}" stop \
    -t "$MAXIM_WEBHOOK_ROLLOUT_STOP_TIMEOUT_SEC" \
    "${MAXIM_WEBHOOK_MODERATION_SERVICES[@]}" >/dev/null
  maxim_webhook_rollout_verify_services_stopped \
    "$compose_args_var" "${MAXIM_WEBHOOK_MODERATION_SERVICES[@]}"

  # FLAG: Pre-lease NULL deadlines and expired leases remain replay-blocking in storage. Once every
  # owning moderation process is stopped, they can no longer hide mixed-version execution.
  MAXIM_WEBHOOK_STALE_TIMEOUT_QUARANTINES_FENCED=1
  maxim_webhook_assert_api_rollout_quiescence "$compose_args_var"
  echo "Active and detached webhook work fenced under the global queue pause."
  echo "Webhook enqueue and moderation roles are quiesced."
}

maxim_webhook_resume_after_api_fence() {
  local compose_args_var="$1"
  maxim_webhook_assert_api_rollout_quiescence "$compose_args_var"
  maxim_webhook_rollout_control \
    "$compose_args_var" resume "$MAXIM_WEBHOOK_ROLLOUT_CONTROL_TIMEOUT_SEC" >/dev/null
  MAXIM_WEBHOOK_QUEUES_MAY_BE_PAUSED=0
  echo "Webhook queues resumed after the exact API image fence."
}

maxim_webhook_rollout_warn_if_paused() {
  if [[ "$MAXIM_WEBHOOK_QUEUES_MAY_BE_PAUSED" -eq 1 ]]; then
    cat >&2 <<'WARNING'
CRITICAL: webhook queues may still be globally paused after an incomplete API transition.
Do not resume them until every production API role is verified on one reviewed image.
WARNING
  fi
}
