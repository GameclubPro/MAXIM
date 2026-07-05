#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

DURATION_SEC="${1:-${MAXIM_MONITOR_DURATION_SEC:-1800}}"
INTERVAL_SEC="${2:-${MAXIM_MONITOR_INTERVAL_SEC:-300}}"
TAIL_LINES="${MAXIM_MONITOR_LOG_TAIL_LINES:-300}"
LOG_FILE="${MAXIM_MONITOR_LOG:-/tmp/maxim-vps-readonly-monitor-$(date +%Y%m%d%H%M%S).log}"
PUBLIC_URL="${MAXIM_VPS_PUBLIC_URL:-https://major-maksimov.ru}"

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
  docker compose --env-file .env -p infra -f infra/docker-compose.yml logs --since "${INTERVAL_SEC}s" --tail "$TAIL_LINES" "\$service" 2>/dev/null |
    grep -Eai '"level":(40|50)|"statusCode":(4[0-9][0-9]|5[0-9][0-9])|(^|[^[:alnum:]_])(error|warn|exception|failed|stalled|rate limit|ECONN|ETIMEDOUT|BullMQ|Redis)([^[:alnum:]_]|$)' |
    sed -E \
      -e "s#(https?://[^\"[:space:]]*)\\?[^\"[:space:]#]*#\\1?[redacted]#g" \
      -e "s#((^|[[:space:]\":=])/(app|api)/[^\"[:space:]]*)\\?[^\"[:space:]#]*#\\1?[redacted]#g" |
    tail -40 || true
done
REMOTE
)

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

summarize_local_ready_health() {
  local ready_json

  ready_json="$(./infra/scripts/vps-connect.sh exec 'curl -fsS --max-time 15 http://127.0.0.1:3001/api/health/ready')"
  READY_JSON="$ready_json" node <<'NODE'
const payload = process.env.READY_JSON ?? '';
const ready = JSON.parse(payload);
const queueLag = ready.checks?.queueLag ?? {};
const systemMode = ready.systemMode ?? {};
const bots = Object.entries(ready.bots ?? {});
const botsWithRecentFailedEvents = bots.filter(([, bot]) => Number(bot?.failedEvents ?? 0) > 0)
  .length;
const summary = {
  ok: ready.ok === true,
  mode: systemMode.mode ?? 'unknown',
  degraded: systemMode.degraded === true,
  queueLagSec: Number(systemMode.queueLagSec ?? queueLag.effectiveLagSec ?? 0),
  database: ready.checks?.database === true,
  redis: ready.checks?.redis === true,
  softWarning: queueLag.softWarning === true,
  softWarningCode: queueLag.softWarningCode ?? null,
  rawOk: queueLag.rawOk !== false,
  bots: bots.length,
  botsWithRecentFailedEvents,
};
console.log(
  [
    `ready ok=${summary.ok}`,
    `mode=${summary.mode}`,
    `degraded=${summary.degraded}`,
    `queueLagSec=${summary.queueLagSec}`,
    `db=${summary.database}`,
    `redis=${summary.redis}`,
    `softWarning=${summary.softWarning}`,
    `rawOk=${summary.rawOk}`,
    `bots=${summary.bots}`,
    `botsWithRecentFailedEvents=${summary.botsWithRecentFailedEvents}`,
  ].join(' '),
);

const warnings = [];
if (summary.degraded) {
  warnings.push(`system mode degraded (${summary.mode})`);
}
if (!summary.database) {
  warnings.push('database check is not true');
}
if (!summary.redis) {
  warnings.push('redis check is not true');
}
if (summary.softWarning) {
  warnings.push(`queue lag soft warning: ${summary.softWarningCode ?? 'unknown'}`);
}
if (!summary.rawOk) {
  warnings.push('queue metrics rawOk=false');
}
for (const warning of warnings) {
  console.log(`WARN: ${warning}`);
}
if (!summary.ok || !summary.database || !summary.redis) {
  process.exitCode = 1;
}
NODE
}

sample_once() {
  local sample_index="$1"

  echo "===== sample $sample_index $(date -Is) ====="
  run_step health ./infra/scripts/vps-connect.sh health
  run_step semantic-health summarize_local_ready_health
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
