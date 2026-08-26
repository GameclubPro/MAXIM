#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=infra/scripts/lib/deploy-topology.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
# shellcheck source=infra/scripts/lib/webhook-rollout-quiescence.sh
source "$ROOT_DIR/infra/scripts/lib/webhook-rollout-quiescence.sh"

COMPOSE_FILES=(--env-file ".env" -p infra -f "infra/docker-compose.yml")
RELEASE_STATE_DIR="${MAXIM_RELEASE_STATE_DIR:-/var/lib/maxim-deploy}"
STATE_HELPER="$ROOT_DIR/infra/scripts/publisher-dispatch-rollout-state.mjs"
CONTROL_HELPER="$ROOT_DIR/infra/scripts/publisher-dispatch-rollout-control.cjs"
INVENTORY_HELPER="$ROOT_DIR/infra/scripts/commercial-ocr-runtime-inventory.mjs"
PUBLISHER_IDENTITY_PROBE_SCRIPT="apps/api/dist/apps/api/src/scripts/attest-publisher-identity.js"
PUBLISHER_IDENTITY_PROBE_SUCCESS="PUBLISHER_IDENTITY_ATTESTED"
PUBLIC_HEALTH_URL="${MAXIM_VPS_PUBLIC_URL:-${MAXIM_PUBLIC_HEALTH_URL:-https://major-maksimov.ru}}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL%/}"
READINESS_TIMEOUT_SEC="${MAXIM_PUBLISHER_ROLLOUT_READINESS_TIMEOUT_SEC:-600}"
STABILITY_WINDOW_SEC="${MAXIM_PUBLISHER_ROLLOUT_STABILITY_WINDOW_SEC:-30}"
COMMAND_TIMEOUT_SEC="${MAXIM_PUBLISHER_ROLLOUT_COMMAND_TIMEOUT_SEC:-30}"
READINESS_PROBE_MAX_SEC=0
IDENTITY_PROBE_TIMEOUT_SEC="${MAXIM_PUBLISHER_IDENTITY_PROBE_TIMEOUT_SEC:-20}"
DOCKER_MUTATION_TIMEOUT_SEC=60
READINESS_DIAGNOSTIC_MAX_BYTES=262144

ACTION_AND_PUBLISHER_WAVE=("api-action" "api-publisher")
ADMIN_WAVE=("api-admin")
INGRESS_WAVE=("api-ingress")
MEDIA_WAVE=("api-media-analysis")
MODERATION_WAVE=(
  "api-moderation"
  "api-moderation-critical"
  "api-moderation-join"
  "api-moderation-realtime-b"
  "api-moderation-realtime-c"
  "api-moderation-realtime-d"
  "api-moderation-background"
)
ENQUEUE_WAVE=("api-enqueue")
HTTP_READY_SERVICES=("api-ingress" "api-admin" "api-media-analysis")

# Compose interpolation gives exported variables precedence over the production dotenv.
# The rollout target must come only from the atomically patched file.
unset \
  MAX_PUBLISHER_DISPATCH_ENABLED \
  MAXIM_COMPOSE_SERVICE_ENV_FILE \
  MAXIM_API_IMAGE \
  COMMERCIAL_OCR_ROLLOUT_MODE \
  COMMERCIAL_OCR_CANARY_CHAT_IDS \
  COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64 \
  MODERATION_DELETE_INTENT_MODE \
  MODERATION_DELETE_INTENT_CANARY_CHAT_IDS \
  MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS \
  MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED
export MAXIM_COMPOSE_SERVICE_ENV_FILE=../.env

COMMAND="${1:-}"
APPLY=0
DESIRED_STATE=""
MANIFEST_SOURCE_SHA=""
MANIFEST_IMAGE_REF=""
MANIFEST_IMAGE_ID=""
EXPECTED_OCR_VERSION=""
CURRENT_ENV_STATE=""
CURRENT_ENV_CONFIGURED=""
PREVIEW_ENV_FILE=""
OPERATOR_OWNER_TOKEN=""
EXPECTED_HEARTBEAT_STATE=""
OPERATOR_PAUSE_ARMED=0
POST_CLEAR_REARM_REQUIRED=0
ROLLOUT_COMPLETE=0

usage() {
  cat <<'USAGE'
Usage:
  ./infra/scripts/vps-publisher-dispatch-rollout.sh status
  ./infra/scripts/vps-publisher-dispatch-rollout.sh enable [--apply]
  ./infra/scripts/vps-publisher-dispatch-rollout.sh disable [--apply]

Enable and disable are read-only previews unless --apply is supplied. Applied operations recreate
all shared API roles from the exact active image without building, migrating, or touching stateful
services. An incomplete operation leaves the bot-scoped operator pause armed.
USAGE
}

fail() {
  printf '%s\n' "$1" >&2
  return 1
}

cleanup() {
  local status=$?
  if [[ "$status" -ne 0 && "$APPLY" -eq 1 &&
        "${POST_CLEAR_REARM_REQUIRED:-0}" -eq 1 && "$ROLLOUT_COMPLETE" -ne 1 ]]; then
    if best_effort_rearm_operator_pause; then
      POST_CLEAR_REARM_REQUIRED=0
    fi
  fi
  maxim_webhook_rollout_warn_if_paused || true
  if [[ "$status" -ne 0 && "$APPLY" -eq 1 &&
        "${POST_CLEAR_REARM_REQUIRED:-0}" -eq 1 && "$ROLLOUT_COMPLETE" -ne 1 ]]; then
    cat >&2 <<'RECOVERY'
CRITICAL: Publik dispatch rollout did not complete and the operator pause could not be confirmed.
Run the guarded recovery command immediately:
  ./infra/scripts/vps-connect.sh publisher-dispatch-disable --apply
RECOVERY
  elif [[ "$status" -ne 0 && "$APPLY" -eq 1 && "$OPERATOR_PAUSE_ARMED" -eq 1 && \
          "$ROLLOUT_COMPLETE" -ne 1 ]]; then
    cat >&2 <<'RECOVERY'
CRITICAL: Publik dispatch rollout did not complete; the operator pause remains armed.
Run the guarded recovery command after fixing the reported cause:
  ./infra/scripts/vps-connect.sh publisher-dispatch-disable --apply
RECOVERY
  fi
  if [[ -n "$PREVIEW_ENV_FILE" && "$PREVIEW_ENV_FILE" == /tmp/maxim-publisher-preview.* ]]; then
    rm -f -- "$PREVIEW_ENV_FILE"
    PREVIEW_ENV_FILE=""
  fi
  release_deploy_lock || true
  return "$status"
}

parse_args() {
  case "$COMMAND" in
    status)
      DESIRED_STATE=""
      ;;
    enable)
      DESIRED_STATE=true
      ;;
    disable)
      DESIRED_STATE=false
      ;;
    -h|--help|help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --apply)
        [[ "$COMMAND" != "status" ]] || fail "Status does not accept --apply."
        [[ "$APPLY" -eq 0 ]] || fail "--apply may be provided only once."
        APPLY=1
        ;;
      *)
        fail "Unknown publisher dispatch rollout option."
        ;;
    esac
    shift
  done
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 not found."
}

require_node_24() {
  [[ "$(node -p 'process.versions.node.split(".")[0]')" == "24" ]] ||
    fail "Node 24 is required for publisher dispatch rollout."
}

require_operational_limits() {
  if [[ ! "$READINESS_TIMEOUT_SEC" =~ ^[0-9]{2,3}$ ]] ||
    ((10#$READINESS_TIMEOUT_SEC < 30 || 10#$READINESS_TIMEOUT_SEC > 600)); then
    fail "Publisher rollout readiness timeout must be between 30 and 600 seconds."
  fi
  if [[ ! "$STABILITY_WINDOW_SEC" =~ ^[0-9]{1,2}$ ]] ||
    ((10#$STABILITY_WINDOW_SEC < 30 || 10#$STABILITY_WINDOW_SEC > 90 ||
      10#$STABILITY_WINDOW_SEC >= 10#$READINESS_TIMEOUT_SEC)); then
    fail "Publisher rollout stability window must be between 30 and 90 seconds and below readiness timeout."
  fi
  if [[ ! "$COMMAND_TIMEOUT_SEC" =~ ^[0-9]{2,3}$ ]] ||
    ((10#$COMMAND_TIMEOUT_SEC < 20 || 10#$COMMAND_TIMEOUT_SEC > 120)); then
    fail "Publisher rollout control/docker command timeout must be between 20 and 120 seconds."
  fi
  if [[ ! "$IDENTITY_PROBE_TIMEOUT_SEC" =~ ^[0-9]{2,3}$ ]] ||
    ((10#$IDENTITY_PROBE_TIMEOUT_SEC < 20 || 10#$IDENTITY_PROBE_TIMEOUT_SEC > 120)); then
    fail "Publisher identity probe timeout must be between 20 and 120 seconds."
  fi
  READINESS_TIMEOUT_SEC=$((10#$READINESS_TIMEOUT_SEC))
  STABILITY_WINDOW_SEC=$((10#$STABILITY_WINDOW_SEC))
  COMMAND_TIMEOUT_SEC=$((10#$COMMAND_TIMEOUT_SEC))
  IDENTITY_PROBE_TIMEOUT_SEC=$((10#$IDENTITY_PROBE_TIMEOUT_SEC))
  READINESS_PROBE_MAX_SEC=$((20 + 4 * COMMAND_TIMEOUT_SEC))
  if ((READINESS_TIMEOUT_SEC < STABILITY_WINDOW_SEC + 2 * READINESS_PROBE_MAX_SEC)); then
    fail "Publisher rollout readiness timeout is too short for two probes and its stability window."
  fi
}

require_topology() {
  local expected=(
    "api-ingress"
    "api-admin"
    "api-enqueue"
    "api-moderation"
    "api-moderation-critical"
    "api-moderation-join"
    "api-moderation-realtime-b"
    "api-moderation-realtime-c"
    "api-moderation-realtime-d"
    "api-moderation-background"
    "api-media-analysis"
    "api-action"
    "api-publisher"
  )
  local waves=(
    "${ACTION_AND_PUBLISHER_WAVE[@]}"
    "${ADMIN_WAVE[@]}"
    "${INGRESS_WAVE[@]}"
    "${MEDIA_WAVE[@]}"
    "${MODERATION_WAVE[@]}"
    "${ENQUEUE_WAVE[@]}"
  )
  [[ "${#MAXIM_PRODUCTION_API_SERVICES[@]}" -eq 13 ]] ||
    fail "Publisher rollout requires the reviewed 13-role API topology."
  [[ "${MAXIM_PRODUCTION_API_SERVICES[*]}" == "${expected[*]}" ]] ||
    fail "Publisher rollout production API topology is not the reviewed topology."
  [[ "${#waves[@]}" -eq 13 ]] || fail "Publisher rollout wave topology is incomplete."
  local service seen=()
  for service in "${waves[@]}"; do
    maxim_topology_contains "$service" "${MAXIM_PRODUCTION_API_SERVICES[@]}" ||
      fail "Publisher rollout wave contains an unknown API role."
    maxim_topology_contains "$service" "${seen[@]}" &&
      fail "Publisher rollout wave topology contains a duplicate role."
    seen+=("$service")
  done
  [[ "${#HTTP_READY_SERVICES[@]}" -eq 3 ]] ||
    fail "Publisher rollout HTTP readiness topology is incomplete."
}

manifest_field() {
  node "$ROOT_DIR/infra/scripts/release-manifest.mjs" field current api-shared "$1" \
    --state-dir "$RELEASE_STATE_DIR"
}

resolve_release_fence() {
  MANIFEST_SOURCE_SHA="$(manifest_field sourceSha)" ||
    fail "Current API release manifest source SHA is unavailable."
  MANIFEST_IMAGE_REF="$(manifest_field imageRef)" ||
    fail "Current API release manifest image ref is unavailable."
  MANIFEST_IMAGE_ID="$(manifest_field imageId)" ||
    fail "Current API release manifest image id is unavailable."
  local checkout_sha image_fence
  checkout_sha="$(git rev-parse --verify HEAD)" || fail "Current checkout SHA is unavailable."
  [[ "$MANIFEST_SOURCE_SHA" == "$checkout_sha" ]] ||
    fail "Current checkout does not match the active API release source SHA."
  [[ "$MANIFEST_SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]] ||
    fail "Active API release source SHA is invalid."
  [[ "$MANIFEST_IMAGE_REF" == "maxim-api:${MANIFEST_SOURCE_SHA}" ]] ||
    fail "Active API image ref is not the immutable source-SHA ref."
  [[ "$MANIFEST_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail "Active API image id is invalid."
  git diff --quiet -- . || fail "Tracked VPS checkout changes block publisher rollout."
  git diff --cached --quiet -- . || fail "Staged VPS checkout changes block publisher rollout."
  image_fence="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker image inspect \
      --format '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "com.maxim.release-protected"}}' \
      "$MANIFEST_IMAGE_REF" 2>/dev/null
  )" || fail "Active API image is unavailable."
  [[ "$image_fence" == "${MANIFEST_IMAGE_ID}|${MANIFEST_SOURCE_SHA}|true" ]] ||
    fail "Active API image does not match its manifest and protected revision labels."
  EXPECTED_OCR_VERSION="$(maxim_topology_git_commercial_ocr_version "$MANIFEST_SOURCE_SHA")" ||
    fail "Could not derive the exact Commercial OCR version from the active source."
  export MAXIM_API_IMAGE="$MANIFEST_IMAGE_REF"
  export COMMERCIAL_OCR_VERSION="$EXPECTED_OCR_VERSION"
}

read_dispatch_env() {
  node "$STATE_HELPER" read-env .env
}

read_dispatch_env_configured() {
  node "$STATE_HELPER" read-env-configured .env
}

verify_compose_config() {
  local expected_state="$1"
  if ! docker compose "${COMPOSE_FILES[@]}" config --format json 2>/dev/null |
    node "$STATE_HELPER" verify-compose "$expected_state" "$MANIFEST_IMAGE_REF"; then
    fail "Compose does not define the exact reviewed 13-role publisher runtime on the active image."
  fi
}

verify_preview_compose_config() {
  local expected_state="$1"
  PREVIEW_ENV_FILE="$(mktemp /tmp/maxim-publisher-preview.XXXXXX)" ||
    fail "Could not create a private publisher preview dotenv."
  install -m 0600 .env "$PREVIEW_ENV_FILE" ||
    fail "Could not prepare a private publisher preview dotenv."
  node "$STATE_HELPER" patch-env "$PREVIEW_ENV_FILE" "$expected_state" ||
    fail "Could not prepare the requested publisher preview state."
  if ! MAXIM_COMPOSE_SERVICE_ENV_FILE="$PREVIEW_ENV_FILE" \
    docker compose --env-file "$PREVIEW_ENV_FILE" -p infra -f "infra/docker-compose.yml" \
      config --format json 2>/dev/null |
    node "$STATE_HELPER" verify-compose "$expected_state" "$MANIFEST_IMAGE_REF"; then
    fail "Compose cannot render the requested publisher dispatch target across all 13 API roles."
  fi
  rm -f -- "$PREVIEW_ENV_FILE"
  PREVIEW_ENV_FILE=""
}

container_env_summary() {
  local container_id="$1"
  timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" 2>/dev/null |
    node -e '
      const { readFileSync } = require("node:fs");
      const allowed = new Set([
        "APP_ROLE",
        "APP_SERVICE_NAME",
        "MAX_PUBLISHER_DISPATCH_ENABLED",
      ]);
      const result = {};
      for (const line of readFileSync(0, "utf8").split(/\r?\n/u)) {
        const separator = line.indexOf("=");
        if (separator < 1) continue;
        const key = line.slice(0, separator);
        if (!allowed.has(key)) continue;
        if (Object.hasOwn(result, key)) process.exit(3);
        result[key] = line.slice(separator + 1);
      }
      process.stdout.write(JSON.stringify(result));
    '
}

verify_no_unreviewed_running_api_containers() {
  local running_raw inventory
  local running=()
  running_raw="$(timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" docker ps --no-trunc -q)" || {
    fail "Could not inspect running Docker containers."
    return 1
  }
  [[ -z "$running_raw" ]] || mapfile -t running <<<"$running_raw"
  if [[ "${#running[@]}" -eq 0 ]]; then
    inventory="$(
      printf '%s\n' '[]' |
        node "$INVENTORY_HELPER" "$MANIFEST_IMAGE_ID" "${MAXIM_PRODUCTION_API_SERVICES[@]}"
    )" || {
      fail "Could not classify the running API inventory."
      return 1
    }
  else
    inventory="$(
      timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
        docker inspect "${running[@]}" |
        node "$INVENTORY_HELPER" "$MANIFEST_IMAGE_ID" "${MAXIM_PRODUCTION_API_SERVICES[@]}"
    )" || {
      fail "Could not classify the running API inventory."
      return 1
    }
  fi
  if ! printf '%s' "$inventory" | node -e '
    const { readFileSync } = require("node:fs");
    const value = JSON.parse(readFileSync(0, "utf8"));
    process.exit(
      Array.isArray(value?.ownedUnreviewedIds) && value.ownedUnreviewedIds.length === 0 &&
      Array.isArray(value?.ambiguousIds) && value.ambiguousIds.length === 0 ? 0 : 1
    );
  '; then
    fail "An owned-unreviewed, ambiguous, foreign, orphaned, or duplicate API container is running."
    return 1
  fi
}

verify_runtime() {
  local expected_state="$1"
  local state_policy="${2:-running}"
  local service container_ids_raw image_id env_summary
  local container_ids=()
  local ps_args=(ps --status running -q)
  if [[ "$state_policy" == "allow-stopped" ]]; then
    ps_args=(ps -a -q)
  elif [[ "$state_policy" != "running" ]]; then
    fail "Publisher runtime verification state policy is invalid."
    return 1
  fi
  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    container_ids_raw="$(
      timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
        docker compose "${COMPOSE_FILES[@]}" "${ps_args[@]}" "$service" 2>/dev/null
    )" || {
      fail "Could not inspect a production API role."
      return 1
    }
    container_ids=()
    [[ -z "$container_ids_raw" ]] || mapfile -t container_ids <<<"$container_ids_raw"
    if [[ "${#container_ids[@]}" -ne 1 ]]; then
      fail "A production API role is missing, stopped, or unexpectedly scaled."
      return 1
    fi
    image_id="$(
      timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
        docker inspect --format '{{.Image}}' "${container_ids[0]}" 2>/dev/null
    )" || {
      fail "Could not inspect a production API role image."
      return 1
    }
    if [[ "$image_id" != "$MANIFEST_IMAGE_ID" ]]; then
      fail "A production API role does not run the exact active image."
      return 1
    fi
    env_summary="$(container_env_summary "${container_ids[0]}")" || {
      fail "Could not inspect a production API role identity."
      return 1
    }
    if ! printf '%s' "$env_summary" |
      node "$STATE_HELPER" verify-runtime-env "$expected_state" "$service"; then
      fail "A production API role does not match its exact service, APP_ROLE, or dispatch state."
      return 1
    fi
  done
  verify_no_unreviewed_running_api_containers || return 1
}

require_stateful_services_ready() {
  local running service
  running="$(docker compose "${COMPOSE_FILES[@]}" ps --status running --services)" ||
    fail "Could not inspect stateful service status."
  for service in postgres redis; do
    grep -Fxq "$service" <<<"$running" ||
      fail "$service is not already running; publisher rollout will not start or recreate it."
  done
  timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
    docker compose "${COMPOSE_FILES[@]}" exec -T postgres \
      pg_isready -U maxim -d maxim >/dev/null 2>&1 || fail "Postgres is not ready."
  timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
    docker compose "${COMPOSE_FILES[@]}" exec -T redis redis-cli ping 2>/dev/null |
    grep -Fxq PONG || fail "Redis is not ready."
}

control_field() {
  local summary="$1" field="$2"
  printf '%s' "$summary" | node -e '
    const { readFileSync } = require("node:fs");
    const value = JSON.parse(readFileSync(0, "utf8"));
    const allowed = new Set([
      "result", "pauseKind", "heartbeatKind", "heartbeatEnabled"
    ]);
    const field = process.argv[1];
    if (!allowed.has(field) || !Object.hasOwn(value, field)) process.exit(2);
    const selected = value[field];
    if (selected !== null && !["string", "boolean"].includes(typeof selected)) process.exit(2);
    process.stdout.write(selected === null ? "null" : String(selected));
  ' "$field"
}

publisher_control() {
  local action="$1"
  local env_args=()
  if [[ "$action" == "arm-enable" || "$action" == "arm-disable" || "$action" == "clear" ]]; then
    [[ -n "$OPERATOR_OWNER_TOKEN" ]] || fail "Publisher operator ownership is unavailable."
    env_args=(-e "MAXIM_PUBLISHER_ROLLOUT_OWNER_TOKEN=$OPERATOR_OWNER_TOKEN")
  elif [[ "$action" == "assert-heartbeat" ]]; then
    [[ "$EXPECTED_HEARTBEAT_STATE" == "true" || "$EXPECTED_HEARTBEAT_STATE" == "false" ]] ||
      fail "Expected publisher heartbeat state is invalid."
    env_args=(-e "MAXIM_PUBLISHER_EXPECTED_HEARTBEAT=$EXPECTED_HEARTBEAT_STATE")
  fi
  if [[ "$action" == "arm-enable" || "$action" == "arm-disable" || "$action" == "clear" ]]; then
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker compose "${COMPOSE_FILES[@]}" run --rm --no-deps --pull never -T \
        -e MAX_PUBLISHER_BOT_ID=se14088825_bot "${env_args[@]}" \
        api-action node - "$action" <"$CONTROL_HELPER"
    return
  fi
  timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
    docker compose "${COMPOSE_FILES[@]}" exec -T \
      -e MAX_PUBLISHER_BOT_ID=se14088825_bot "${env_args[@]}" \
      api-admin node - "$action" <"$CONTROL_HELPER"
}

read_control_status() {
  publisher_control status
}

arm_operator_pause() {
  local random_hex summary result
  random_hex="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')" ||
    fail "Could not generate publisher rollout ownership."
  [[ "$random_hex" =~ ^[a-f0-9]{64}$ ]] || fail "Publisher rollout ownership is invalid."
  OPERATOR_OWNER_TOKEN="publisher-rollout:$random_hex"
  summary="$(publisher_control "arm-${COMMAND}")" || fail "Could not arm publisher operator pause."
  result="$(control_field "$summary" result)" || fail "Publisher pause result is invalid."
  [[ "$result" == "acquired" ]] ||
    fail "Publisher dispatch already has a pause that this operation cannot safely own."
  OPERATOR_PAUSE_ARMED=1
  printf '%s\n' "Publik operator pause armed."
}

best_effort_rearm_operator_pause() {
  local random_hex summary result pause_kind
  random_hex="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')" || {
    printf '%s\n' \
      'CRITICAL: Could not generate ownership while re-arming the Publik operator pause.' >&2
    return 1
  }
  if [[ ! "$random_hex" =~ ^[a-f0-9]{64}$ ]]; then
    printf '%s\n' \
      'CRITICAL: Generated invalid ownership while re-arming the Publik operator pause.' >&2
    return 1
  fi
  OPERATOR_OWNER_TOKEN="publisher-rollout:$random_hex"
  # A timeout after the Redis request is ambiguous. Keep cleanup armed until a confirmed result.
  OPERATOR_PAUSE_ARMED=1
  if ! summary="$(publisher_control arm-disable)"; then
    printf '%s\n' \
      'CRITICAL: Publik operator pause re-arm was not confirmed; guarded disable is required.' >&2
    return 1
  fi
  result="$(control_field "$summary" result)" || {
    printf '%s\n' 'CRITICAL: Publik operator pause re-arm returned an invalid result.' >&2
    return 1
  }
  pause_kind="$(control_field "$summary" pauseKind)" || {
    printf '%s\n' 'CRITICAL: Publik operator pause re-arm returned an invalid pause state.' >&2
    return 1
  }
  if [[ "$result" != "acquired" || "$pause_kind" != "operator" ]]; then
    printf '%s\n' \
      'CRITICAL: Publik operator pause re-arm did not acquire the reviewed operator marker.' >&2
    return 1
  fi
  printf '%s\n' 'Publik operator pause re-armed after post-enable stability failure.'
}

clear_operator_pause() {
  local summary result pause_kind
  summary="$(publisher_control clear)" || fail "Could not clear the owned publisher operator pause."
  result="$(control_field "$summary" result)" || fail "Publisher pause clear result is invalid."
  pause_kind="$(control_field "$summary" pauseKind)" ||
    fail "Publisher pause state after clear is invalid."
  if [[ "$result" == "cleared" || "$result" == "not_owned" ]]; then
    # The Redis mutation proved this process no longer owns an operator marker.
    OPERATOR_PAUSE_ARMED=0
  fi
  if [[ "$COMMAND" == "enable" ]]; then
    [[ "$result" == "cleared" && "$pause_kind" == "missing" ]] ||
      fail "Publisher operator pause was replaced by another fail-closed pause during enable."
  else
    if [[ "$result" == "cleared" ]]; then
      [[ "$pause_kind" == "missing" || "$pause_kind" == "authorization" ]] ||
        fail "Publisher disable restored an unreviewed pause state."
    else
      [[ "$result" == "not_owned" && "$pause_kind" == "authorization" ]] ||
        fail "Publisher operator pause ownership changed during disable."
    fi
  fi
  printf 'Publik operator pause released: retained_pause=%s\n' \
    "$([[ "$pause_kind" == "missing" ]] && printf '%s' no || printf '%s' yes)"
}

patch_dispatch_env() {
  node "$STATE_HELPER" patch-env .env "$DESIRED_STATE"
  [[ "$(read_dispatch_env)" == "$DESIRED_STATE" ]] ||
    fail "Production dotenv did not reach the requested publisher dispatch state."
}

wait_for_service_running() {
  local service="$1" deadline=$((SECONDS + READINESS_TIMEOUT_SEC))
  while ((SECONDS < deadline)); do
    if docker compose "${COMPOSE_FILES[@]}" ps --status running --services 2>/dev/null |
      grep -Fxq "$service"; then
      return 0
    fi
    sleep 1
  done
  fail "A recreated publisher rollout service did not become running."
}

recreate_wave() {
  local label="$1"
  shift
  local services=("$@") service
  maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
  printf 'Recreating publisher rollout wave: %s\n' "$label"
  timeout --foreground --kill-after=5s "${DOCKER_MUTATION_TIMEOUT_SEC}s" \
    docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --no-build --pull never \
      --force-recreate "${services[@]}" >/dev/null
  for service in "${services[@]}"; do
    wait_for_service_running "$service"
  done
}

recreate_all_api_roles() {
  maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES
  recreate_wave "action and publisher" "${ACTION_AND_PUBLISHER_WAVE[@]}"
  recreate_wave "admin" "${ADMIN_WAVE[@]}"
  recreate_wave "ingress" "${INGRESS_WAVE[@]}"
  recreate_wave "media analysis" "${MEDIA_WAVE[@]}"
  recreate_wave "moderation" "${MODERATION_WAVE[@]}"
  recreate_wave "enqueue" "${ENQUEUE_WAVE[@]}"
  maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
}

wait_for_url() {
  local url="$1" deadline=$((SECONDS + READINESS_TIMEOUT_SEC))
  while ((SECONDS < deadline)); do
    if curl -fsS --connect-timeout 2 --max-time 5 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "Publisher rollout health endpoint did not become ready."
}

api_runtime_signature() {
  local container_ids_raw inspect_raw service container_id restart_count state extra
  local container_ids=()
  local -A signatures=()
  container_ids_raw="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker compose "${COMPOSE_FILES[@]}" ps --status running -q \
      "${MAXIM_PRODUCTION_API_SERVICES[@]}" 2>/dev/null
  )" || return 1
  [[ -z "$container_ids_raw" ]] || mapfile -t container_ids <<<"$container_ids_raw"
  [[ "${#container_ids[@]}" -eq 13 ]] || return 1
  inspect_raw="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker inspect --format \
      '{{index .Config.Labels "com.docker.compose.service"}}|{{.Id}}|{{.RestartCount}}|{{.State.Status}}' \
      "${container_ids[@]}" 2>/dev/null
  )" || return 1
  while IFS='|' read -r service container_id restart_count state extra; do
    [[ -n "$service" && -n "$container_id" && -z "$extra" ]] || return 1
    maxim_topology_contains "$service" "${MAXIM_PRODUCTION_API_SERVICES[@]}" || return 1
    [[ -z "${signatures[$service]+present}" ]] || return 1
    [[ "$container_id" =~ ^[a-f0-9]{64}$ && "$restart_count" =~ ^[0-9]+$ && \
      "$state" == "running" ]] || return 1
    signatures[$service]="$container_id|$restart_count"
  done <<<"$inspect_raw"
  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    [[ -n "${signatures[$service]+present}" ]] || return 1
    printf '%s|%s\n' "$service" "${signatures[$service]}"
  done
}

api_media_readiness_endpoint_ready() {
  local container_ids_raw
  local container_ids=()
  container_ids_raw="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker compose "${COMPOSE_FILES[@]}" ps --status running -q api-media-analysis \
      2>/dev/null
  )" || return 1
  [[ -z "$container_ids_raw" ]] || mapfile -t container_ids <<<"$container_ids_raw"
  [[ "${#container_ids[@]}" -eq 1 ]] || return 1
  timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
    docker exec "${container_ids[0]}" node -e \
    'fetch("http://127.0.0.1:3001/api/health/ready", { signal: AbortSignal.timeout(3000) }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));' \
    >/dev/null 2>&1
}

all_api_readiness_endpoints_ready() {
  curl -fsS --connect-timeout 2 --max-time 5 \
    http://127.0.0.1:3001/api/health/ready >/dev/null 2>&1 &&
    curl -fsS --connect-timeout 2 --max-time 5 \
      http://127.0.0.1:3002/api/health/ready >/dev/null 2>&1 &&
    api_media_readiness_endpoint_ready
}

readiness_diagnostic_javascript() {
  cat <<'NODE'
const [service, url, maxBytesRaw] = process.argv.slice(1);
const maxBytes = Number(maxBytesRaw);
const finite = (value) => (Number.isFinite(value) ? value : null);
const bounded = (value) => (typeof value === 'string' ? value.slice(0, 64) : null);
void (async () => {
  let httpStatus = null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    httpStatus = response.status;
    const declaredBytes = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) throw new Error('bounded');
    if (!response.body) throw new Error('missing_body');
    const reader = response.body.getReader();
    const chunks = [];
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel();
        throw new Error('bounded');
      }
      chunks.push(Buffer.from(value));
    }
    const body = Buffer.concat(chunks, receivedBytes).toString('utf8');
    const snapshot = JSON.parse(body);
    const queue = snapshot?.checks?.queueLag;
    const ocr = snapshot?.checks?.ocr;
    process.stdout.write(
      `Publisher readiness diagnostic: ${JSON.stringify({
        service,
        probe: 'ok',
        httpStatus,
        ok: snapshot?.ok === true,
        database: snapshot?.checks?.database === true,
        redis: snapshot?.checks?.redis === true,
        queue: queue
          ? {
              ok: queue.ok === true,
              effectiveSec: finite(queue.effectiveLagSec),
              breachSec: finite(queue.breachDurationSec),
            }
          : null,
        ocr: ocr
          ? {
              ready: ocr.ready === true,
              state: bounded(ocr.state),
              liveWorkers: finite(ocr.workers?.live),
              readyWorkers: finite(ocr.workers?.ready),
              identity: bounded(ocr.behaviorIdentity?.state),
            }
          : null,
      })}\n`,
    );
  } catch (error) {
    const probe =
      error?.message === 'bounded'
        ? 'body_too_large'
        : error?.name === 'AbortError' || error?.name === 'TimeoutError'
          ? 'timeout'
          : 'failed';
    process.stdout.write(
      `Publisher readiness diagnostic: ${JSON.stringify({ service, probe, httpStatus })}\n`,
    );
  }
})().catch(() => {
  process.stdout.write(
    `Publisher readiness diagnostic: ${JSON.stringify({ service, probe: 'failed' })}\n`,
  );
});
NODE
}

emit_api_readiness_endpoint_diagnostic() {
  local service="$1" location="$2" url="$3" javascript container_ids_raw
  local container_ids=()
  javascript="$(readiness_diagnostic_javascript)"
  if [[ "$location" == "host" ]]; then
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      node -e "$javascript" "$service" "$url" "$READINESS_DIAGNOSTIC_MAX_BYTES" ||
      printf 'Publisher readiness diagnostic: service=%s probe=command_failed\n' "$service"
    return
  fi
  container_ids_raw="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker compose "${COMPOSE_FILES[@]}" ps -a -q "$service" 2>/dev/null
  )" || {
    printf 'Publisher readiness diagnostic: service=%s probe=compose_failed\n' "$service"
    return
  }
  [[ -z "$container_ids_raw" ]] || mapfile -t container_ids <<<"$container_ids_raw"
  if [[ "${#container_ids[@]}" -ne 1 ]]; then
    printf 'Publisher readiness diagnostic: service=%s container_count=%s\n' \
      "$service" "${#container_ids[@]}"
    return
  fi
  timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
    docker exec "${container_ids[0]}" node -e "$javascript" \
      "$service" "$url" "$READINESS_DIAGNOSTIC_MAX_BYTES" ||
    printf 'Publisher readiness diagnostic: service=%s probe=command_failed\n' "$service"
}

emit_api_runtime_signature_diagnostics() {
  local baseline_signature="$1" current_signature compose_state
  local service container_id restart_count extra match
  local -A baseline=()
  while IFS='|' read -r service container_id restart_count extra; do
    [[ -n "$service" && -n "$container_id" && "$restart_count" =~ ^[0-9]+$ && \
      -z "$extra" ]] || continue
    baseline[$service]="$container_id|$restart_count"
  done <<<"$baseline_signature"
  current_signature="$(api_runtime_signature)" || current_signature=""
  if [[ -n "$current_signature" ]]; then
    while IFS='|' read -r service container_id restart_count extra; do
      match=unavailable
      if [[ -n "${baseline[$service]+present}" ]]; then
        if [[ "${baseline[$service]}" == "$container_id|$restart_count" ]]; then
          match=true
        else
          match=false
        fi
      fi
      printf 'Publisher runtime diagnostic: service=%s state=running restarts=%s baseline_match=%s\n' \
        "$service" "$restart_count" "$match"
    done <<<"$current_signature"
    return
  fi
  compose_state="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker compose "${COMPOSE_FILES[@]}" ps -a --format '{{.Service}}|{{.State}}' \
      "${MAXIM_PRODUCTION_API_SERVICES[@]}" 2>/dev/null
  )" || compose_state=""
  printf '%s\n' 'Publisher runtime diagnostic: signature=unavailable'
  while IFS='|' read -r service state extra; do
    maxim_topology_contains "$service" "${MAXIM_PRODUCTION_API_SERVICES[@]}" || continue
    printf 'Publisher runtime diagnostic: service=%s state=%s\n' "$service" "$state"
  done <<<"$compose_state"
}

emit_api_readiness_timeout_diagnostics() {
  local baseline_signature="$1"
  emit_api_readiness_endpoint_diagnostic \
    api-ingress host http://127.0.0.1:3001/api/health/ready
  emit_api_readiness_endpoint_diagnostic \
    api-admin host http://127.0.0.1:3002/api/health/ready
  emit_api_readiness_endpoint_diagnostic \
    api-media-analysis container http://127.0.0.1:3001/api/health/ready
  emit_api_runtime_signature_diagnostics "$baseline_signature"
}

wait_for_api_readiness() {
  local deadline=$((SECONDS + READINESS_TIMEOUT_SEC))
  local probe_max_sec="${READINESS_PROBE_MAX_SEC:-1}"
  local stable_since=-1 stable_signature="" current_signature="" last_signature=""
  while ((SECONDS + probe_max_sec <= deadline)); do
    if all_api_readiness_endpoints_ready; then
      ((SECONDS < deadline)) || break
      current_signature="$(api_runtime_signature)" || current_signature=""
      ((SECONDS < deadline)) || break
      if [[ -n "$current_signature" ]]; then
        last_signature="$current_signature"
        if [[ "$current_signature" != "$stable_signature" ]]; then
          stable_signature="$current_signature"
          stable_since=$SECONDS
        elif ((SECONDS - stable_since >= STABILITY_WINDOW_SEC && SECONDS < deadline)); then
          return 0
        fi
      else
        stable_signature=""
        stable_since=-1
      fi
    else
      stable_signature=""
      stable_since=-1
    fi
    ((SECONDS < deadline)) && sleep 1
  done
  if [[ "${POST_CLEAR_REARM_REQUIRED:-0}" -ne 1 ]]; then
    emit_api_readiness_timeout_diagnostics "$last_signature"
  fi
  fail "All 13 API roles did not pass continuous readiness and restart stability."
}

run_health_smokes() {
  wait_for_url http://127.0.0.1:3001/api/health/live
  wait_for_url http://127.0.0.1:3002/api/health/live
  wait_for_api_readiness
  wait_for_url "$PUBLIC_HEALTH_URL/api/health/live"
  node scripts/smoke-http.mjs json-ok http://127.0.0.1:3001/api/health/live >/dev/null
  node scripts/smoke-http.mjs json-ok http://127.0.0.1:3001/api/health/ready >/dev/null
  node scripts/smoke-http.mjs json-ok http://127.0.0.1:3002/api/health/live >/dev/null
  node scripts/smoke-http.mjs json-ok http://127.0.0.1:3002/api/health/ready >/dev/null
  node scripts/smoke-http.mjs json-ok "$PUBLIC_HEALTH_URL/api/health/live" >/dev/null
}

wait_for_heartbeat() {
  local heartbeat_expected="$1" deadline=$((SECONDS + READINESS_TIMEOUT_SEC))
  EXPECTED_HEARTBEAT_STATE="$heartbeat_expected"
  while ((SECONDS < deadline)); do
    if publisher_control assert-heartbeat >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "Publik runtime heartbeat did not reach the exact requested dispatch state."
}

run_publisher_identity_probe() {
  local output
  if ! docker compose "${COMPOSE_FILES[@]}" exec -T api-publisher \
    test -f "$PUBLISHER_IDENTITY_PROBE_SCRIPT"; then
    fail "The exact active publisher image lacks the identity attestation probe."
    return 1
  fi
  if ! output="$(
    timeout --foreground --kill-after=2s "${IDENTITY_PROBE_TIMEOUT_SEC}s" \
      docker compose "${COMPOSE_FILES[@]}" exec -T api-publisher \
      node "$PUBLISHER_IDENTITY_PROBE_SCRIPT" 2>/dev/null
  )"; then
    fail "Publik identity attestation failed closed."
    return 1
  fi
  [[ "$output" == "$PUBLISHER_IDENTITY_PROBE_SUCCESS" ]] ||
    fail "Publik identity attestation returned an invalid result."
  printf '%s\n' "Publik action identity and webhook target attested."
}

publisher_secret_state() {
  local path mode size
  for path in "${MAXIM_PUBLISHER_SECRET_FILES[@]}"; do
    [[ -f "$path" && ! -L "$path" ]] || return 1
    mode="$(stat -c '%a' "$path" 2>/dev/null || true)"
    size="$(stat -c '%s' "$path" 2>/dev/null || true)"
    [[ "$mode" == "600" && "$size" =~ ^[1-9][0-9]{0,4}$ && "$size" -le 16384 ]] ||
      return 1
  done
}

status_command() {
  local control pause_kind heartbeat_kind heartbeat_enabled runtime_parity secrets
  local current_expected="$CURRENT_ENV_STATE"
  [[ "$CURRENT_ENV_CONFIGURED" == "true" ]] || current_expected=default-false
  if verify_runtime "$current_expected" >/dev/null 2>&1; then
    runtime_parity=exact
  else
    verify_runtime any
    runtime_parity=mixed
  fi
  control="$(read_control_status)" || fail "Could not read privacy-safe publisher runtime status."
  pause_kind="$(control_field "$control" pauseKind)"
  heartbeat_kind="$(control_field "$control" heartbeatKind)"
  heartbeat_enabled="$(control_field "$control" heartbeatEnabled)"
  if publisher_secret_state; then secrets=ready; else secrets=missing; fi
  printf 'Publik dispatch status: env=%s runtime=%s pause=%s heartbeat=%s/%s secrets=%s\n' \
    "$CURRENT_ENV_STATE" "$runtime_parity" "$pause_kind" "$heartbeat_kind" \
    "$heartbeat_enabled" "$secrets"
}

rollout_preflight() {
  local control pause_kind
  local current_expected="$CURRENT_ENV_STATE"
  local runtime_state_policy=running
  [[ "$CURRENT_ENV_CONFIGURED" == "true" ]] || current_expected=default-false
  if [[ "$COMMAND" == "disable" && "$APPLY" -eq 1 && \
        "$MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE" == "1" ]]; then
    runtime_state_policy=allow-stopped
  fi
  verify_runtime any "$runtime_state_policy"
  verify_compose_config "$current_expected"
  verify_preview_compose_config "$DESIRED_STATE"
  maxim_topology_require_api_commercial_ocr_version_config \
    COMPOSE_FILES "$EXPECTED_OCR_VERSION" required
  maxim_topology_require_media_analysis_shadow_config COMPOSE_FILES
  require_stateful_services_ready
  if [[ "$COMMAND" == "enable" ]]; then
    maxim_topology_require_publisher_secret_files
    verify_runtime "$current_expected"
    control="$(read_control_status)" || fail "Could not read publisher pause state."
    pause_kind="$(control_field "$control" pauseKind)"
    [[ "$pause_kind" == "missing" ]] ||
      fail "Publisher enable requires a missing auth/operator pause; recover with guarded disable first."
  fi
}

apply_rollout() {
  arm_operator_pause
  patch_dispatch_env
  verify_compose_config "$DESIRED_STATE"
  maxim_topology_require_api_commercial_ocr_version_config \
    COMPOSE_FILES "$EXPECTED_OCR_VERSION" required
  maxim_topology_require_media_analysis_shadow_config COMPOSE_FILES
  recreate_all_api_roles
  verify_runtime "$DESIRED_STATE"
  wait_for_url http://127.0.0.1:3001/api/health/live
  wait_for_url http://127.0.0.1:3002/api/health/live
  wait_for_heartbeat false
  maxim_webhook_resume_after_api_fence COMPOSE_FILES
  run_health_smokes
  verify_runtime "$DESIRED_STATE"
  maxim_topology_verify_api_commercial_ocr_version COMPOSE_FILES "$EXPECTED_OCR_VERSION"
  maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required

  if [[ "$COMMAND" == "enable" ]]; then
    run_publisher_identity_probe
    POST_CLEAR_REARM_REQUIRED=1
    clear_operator_pause
    if ! wait_for_heartbeat true ||
      ! wait_for_api_readiness ||
      ! verify_runtime "$DESIRED_STATE"; then
      if best_effort_rearm_operator_pause; then
        POST_CLEAR_REARM_REQUIRED=0
      fi
      return 1
    fi
    POST_CLEAR_REARM_REQUIRED=0
  else
    clear_operator_pause
    wait_for_heartbeat false
    verify_runtime "$DESIRED_STATE"
  fi
  ROLLOUT_COMPLETE=1
  printf 'Publik dispatch rollout complete: enabled=%s roles=13 image=%s\n' \
    "$DESIRED_STATE" "$MANIFEST_SOURCE_SHA"
}

parse_args "$@"
require_command node
require_command git
require_command docker
require_command curl
require_command timeout
require_command install
require_node_24
require_operational_limits
require_topology
[[ -s "$STATE_HELPER" && -s "$CONTROL_HELPER" && -s "$INVENTORY_HELPER" ]] ||
  fail "Publisher rollout helpers are missing."
[[ -f .env && ! -L .env ]] || fail "Production .env must be a regular non-symlink file."
acquire_deploy_lock
trap cleanup EXIT
resolve_release_fence
CURRENT_ENV_STATE="$(read_dispatch_env)" || fail "Could not read publisher dispatch dotenv state."
CURRENT_ENV_CONFIGURED="$(read_dispatch_env_configured)" ||
  fail "Could not read publisher dispatch dotenv configuration."

if [[ "$COMMAND" == "status" ]]; then
  current_compose_expected="$CURRENT_ENV_STATE"
  [[ "$CURRENT_ENV_CONFIGURED" == "true" ]] || current_compose_expected=default-false
  verify_compose_config "$current_compose_expected"
  status_command
  exit 0
fi

rollout_preflight
if [[ "$APPLY" -ne 1 ]]; then
  printf 'Publik dispatch preflight passed: current=%s target=%s; no state changed.\n' \
    "$CURRENT_ENV_STATE" "$DESIRED_STATE"
  exit 0
fi
apply_rollout
