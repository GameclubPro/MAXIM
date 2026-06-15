#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

DURATION_SEC="${1:-${MAXIM_MONITOR_DURATION_SEC:-1800}}"
INTERVAL_SEC="${2:-${MAXIM_MONITOR_INTERVAL_SEC:-300}}"
TAIL_LINES="${MAXIM_MONITOR_LOG_TAIL_LINES:-300}"
LOG_FILE="${MAXIM_MONITOR_LOG:-/tmp/maxim-vps-readonly-monitor-$(date +%Y%m%d%H%M%S).log}"

SERVICES=(
  api-ingress
  api-admin
  api-enqueue
  api-moderation
  api-moderation-critical
  api-moderation-join
  api-moderation-realtime-b
  api-moderation-realtime-c
  api-moderation-realtime-d
  api-moderation-background
  api-action
)

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

if ! is_positive_integer "$DURATION_SEC"; then
  echo "DURATION_SEC must be a positive integer, got: $DURATION_SEC" >&2
  exit 2
fi

if ! is_positive_integer "$INTERVAL_SEC"; then
  echo "INTERVAL_SEC must be a positive integer, got: $INTERVAL_SEC" >&2
  exit 2
fi

if ! is_positive_integer "$TAIL_LINES"; then
  echo "MAXIM_MONITOR_LOG_TAIL_LINES must be a positive integer, got: $TAIL_LINES" >&2
  exit 2
fi

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
  local service_args
  local remote_command

  printf -v service_args '%q ' "${SERVICES[@]}"
  remote_command=$(cat <<REMOTE
services=($service_args)
for service in "\${services[@]}"; do
  echo "-- \${service} --"
  docker compose -p infra -f infra/docker-compose.yml logs --since "${INTERVAL_SEC}s" --tail "$TAIL_LINES" "\$service" 2>/dev/null |
    grep -Eai '"level":(40|50)|"statusCode":(4[0-9][0-9]|5[0-9][0-9])|(^|[^[:alnum:]_])(error|warn|exception|failed|stalled|rate limit|ECONN|ETIMEDOUT|BullMQ|Redis)([^[:alnum:]_]|$)' |
    tail -40 || true
done
REMOTE
)

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

sample_once() {
  local sample_index="$1"

  echo "===== sample $sample_index $(date -Is) ====="
  run_step health ./infra/scripts/vps-connect.sh health
  run_step ps ./infra/scripts/vps-connect.sh ps
  run_step restart-counts ./infra/scripts/vps-connect.sh exec \
    'ids=$(docker ps -q --filter label=com.docker.compose.project=infra); docker inspect --format "{{.Name}}\t{{.RestartCount}}\t{{.State.Status}}\t{{.State.StartedAt}}" $ids'
  run_step log-scan scan_service_logs
  run_step public-app curl -fsS --max-time 15 -o /dev/null -w 'app %{http_code} %{time_total}\n' \
    https://major-maksimov.ru/app/
}

run_monitor() {
  local end_at
  local sample_index=0

  end_at=$(($(date +%s) + DURATION_SEC))
  echo "Readonly VPS monitor started at $(date -Is)"
  echo "duration_sec=$DURATION_SEC interval_sec=$INTERVAL_SEC log_tail_lines=$TAIL_LINES"
  echo "log_file=$LOG_FILE"

  while true; do
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

mkdir -p "$(dirname "$LOG_FILE")"
{
  run_monitor
} 2>&1 | tee "$LOG_FILE"
