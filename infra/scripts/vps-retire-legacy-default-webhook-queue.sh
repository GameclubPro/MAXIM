#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
# shellcheck source=infra/scripts/lib/deploy-topology.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"

COMPOSE_FILES=(--env-file .env -p infra -f infra/docker-compose.yml)
RELEASE_STATE_DIR="${MAXIM_RELEASE_STATE_DIR:-/var/lib/maxim-deploy}"
RELEASE_HELPER="$ROOT_DIR/infra/scripts/release-manifest.mjs"
QUEUE_HELPER="$ROOT_DIR/infra/scripts/legacy-default-webhook-queue-retirement.cjs"
DB_AUDIT_HELPER="$ROOT_DIR/infra/scripts/legacy-default-webhook-db-audit.mjs"
POSTGRES_AUDIT="$ROOT_DIR/infra/scripts/vps-postgres-audit.sh"
QUEUE_FENCE_HELPER="$ROOT_DIR/infra/scripts/webhook-queue-rollout-control.cjs"
FLEET_HELPER="$ROOT_DIR/infra/scripts/monitor-capacity-probe.cjs"
SHARDING_FLOOR_SHA=88fb79896ce47c8abb27c002e72ade544d34dbb9
COMMAND_TIMEOUT_SEC="${MAXIM_LEGACY_DEFAULT_QUEUE_RETIRE_TIMEOUT_SEC:-120}"
REMOTE_APPLY_TIMEOUT_MARGIN_SEC=10
ACTION=preview
PRIVATE_SNAPSHOT=''
CONTROL_SOURCE=''
QUEUE_SUMMARY=''
LEGACY_QUEUE_PAUSED_COUNT=0
ENQUEUE_SERVICE_STOPPED=0
API_FLEET_RESTART_BASELINE=''
REMOTE_APPLY_DEADLINE_MS=''
REMOTE_APPLY_NOT_BEFORE_SECONDS=''
REMOTE_APPLY_AMBIGUOUS=0

usage() {
  cat <<'USAGE'
Usage:
  ./infra/scripts/vps-retire-legacy-default-webhook-queue.sh [--apply]

The default is a read-only preview. Apply holds the shared deploy lock, requires an exact
post-sharding release with no transition journal, proves every legacy job terminal or absent in
Postgres, and proves the active runtime has only one enqueue producer. Apply briefly stops that
producer, takes a fresh snapshot, pauses only moderation-default, and obliterates without force.
It never starts a legacy worker, replays a job, or changes Postgres or active shard queues.
USAGE
}

fail() {
  printf '%s\n' "$1" >&2
  return 1
}

cleanup() {
  local status=$?
  local settlement_proven=1
  trap - EXIT
  trap '' HUP INT TERM
  if [[ "$ENQUEUE_SERVICE_STOPPED" -eq 1 ]]; then
    if [[ "$REMOTE_APPLY_AMBIGUOUS" -eq 1 ]]; then
      wait_for_remote_apply_deadline
      if ! prove_remote_apply_settled; then
        printf '%s\n' \
          "Legacy queue remote apply settlement could not be proven after its deadline." >&2
        settlement_proven=0
        if [[ "$status" -eq 0 ]]; then status=1; fi
      fi
    fi
    if ! restore_enqueue_service; then
      printf '%s\n' "Could not restore and verify api-enqueue during retirement cleanup." >&2
      if [[ "$status" -eq 0 ]]; then status=1; fi
    fi
  fi
  if [[ "$settlement_proven" -eq 0 ]]; then
    printf '%s\n' \
      "api-enqueue was restored after the remote deadline, but legacy queue state needs review." >&2
  fi
  if [[ -n "$PRIVATE_SNAPSHOT" && -f "$PRIVATE_SNAPSHOT" && ! -L "$PRIVATE_SNAPSHOT" ]]; then
    rm -f -- "$PRIVATE_SNAPSHOT"
  fi
  PRIVATE_SNAPSHOT=''
  if ! release_deploy_lock; then
    printf '%s\n' "Could not release the shared deploy lock." >&2
    if [[ "$status" -eq 0 ]]; then status=1; fi
  fi
  exit "$status"
}

arm_cleanup_traps() {
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

arm_cleanup_traps

parse_args() {
  if [[ $# -eq 0 ]]; then
    return 0
  fi
  if [[ $# -eq 1 && "$1" == "--apply" ]]; then
    ACTION=apply
    return 0
  fi
  if [[ $# -eq 1 && ( "$1" == "--help" || "$1" == "-h" ) ]]; then
    usage
    exit 0
  fi
  usage >&2
  exit 2
}

require_preconditions() {
  local helper_size
  local required

  [[ -f .env ]] || fail "Production Compose env is unavailable."
  for required in docker git node timeout; do
    command -v "$required" >/dev/null 2>&1 || fail "$required not found."
  done
  [[ "$(node -p 'process.versions.node.split(".")[0]')" == "24" ]] ||
    fail "Node 24 is required for legacy queue retirement."
  for required in \
    "$RELEASE_HELPER" \
    "$QUEUE_HELPER" \
    "$DB_AUDIT_HELPER" \
    "$POSTGRES_AUDIT" \
    "$QUEUE_FENCE_HELPER" \
    "$FLEET_HELPER"; do
    [[ -s "$required" && ! -L "$required" ]] || fail "A required retirement helper is unavailable."
  done
  if [[ ! "$COMMAND_TIMEOUT_SEC" =~ ^[1-9][0-9]{1,2}$ ]] ||
    ((10#$COMMAND_TIMEOUT_SEC < 30 || 10#$COMMAND_TIMEOUT_SEC > 120)); then
    fail "MAXIM_LEGACY_DEFAULT_QUEUE_RETIRE_TIMEOUT_SEC must be between 30 and 120."
  fi
  ((10#$COMMAND_TIMEOUT_SEC > REMOTE_APPLY_TIMEOUT_MARGIN_SEC + 1)) ||
    fail "Legacy queue retirement timeout leaves no remote watchdog margin."
  helper_size="$(wc -c <"$QUEUE_HELPER")"
  [[ "$helper_size" =~ ^[1-9][0-9]*$ && "$helper_size" -le 65536 ]] ||
    fail "Legacy queue retirement helper is oversized."
  CONTROL_SOURCE="$(<"$QUEUE_HELPER")"
}

resolve_release_fence() {
  local checkout_sha
  local journal
  local manifest_json
  local manifest_fields
  local source_sha
  local target_sha
  local image_ref
  local image_id
  local grep_status
  local producer_binding_count
  local producer_job_name_count

  manifest_json="$(
    node "$RELEASE_HELPER" validate-current --state-dir "$RELEASE_STATE_DIR"
  )" || fail "Current release manifest is missing, incomplete, or coexists with a journal."
  journal="$(
    find "$RELEASE_STATE_DIR" -maxdepth 1 -name 'current.invalid-*' -print -quit 2>/dev/null
  )"
  [[ -z "$journal" ]] || fail "An unresolved release transition journal blocks queue retirement."
  manifest_fields="$(printf '%s' "$manifest_json" | node -e '
    const { readFileSync } = require("node:fs");
    const value = JSON.parse(readFileSync(0, "utf8"));
    const component = value?.components?.["api-shared"];
    const fields = [value?.targetSha, component?.sourceSha, component?.imageRef, component?.imageId];
    if (!fields.every((field) => typeof field === "string" && !/[\\r\\n\\t]/u.test(field))) {
      process.exit(1);
    }
    process.stdout.write(fields.join("\\t"));
  ')" || fail "Current API release identity is invalid."
  IFS=$'\t' read -r target_sha source_sha image_ref image_id <<<"$manifest_fields"
  checkout_sha="$(git rev-parse --verify HEAD)" || fail "Current checkout SHA is unavailable."
  [[ "$target_sha" == "$checkout_sha" && "$source_sha" == "$checkout_sha" ]] ||
    fail "Current checkout is not the exact active API release."
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || fail "Current API source SHA is invalid."
  [[ "$image_ref" == "maxim-api:${source_sha}" ]] ||
    fail "Current API image is not the immutable source-SHA ref."
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "Current API image id is invalid."
  git diff --quiet -- . || fail "Tracked VPS checkout changes block queue retirement."
  git diff --cached --quiet -- . || fail "Staged VPS checkout changes block queue retirement."
  [[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ]] ||
    fail "An unclean VPS checkout blocks queue retirement."
  git merge-base --is-ancestor "$SHARDING_FLOOR_SHA" "$source_sha" ||
    fail "Current API release predates the default webhook sharding boundary."

  set +e
  git grep -I -E "['\"]moderation-default['\"]" "$source_sha" -- \
    apps/api/src ':(exclude,glob)apps/api/src/**/*.spec.ts' >/dev/null 2>&1
  grep_status=$?
  set -e
  [[ "$grep_status" -eq 1 ]] ||
    fail "Current API source still contains an exact moderation-default runtime literal."
  producer_binding_count="$(
    git grep -I -h -F 'this.enabled = roleRunsEnqueue(getAppRole());' "$source_sha" -- \
      apps/api/src/webhook/webhook-outbox.service.ts | wc -l
  )" || fail "Could not inspect the webhook producer role binding."
  [[ "$producer_binding_count" == "1" ]] ||
    fail "Current API source has an unexpected webhook producer role binding."
  producer_job_name_count="$(
    git grep -I -h -F "'process-webhook-event'" "$source_sha" -- \
      apps/api/src ':(exclude,glob)apps/api/src/**/*.spec.ts' | wc -l
  )" || fail "Could not inspect webhook producer call sites."
  [[ "$producer_job_name_count" == "1" ]] ||
    fail "Current API source has an unexpected webhook producer call-site count."
}

require_stateful_services_ready() {
  local running
  local service
  running="$(docker compose "${COMPOSE_FILES[@]}" ps --status running --services)" ||
    fail "Could not inspect stateful service status."
  for service in postgres redis; do
    grep -Fxq "$service" <<<"$running" || fail "$service is not already running."
  done
  timeout --foreground --kill-after=2s 10s \
    docker compose "${COMPOSE_FILES[@]}" exec -T postgres \
      pg_isready -U maxim -d maxim >/dev/null 2>&1 || fail "Postgres is not ready."
  timeout --foreground --kill-after=2s 10s \
    docker compose "${COMPOSE_FILES[@]}" exec -T redis redis-cli ping 2>/dev/null |
    grep -Fxq PONG || fail "Redis is not ready."
}

read_api_fleet() {
  local fleet
  fleet="$(MAXIM_RELEASE_STATE_DIR="$RELEASE_STATE_DIR" node -e '
    const probe = require("./infra/scripts/monitor-capacity-probe.cjs");
    probe.probeApiFleet(probe.DEFAULT_EXPECTED_API_SERVICES).then((value) => {
      process.stdout.write(JSON.stringify(value));
    }).catch(() => process.exit(1));
  ')" || fail "Could not inspect the production API fleet."
  printf '%s' "$fleet"
}

validate_api_fleet() {
  local fleet="$1"
  local expected_running="$2"
  printf '%s' "$fleet" | node -e '
    const { readFileSync } = require("node:fs");
    const value = JSON.parse(readFileSync(0, "utf8"));
    const expected = 13;
    const expectedRunning = Number(process.argv[1]);
    const countFields = [
      "expectedRoleCount",
      "observedRoleCount",
      "singletonRoleCount",
      "runningRoleCount",
      "identityRoleCount",
      "exactImageRoleCount",
      "duplicateContainerCount",
      "unexpectedApiContainerCount",
      "unexpectedMainContainerCount",
      "unexpectedScaleContainerCount",
      "unexpectedManualContainerCount",
      "totalRestartCount",
    ];
    const countsValid = countFields.every(
      (field) => Object.hasOwn(value, field) && Number.isSafeInteger(value[field]) && value[field] >= 0,
    );
    const valid =
      value && Object.hasOwn(value, "available") && value.available === true && countsValid &&
      value.expectedRoleCount === expected &&
      value.observedRoleCount === expected &&
      value.singletonRoleCount === expected &&
      value.runningRoleCount === expectedRunning &&
      value.identityRoleCount === expected &&
      value.exactImageRoleCount === expected &&
      value.duplicateContainerCount === 0 &&
      value.unexpectedApiContainerCount === 0 &&
      value.unexpectedMainContainerCount === 0 &&
      value.unexpectedScaleContainerCount === 0 &&
      value.unexpectedManualContainerCount === 0;
    if (!valid) process.exit(1);
    process.stdout.write(String(value.totalRestartCount));
  ' "$expected_running"
}

verify_exact_api_fleet() {
  local fleet
  local restart_count
  fleet="$(read_api_fleet)" || return 1
  restart_count="$(validate_api_fleet "$fleet" 13)" ||
    fail "Production API fleet is not the exact current 13-role release."
  if [[ -z "$API_FLEET_RESTART_BASELINE" ]]; then
    API_FLEET_RESTART_BASELINE="$restart_count"
  elif [[ "$restart_count" != "$API_FLEET_RESTART_BASELINE" ]]; then
    fail "Production API fleet restart count changed during queue retirement."
  fi
}

verify_api_fleet_with_enqueue_stopped() {
  local fleet
  local restart_count
  local running_ids
  running_ids="$(docker compose "${COMPOSE_FILES[@]}" ps --status running -q api-enqueue)" ||
    fail "Could not verify that api-enqueue stopped."
  [[ -z "$running_ids" ]] || fail "api-enqueue is still running."
  fleet="$(read_api_fleet)" || return 1
  restart_count="$(validate_api_fleet "$fleet" 12)" ||
    fail "API fleet is not exact with only api-enqueue stopped."
  [[ -n "$API_FLEET_RESTART_BASELINE" && "$restart_count" == "$API_FLEET_RESTART_BASELINE" ]] ||
    fail "API fleet restart count changed while api-enqueue was stopped."
}

verify_webhook_producer_topology() {
  local proof
  proof="$(
    timeout --foreground --kill-after=2s 20s \
      docker compose "${COMPOSE_FILES[@]}" exec -T api-admin \
        node -e "$CONTROL_SOURCE" runtime-proof
  )" || fail "Could not attest the active webhook producer topology."
  printf '%s' "$proof" | node -e '
    const { readFileSync } = require("node:fs");
    const value = JSON.parse(readFileSync(0, "utf8"));
    const expectedCounts = {
      productionServiceCount: 13,
      productionEnqueueProducerCount: 1,
      enqueueRoleCount: 2,
      activeWebhookQueueCount: 22,
      registeredWebhookQueueCount: 23,
    };
    const countsValid = Object.entries(expectedCounts).every(
      ([field, expected]) =>
        Object.hasOwn(value, field) &&
        Number.isSafeInteger(value[field]) &&
        value[field] === expected,
    );
    const valid =
      value &&
      Object.hasOwn(value, "version") &&
      value.version === 1 &&
      countsValid &&
      Object.hasOwn(value, "retiredDefaultQueueRegistered") &&
      value.retiredDefaultQueueRegistered === false;
    process.exit(valid ? 0 : 1);
  ' || fail "Active webhook producer topology is not retirement-safe."
}

verify_queue_fence_released() {
  local expected_paused_count="${1:-0}"
  local summary
  [[ "$expected_paused_count" == "0" || "$expected_paused_count" == "1" ]] ||
    fail "Expected webhook queue pause count is invalid."
  summary="$(
    timeout --foreground --kill-after=2s 20s \
      docker compose "${COMPOSE_FILES[@]}" exec -T api-admin node - status \
      <"$QUEUE_FENCE_HELPER"
  )" || fail "Could not inspect the webhook queue fence."
  printf '%s' "$summary" | node -e '
    const { readFileSync } = require("node:fs");
    const value = JSON.parse(readFileSync(0, "utf8"));
    const expectedPausedCount = Number(process.argv[1]);
    const countFields = ["queueCount", "pausedCount", "activeCount"];
    const countsValid = countFields.every(
      (field) => Object.hasOwn(value, field) && Number.isSafeInteger(value[field]) && value[field] >= 0,
    );
    const valid =
      value && countsValid &&
      value.queueCount === 24 &&
      value.pausedCount === expectedPausedCount &&
      Object.hasOwn(value, "legacyDefaultPaused") &&
      value.legacyDefaultPaused === (expectedPausedCount === 1) &&
      value.activeCount >= 0 &&
      Object.hasOwn(value, "ownerPresent") &&
      value.ownerPresent === false;
    process.exit(valid ? 0 : 1);
  ' "$expected_paused_count" || fail "Webhook queue fence is owned, unexpectedly paused, or incomplete."
}

wait_for_remote_apply_deadline() {
  if [[ ! "$REMOTE_APPLY_NOT_BEFORE_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
    sleep "$COMMAND_TIMEOUT_SEC"
    return 0
  fi
  while ((SECONDS < REMOTE_APPLY_NOT_BEFORE_SECONDS)); do
    sleep 1
  done
}

prove_remote_apply_settled() {
  local attempts_remaining=3
  local output
  local output_bytes
  local paused_count
  local status

  while ((attempts_remaining > 0)); do
    attempts_remaining=$((attempts_remaining - 1))
    set +e
    output="$(
      timeout --foreground --kill-after=2s 8s \
        docker compose "${COMPOSE_FILES[@]}" exec -T api-admin \
          node -e "$CONTROL_SOURCE" settlement
    )"
    status=$?
    set -e
    if [[ "$status" -ne 0 ]]; then
      sleep 1
      continue
    fi
    output_bytes="$(printf '%s' "$output" | wc -c)"
    if [[ ! "$output_bytes" =~ ^[1-9][0-9]*$ || "$output_bytes" -gt 16384 ]]; then
      sleep 1
      continue
    fi
    set +e
    paused_count="$(printf '%s' "$output" | node -e '
      const { readFileSync } = require("node:fs");
      const value = JSON.parse(readFileSync(0, "utf8"));
      const queue = value?.queue;
      const countFields = ["workerCount", "jobSchedulerCount", "totalJobs"];
      const countsValid = countFields.every(
        (field) => Object.hasOwn(queue, field) && Number.isSafeInteger(queue[field]) && queue[field] >= 0,
      );
      const valid =
        value?.version === 1 && value?.mode === "settlement" && value?.settled === true &&
        queue?.version === 1 && queue?.queue === "moderation-default" &&
        typeof queue?.present === "boolean" && typeof queue?.paused === "boolean" &&
        countsValid && queue.workerCount === 0 && queue.jobSchedulerCount === 0;
      if (!valid) process.exit(1);
      process.stdout.write(queue.paused ? "1" : "0");
    ')"
    status=$?
    set -e
    if [[ "$status" -eq 0 ]] && verify_queue_fence_released "$paused_count"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

run_http_smoke_before_deadline() {
  local deadline="$1"
  local url="$2"
  local remaining=$((deadline - SECONDS))
  local timeout_sec=20

  ((remaining > 0)) || return 1
  if ((remaining < timeout_sec)); then
    timeout_sec="$remaining"
  fi
  timeout --foreground --kill-after=1s "${timeout_sec}s" \
    node scripts/smoke-http.mjs json-ok "$url" >/dev/null
}

run_readiness_smokes() {
  local deadline="${1:-$((SECONDS + 80))}"
  local url
  for url in \
    http://127.0.0.1:3001/api/health/live \
    http://127.0.0.1:3001/api/health/ready \
    http://127.0.0.1:3002/api/health/live \
    http://127.0.0.1:3002/api/health/ready; do
    run_http_smoke_before_deadline "$deadline" "$url" || return 1
  done
}

stop_enqueue_service() {
  ENQUEUE_SERVICE_STOPPED=1
  timeout --foreground --kill-after=5s 30s \
    docker compose "${COMPOSE_FILES[@]}" stop api-enqueue >/dev/null ||
    fail "Could not stop api-enqueue for legacy queue retirement."
  verify_api_fleet_with_enqueue_stopped || return 1
  sleep 1
  verify_api_fleet_with_enqueue_stopped || return 1
}

restore_enqueue_service() {
  local deadline
  local remaining
  local start_timeout_sec
  local stable_samples=0

  deadline=$((SECONDS + COMMAND_TIMEOUT_SEC))
  while ((SECONDS < deadline)); do
    remaining=$((deadline - SECONDS))
    start_timeout_sec=30
    if ((remaining < start_timeout_sec)); then
      start_timeout_sec="$remaining"
    fi
    if timeout --foreground --kill-after=2s "${start_timeout_sec}s" \
      docker compose "${COMPOSE_FILES[@]}" start api-enqueue >/dev/null; then
      break
    fi
    if ((SECONDS < deadline)); then sleep 1; fi
  done
  ((SECONDS < deadline)) || return 1
  while ((SECONDS < deadline)); do
    if verify_exact_api_fleet >/dev/null 2>&1 &&
      run_readiness_smokes "$deadline" >/dev/null 2>&1; then
      stable_samples=$((stable_samples + 1))
      if ((stable_samples == 2)); then
        ENQUEUE_SERVICE_STOPPED=0
        return 0
      fi
    else
      stable_samples=0
    fi
    if ((SECONDS < deadline)); then sleep 1; fi
  done
  return 1
}

create_private_snapshot() {
  local temp_root="${TMPDIR:-/tmp}"
  [[ "$temp_root" == /* && -d "$temp_root" && "$temp_root" != *$'\n'* ]] ||
    fail "TMPDIR must be an existing absolute directory."
  PRIVATE_SNAPSHOT="$(mktemp "$temp_root/maxim-legacy-default-webhook.XXXXXXXX")" ||
    fail "Could not create the private legacy queue snapshot."
  chmod 0600 "$PRIVATE_SNAPSHOT"
  timeout --foreground --kill-after=5s "${COMMAND_TIMEOUT_SEC}s" \
    docker compose "${COMPOSE_FILES[@]}" exec -T api-admin \
      node -e "$CONTROL_SOURCE" snapshot >"$PRIVATE_SNAPSHOT" ||
    fail "Could not capture the bounded legacy queue snapshot."
  node "$QUEUE_HELPER" validate-snapshot "$PRIVATE_SNAPSHOT" ||
    fail "Legacy queue snapshot validation failed."
  QUEUE_SUMMARY="$(node "$QUEUE_HELPER" summarize "$PRIVATE_SNAPSHOT")" ||
    fail "Could not summarize the legacy queue snapshot."
  LEGACY_QUEUE_PAUSED_COUNT="$(
    printf '%s' "$QUEUE_SUMMARY" | node -e '
      const { readFileSync } = require("node:fs");
      const value = JSON.parse(readFileSync(0, "utf8"));
      if (!value || !Object.hasOwn(value, "paused") ||
          (value.paused !== true && value.paused !== false)) process.exit(1);
      process.stdout.write(value.paused ? "1" : "0");
    '
  )" || fail "Legacy queue pause state is invalid."
}

refresh_private_snapshot() {
  if [[ -n "$PRIVATE_SNAPSHOT" ]]; then
    [[ -f "$PRIVATE_SNAPSHOT" && ! -L "$PRIVATE_SNAPSHOT" ]] ||
      fail "Private legacy queue snapshot became unsafe."
    rm -f -- "$PRIVATE_SNAPSHOT"
    PRIVATE_SNAPSHOT=''
  fi
  QUEUE_SUMMARY=''
  LEGACY_QUEUE_PAUSED_COUNT=0
  create_private_snapshot
}

print_queue_summary() {
  [[ -n "$QUEUE_SUMMARY" ]] || fail "Legacy queue summary is unavailable."
  printf 'legacy-default-queue %s\n' "$QUEUE_SUMMARY"
}

run_database_crosscheck() {
  local raw_summary
  local summary
  local status
  raw_summary="$(
    MAXIM_INTERNAL_LEGACY_DEFAULT_WEBHOOK_AUDIT=1 \
      "$POSTGRES_AUDIT" legacy-default-webhook-jobs "$PRIVATE_SNAPSHOT"
  )" || fail "Bounded legacy queue database audit failed."
  set +e
  summary="$(
    printf '%s' "$raw_summary" |
      node "$DB_AUDIT_HELPER" validate-summary "$PRIVATE_SNAPSHOT"
  )"
  status=$?
  set -e
  [[ -z "$summary" ]] || printf 'legacy-default-db %s\n' "$summary"
  if [[ "$status" -eq 3 ]]; then
    fail "Legacy queue jobs still have live or quarantined database state."
  fi
  [[ "$status" -eq 0 ]] || fail "Legacy queue database summary validation failed."
}

inspect_active_shards() {
  local summary
  summary="$(
    timeout --foreground --kill-after=2s 30s \
      docker compose "${COMPOSE_FILES[@]}" exec -T api-admin \
        node -e "$CONTROL_SOURCE" shards
  )" || fail "Could not inspect active default webhook shards."
  printf '%s' "$summary" | node -e '
    const { readFileSync } = require("node:fs");
    const value = JSON.parse(readFileSync(0, "utf8"));
    const countFields = ["queueCount", "pausedQueueCount", "totalJobs"];
    const countsValid = countFields.every(
      (field) => Object.hasOwn(value, field) && Number.isSafeInteger(value[field]) && value[field] >= 0,
    );
    const valid =
      value && Object.hasOwn(value, "version") && value.version === 1 && countsValid &&
      value.queueCount === 16 && value.pausedQueueCount === 0;
    process.exit(valid ? 0 : 1);
  ' || fail "Active default webhook shard state is invalid or paused."
  printf 'default-webhook-shards %s\n' "$summary"
}

apply_retirement() {
  local remote_window_sec=$((COMMAND_TIMEOUT_SEC - REMOTE_APPLY_TIMEOUT_MARGIN_SEC))
  local output
  local status

  REMOTE_APPLY_DEADLINE_MS="$(
    node -e '
      const windowSec = Number(process.argv[1]);
      if (!Number.isSafeInteger(windowSec) || windowSec < 1 || windowSec > 120) process.exit(1);
      process.stdout.write(String(Date.now() + windowSec * 1_000));
    ' "$remote_window_sec"
  )" || fail "Could not construct the remote queue apply deadline."
  [[ "$REMOTE_APPLY_DEADLINE_MS" =~ ^[1-9][0-9]{12}$ ]] ||
    fail "Remote queue apply deadline is invalid."
  REMOTE_APPLY_NOT_BEFORE_SECONDS=$((SECONDS + remote_window_sec))
  REMOTE_APPLY_AMBIGUOUS=1
  set +e
  output="$(
    timeout --foreground --kill-after=5s "${COMMAND_TIMEOUT_SEC}s" \
      docker compose "${COMPOSE_FILES[@]}" exec -T \
        -e "MAXIM_LEGACY_DEFAULT_QUEUE_REMOTE_DEADLINE_MS=$REMOTE_APPLY_DEADLINE_MS" api-admin \
        node -e "$CONTROL_SOURCE" apply <"$PRIVATE_SNAPSHOT"
  )"
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    fail "Legacy default webhook queue retirement failed closed."
  fi
  printf '%s' "$output" | node -e '
    const { readFileSync } = require("node:fs");
    const value = JSON.parse(readFileSync(0, "utf8"));
    const valid =
      value?.version === 1 && value?.mode === "apply" &&
      (value?.result === "obliterated" || value?.result === "already_absent") &&
      value?.before?.queue === "moderation-default" &&
      value?.after?.queue === "moderation-default";
    process.exit(valid ? 0 : 1);
  ' || fail "Legacy default webhook queue retirement returned invalid output."
  REMOTE_APPLY_AMBIGUOUS=0
  printf 'legacy-default-retirement %s\n' "$output"
}

main() {
  parse_args "$@"
  require_preconditions
  acquire_deploy_lock
  arm_cleanup_traps
  resolve_release_fence
  require_stateful_services_ready
  verify_exact_api_fleet
  verify_webhook_producer_topology
  create_private_snapshot
  print_queue_summary
  verify_queue_fence_released "$LEGACY_QUEUE_PAUSED_COUNT"
  run_readiness_smokes
  run_database_crosscheck
  inspect_active_shards

  if [[ "$ACTION" == "preview" ]]; then
    echo "Legacy default webhook queue retirement preview passed; no production state changed."
    return 0
  fi

  stop_enqueue_service
  refresh_private_snapshot
  print_queue_summary
  verify_queue_fence_released "$LEGACY_QUEUE_PAUSED_COUNT"
  run_database_crosscheck
  inspect_active_shards

  # FLAG: The private DB-approved snapshot is revalidated inside the container after the queue pause.
  apply_retirement
  inspect_active_shards
  verify_queue_fence_released 0
  restore_enqueue_service || fail "Could not restore and verify api-enqueue after queue retirement."
  echo "Legacy default webhook queue retirement completed."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
