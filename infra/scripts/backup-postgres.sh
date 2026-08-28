#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_DIR="${MAXIM_BACKUP_DIR:-$ROOT_DIR/infra/data/backups}"
RETENTION_DAYS="${MAXIM_BACKUP_RETENTION_DAYS:-14}"
COMPOSE_FILE="${MAXIM_BACKUP_COMPOSE_FILE:-$ROOT_DIR/infra/docker-compose.yml}"
MIN_FREE_BYTES="${MAXIM_BACKUP_MIN_FREE_BYTES:-2147483648}"
REQUIRE_DEDICATED_FILESYSTEM="${MAXIM_BACKUP_REQUIRE_DEDICATED_FILESYSTEM:-1}"
RATE_LIMIT_BYTES_PER_SEC="${MAXIM_BACKUP_RATE_LIMIT_BYTES_PER_SEC:-1048576}"
MAX_DURATION_SEC="${MAXIM_BACKUP_MAX_DURATION_SEC:-43200}"
READINESS_URL="${MAXIM_BACKUP_READINESS_URL:-http://127.0.0.1:3001/api/health/ready}"
READINESS_TIMEOUT_SEC="${MAXIM_BACKUP_READINESS_TIMEOUT_SEC:-10}"
WATCHDOG_INTERVAL_SEC="${MAXIM_BACKUP_WATCHDOG_INTERVAL_SEC:-30}"
WATCHDOG_FAILURE_THRESHOLD="${MAXIM_BACKUP_WATCHDOG_FAILURE_THRESHOLD:-2}"
LOCK_FILE="${MAXIM_BACKUP_LOCK_FILE:-$BACKUP_DIR/.maxim-postgres-backup.lock}"
RATE_LIMITER="$ROOT_DIR/infra/scripts/rate-limit-stream.mjs"
MODE="${1:-}"

validate_non_negative_integer() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "$name must be a non-negative integer." >&2
    exit 2
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required for PostgreSQL backups." >&2
    exit 1
  fi
}

validate_non_negative_integer MAXIM_BACKUP_RETENTION_DAYS "$RETENTION_DAYS"
validate_non_negative_integer MAXIM_BACKUP_MIN_FREE_BYTES "$MIN_FREE_BYTES"
validate_non_negative_integer MAXIM_BACKUP_RATE_LIMIT_BYTES_PER_SEC "$RATE_LIMIT_BYTES_PER_SEC"
validate_non_negative_integer MAXIM_BACKUP_MAX_DURATION_SEC "$MAX_DURATION_SEC"
validate_non_negative_integer MAXIM_BACKUP_READINESS_TIMEOUT_SEC "$READINESS_TIMEOUT_SEC"
validate_non_negative_integer MAXIM_BACKUP_WATCHDOG_INTERVAL_SEC "$WATCHDOG_INTERVAL_SEC"
validate_non_negative_integer MAXIM_BACKUP_WATCHDOG_FAILURE_THRESHOLD "$WATCHDOG_FAILURE_THRESHOLD"
if ((RATE_LIMIT_BYTES_PER_SEC < 1 || RATE_LIMIT_BYTES_PER_SEC > 1073741824)); then
  echo "MAXIM_BACKUP_RATE_LIMIT_BYTES_PER_SEC must be between 1 and 1073741824." >&2
  exit 2
fi
if ((MAX_DURATION_SEC < 1 || MAX_DURATION_SEC > 43200)); then
  echo "MAXIM_BACKUP_MAX_DURATION_SEC must be between 1 and 43200." >&2
  exit 2
fi
if ((READINESS_TIMEOUT_SEC < 1 || READINESS_TIMEOUT_SEC > 60)); then
  echo "MAXIM_BACKUP_READINESS_TIMEOUT_SEC must be between 1 and 60." >&2
  exit 2
fi
if ((WATCHDOG_INTERVAL_SEC < 1 || WATCHDOG_INTERVAL_SEC > 3600)); then
  echo "MAXIM_BACKUP_WATCHDOG_INTERVAL_SEC must be between 1 and 3600." >&2
  exit 2
fi
if ((WATCHDOG_FAILURE_THRESHOLD < 1 || WATCHDOG_FAILURE_THRESHOLD > 10)); then
  echo "MAXIM_BACKUP_WATCHDOG_FAILURE_THRESHOLD must be between 1 and 10." >&2
  exit 2
fi
if [[ "$REQUIRE_DEDICATED_FILESYSTEM" != "0" && "$REQUIRE_DEDICATED_FILESYSTEM" != "1" ]]; then
  echo "MAXIM_BACKUP_REQUIRE_DEDICATED_FILESYSTEM must be 0 or 1." >&2
  exit 2
fi
if [[ -z "$LOCK_FILE" ]]; then
  echo "MAXIM_BACKUP_LOCK_FILE must not be empty." >&2
  exit 2
fi
if [[ -n "$MODE" && "$MODE" != "--preflight-only" ]]; then
  echo "Usage: $0 [--preflight-only]" >&2
  exit 2
fi

for required_command in curl docker flock node; do
  require_command "$required_command"
done
if [[ "$MODE" != "--preflight-only" ]]; then
  require_command timeout
  if [[ ! -r "$RATE_LIMITER" ]]; then
    echo "PostgreSQL backup stream rate limiter is missing." >&2
    exit 1
  fi
fi

mkdir -p "$BACKUP_DIR"
exec {BACKUP_LOCK_FD}>>"$LOCK_FILE"
if ! flock -n "$BACKUP_LOCK_FD"; then
  echo "Another PostgreSQL backup is already running." >&2
  exit 75
fi

probe_runtime_ready() {
  local readiness_json
  if ! readiness_json="$(curl -fsS --max-time "$READINESS_TIMEOUT_SEC" "$READINESS_URL")"; then
    return 1
  fi
  if ! node -e '
    const fs = require("node:fs");
    let snapshot;
    try {
      snapshot = JSON.parse(fs.readFileSync(0, "utf8"));
    } catch {
      process.exit(1);
    }
    const queueLag = snapshot?.checks?.queueLag;
    if (
      snapshot?.ok !== true ||
      snapshot?.checks?.database !== true ||
      snapshot?.checks?.redis !== true ||
      queueLag?.rawOk !== true ||
      queueLag?.softWarning === true
    ) {
      process.exit(1);
    }
  ' <<<"$readiness_json"; then
    return 1
  fi
}

if ! probe_runtime_ready; then
  echo "Refusing PostgreSQL backup while readiness or raw queue lag is degraded." >&2
  exit 75
fi

if [[ "$REQUIRE_DEDICATED_FILESYSTEM" == "1" ]] && \
  [[ "$(stat -c %d "$BACKUP_DIR")" == "$(stat -c %d "$ROOT_DIR")" ]]; then
  echo "Refusing to store a PostgreSQL backup on the production application filesystem." >&2
  echo "Mount a separate persistent volume at MAXIM_BACKUP_DIR before retrying." >&2
  exit 1
fi

# Remove expired generations before the capacity check, but preserve the newest completed
# dump/checksum pair until a later run has successfully published its replacement.
LATEST_COMPLETED_DUMP=""
shopt -s nullglob
for completed_dump in "$BACKUP_DIR"/maxim_*.dump; do
  if [[ -f "$completed_dump.sha256" ]]; then
    LATEST_COMPLETED_DUMP="$completed_dump"
  fi
done
shopt -u nullglob

if [[ "$MODE" != "--preflight-only" ]]; then
  while IFS= read -r -d '' expired_dump; do
    if [[ "$expired_dump" == "$LATEST_COMPLETED_DUMP" ]]; then
      continue
    fi
    rm -f -- "$expired_dump" "$expired_dump.sha256"
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'maxim_*.dump' -mtime "+$RETENTION_DAYS" -print0)
  while IFS= read -r -d '' expired_checksum; do
    if [[ "$expired_checksum" == "$LATEST_COMPLETED_DUMP.sha256" ]]; then
      continue
    fi
    rm -f -- "$expired_checksum"
  done < <(
    find "$BACKUP_DIR" -maxdepth 1 -type f -name 'maxim_*.dump.sha256' \
      -mtime "+$RETENTION_DAYS" -print0
  )
fi

DATABASE_BYTES="$(
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U maxim -d maxim -Atqc 'SELECT pg_database_size(current_database())'
)"
DATABASE_BYTES="${DATABASE_BYTES//[[:space:]]/}"
AVAILABLE_BYTES="$(df -PB1 "$BACKUP_DIR" | awk 'NR == 2 { print $4 }')"
if [[ ! "$DATABASE_BYTES" =~ ^[0-9]+$ || ! "$AVAILABLE_BYTES" =~ ^[0-9]+$ ]]; then
  echo "Could not determine PostgreSQL size or backup filesystem capacity." >&2
  exit 1
fi

# A custom dump omits physical index pages, but reserving the full database size keeps
# incompressible data from filling the production filesystem mid-stream.
REQUIRED_BYTES=$((DATABASE_BYTES + MIN_FREE_BYTES))
if ((AVAILABLE_BYTES < REQUIRED_BYTES)); then
  echo "Insufficient free space for a fail-safe PostgreSQL backup." >&2
  echo "Available bytes: $AVAILABLE_BYTES; required bytes: $REQUIRED_BYTES." >&2
  echo "Configure MAXIM_BACKUP_DIR on a separate persistent volume before retrying." >&2
  exit 1
fi

if [[ "$MODE" == "--preflight-only" ]]; then
  echo "PostgreSQL backup readiness and capacity preflight passed."
  exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PG_APP_NAME="maxim-postgres-backup-${STAMP}-${BASHPID}"
TARGET="$BACKUP_DIR/maxim_${STAMP}.dump"
CHECKSUM_TARGET="$TARGET.sha256"
if [[ -e "$TARGET" || -e "$CHECKSUM_TARGET" ]]; then
  echo "Refusing to overwrite an existing PostgreSQL backup generation." >&2
  exit 1
fi
TEMP_DUMP="$(mktemp "$BACKUP_DIR/.maxim_${STAMP}.XXXXXX.dump.tmp")"
TEMP_CHECKSUM="$(mktemp "$BACKUP_DIR/.maxim_${STAMP}.XXXXXX.sha256.tmp")"
TEMP_PIPE="$(mktemp "$BACKUP_DIR/.maxim_${STAMP}.XXXXXX.pipe.tmp")"
WATCHDOG_ABORT_MARKER="$(mktemp "$BACKUP_DIR/.maxim_${STAMP}.XXXXXX.watchdog.tmp")"
rm -f -- "$TEMP_PIPE"
mkfifo -m 600 "$TEMP_PIPE"
DUMP_STARTED=0
PUBLISH_STARTED=0
DUMP_PROCESS_PID=""
LIMITER_PROCESS_PID=""
WATCHDOG_PROCESS_PID=""

cleanup_backend() {
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U maxim -d maxim -Atqc \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '$PG_APP_NAME' AND pid <> pg_backend_pid()" \
    >/dev/null 2>&1 || true
}

terminate_process_group() {
  local pid="$1"
  local process_group
  if [[ ! "$pid" =~ ^[0-9]+$ ]] || ! kill -0 "$pid" 2>/dev/null; then
    return
  fi
  process_group="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$process_group" == "$pid" ]]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
  else
    kill -TERM "$pid" 2>/dev/null || true
  fi
}

stop_dump_processes() {
  terminate_process_group "$DUMP_PROCESS_PID"
  terminate_process_group "$LIMITER_PROCESS_PID"
  terminate_process_group "$WATCHDOG_PROCESS_PID"
  for pid in "$DUMP_PROCESS_PID" "$LIMITER_PROCESS_PID" "$WATCHDOG_PROCESS_PID"; do
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
      wait "$pid" 2>/dev/null || true
    fi
  done
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if ((DUMP_STARTED == 1)); then
    cleanup_backend
    stop_dump_processes
  fi
  rm -f -- "$TEMP_DUMP" "$TEMP_CHECKSUM" "$TEMP_PIPE" "$WATCHDOG_ABORT_MARKER"
  if ((PUBLISH_STARTED == 1)); then
    rm -f -- "$TARGET" "$CHECKSUM_TARGET"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

watch_dump_health() {
  local consecutive_failures=0
  while sleep "$WATCHDOG_INTERVAL_SEC"; do
    if ! kill -0 "$DUMP_PROCESS_PID" 2>/dev/null; then
      return
    fi
    if probe_runtime_ready; then
      consecutive_failures=0
      continue
    fi
    consecutive_failures=$((consecutive_failures + 1))
    echo "PostgreSQL backup watchdog observed degraded readiness or raw queue lag ($consecutive_failures/$WATCHDOG_FAILURE_THRESHOLD)." >&2
    if ((consecutive_failures < WATCHDOG_FAILURE_THRESHOLD)); then
      continue
    fi
    printf 'aborted\n' >"$WATCHDOG_ABORT_MARKER"
    cleanup_backend
    terminate_process_group "$DUMP_PROCESS_PID"
    terminate_process_group "$LIMITER_PROCESS_PID"
    return
  done
}

DUMP_STARTED=1
set -m
# Positional parameters expand inside the container shell.
# shellcheck disable=SC2016
timeout --signal=TERM --kill-after=30s "${MAX_DURATION_SEC}s" \
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    sh -lc 'exec env PGAPPNAME="$3" ionice -c2 -n7 nice -n19 pg_dump \
      --no-password -U "$1" -d "$2" \
      --format=custom --compress=gzip:3 --no-owner --no-privileges \
      --lock-wait-timeout=10s' -- maxim maxim "$PG_APP_NAME" >"$TEMP_PIPE" &
DUMP_PROCESS_PID=$!
node "$RATE_LIMITER" "$RATE_LIMIT_BYTES_PER_SEC" <"$TEMP_PIPE" >"$TEMP_DUMP" &
LIMITER_PROCESS_PID=$!
watch_dump_health &
WATCHDOG_PROCESS_PID=$!
set +m

set +e
wait -n -p FIRST_COMPLETED_PID "$DUMP_PROCESS_PID" "$LIMITER_PROCESS_PID"
FIRST_COMPLETED_STATUS=$?
set -e
if [[ "$FIRST_COMPLETED_PID" == "$DUMP_PROCESS_PID" ]]; then
  DUMP_STATUS=$FIRST_COMPLETED_STATUS
  set +e
  wait "$LIMITER_PROCESS_PID"
  LIMITER_STATUS=$?
  set -e
else
  LIMITER_STATUS=$FIRST_COMPLETED_STATUS
  if ((LIMITER_STATUS != 0)); then
    cleanup_backend
    terminate_process_group "$DUMP_PROCESS_PID"
  fi
  set +e
  wait "$DUMP_PROCESS_PID"
  DUMP_STATUS=$?
  set -e
fi
terminate_process_group "$WATCHDOG_PROCESS_PID"
wait "$WATCHDOG_PROCESS_PID" 2>/dev/null || true
WATCHDOG_PROCESS_PID=""
cleanup_backend
DUMP_STARTED=0
rm -f -- "$TEMP_PIPE"

if [[ -s "$WATCHDOG_ABORT_MARKER" ]]; then
  echo "PostgreSQL backup aborted after sustained readiness or raw queue lag degradation." >&2
  exit 1
fi
if ((DUMP_STATUS != 0 || LIMITER_STATUS != 0)); then
  echo "PostgreSQL backup did not complete within its bounded resource envelope." >&2
  exit 1
fi

if [[ ! -s "$TEMP_DUMP" ]]; then
  echo "PostgreSQL backup is empty." >&2
  exit 1
fi

docker compose -f "$COMPOSE_FILE" exec -T postgres pg_restore --list <"$TEMP_DUMP" >/dev/null

CHECKSUM="$(sha256sum "$TEMP_DUMP" | awk '{print $1}')"
printf '%s  %s\n' "$CHECKSUM" "$(basename "$TARGET")" >"$TEMP_CHECKSUM"

PUBLISH_STARTED=1
mv -- "$TEMP_DUMP" "$TARGET"
mv -- "$TEMP_CHECKSUM" "$CHECKSUM_TARGET"
PUBLISH_STARTED=0
rm -f -- "$WATCHDOG_ABORT_MARKER"
trap - EXIT HUP INT TERM

echo "Validated PostgreSQL backup saved to $TARGET"
