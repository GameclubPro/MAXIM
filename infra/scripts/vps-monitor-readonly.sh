#!/usr/bin/env bash
# Trap handlers and run_step callbacks are referenced indirectly.
# shellcheck disable=SC2329
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=infra/scripts/lib/deploy-topology.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"
# shellcheck source=infra/scripts/lib/deploy-disk-capacity.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-disk-capacity.sh"
# shellcheck source=infra/scripts/lib/monitor-process-tree.sh
source "$ROOT_DIR/infra/scripts/lib/monitor-process-tree.sh"

MIN_MONITOR_INTERVAL_SEC=15
MAX_MONITOR_DURATION_SEC=21600
MAX_MONITOR_FAILED_FRESH_WINDOW_SEC=86400
REMOTE_MONITOR_LOCK_MARKER='MAXIM_REMOTE_MONITOR_LOCK_ACQUIRED'
REMOTE_MONITOR_LOCK_PING='MAXIM_REMOTE_MONITOR_LOCK_PING'
REMOTE_MONITOR_LOCK_ACK='MAXIM_REMOTE_MONITOR_LOCK_ACK'
REMOTE_MONITOR_LOCK_ACK_TIMEOUT_SEC=5
REMOTE_MONITOR_LOCK_HEARTBEAT_SEC=5
MONITOR_SAMPLE_REQUEST='MAXIM_MONITOR_SAMPLE_REQUEST'
MONITOR_SAMPLE_PERMIT='MAXIM_MONITOR_SAMPLE_PERMIT'
MONITOR_CHILD_MODE="${MAXIM_MONITOR_CHILD_MODE:-0}"
DURATION_SEC="${1:-${MAXIM_MONITOR_DURATION_SEC:-1800}}"
INTERVAL_SEC="${2:-${MAXIM_MONITOR_INTERVAL_SEC:-300}}"
TAIL_LINES="${MAXIM_MONITOR_LOG_TAIL_LINES:-300}"
FAILED_FRESH_WINDOW_SEC="${MAXIM_MONITOR_FAILED_FRESH_WINDOW_SEC:-300}"
LAST_SERVICE_LOG_SCAN_AT_SEC=0
LAST_STATIC_LOG_SCAN_AT_SEC=0
LAST_BULLMQ_PROBE_AT_MS=0
LOG_FILE="${MAXIM_MONITOR_LOG:-/tmp/maxim-vps-readonly-monitor-$(date +%Y%m%d%H%M%S).log}"
PUBLIC_URL="${MAXIM_VPS_PUBLIC_URL:-https://major-maksimov.ru}"
ADMIN_PUBLIC_URL="${MAXIM_ADMIN_PUBLIC_URL:-https://admin.major-maksimov.ru}"
SIGNAL_WINDOW_MIN="${MAXIM_MONITOR_SIGNAL_WINDOW_MIN:-30}"
MONITOR_LOCK_FILE="${MAXIM_MONITOR_LOCK_FILE:-${TMPDIR:-/tmp}/maxim-vps-monitor-readonly-${UID}.lock}"
MONITOR_SUPERVISION_DIR=''
REMOTE_MONITOR_LOCK_HELD=0
REMOTE_MONITOR_LOCK_PID=''
REMOTE_MONITOR_LOCK_PID_STARTTIME=''
REMOTE_MONITOR_LOCK_SESSION=''
REMOTE_MONITOR_LOCK_SESSION_STARTTIME=''
REMOTE_MONITOR_LOCK_INPUT_FIFO=''
REMOTE_MONITOR_LOCK_OUTPUT_FIFO=''
REMOTE_MONITOR_LOCK_READ_FD=''
REMOTE_MONITOR_LOCK_WRITE_FD=''
REMOTE_MONITOR_LOCK_CHALLENGE_INDEX=0
REMOTE_MONITOR_LOCK_NEXT_HEARTBEAT_AT_SEC=0
MONITOR_RUNNER_PID=''
MONITOR_RUNNER_PID_STARTTIME=''
MONITOR_RUNNER_SESSION=''
MONITOR_RUNNER_SESSION_STARTTIME=''
MONITOR_RUNNER_OUTPUT_FIFO=''
MONITOR_RUNNER_REQUEST_FIFO=''
MONITOR_RUNNER_PERMIT_FIFO=''
MONITOR_RUNNER_READ_FD=''
MONITOR_RUNNER_REQUEST_FD=''
MONITOR_RUNNER_PERMIT_FD=''
MONITOR_RUNNER_NEXT_SAMPLE_INDEX=0
MONITOR_CHILD_REQUEST_FIFO="${MAXIM_MONITOR_SAMPLE_REQUEST_FIFO:-}"
MONITOR_CHILD_PERMIT_FIFO="${MAXIM_MONITOR_SAMPLE_PERMIT_FIFO:-}"
MONITOR_CHILD_REQUEST_FD=''
MONITOR_CHILD_PERMIT_FD=''
MONITOR_LOG_FD=''
MONITOR_WRAPPER_PID="$BASHPID"
MONITOR_WRAPPER_STARTTIME=''
SUCCESSFUL_ACCESS_LOG_PATTERN='" (2[0-9][0-9]|3[0-9][0-9]) [0-9]+'
PUBLIC_URL="${PUBLIC_URL%/}"
ADMIN_PUBLIC_URL="${ADMIN_PUBLIC_URL%/}"

SERVICES=("${MAXIM_PRODUCTION_API_SERVICES[@]}")
STATIC_SERVICES=("miniapp-major-static" "admin-static")
LOG_SERVICES=("${SERVICES[@]}" "${STATIC_SERVICES[@]}")

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

case "$MONITOR_CHILD_MODE" in
  0|1) ;;
  *)
    echo "MAXIM_MONITOR_CHILD_MODE must be 0 or 1." >&2
    exit 2
    ;;
esac

MONITOR_WRAPPER_STARTTIME="$(monitor_wait_for_process_starttime "$MONITOR_WRAPPER_PID")" || {
  echo "Could not bind the monitor wrapper to its process identity." >&2
  exit 2
}
if ((MONITOR_CHILD_MODE == 1)); then
  if [[ "${MAXIM_MONITOR_PARENT_PID:-}" != "$PPID" ]] ||
    ! monitor_process_identity_is_alive \
      "${MAXIM_MONITOR_PARENT_PID:-}" \
      "${MAXIM_MONITOR_PARENT_STARTTIME:-}"; then
    echo "Monitor child mode requires its exact live wrapper parent." >&2
    exit 2
  fi
fi

if ! is_positive_integer "$DURATION_SEC" || ((DURATION_SEC > MAX_MONITOR_DURATION_SEC)); then
  echo "DURATION_SEC must be an integer between 1 and $MAX_MONITOR_DURATION_SEC, got: $DURATION_SEC" >&2
  exit 2
fi

if ! is_positive_integer "$INTERVAL_SEC" || ((INTERVAL_SEC < MIN_MONITOR_INTERVAL_SEC)); then
  echo "INTERVAL_SEC must be an integer of at least $MIN_MONITOR_INTERVAL_SEC, got: $INTERVAL_SEC" >&2
  exit 2
fi

if ! is_positive_integer "$TAIL_LINES" || ((TAIL_LINES > 10000)); then
  echo "MAXIM_MONITOR_LOG_TAIL_LINES must be an integer between 1 and 10000, got: $TAIL_LINES" >&2
  exit 2
fi
LOG_REQUEST_LINES=$((TAIL_LINES + 1))

if ! is_positive_integer "$FAILED_FRESH_WINDOW_SEC" ||
  ((FAILED_FRESH_WINDOW_SEC < INTERVAL_SEC ||
    FAILED_FRESH_WINDOW_SEC > MAX_MONITOR_FAILED_FRESH_WINDOW_SEC)); then
  echo "MAXIM_MONITOR_FAILED_FRESH_WINDOW_SEC must be between INTERVAL_SEC and $MAX_MONITOR_FAILED_FRESH_WINDOW_SEC, got: $FAILED_FRESH_WINDOW_SEC" >&2
  exit 2
fi

if ! is_positive_integer "$SIGNAL_WINDOW_MIN" || ((SIGNAL_WINDOW_MIN > 1440)); then
  echo "MAXIM_MONITOR_SIGNAL_WINDOW_MIN must be an integer between 1 and 1440, got: $SIGNAL_WINDOW_MIN" >&2
  exit 2
fi

if ((MONITOR_CHILD_MODE == 0)); then
  for required_command in flock mkfifo mktemp setsid; do
    if ! command -v "$required_command" >/dev/null 2>&1; then
      echo "$required_command is required for serialized readonly production monitoring" >&2
      exit 2
    fi
  done

  # FLAG: Multiple full-fleet monitors amplify diagnostic load and can distort the system observed.
  exec {MONITOR_LOCK_FD}>>"$MONITOR_LOCK_FILE"
  if ! flock -n "$MONITOR_LOCK_FD"; then
    echo "Another readonly VPS monitor already holds $MONITOR_LOCK_FILE" >&2
    exit 3
  fi
fi

prepare_monitor_supervision() {
  if [[ -n "$MONITOR_SUPERVISION_DIR" ]]; then
    return 0
  fi

  MONITOR_SUPERVISION_DIR="$(
    mktemp -d "${TMPDIR:-/tmp}/maxim-vps-monitor-supervision.XXXXXXXX"
  )"
  REMOTE_MONITOR_LOCK_INPUT_FIFO="$MONITOR_SUPERVISION_DIR/remote-lock.stdin"
  REMOTE_MONITOR_LOCK_OUTPUT_FIFO="$MONITOR_SUPERVISION_DIR/remote-lock.stdout"
  MONITOR_RUNNER_OUTPUT_FIFO="$MONITOR_SUPERVISION_DIR/runner.stdout"
  MONITOR_RUNNER_REQUEST_FIFO="$MONITOR_SUPERVISION_DIR/runner.request"
  MONITOR_RUNNER_PERMIT_FIFO="$MONITOR_SUPERVISION_DIR/runner.permit"
  mkfifo -- \
    "$REMOTE_MONITOR_LOCK_INPUT_FIFO" \
    "$REMOTE_MONITOR_LOCK_OUTPUT_FIFO" \
    "$MONITOR_RUNNER_OUTPUT_FIFO" \
    "$MONITOR_RUNNER_REQUEST_FIFO" \
    "$MONITOR_RUNNER_PERMIT_FIFO"
}

cleanup_monitor_supervision() {
  if [[ -z "$MONITOR_SUPERVISION_DIR" ]]; then
    return 0
  fi

  rm -f -- \
    "$REMOTE_MONITOR_LOCK_INPUT_FIFO" \
    "$REMOTE_MONITOR_LOCK_OUTPUT_FIFO" \
    "$MONITOR_RUNNER_OUTPUT_FIFO" \
    "$MONITOR_RUNNER_REQUEST_FIFO" \
    "$MONITOR_RUNNER_PERMIT_FIFO"
  rmdir -- "$MONITOR_SUPERVISION_DIR" 2>/dev/null || true
  MONITOR_SUPERVISION_DIR=''
  REMOTE_MONITOR_LOCK_INPUT_FIFO=''
  REMOTE_MONITOR_LOCK_OUTPUT_FIFO=''
  MONITOR_RUNNER_OUTPUT_FIFO=''
  MONITOR_RUNNER_REQUEST_FIFO=''
  MONITOR_RUNNER_PERMIT_FIFO=''
}

release_remote_monitor_lock() {
  if [[ "$REMOTE_MONITOR_LOCK_WRITE_FD" =~ ^[0-9]+$ ]]; then
    exec {REMOTE_MONITOR_LOCK_WRITE_FD}>&- 2>/dev/null || true
    REMOTE_MONITOR_LOCK_WRITE_FD=''
  fi
  if [[ "$REMOTE_MONITOR_LOCK_PID" =~ ^[1-9][0-9]*$ &&
    "$REMOTE_MONITOR_LOCK_PID_STARTTIME" =~ ^[0-9]+$ &&
    "$REMOTE_MONITOR_LOCK_SESSION" =~ ^[1-9][0-9]*$ &&
    "$REMOTE_MONITOR_LOCK_SESSION_STARTTIME" =~ ^[0-9]+$ ]]; then
    if ! monitor_wait_for_owned_tree_exit \
      "$REMOTE_MONITOR_LOCK_PID" \
      "$REMOTE_MONITOR_LOCK_PID_STARTTIME" \
      "$REMOTE_MONITOR_LOCK_SESSION" \
      "$REMOTE_MONITOR_LOCK_SESSION_STARTTIME" 20; then
      monitor_terminate_owned_tree \
        "$REMOTE_MONITOR_LOCK_PID" \
        "$REMOTE_MONITOR_LOCK_PID_STARTTIME" \
        "$REMOTE_MONITOR_LOCK_SESSION" \
        "$REMOTE_MONITOR_LOCK_SESSION_STARTTIME" || true
    fi
    wait "$REMOTE_MONITOR_LOCK_PID" 2>/dev/null || true
  elif [[ "$REMOTE_MONITOR_LOCK_PID" =~ ^[1-9][0-9]*$ &&
    "$REMOTE_MONITOR_LOCK_PID_STARTTIME" =~ ^[0-9]+$ ]]; then
    monitor_terminate_owned_tree \
      "$REMOTE_MONITOR_LOCK_PID" \
      "$REMOTE_MONITOR_LOCK_PID_STARTTIME" 0 0 || true
    wait "$REMOTE_MONITOR_LOCK_PID" 2>/dev/null || true
  fi
  if [[ "$REMOTE_MONITOR_LOCK_READ_FD" =~ ^[0-9]+$ ]]; then
    exec {REMOTE_MONITOR_LOCK_READ_FD}<&- 2>/dev/null || true
    REMOTE_MONITOR_LOCK_READ_FD=''
  fi
  REMOTE_MONITOR_LOCK_HELD=0
  REMOTE_MONITOR_LOCK_PID=''
  REMOTE_MONITOR_LOCK_PID_STARTTIME=''
  REMOTE_MONITOR_LOCK_SESSION=''
  REMOTE_MONITOR_LOCK_SESSION_STARTTIME=''
  REMOTE_MONITOR_LOCK_CHALLENGE_INDEX=0
  REMOTE_MONITOR_LOCK_NEXT_HEARTBEAT_AT_SEC=0
}

acquire_remote_monitor_lock() {
  local marker=''
  local session_starttime=''

  prepare_monitor_supervision
  setsid --wait ./infra/scripts/vps-monitor-process-guardian.sh \
    ./infra/scripts/vps-connect.sh exec \
    'env -u MAXIM_MONITOR_REMOTE_LOCK_FILE ./infra/scripts/vps-monitor-lock-holder.sh' \
    <"$REMOTE_MONITOR_LOCK_INPUT_FIFO" >"$REMOTE_MONITOR_LOCK_OUTPUT_FIFO" &
  REMOTE_MONITOR_LOCK_PID=$!
  disown "$REMOTE_MONITOR_LOCK_PID" 2>/dev/null || true
  REMOTE_MONITOR_LOCK_PID_STARTTIME="$(
    monitor_wait_for_process_starttime "$REMOTE_MONITOR_LOCK_PID"
  )" || {
    release_remote_monitor_lock
    echo "Could not bind the VPS-wide monitor transport to its process identity." >&2
    return 3
  }
  exec {REMOTE_MONITOR_LOCK_WRITE_FD}<>"$REMOTE_MONITOR_LOCK_INPUT_FIFO"
  exec {REMOTE_MONITOR_LOCK_READ_FD}<>"$REMOTE_MONITOR_LOCK_OUTPUT_FIFO"
  session_starttime="$(monitor_wait_for_session_leader "$REMOTE_MONITOR_LOCK_PID")" || {
    release_remote_monitor_lock
    echo "Could not isolate the VPS-wide monitor transport process group." >&2
    return 3
  }
  if [[ "$session_starttime" != "$REMOTE_MONITOR_LOCK_PID_STARTTIME" ]]; then
    release_remote_monitor_lock
    echo "VPS-wide monitor transport identity changed during startup." >&2
    return 3
  fi
  REMOTE_MONITOR_LOCK_SESSION="$REMOTE_MONITOR_LOCK_PID"
  REMOTE_MONITOR_LOCK_SESSION_STARTTIME="$session_starttime"

  if ! IFS= read -r -t 15 marker <&"$REMOTE_MONITOR_LOCK_READ_FD" ||
    [[ "$marker" != "$REMOTE_MONITOR_LOCK_MARKER" ]]; then
    release_remote_monitor_lock
    echo "Could not acquire the VPS-wide readonly monitor lock." >&2
    return 3
  fi

  REMOTE_MONITOR_LOCK_HELD=1
  if ! assert_remote_monitor_lock; then
    return 3
  fi
}

assert_remote_monitor_lock() {
  local acknowledgement=''
  local challenge=''
  local expected_acknowledgement=''

  if ((REMOTE_MONITOR_LOCK_HELD != 1)) ||
    [[ ! "$REMOTE_MONITOR_LOCK_READ_FD" =~ ^[0-9]+$ ]] ||
    [[ ! "$REMOTE_MONITOR_LOCK_WRITE_FD" =~ ^[0-9]+$ ]] ||
    ! monitor_process_identity_is_alive \
      "$REMOTE_MONITOR_LOCK_PID" \
      "$REMOTE_MONITOR_LOCK_PID_STARTTIME" ||
    ! monitor_owned_session_is_alive \
      "$REMOTE_MONITOR_LOCK_SESSION" \
      "$REMOTE_MONITOR_LOCK_SESSION_STARTTIME"; then
    echo "Lost the VPS-wide readonly monitor lock; stopping before the next sample." >&2
    return 3
  fi

  REMOTE_MONITOR_LOCK_CHALLENGE_INDEX=$((REMOTE_MONITOR_LOCK_CHALLENGE_INDEX + 1))
  challenge="${MONITOR_WRAPPER_PID}-${MONITOR_WRAPPER_STARTTIME}-${REMOTE_MONITOR_LOCK_CHALLENGE_INDEX}"
  expected_acknowledgement="$REMOTE_MONITOR_LOCK_ACK $challenge"
  if ! printf '%s %s\n' "$REMOTE_MONITOR_LOCK_PING" "$challenge" \
    >&"$REMOTE_MONITOR_LOCK_WRITE_FD"; then
    echo "Lost the VPS-wide readonly monitor lock challenge channel." >&2
    return 3
  fi
  if ! IFS= read -r -t "$REMOTE_MONITOR_LOCK_ACK_TIMEOUT_SEC" acknowledgement \
    <&"$REMOTE_MONITOR_LOCK_READ_FD" ||
    [[ "$acknowledgement" != "$expected_acknowledgement" ]]; then
    echo "The VPS-wide readonly monitor lock did not acknowledge its live challenge." >&2
    return 3
  fi
  REMOTE_MONITOR_LOCK_NEXT_HEARTBEAT_AT_SEC=$((SECONDS + REMOTE_MONITOR_LOCK_HEARTBEAT_SEC))
}

maintain_remote_monitor_lock() {
  if ((SECONDS >= REMOTE_MONITOR_LOCK_NEXT_HEARTBEAT_AT_SEC)); then
    assert_remote_monitor_lock
  fi
}

initialize_monitor_child_control() {
  if [[ ! -p "$MONITOR_CHILD_REQUEST_FIFO" || ! -p "$MONITOR_CHILD_PERMIT_FIFO" ]]; then
    echo "Monitor child mode requires private sample-control FIFOs." >&2
    return 3
  fi
  exec {MONITOR_CHILD_REQUEST_FD}>"$MONITOR_CHILD_REQUEST_FIFO"
  exec {MONITOR_CHILD_PERMIT_FD}<"$MONITOR_CHILD_PERMIT_FIFO"
}

request_monitor_sample_permit() {
  local sample_index="$1"
  local permit=''

  if [[ ! "$MONITOR_CHILD_REQUEST_FD" =~ ^[0-9]+$ ||
    ! "$MONITOR_CHILD_PERMIT_FD" =~ ^[0-9]+$ ]]; then
    echo "Monitor child sample-control channels are unavailable." >&2
    return 3
  fi
  if ! printf '%s %s\n' "$MONITOR_SAMPLE_REQUEST" "$sample_index" \
    >&"$MONITOR_CHILD_REQUEST_FD"; then
    echo "Monitor child could not request its next sample permit." >&2
    return 3
  fi
  if ! IFS= read -r -t 15 permit <&"$MONITOR_CHILD_PERMIT_FD" ||
    [[ "$permit" != "$MONITOR_SAMPLE_PERMIT $sample_index" ]]; then
    echo "Monitor child did not receive its next sample permit." >&2
    return 3
  fi
}

close_monitor_runner_channels() {
  if [[ "$MONITOR_RUNNER_READ_FD" =~ ^[0-9]+$ ]]; then
    exec {MONITOR_RUNNER_READ_FD}<&- 2>/dev/null || true
    MONITOR_RUNNER_READ_FD=''
  fi
  if [[ "$MONITOR_RUNNER_REQUEST_FD" =~ ^[0-9]+$ ]]; then
    exec {MONITOR_RUNNER_REQUEST_FD}<&- 2>/dev/null || true
    MONITOR_RUNNER_REQUEST_FD=''
  fi
  if [[ "$MONITOR_RUNNER_PERMIT_FD" =~ ^[0-9]+$ ]]; then
    exec {MONITOR_RUNNER_PERMIT_FD}>&- 2>/dev/null || true
    MONITOR_RUNNER_PERMIT_FD=''
  fi
}

stop_monitor_runner() {
  if [[ "$MONITOR_RUNNER_PID" =~ ^[1-9][0-9]*$ &&
    "$MONITOR_RUNNER_PID_STARTTIME" =~ ^[0-9]+$ &&
    "$MONITOR_RUNNER_SESSION" =~ ^[1-9][0-9]*$ &&
    "$MONITOR_RUNNER_SESSION_STARTTIME" =~ ^[0-9]+$ ]]; then
    monitor_terminate_owned_tree \
      "$MONITOR_RUNNER_PID" \
      "$MONITOR_RUNNER_PID_STARTTIME" \
      "$MONITOR_RUNNER_SESSION" \
      "$MONITOR_RUNNER_SESSION_STARTTIME" || true
    wait "$MONITOR_RUNNER_PID" 2>/dev/null || true
  elif [[ "$MONITOR_RUNNER_PID" =~ ^[1-9][0-9]*$ &&
    "$MONITOR_RUNNER_PID_STARTTIME" =~ ^[0-9]+$ ]]; then
    monitor_terminate_owned_tree \
      "$MONITOR_RUNNER_PID" \
      "$MONITOR_RUNNER_PID_STARTTIME" 0 0 || true
    wait "$MONITOR_RUNNER_PID" 2>/dev/null || true
  fi
  close_monitor_runner_channels
  MONITOR_RUNNER_PID=''
  MONITOR_RUNNER_PID_STARTTIME=''
  MONITOR_RUNNER_SESSION=''
  MONITOR_RUNNER_SESSION_STARTTIME=''
  MONITOR_RUNNER_NEXT_SAMPLE_INDEX=0
}

start_monitor_runner() {
  local session_starttime

  setsid --wait "$ROOT_DIR/infra/scripts/vps-monitor-process-guardian.sh" env \
    MAXIM_MONITOR_CHILD_MODE=1 \
    MAXIM_MONITOR_SAMPLE_REQUEST_FIFO="$MONITOR_RUNNER_REQUEST_FIFO" \
    MAXIM_MONITOR_SAMPLE_PERMIT_FIFO="$MONITOR_RUNNER_PERMIT_FIFO" \
    "$ROOT_DIR/infra/scripts/vps-monitor-readonly.sh" \
    "$DURATION_SEC" \
    "$INTERVAL_SEC" \
    </dev/null >"$MONITOR_RUNNER_OUTPUT_FIFO" 2>&1 &
  MONITOR_RUNNER_PID=$!
  disown "$MONITOR_RUNNER_PID" 2>/dev/null || true
  MONITOR_RUNNER_PID_STARTTIME="$(monitor_wait_for_process_starttime "$MONITOR_RUNNER_PID")" || {
    stop_monitor_runner
    echo "Could not bind the monitor runner to its process identity." >&2
    return 3
  }
  exec {MONITOR_RUNNER_REQUEST_FD}<>"$MONITOR_RUNNER_REQUEST_FIFO"
  exec {MONITOR_RUNNER_PERMIT_FD}<>"$MONITOR_RUNNER_PERMIT_FIFO"
  exec {MONITOR_RUNNER_READ_FD}<>"$MONITOR_RUNNER_OUTPUT_FIFO"
  session_starttime="$(monitor_wait_for_session_leader "$MONITOR_RUNNER_PID")" || {
    stop_monitor_runner
    echo "Could not isolate the monitor runner process group." >&2
    return 3
  }
  if [[ "$session_starttime" != "$MONITOR_RUNNER_PID_STARTTIME" ]]; then
    stop_monitor_runner
    echo "Monitor runner identity changed during startup." >&2
    return 3
  fi
  MONITOR_RUNNER_SESSION="$MONITOR_RUNNER_PID"
  MONITOR_RUNNER_SESSION_STARTTIME="$session_starttime"
  MONITOR_RUNNER_NEXT_SAMPLE_INDEX=0
}

finish_monitor_runner() {
  local status=0

  if [[ "$MONITOR_RUNNER_PID" =~ ^[1-9][0-9]*$ ]]; then
    wait "$MONITOR_RUNNER_PID" || status=$?
  fi
  close_monitor_runner_channels
  MONITOR_RUNNER_PID=''
  MONITOR_RUNNER_PID_STARTTIME=''
  MONITOR_RUNNER_SESSION=''
  MONITOR_RUNNER_SESSION_STARTTIME=''
  MONITOR_RUNNER_NEXT_SAMPLE_INDEX=0
  return "$status"
}

service_monitor_runner_request() {
  local request=''
  local request_command=''
  local request_index=''
  local extra=''

  if ! IFS= read -r -t 0 <&"$MONITOR_RUNNER_REQUEST_FD"; then
    return 0
  fi
  if ! IFS= read -r request <&"$MONITOR_RUNNER_REQUEST_FD"; then
    echo "Monitor runner sample request channel closed unexpectedly." >&2
    return 3
  fi
  IFS=' ' read -r request_command request_index extra <<<"$request"
  if [[ "$request_command" != "$MONITOR_SAMPLE_REQUEST" ||
    "$request_index" != "$MONITOR_RUNNER_NEXT_SAMPLE_INDEX" ||
    ! "$request_index" =~ ^(0|[1-9][0-9]*)$ ||
    -n "$extra" ]]; then
    echo "Monitor runner sent an invalid or out-of-order sample request." >&2
    return 3
  fi
  assert_remote_monitor_lock || return 3
  if ! printf '%s %s\n' "$MONITOR_SAMPLE_PERMIT" "$request_index" \
    >&"$MONITOR_RUNNER_PERMIT_FD"; then
    echo "Could not grant the monitor runner sample permit." >&2
    return 3
  fi
  MONITOR_RUNNER_NEXT_SAMPLE_INDEX=$((MONITOR_RUNNER_NEXT_SAMPLE_INDEX + 1))
}

stream_monitor_runner() {
  local line
  local status=0

  while true; do
    service_monitor_runner_request || return 3
    maintain_remote_monitor_lock || return 3
    if IFS= read -r -t 0.5 line <&"$MONITOR_RUNNER_READ_FD"; then
      printf '%s\n' "$line"
      printf '%s\n' "$line" >&"$MONITOR_LOG_FD"
      continue
    fi
    if monitor_process_identity_is_alive "$MONITOR_RUNNER_PID" "$MONITOR_RUNNER_PID_STARTTIME" ||
      monitor_owned_session_is_alive \
        "$MONITOR_RUNNER_SESSION" \
        "$MONITOR_RUNNER_SESSION_STARTTIME"; then
      continue
    fi
    break
  done
  finish_monitor_runner || status=$?
  return "$status"
}

cleanup_monitor_wrapper() {
  trap - EXIT
  stop_monitor_runner
  release_remote_monitor_lock
  if [[ "$MONITOR_LOG_FD" =~ ^[0-9]+$ ]]; then
    exec {MONITOR_LOG_FD}>&- 2>/dev/null || true
    MONITOR_LOG_FD=''
  fi
  cleanup_monitor_supervision
}

handle_monitor_signal() {
  local status="$1"
  trap - HUP INT TERM
  cleanup_monitor_wrapper
  exit "$status"
}

run_step() {
  local label="$1"
  local status
  shift

  echo "--- $label ---"
  set +e
  "$@"
  status=$?
  set -e
  if ((status != 0)); then
    echo "WARN: $label failed with exit code $status"
  fi
}

scan_service_logs() {
  local cursor_sec
  local lookback_sec
  local output
  local service_args
  local status
  local remote_command
  local since_at
  local since_epoch_sec

  if ((LAST_SERVICE_LOG_SCAN_AT_SEC > 0)); then
    since_epoch_sec=$((LAST_SERVICE_LOG_SCAN_AT_SEC - 5))
  else
    since_epoch_sec=$(($(date +%s) - INTERVAL_SEC))
  fi
  if ((since_epoch_sec < 0)); then since_epoch_sec=0; fi
  since_at=$(date -u -d "@$since_epoch_sec" '+%Y-%m-%dT%H:%M:%SZ')

  printf -v service_args '%q ' "${LOG_SERVICES[@]}"
  remote_command=$(cat <<REMOTE
scan_cursor_sec=\$(date +%s)
echo "monitor_service_log_cursor_sec=\$scan_cursor_sec"
services=($service_args)
failed=0
for service in "\${services[@]}"; do
  echo "-- \${service} --"
  if ! logs=\$(docker compose --env-file .env -p infra -f infra/docker-compose.yml \
    logs --since "$since_at" --tail "$LOG_REQUEST_LINES" "\$service" 2>/dev/null); then
    echo "WARN: could not read logs for \$service"
    failed=1
    continue
  fi
  raw_line_count=0
  if [[ -n "\$logs" ]]; then
    raw_line_count=\$(printf '%s\n' "\$logs" | wc -l | tr -d '[:space:]')
  fi
  if ((raw_line_count > $TAIL_LINES)); then
    echo "WARN: log scan saturated=true service=\$service raw_lines=\$raw_line_count limit=$TAIL_LINES"
  fi
  printf '%s\n' "\$logs" |
    grep -Eav '${SUCCESSFUL_ACCESS_LOG_PATTERN}' |
    grep -Eai '"level":(40|50)|"statusCode":(4[0-9][0-9]|5[0-9][0-9])|(^|[^[:alnum:]_])(error|warn|exception|failed|stalled|rate limit|ECONN|ETIMEDOUT|BullMQ|Redis)([^[:alnum:]_]|$)' |
    sed -E \
      -e "s#(https?://[^\"[:space:]]*)\\?[^\"[:space:]#]*#\\1?[redacted]#g" \
      -e "s#((^|[[:space:]\":=])/(app|api)/[^\"[:space:]]*)\\?[^\"[:space:]#]*#\\1?[redacted]#g" |
    tail -40 || true
done
exit "\$failed"
REMOTE
)

  if output="$(./infra/scripts/vps-connect.sh exec "$remote_command")"; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$output"
  if ((status != 0)); then
    return "$status"
  fi
  cursor_sec="$(printf '%s\n' "$output" |
    sed -n 's/^monitor_service_log_cursor_sec=\([0-9][0-9]*\)$/\1/p' | head -1)"
  [[ "$cursor_sec" =~ ^[0-9]+$ ]] || return 1
  LAST_SERVICE_LOG_SCAN_AT_SEC="$cursor_sec"
  lookback_sec=$((cursor_sec - since_epoch_sec))
  echo "service_log_since=$since_at lookback_sec=$lookback_sec"
}

summarize_static_services() {
  local cursor_sec
  local lookback_sec
  local output
  local service_args
  local status
  local remote_command
  local since_at
  local since_epoch_sec

  if ((LAST_STATIC_LOG_SCAN_AT_SEC > 0)); then
    since_epoch_sec=$((LAST_STATIC_LOG_SCAN_AT_SEC - 5))
  else
    since_epoch_sec=$(($(date +%s) - INTERVAL_SEC))
  fi
  if ((since_epoch_sec < 0)); then since_epoch_sec=0; fi
  since_at=$(date -u -d "@$since_epoch_sec" '+%Y-%m-%dT%H:%M:%SZ')

  printf -v service_args '%q ' "${STATIC_SERVICES[@]}"
  remote_command=$(cat <<REMOTE
scan_cursor_sec=\$(date +%s)
echo "monitor_static_log_cursor_sec=\$scan_cursor_sec"
services=($service_args)
failed=0
for service in "\${services[@]}"; do
  echo "-- \${service} --"
  docker compose --env-file .env -p infra -f infra/docker-compose.yml ps "\$service" || true
  ids=\$(docker compose --env-file .env -p infra -f infra/docker-compose.yml ps -q "\$service" 2>/dev/null || true)
  if [[ -z "\$ids" ]]; then
    echo "WARN: no container found for \$service"
    failed=1
    continue
  fi

  if ! docker inspect --format '{{.Name}}\trestarts={{.RestartCount}}\tstatus={{.State.Status}}\tstarted={{.State.StartedAt}}{{if .State.Health}}\thealth={{.State.Health.Status}}{{else}}\thealth=none{{end}}' \$ids; then
    echo "WARN: could not inspect \$service"
    failed=1
    continue
  fi
  if ! logs=\$(docker compose --env-file .env -p infra -f infra/docker-compose.yml \
    logs --since "$since_at" --tail "$LOG_REQUEST_LINES" "\$service" 2>/dev/null); then
    echo "WARN: could not read logs for \$service"
    failed=1
    continue
  fi
  raw_line_count=0
  if [[ -n "\$logs" ]]; then
    raw_line_count=\$(printf '%s\n' "\$logs" | wc -l | tr -d '[:space:]')
  fi
  if ((raw_line_count > $TAIL_LINES)); then
    echo "WARN: log scan saturated=true service=\$service raw_lines=\$raw_line_count limit=$TAIL_LINES"
  fi
  printf '%s\n' "\$logs" |
    grep -Eav '${SUCCESSFUL_ACCESS_LOG_PATTERN}' |
    grep -Eai '(^|[^[:alnum:]_])(error|warn|exception|failed|502|503|504|upstream|permission|denied)([^[:alnum:]_]|$)' |
    sed -E \
      -e "s#(https?://[^\"[:space:]]*)\\?[^\"[:space:]#]*#\\1?[redacted]#g" \
      -e "s#((^|[[:space:]\":=])/(app|api)/[^\"[:space:]]*)\\?[^\"[:space:]#]*#\\1?[redacted]#g" |
    tail -40 || true
done
exit "\$failed"
REMOTE
)

  if output="$(./infra/scripts/vps-connect.sh exec "$remote_command")"; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$output"
  if ((status != 0)); then
    return "$status"
  fi
  cursor_sec="$(printf '%s\n' "$output" |
    sed -n 's/^monitor_static_log_cursor_sec=\([0-9][0-9]*\)$/\1/p' | head -1)"
  [[ "$cursor_sec" =~ ^[0-9]+$ ]] || return 1
  LAST_STATIC_LOG_SCAN_AT_SEC="$cursor_sec"
  lookback_sec=$((cursor_sec - since_epoch_sec))
  echo "static_log_since=$since_at lookback_sec=$lookback_sec"
}

summarize_public_app_assets() {
  local html
  local asset_lines
  local kind
  local url

  html="$(curl -fsSL --max-time 15 "$PUBLIC_URL/app/")"
  asset_lines="$(
    APP_HTML="$html" PUBLIC_URL="$PUBLIC_URL" node <<'NODE'
const html = process.env.APP_HTML ?? '';
const publicUrl = (process.env.PUBLIC_URL ?? 'https://major-maksimov.ru').replace(/\/+$/, '');
const base = new URL('/app/', `${publicUrl}/`);

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return match?.[2] ?? '';
}

function absolute(value) {
  if (!value) {
    return '';
  }
  try {
    return new URL(value, base).toString();
  } catch {
    return '';
  }
}

const firstJs = (html.match(/<script\b[^>]*>/gi) ?? [])
  .map((tag) => absolute(attr(tag, 'src')))
  .find(Boolean);
const firstCss = (html.match(/<link\b[^>]*>/gi) ?? [])
  .map((tag) => ({ href: absolute(attr(tag, 'href')), rel: attr(tag, 'rel') }))
  .find((link) => link.href && /\bstylesheet\b/i.test(link.rel))?.href;

if (firstJs) {
  console.log(`js\t${firstJs}`);
} else {
  console.log('WARN\tmissing first JS asset in /app/ HTML');
}
if (firstCss) {
  console.log(`css\t${firstCss}`);
} else {
  console.log('WARN\tmissing first CSS asset in /app/ HTML');
}
NODE
  )"

  while IFS=$'\t' read -r kind url; do
    [[ -n "$kind" ]] || continue
    if [[ "$kind" == "WARN" ]]; then
      echo "WARN: $url"
      continue
    fi

    curl -fsSIL --max-time 15 -o /dev/null \
      -w "$kind %{http_code} %{content_type} %{url_effective}\n" \
      "$url"
  done <<<"$asset_lines"
}

summarize_public_access_guards() {
  local failed=0
  local path
  local status
  local url

  for path in /api/v1/safety-desk /api/v1/support-requests; do
    url="$PUBLIC_URL$path"
    status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$url" 2>/dev/null || true)"
    status="${status:-000}"
    echo "public $path status=$status"
    case "$status" in
      401|403|404)
        ;;
      *)
        echo "WARN: public $path is not denied"
        failed=1
        ;;
    esac
  done

  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$ADMIN_PUBLIC_URL/" 2>/dev/null || true)"
  status="${status:-000}"
  echo "admin unauth / status=$status"
  if [[ "$status" != "401" ]]; then
    echo "WARN: admin root without credentials should return 401"
    failed=1
  fi

  return "$failed"
}

summarize_local_ready_health() {
  ./infra/scripts/vps-connect.sh exec 'node -' \
    < "$ROOT_DIR/infra/scripts/monitor-ready-status.cjs"
}

summarize_publisher_runtime() {
  local remote_command

  remote_command=$(cat <<'REMOTE'
set -o pipefail
compose=(docker compose --env-file .env -p infra -f infra/docker-compose.yml)
read_expected() {
  local service="$1"
  "${compose[@]}" exec -T "$service" node -e '
  const value = process.env.MAX_PUBLISHER_DISPATCH_ENABLED ?? "false";
  if (value !== "true" && value !== "false") process.exit(2);
  process.stdout.write(value);
'
}
read_bot_id() {
  local service="$1"
  "${compose[@]}" exec -T "$service" node -e '
  const value = (process.env.MAX_PUBLISHER_BOT_ID ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/.test(value)) process.exit(2);
  process.stdout.write(value);
'
}
admin_expected="$(read_expected api-admin)" || exit 1
publisher_expected="$(read_expected api-publisher)" || exit 1
admin_bot_id="$(read_bot_id api-admin)" || exit 1
publisher_bot_id="$(read_bot_id api-publisher)" || exit 1
bot_id_parity=false
if [[ -n "$admin_bot_id" && "$admin_bot_id" == "$publisher_bot_id" ]]; then
  bot_id_parity=true
fi
control="$("${compose[@]}" exec -T api-admin node - status \
  < infra/scripts/publisher-dispatch-rollout-control.cjs)" || exit 1
printf '%s' "$control" |
  node infra/scripts/monitor-publisher-status.cjs \
    "$admin_expected" "$publisher_expected" "$bot_id_parity"
REMOTE
)

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

summarize_media_analysis_ready() {
  local remote_command
  local service_quoted

  printf -v service_quoted '%q' "$MAXIM_MEDIA_ANALYSIS_SERVICE"
  remote_command=$(cat <<REMOTE
docker compose --env-file .env -p infra -f infra/docker-compose.yml exec -T \
  $service_quoted node - < infra/scripts/monitor-media-ready.cjs
REMOTE
)

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

summarize_real_chat_signals() {
  ./infra/scripts/vps-connect.sh exec \
    ./infra/scripts/vps-postgres-audit.sh monitor-signals "$SIGNAL_WINDOW_MIN"
}

summarize_bullmq_state() {
  local cursor_ms
  local output
  local probe_env
  local remote_command
  local status

  remote_command=$(cat <<'REMOTE'
queues=(
  moderation
  moderation-critical
  moderation-join-0
  moderation-join-1
  moderation-join-2
  moderation-join-3
  moderation-default-0
  moderation-default-1
  moderation-default-2
  moderation-default-3
  moderation-default-4
  moderation-default-5
  moderation-default-6
  moderation-default-7
  moderation-default-8
  moderation-default-9
  moderation-default-10
  moderation-default-11
  moderation-default-12
  moderation-default-13
  moderation-default-14
  moderation-default-15
  moderation-background
  moderation-actions
  max-actions-critical
  max-actions-interactive
  max-actions-background
  night-mode-transitions
  moderation-delete-intents
  global-spammer-denorm
  photo-duplicates
  commercial-image-ocr
  admin-managed-entities-refresh
  max-chat-admin-roster-sync
  admin-suggestion-delivery
  admin-manual-fanout
  admin-super-ban
  publisher-binding-refresh
  publisher-chat-comments
  publisher-auto-replies
  publisher-auto-reply-authoring
  publisher-post-import
  publisher-suggestion-publication
  vk-parsing-sync
  vk-parsing-publish
  vk-parsing-publisher
)
docker compose --env-file .env -p infra -f infra/docker-compose.yml exec -T redis sh -lc '
minimum_failed_fresh_window_sec="$1"
previous_probe_at_ms="$2"
shift 2
queue_counts_script="
local redisTime = redis.call(\"TIME\")
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local failedFreshWindowSec = tonumber(ARGV[1])
local previousProbeAtMs = tonumber(ARGV[2])
if previousProbeAtMs and previousProbeAtMs > 0 and nowMs >= previousProbeAtMs then
  local elapsedWindowSec = math.ceil((nowMs - previousProbeAtMs) / 1000) + 5
  failedFreshWindowSec = math.max(failedFreshWindowSec, elapsedWindowSec)
end
local failedFreshCutoffMs = nowMs - failedFreshWindowSec * 1000
local dueScore = nowMs * 4096 + 4095
local function listCountWithoutMarker(key)
  local count = redis.call(\"LLEN\", key)
  local marker = redis.call(\"LINDEX\", key, -1)
  if marker and string.sub(marker, 1, 2) == \"0:\" then
    return math.max(0, count - 1)
  end
  return count
end
local waiting = listCountWithoutMarker(KEYS[1]) + listCountWithoutMarker(KEYS[2])
local prioritized = redis.call(\"ZCARD\", KEYS[3])
local active = redis.call(\"LLEN\", KEYS[4])
local failed = redis.call(\"ZCARD\", KEYS[5])
local failedFresh = redis.call(\"ZCOUNT\", KEYS[5], failedFreshCutoffMs, nowMs)
local failedFuture = redis.call(\"ZCOUNT\", KEYS[5], \"(\" .. tostring(nowMs), \"+inf\")
local newestFailed = redis.call(\"ZREVRANGE\", KEYS[5], 0, 0, \"WITHSCORES\")
local failedNewestAgeSec = -1
if newestFailed[2] then
  local newestFailedAtMs = tonumber(newestFailed[2])
  if newestFailedAtMs and nowMs then
    failedNewestAgeSec = math.max(0, math.floor((nowMs - newestFailedAtMs) / 1000))
  end
end
local delayed = redis.call(\"ZCARD\", KEYS[6])
local dueNow = redis.call(\"ZCOUNT\", KEYS[6], \"-inf\", dueScore)
return string.format(
  \"observedAtMs=%d\\nwait=%d\\nprioritized=%d\\nactive=%d\\nfailedTotal=%d\\nfailedFresh=%d\\nfailedFreshWindowSec=%d\\nfailedFuture=%d\\nfailedNewestAgeSec=%d\\ndelayed=%d\\ndueNow=%d\",
  nowMs,
  waiting,
  prioritized,
  active,
  failed,
  failedFresh,
  failedFreshWindowSec,
  failedFuture,
  failedNewestAgeSec,
  delayed,
  dueNow
)
"
validate_counts() {
  awk -F= '\''
    BEGIN {
      expected["observedAtMs"] = 1
      expected["wait"] = 1
      expected["prioritized"] = 1
      expected["active"] = 1
      expected["failedTotal"] = 1
      expected["failedFresh"] = 1
      expected["failedFreshWindowSec"] = 1
      expected["failedFuture"] = 1
      expected["failedNewestAgeSec"] = 1
      expected["delayed"] = 1
      expected["dueNow"] = 1
    }
    NF != 2 || !($1 in expected) || seen[$1] { exit 1 }
    $1 == "failedNewestAgeSec" {
      if ($2 !~ /^-?[0-9]+$/) exit 1
      seen[$1] = 1
      next
    }
    $2 !~ /^[0-9]+$/ { exit 1 }
    { seen[$1] = 1 }
    END {
      if (NR != 11) exit 1
      for (key in expected) if (!(key in seen)) exit 1
    }
  '\''
}
failed=0
probe_cursor_ms=""
for q in "$@"; do
  if ! counts="$(redis-cli --raw eval "$queue_counts_script" 6 \
    "bull:$q:wait" \
    "bull:$q:paused" \
    "bull:$q:prioritized" \
    "bull:$q:active" \
    "bull:$q:failed" \
    "bull:$q:delayed" \
    "$minimum_failed_fresh_window_sec" \
    "$previous_probe_at_ms" 2>/dev/null)"; then
    printf "%s counts=unavailable\n" "$q"
    failed=1
    continue
  fi
  if ! printf "%s\n" "$counts" | validate_counts; then
    printf "%s counts=unavailable\n" "$q"
    failed=1
    continue
  fi
  observed_at_ms="$(printf "%s\n" "$counts" | sed -n "s/^observedAtMs=//p")"
  if [ -z "$probe_cursor_ms" ]; then probe_cursor_ms="$observed_at_ms"; fi
  while IFS= read -r count; do
    case "$count" in observedAtMs=*) continue ;; esac
    printf "%s %s\n" "$q" "$count"
  done <<EOF
$counts
EOF
done
if [ "$failed" -ne 0 ] || [ -z "$probe_cursor_ms" ]; then exit 1; fi
printf "monitor_bullmq_cursor_ms=%s\n" "$probe_cursor_ms"
' sh "$minimum_failed_fresh_window_sec" "$previous_probe_at_ms" "${queues[@]}"
REMOTE
)
  printf -v probe_env \
    'minimum_failed_fresh_window_sec=%q\nprevious_probe_at_ms=%q\n' \
    "$FAILED_FRESH_WINDOW_SEC" "$LAST_BULLMQ_PROBE_AT_MS"
  remote_command="$probe_env$remote_command"

  if output="$(./infra/scripts/vps-connect.sh exec "$remote_command")"; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$output"
  if ((status != 0)); then
    return "$status"
  fi
  cursor_ms="$(printf '%s\n' "$output" |
    sed -n 's/^monitor_bullmq_cursor_ms=\([0-9][0-9]*\)$/\1/p' | head -1)"
  [[ "$cursor_ms" =~ ^[0-9]+$ ]] || return 1
  LAST_BULLMQ_PROBE_AT_MS="$cursor_ms"
}

summarize_redis_runtime() {
  local remote_command

  remote_command=$(cat <<'REMOTE'
set -o pipefail
docker compose --env-file .env -p infra -f infra/docker-compose.yml exec -T redis \
  redis-cli --raw INFO all |
  node infra/scripts/monitor-redis-info.cjs
REMOTE
)

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

summarize_runtime_pressure() {
  local disk_capacity_env
  local remote_command

  printf -v disk_capacity_env 'MAXIM_API_BUILD_HARD_MIN_FREE_BYTES=%q\n' \
    "$MAXIM_API_BUILD_HARD_MIN_FREE_BYTES"
  remote_command=$(cat <<'REMOTE'
echo "uptime"
uptime || true
echo "memory"
free -m || true
echo "disk"
df -h / /var/lib/docker 2>/dev/null || df -h / || true
disk_path="/var/lib/docker"
if [[ ! -d "$disk_path" ]]; then
  disk_path="/"
fi
deploy_disk_hard_minimum_free_bytes="$MAXIM_API_BUILD_HARD_MIN_FREE_BYTES"
disk_stats="$(df -P -B1 "$disk_path" 2>/dev/null | awk 'NR == 2 { gsub(/%/, "", $5); print $4, $5 }')"
read -r disk_available_bytes disk_used_percent <<< "$disk_stats"
if [[ "$disk_available_bytes" =~ ^[0-9]+$ && "$disk_used_percent" =~ ^[0-9]+$ ]]; then
  if (( disk_available_bytes < deploy_disk_hard_minimum_free_bytes )); then
    printf "API_BUILD_DISK_BLOCKED path=%s available=%sB minimum-free=%sB\n" \
      "$disk_path" "$disk_available_bytes" "$deploy_disk_hard_minimum_free_bytes"
  fi
  if (( disk_used_percent >= 90 )); then
    printf "DISK_CRITICAL path=%s used=%s%% threshold=90%%\n" "$disk_path" "$disk_used_percent"
  elif (( disk_used_percent >= 80 )); then
    printf "DISK_WARNING path=%s used=%s%% threshold=80%%\n" "$disk_path" "$disk_used_percent"
  else
    printf "DISK_OK path=%s used=%s%% warning=80%% critical=90%%\n" "$disk_path" "$disk_used_percent"
  fi
else
  printf "DISK_UNKNOWN path=%s reason=invalid-df-output\n" "$disk_path"
fi
echo "docker_stats"
docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.BlockIO}}' 2>/dev/null |
  grep -E '^infra-(api|postgres|redis|miniapp|admin)' |
  sort || true
if command -v iostat >/dev/null 2>&1; then
  echo "iostat"
  iostat -x 1 2 | tail -40 || true
fi
REMOTE
)
  remote_command="$disk_capacity_env$remote_command"

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

summarize_log_signal_counts() {
  local service_args
  local remote_command

  printf -v service_args '%q ' "${LOG_SERVICES[@]}"
  remote_command=$(cat <<REMOTE
services=($service_args)
printf "service\\tlevel40_50\\trate_limit\\tskipped_perm\\taccess_loss\\tstatus403\\ttimeout\\tgovernor\\tslow\\tledger\\tpg_warn\\tsaturated\\traw_lines\\n"
failed=0
for service in "\${services[@]}"; do
  if ! logs=\$(docker compose --env-file .env -p infra -f infra/docker-compose.yml \
    logs --since "${SIGNAL_WINDOW_MIN}m" --tail "$LOG_REQUEST_LINES" "\$service" 2>/dev/null); then
    echo "WARN: could not read signal-count logs for \$service"
    failed=1
    continue
  fi
  raw_line_count=0
  if [[ -n "\$logs" ]]; then
    raw_line_count=\$(printf '%s\\n' "\$logs" | wc -l | tr -d '[:space:]')
  fi
  saturated=false
  if ((raw_line_count > $TAIL_LINES)); then
    saturated=true
    echo "WARN: log signal counts saturated=true service=\$service raw_lines=\$raw_line_count limit=$TAIL_LINES"
  fi
  count() { printf "%s" "\$logs" | grep -Eci "\$1" || true; }
  printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" \\
    "\$service" \\
    "\$(count '"level":(40|50)')" \\
    "\$(count 'rate[ _-]?limit|internal limiter|"statusCode":429|HTTP( status)? 429')" \\
    "\$(count 'no active bot has the required MAX permissions|Skipped moderation action')" \\
    "\$(count 'ManagedEntityAccessLossService|chat_not_found|chat.denied|BOT_DENIED|access loss')" \\
    "\$(count 'status code 403|"statusCode":403')" \\
    "\$(count 'ETIMEDOUT|timeout|timed out|ECONN')" \\
    "\$(count 'BackgroundRuntimeGovernor|governor|pause|slow path')" \\
    "\$(count 'slow|Slow')" \\
    "\$(count 'Failed to record successful MAX action ledger outcome|delivery-ledger-risk|ambiguous MAX')" \\
    "\$(count 'client.query\\(\\) on a client that has already been checked out')" \\
    "\$saturated" \\
    "\$raw_line_count"
done
exit "\$failed"
REMOTE
)

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

sample_once() {
  local sample_index="$1"

  echo "===== sample $sample_index $(date -Is) ====="
  run_step health ./infra/scripts/vps-connect.sh health
  run_step semantic-health summarize_local_ready_health
  run_step publisher-runtime summarize_publisher_runtime
  run_step media-analysis-ready summarize_media_analysis_ready
  run_step real-chat-signals summarize_real_chat_signals
  run_step bullmq-state summarize_bullmq_state
  run_step redis-runtime summarize_redis_runtime
  run_step runtime-pressure summarize_runtime_pressure
  run_step ps ./infra/scripts/vps-connect.sh ps
  run_step static-services summarize_static_services
  # Command substitutions and $ids are intentionally evaluated by the remote shell.
  # shellcheck disable=SC2016
  run_step restart-counts ./infra/scripts/vps-connect.sh exec \
    'ids=$(docker ps -q --filter label=com.docker.compose.project=infra); docker inspect --format "{{.Name}}\t{{.RestartCount}}\t{{.State.Status}}\t{{.State.StartedAt}}" $ids'
  run_step log-signal-counts summarize_log_signal_counts
  run_step log-scan scan_service_logs
  run_step public-app curl -fsS --max-time 15 -o /dev/null -w 'app %{http_code} %{time_total}\n' \
    "$PUBLIC_URL/app/"
  run_step public-app-assets summarize_public_app_assets
  run_step public-access-guards summarize_public_access_guards
}

run_monitor() {
  local end_at
  local sample_index=0

  end_at=$(($(date +%s) + DURATION_SEC))
  echo "Readonly VPS monitor started at $(date -Is)"
  echo "duration_sec=$DURATION_SEC interval_sec=$INTERVAL_SEC log_tail_lines=$TAIL_LINES"
  echo "signal_window_min=$SIGNAL_WINDOW_MIN"
  echo "log_file=$LOG_FILE"

  while true; do
    request_monitor_sample_permit "$sample_index"
    sample_once "$sample_index"
    sample_index=$((sample_index + 1))

    local now
    local sleep_for
    now=$(date +%s)
    sleep_for=$((end_at - now))
    if ((sleep_for <= 0)); then
      break
    fi
    if ((sleep_for > INTERVAL_SEC)); then
      sleep_for=$INTERVAL_SEC
    fi
    sleep "$sleep_for"
  done

  echo "Readonly VPS monitor finished at $(date -Is)"
}

if ((MONITOR_CHILD_MODE == 1)); then
  initialize_monitor_child_control
  run_monitor
  exit $?
fi

trap cleanup_monitor_wrapper EXIT
trap 'handle_monitor_signal 129' HUP
trap 'handle_monitor_signal 130' INT
trap 'handle_monitor_signal 143' TERM

acquire_remote_monitor_lock
mkdir -p "$(dirname "$LOG_FILE")"
: >"$LOG_FILE"
exec {MONITOR_LOG_FD}>>"$LOG_FILE"
start_monitor_runner
monitor_status=0
stream_monitor_runner || monitor_status=$?
exit "$monitor_status"
