#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=infra/scripts/lib/deploy-topology.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"

DURATION_SEC="${1:-${MAXIM_MONITOR_DURATION_SEC:-1800}}"
INTERVAL_SEC="${2:-${MAXIM_MONITOR_INTERVAL_SEC:-300}}"
TAIL_LINES="${MAXIM_MONITOR_LOG_TAIL_LINES:-300}"
LOG_FILE="${MAXIM_MONITOR_LOG:-/tmp/maxim-vps-readonly-monitor-$(date +%Y%m%d%H%M%S).log}"
PUBLIC_URL="${MAXIM_VPS_PUBLIC_URL:-https://major-maksimov.ru}"
SIGNAL_WINDOW_MIN="${MAXIM_MONITOR_SIGNAL_WINDOW_MIN:-30}"
PUBLIC_URL="${PUBLIC_URL%/}"

SERVICES=("${MAXIM_PRODUCTION_API_SERVICES[@]}")

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

if ! is_positive_integer "$SIGNAL_WINDOW_MIN"; then
  echo "MAXIM_MONITOR_SIGNAL_WINDOW_MIN must be a positive integer, got: $SIGNAL_WINDOW_MIN" >&2
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

summarize_real_chat_signals() {
  local remote_command

  remote_command=$(cat <<REMOTE
docker compose --env-file .env -p infra -f infra/docker-compose.yml exec -T postgres \\
  psql -U maxim -d maxim -v window_min="$SIGNAL_WINDOW_MIN" -P pager=off <<'SQL'
\\echo webhook_status_last_window
select status, count(*) as count
from webhook_events
where created_at >= now() - make_interval(mins => :window_min)
group by 1
order by 1;

\\echo webhook_failed_last_window
select count(*) as failed, max(created_at) as last_failed_at
from webhook_events
where status = 'FAILED'
  and created_at >= now() - make_interval(mins => :window_min);

\\echo night_mode_close_duplicates_last_window
with close_events as (
  select id, chat_id, metadata->>'sessionKey' as session_key, message_id, created_at,
         row_number() over (
           partition by chat_id, metadata->>'sessionKey'
           order by created_at desc, id desc
         ) as newest_rank,
         count(*) over (partition by chat_id, metadata->>'sessionKey') as group_count
  from moderation_events
  where rule_code = 'NIGHT_MODE_CLOSE_NOTICE'
    and created_at >= now() - make_interval(mins => :window_min)
    and metadata->>'sessionKey' is not null
), unrecovered_extras as (
  select *
  from close_events
  where group_count > 1
    and newest_rank > 1
    and not exists (
      select 1
      from moderation_events recovery
      where recovery.chat_id = close_events.chat_id
        and recovery.rule_code = 'NIGHT_MODE_CLOSE_NOTICE_RECOVERY_DELETE'
        and recovery.created_at >= close_events.created_at
        and (
          recovery.message_id = close_events.message_id
          or recovery.metadata->>'originalEventId' = close_events.id
        )
    )
)
select count(distinct (chat_id, session_key)) as duplicate_groups,
       count(*) as duplicate_extra_events
from unrecovered_extras;

\\echo night_mode_events_last_window
select rule_code,
       count(*) as events,
       count(distinct (chat_id, metadata->>'sessionKey')) as chat_sessions
from moderation_events
where rule_code in (
    'NIGHT_MODE_CLOSE_NOTICE',
    'NIGHT_MODE_OPEN_NOTICE',
    'NIGHT_MODE_CLOSE_NOTICE_RECOVERY_DELETE'
  )
  and created_at >= now() - make_interval(mins => :window_min)
group by 1
order by 1;
SQL
REMOTE
)

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

summarize_bullmq_state() {
  local remote_command

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
  night-mode-transitions
  managed-broadcast
  admin-managed-entities-refresh
  max-chat-admin-roster-sync
  admin-suggestion-delivery
  admin-manual-fanout
  admin-super-ban
  vk-parsing-sync
  vk-parsing-publish
)
docker compose --env-file .env -p infra -f infra/docker-compose.yml exec -T redis sh -lc '
redis_count() {
  key="$1"
  type="$(redis-cli --raw type "$key" 2>/dev/null || true)"
  case "$type" in
    none) printf "0\n" ;;
    list) redis-cli --raw llen "$key" ;;
    zset) redis-cli --raw zcard "$key" ;;
    set) redis-cli --raw scard "$key" ;;
    stream) redis-cli --raw xlen "$key" ;;
    hash) redis-cli --raw hlen "$key" ;;
    string) redis-cli --raw strlen "$key" ;;
    *) printf "unsupported:%s\n" "$type" ;;
  esac
}
for q in "$@"; do
  printf "%s wait=" "$q"; redis_count "bull:$q:wait"
  printf "%s active=" "$q"; redis_count "bull:$q:active"
  printf "%s failed=" "$q"; redis_count "bull:$q:failed"
  printf "%s delayed=" "$q"; redis_count "bull:$q:delayed"
done
' sh "${queues[@]}"
REMOTE
)

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

sample_once() {
  local sample_index="$1"

  echo "===== sample $sample_index $(date -Is) ====="
  run_step health ./infra/scripts/vps-connect.sh health
  run_step semantic-health summarize_local_ready_health
  run_step real-chat-signals summarize_real_chat_signals
  run_step bullmq-state summarize_bullmq_state
  run_step ps ./infra/scripts/vps-connect.sh ps
  run_step restart-counts ./infra/scripts/vps-connect.sh exec \
    'ids=$(docker ps -q --filter label=com.docker.compose.project=infra); docker inspect --format "{{.Name}}\t{{.RestartCount}}\t{{.State.Status}}\t{{.State.StartedAt}}" $ids'
  run_step log-scan scan_service_logs
  run_step public-app curl -fsS --max-time 15 -o /dev/null -w 'app %{http_code} %{time_total}\n' \
    "$PUBLIC_URL/app/"
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
