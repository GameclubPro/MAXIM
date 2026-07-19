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
ADMIN_PUBLIC_URL="${MAXIM_ADMIN_PUBLIC_URL:-https://admin.major-maksimov.ru}"
SIGNAL_WINDOW_MIN="${MAXIM_MONITOR_SIGNAL_WINDOW_MIN:-30}"
PUBLIC_URL="${PUBLIC_URL%/}"
ADMIN_PUBLIC_URL="${ADMIN_PUBLIC_URL%/}"

SERVICES=("${MAXIM_PRODUCTION_API_SERVICES[@]}")
STATIC_SERVICES=("miniapp-major-static" "admin-static")
LOG_SERVICES=("${SERVICES[@]}" "${STATIC_SERVICES[@]}")

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

  printf -v service_args '%q ' "${LOG_SERVICES[@]}"
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

summarize_static_services() {
  local service_args
  local remote_command

  printf -v service_args '%q ' "${STATIC_SERVICES[@]}"
  remote_command=$(cat <<REMOTE
services=($service_args)
for service in "\${services[@]}"; do
  echo "-- \${service} --"
  docker compose --env-file .env -p infra -f infra/docker-compose.yml ps "\$service" || true
  ids=\$(docker compose --env-file .env -p infra -f infra/docker-compose.yml ps -q "\$service" 2>/dev/null || true)
  if [[ -z "\$ids" ]]; then
    echo "WARN: no container found for \$service"
    continue
  fi

  docker inspect --format '{{.Name}}\trestarts={{.RestartCount}}\tstatus={{.State.Status}}\tstarted={{.State.StartedAt}}{{if .State.Health}}\thealth={{.State.Health.Status}}{{else}}\thealth=none{{end}}' \$ids
  docker compose --env-file .env -p infra -f infra/docker-compose.yml logs --since "${INTERVAL_SEC}s" --tail "$TAIL_LINES" "\$service" 2>/dev/null |
    grep -Eai '(^|[^[:alnum:]_])(error|warn|exception|failed|502|503|504|upstream|permission|denied)([^[:alnum:]_]|$)' |
    sed -E \
      -e "s#(https?://[^\"[:space:]]*)\\?[^\"[:space:]#]*#\\1?[redacted]#g" \
      -e "s#((^|[[:space:]\":=])/(app|api)/[^\"[:space:]]*)\\?[^\"[:space:]#]*#\\1?[redacted]#g" |
    tail -40 || true
done
REMOTE
)

  ./infra/scripts/vps-connect.sh exec "$remote_command"
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
  local admin_ready_json
  local ready_json

  ready_json="$(./infra/scripts/vps-connect.sh exec 'curl -fsS --max-time 15 http://127.0.0.1:3001/api/health/ready')"
  admin_ready_json="$(./infra/scripts/vps-connect.sh exec 'curl -fsS --max-time 15 http://127.0.0.1:3002/api/health/ready')"
  READY_JSON="$ready_json" ADMIN_READY_JSON="$admin_ready_json" node <<'NODE'
const payload = process.env.READY_JSON ?? '';
const ready = JSON.parse(payload);
const adminPayload = process.env.ADMIN_READY_JSON ?? '';
const adminReady = JSON.parse(adminPayload);
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
  adminReady: adminReady.ok === true,
  adminDatabase: adminReady.checks?.database === true,
  adminRedis: adminReady.checks?.redis === true,
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
    `apiAdminReady=${summary.adminReady}`,
    `apiAdminDb=${summary.adminDatabase}`,
    `apiAdminRedis=${summary.adminRedis}`,
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
if (!summary.adminReady || !summary.adminDatabase || !summary.adminRedis) {
  warnings.push('api-admin ready check failed');
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
if (
  !summary.ok ||
  !summary.database ||
  !summary.redis ||
  !summary.adminReady ||
  !summary.adminDatabase ||
  !summary.adminRedis
) {
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
  max-actions-critical
  max-actions-interactive
  max-actions-background
  night-mode-transitions
  moderation-delete-intents
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
now_ms="$(($(date +%s) * 1000))"
due_score="$((now_ms * 4096 + 4095))"
for q in "$@"; do
  printf "%s wait=" "$q"; redis_count "bull:$q:wait"
  printf "%s active=" "$q"; redis_count "bull:$q:active"
  printf "%s failed=" "$q"; redis_count "bull:$q:failed"
  printf "%s delayed=" "$q"; redis_count "bull:$q:delayed"
  printf "%s dueNow=" "$q"; redis-cli --raw zcount "bull:$q:delayed" -inf "$due_score" 2>/dev/null || printf "0\n"
done
' sh "${queues[@]}"
REMOTE
)

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

summarize_runtime_pressure() {
  local remote_command

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
disk_used_percent="$(df -P "$disk_path" 2>/dev/null | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
if [[ "$disk_used_percent" =~ ^[0-9]+$ ]]; then
  if (( disk_used_percent >= 90 )); then
    printf "DISK_CRITICAL path=%s used=%s%% threshold=90%%\n" "$disk_path" "$disk_used_percent"
  elif (( disk_used_percent >= 80 )); then
    printf "DISK_WARNING path=%s used=%s%% threshold=80%%\n" "$disk_path" "$disk_used_percent"
  else
    printf "DISK_OK path=%s used=%s%% warning=80%% critical=90%%\n" "$disk_path" "$disk_used_percent"
  fi
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

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

summarize_log_signal_counts() {
  local service_args
  local remote_command

  printf -v service_args '%q ' "${LOG_SERVICES[@]}"
  remote_command=$(cat <<REMOTE
services=($service_args)
printf "service\\tlevel40_50\\trate_limit\\tskipped_perm\\taccess_loss\\tstatus403\\ttimeout\\tgovernor\\tslow\\tledger\\tpg_warn\\n"
for service in "\${services[@]}"; do
  logs=\$(docker compose --env-file .env -p infra -f infra/docker-compose.yml logs --since "${SIGNAL_WINDOW_MIN}m" --tail "$TAIL_LINES" "\$service" 2>/dev/null || true)
  count() { printf "%s" "\$logs" | grep -Eci "\$1" || true; }
  printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" \\
    "\$service" \\
    "\$(count '"level":(40|50)')" \\
    "\$(count 'rate limit|rate_limit|429')" \\
    "\$(count 'no active bot has the required MAX permissions|Skipped moderation action')" \\
    "\$(count 'ManagedEntityAccessLossService|chat_not_found|chat.denied|BOT_DENIED|access loss')" \\
    "\$(count 'status code 403|"statusCode":403')" \\
    "\$(count 'ETIMEDOUT|timeout|timed out|ECONN')" \\
    "\$(count 'BackgroundRuntimeGovernor|governor|pause|slow path')" \\
    "\$(count 'slow|Slow')" \\
    "\$(count 'Failed to record successful MAX action ledger outcome|delivery-ledger-risk|ambiguous MAX')" \\
    "\$(count 'client.query\\(\\) on a client that has already been checked out')"
done
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
