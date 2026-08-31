#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
# shellcheck source=infra/scripts/lib/deploy-topology.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"

MAIN_PROJECT_NAME="infra"
COMPOSE_FILES=(--env-file ".env" -p "$MAIN_PROJECT_NAME" -f "infra/docker-compose.yml")
RELEASE_STATE_DIR="${MAXIM_RELEASE_STATE_DIR:-/var/lib/maxim-deploy}"
EXPECTED_DEPLOY_SHA="${MAXIM_EXPECTED_DEPLOY_SHA:-}"
PUBLIC_HEALTH_URL="${MAXIM_VPS_PUBLIC_URL:-${MAXIM_PUBLIC_HEALTH_URL:-https://major-maksimov.ru}}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL%/}"
COMMAND_TIMEOUT_SEC="${MAXIM_FINALIZER_COMMAND_TIMEOUT_SEC:-30}"
STABILITY_WINDOW_SEC="${MAXIM_FINALIZER_STABILITY_WINDOW_SEC:-30}"
MAX_MIGRATIONS_FILE_BYTES=1048576
WEBHOOK_QUEUE_CONTROL_HELPER="$ROOT_DIR/infra/scripts/webhook-queue-rollout-control.cjs"
RUNTIME_INVENTORY_HELPER="$ROOT_DIR/infra/scripts/commercial-ocr-runtime-inventory.mjs"

BRANCH=""
RECOVERY_BASE_MANIFEST=""
MIGRATIONS_FILE=""
TARGET_COMMERCIAL_OCR_VERSION=""
TARGET_HAS_MEDIA_ANALYSIS=0
declare -A COMPONENT_IMAGE_REF=()
declare -A COMPONENT_IMAGE_ID=()
SMOKE_RESULTS=()

fail() {
  echo "$1" >&2
  return 1
}

finalizer_cleanup() {
  local exit_status=$?

  if [[ -n "$MIGRATIONS_FILE" ]] && ! rm -f -- "$MIGRATIONS_FILE"; then
    echo "Could not remove the recovery finalizer migration snapshot." >&2
  fi
  if ! release_deploy_lock; then
    echo "Could not release the recovery finalizer deploy lock." >&2
  fi
  return "$exit_status"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required recovery finalizer command is missing: $1"
}

validate_positive_int_range() {
  local name="$1"
  local value="$2"
  local minimum="$3"
  local maximum="$4"

  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]] ||
     ((value < minimum || value > maximum)); then
    fail "$name must be an integer between $minimum and $maximum."
  fi
}

validate_finalizer_environment() {
  local command_name

  if [[ ! "$EXPECTED_DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    fail "MAXIM_EXPECTED_DEPLOY_SHA must be the reviewed full lowercase Git SHA."
  fi
  if [[ -z "$BRANCH" || ! "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] ||
     [[ "$BRANCH" == *..* || "$BRANCH" == *//* || "$BRANCH" == */ ]]; then
    fail "Recovery finalizer branch is invalid."
  fi
  if [[ "$BRANCH" != "main" && "${MAXIM_ALLOW_NON_MAIN_DEPLOY:-0}" != "1" ]]; then
    fail "Recovery finalization outside main requires MAXIM_ALLOW_NON_MAIN_DEPLOY=1."
  fi
  validate_positive_int_range MAXIM_FINALIZER_COMMAND_TIMEOUT_SEC "$COMMAND_TIMEOUT_SEC" 20 120
  validate_positive_int_range MAXIM_FINALIZER_STABILITY_WINDOW_SEC "$STABILITY_WINDOW_SEC" 10 90
  for command_name in chmod curl docker git head mktemp node timeout; do
    require_command "$command_name"
  done
  if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'; then
    fail "Node 24 is required for release recovery finalization."
  fi
  if [[ ! -s ".env" ]]; then
    fail "Production .env is required and will not be synthesized by the recovery finalizer."
  fi
  for path in \
    "$WEBHOOK_QUEUE_CONTROL_HELPER" \
    "$RUNTIME_INVENTORY_HELPER" \
    "$ROOT_DIR/infra/scripts/release-manifest.mjs" \
    "$ROOT_DIR/scripts/smoke-http.mjs"; do
    [[ -s "$path" ]] || fail "Required recovery finalizer helper is missing: $path"
  done
}

verify_synchronized_checkout() {
  local head_sha
  local remote_sha

  head_sha="$(git rev-parse --verify HEAD)" || fail "Could not read the synchronized VPS HEAD."
  remote_sha="$(git rev-parse --verify "refs/remotes/origin/$BRANCH")" ||
    fail "Could not read the synchronized origin/$BRANCH ref."
  [[ "$head_sha" == "$EXPECTED_DEPLOY_SHA" ]] ||
    fail "VPS HEAD does not match the reviewed recovery finalizer SHA."
  [[ "$remote_sha" == "$EXPECTED_DEPLOY_SHA" ]] ||
    fail "origin/$BRANCH does not match the reviewed recovery finalizer SHA."
  git diff --quiet -- . || fail "Tracked VPS changes block release recovery finalization."
  git diff --cached --quiet -- . || fail "Staged VPS changes block release recovery finalization."
}

release_manifest() {
  MAXIM_RELEASE_STATE_DIR="$RELEASE_STATE_DIR" \
    node "$ROOT_DIR/infra/scripts/release-manifest.mjs" "$@"
}

require_missing_current_manifest() {
  local status

  if release_manifest validate-current >/dev/null 2>&1; then
    fail "A valid current release already exists; recovery finalization is not applicable."
  else
    status=$?
  fi
  [[ "$status" -eq 3 ]] ||
    fail "Current release inventory is invalid rather than absent; refusing finalization."
}

resolve_recovery_base_manifest() {
  require_missing_current_manifest
  RECOVERY_BASE_MANIFEST="$(release_manifest recovery-base)" ||
    fail "Recovery finalization requires exactly one complete typed transition journal."
  [[ -n "$RECOVERY_BASE_MANIFEST" ]] ||
    fail "Recovery finalization did not resolve a transition journal."
}

verify_recovery_base_unchanged() {
  local current_recovery_base

  require_missing_current_manifest
  current_recovery_base="$(release_manifest recovery-base)" ||
    fail "The recovery transition journal is no longer uniquely valid."
  [[ "$current_recovery_base" == "$RECOVERY_BASE_MANIFEST" ]] ||
    fail "The recovery transition journal changed during finalization."
}

expected_component_ref() {
  case "$1" in
    api-shared) printf 'maxim-api:%s' "$EXPECTED_DEPLOY_SHA" ;;
    miniapp-major-static) printf 'maxim-miniapp-major:%s' "$EXPECTED_DEPLOY_SHA" ;;
    admin-static) printf 'maxim-admin:%s' "$EXPECTED_DEPLOY_SHA" ;;
    *) fail "Unknown recovery finalizer component: $1" ;;
  esac
}

inspect_target_image() {
  local component="$1"
  local image_ref="$2"
  local inspection
  local image_id
  local revision
  local protected
  local extra

  inspection="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker image inspect \
        --format '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "com.maxim.release-protected"}}' \
        "$image_ref" 2>/dev/null
  )" || fail "Exact recovery image is unavailable: $image_ref"
  IFS='|' read -r image_id revision protected extra <<<"$inspection"
  [[ -z "$extra" && "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    fail "Recovery image returned an invalid identity: $image_ref"
  [[ "$protected" == "true" ]] ||
    fail "Recovery image is missing its release-protected label: $image_ref"
  if [[ "$component" == "api-shared" ]]; then
    [[ "$revision" == "$EXPECTED_DEPLOY_SHA" ]] ||
      fail "Shared API recovery image lacks the exact reviewed revision label."
  elif [[ -n "$revision" && "$revision" != "<no value>" ]]; then
    [[ "$revision" == "$EXPECTED_DEPLOY_SHA" ]] ||
      fail "Static recovery image has a mismatched revision label: $image_ref"
  fi
  printf '%s' "$image_id"
}

resolve_target_images() {
  local component
  local image_ref

  for component in api-shared miniapp-major-static admin-static; do
    image_ref="$(expected_component_ref "$component")"
    COMPONENT_IMAGE_REF["$component"]="$image_ref"
    COMPONENT_IMAGE_ID["$component"]="$(inspect_target_image "$component" "$image_ref")"
  done
  export MAXIM_API_IMAGE="${COMPONENT_IMAGE_REF[api-shared]}"
  export MAXIM_MINIAPP_MAJOR_IMAGE="${COMPONENT_IMAGE_REF[miniapp-major-static]}"
  export MAXIM_ADMIN_IMAGE="${COMPONENT_IMAGE_REF[admin-static]}"
}

verify_target_images_unchanged() {
  local component
  local image_ref
  local image_id

  for component in api-shared miniapp-major-static admin-static; do
    image_ref="${COMPONENT_IMAGE_REF[$component]}"
    image_id="$(inspect_target_image "$component" "$image_ref")"
    [[ "$image_id" == "${COMPONENT_IMAGE_ID[$component]}" ]] ||
      fail "Recovery image id changed during finalization: $component"
  done
}

inspect_service_runtime() {
  local service="$1"
  local expected_ref="$2"
  local expected_id="$3"
  local container_ids_raw
  local inspection
  local container_id
  local running
  local status
  local image_ref
  local image_id
  local restart_count
  local started_at
  local extra
  local container_ids=()

  container_ids_raw="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker compose "${COMPOSE_FILES[@]}" ps -a -q "$service" 2>/dev/null
  )" || fail "Could not inspect recovery runtime service: $service"
  [[ -z "$container_ids_raw" ]] || mapfile -t container_ids <<<"$container_ids_raw"
  [[ "${#container_ids[@]}" -eq 1 ]] ||
    fail "Recovery runtime service is missing or unexpectedly scaled: $service"
  inspection="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker inspect \
        --format '{{.Id}}|{{.State.Running}}|{{.State.Status}}|{{.Config.Image}}|{{.Image}}|{{.RestartCount}}|{{.State.StartedAt}}' \
        "${container_ids[0]}" 2>/dev/null
  )" || fail "Could not inspect recovery runtime identity: $service"
  IFS='|' read -r container_id running status image_ref image_id restart_count started_at extra \
    <<<"$inspection"
  [[ -z "$extra" && "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
    fail "Recovery runtime returned an invalid container identity: $service"
  [[ "$running" == "true" && "$status" == "running" ]] ||
    fail "Recovery runtime service is not running: $service"
  [[ "$image_ref" == "$expected_ref" ]] ||
    fail "Recovery runtime service does not use the exact target ref: $service"
  [[ "$image_id" == "$expected_id" ]] ||
    fail "Recovery runtime service does not use the exact target image id: $service"
  [[ "$restart_count" =~ ^[0-9]+$ && -n "$started_at" ]] ||
    fail "Recovery runtime service returned invalid stability metadata: $service"
  printf '%s|%s|%s|%s\n' "$service" "$container_id" "$restart_count" "$started_at"
}

verify_no_unreviewed_running_api_containers() {
  local running_ids_raw
  local inventory
  local running_ids=()

  running_ids_raw="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker ps --no-trunc -q
  )" || fail "Could not inspect running containers for the API runtime fence."
  [[ -z "$running_ids_raw" ]] || mapfile -t running_ids <<<"$running_ids_raw"
  [[ "${#running_ids[@]}" -gt 0 ]] || fail "No running containers were found for runtime fencing."
  inventory="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker inspect "${running_ids[@]}" |
      node "$RUNTIME_INVENTORY_HELPER" \
        "${COMPONENT_IMAGE_ID[api-shared]}" "${MAXIM_PRODUCTION_API_SERVICES[@]}"
  )" || fail "Could not classify the running API container inventory."
  if ! printf '%s' "$inventory" | node -e '
      const { readFileSync } = require("node:fs");
      const value = JSON.parse(readFileSync(0, "utf8"));
      process.exit(
        Array.isArray(value?.ownedUnreviewedIds) && value.ownedUnreviewedIds.length === 0 &&
        Array.isArray(value?.ambiguousIds) && value.ambiguousIds.length === 0 ? 0 : 1,
      );
    '; then
    fail "An unreviewed, ambiguous, orphaned, or duplicate API container is running."
  fi
}

verify_runtime_snapshot() {
  local service

  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    inspect_service_runtime \
      "$service" \
      "${COMPONENT_IMAGE_REF[api-shared]}" \
      "${COMPONENT_IMAGE_ID[api-shared]}"
  done
  inspect_service_runtime \
    miniapp-major-static \
    "${COMPONENT_IMAGE_REF[miniapp-major-static]}" \
    "${COMPONENT_IMAGE_ID[miniapp-major-static]}"
  inspect_service_runtime \
    admin-static \
    "${COMPONENT_IMAGE_REF[admin-static]}" \
    "${COMPONENT_IMAGE_ID[admin-static]}"
  verify_no_unreviewed_running_api_containers
}

read_webhook_queue_status() {
  timeout --foreground --kill-after=5s "${COMMAND_TIMEOUT_SEC}s" \
    docker compose "${COMPOSE_FILES[@]}" exec -T api-admin node - status \
    <"$WEBHOOK_QUEUE_CONTROL_HELPER"
}

validate_webhook_queue_status() {
  local summary="$1"

  printf '%s' "$summary" | node -e '
    const { readFileSync } = require("node:fs");
    const value = JSON.parse(readFileSync(0, "utf8"));
    const valid =
      value?.queueCount === 24 &&
      value?.pausedCount === 0 &&
      Number.isSafeInteger(value?.activeCount) &&
      value.activeCount >= 0 &&
      value?.ownerPresent === false;
    process.exit(valid ? 0 : 1);
  '
}

assert_webhook_queue_fence_released() {
  local summary

  summary="$(read_webhook_queue_status)" ||
    fail "Could not inspect the webhook rollout queue fence."
  validate_webhook_queue_status "$summary" ||
    fail "Webhook queues remain paused, owned, or topologically incomplete."
}

require_stateful_services_ready() {
  local running
  local service

  running="$(docker compose "${COMPOSE_FILES[@]}" ps --status running --services)" ||
    fail "Could not inspect stateful runtime dependencies."
  for service in postgres redis; do
    grep -Fxq "$service" <<<"$running" || fail "$service is not already running."
  done
  timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
    docker compose "${COMPOSE_FILES[@]}" exec -T postgres \
      pg_isready -U maxim -d maxim >/dev/null 2>&1 || fail "Postgres is not ready."
  timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
    docker compose "${COMPOSE_FILES[@]}" exec -T redis redis-cli ping 2>/dev/null |
    grep -Fxq PONG || fail "Redis is not ready."
}

capture_applied_migrations() {
  local pgoptions

  [[ -z "$MIGRATIONS_FILE" ]] || fail "The Prisma migration snapshot was already captured."
  MIGRATIONS_FILE="$(mktemp /tmp/maxim-release-finalizer-migrations.XXXXXX)" ||
    fail "Could not create the recovery finalizer migration snapshot."
  chmod 0600 "$MIGRATIONS_FILE" ||
    fail "Could not restrict the recovery finalizer migration snapshot."

  pgoptions="-c default_transaction_read_only=on -c statement_timeout=5s -c lock_timeout=500ms"
  pgoptions+=" -c idle_in_transaction_session_timeout=5s -c max_parallel_workers_per_gather=0"
  pgoptions+=" -c application_name=maxim_release_finalizer_$$"
  if ! timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
    docker compose "${COMPOSE_FILES[@]}" exec -T -e "PGOPTIONS=$pgoptions" postgres \
      psql -X --no-password -v ON_ERROR_STOP=1 -U maxim -d maxim -Atq \
        -c 'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name;' \
      | head -c "$((MAX_MIGRATIONS_FILE_BYTES + 1))" >"$MIGRATIONS_FILE"; then
    fail "Could not read the currently applied Prisma migrations."
  fi

  if ! node - "$MIGRATIONS_FILE" "$MAX_MIGRATIONS_FILE_BYTES" <<'NODE'
const { readFileSync, statSync } = require('node:fs');

const migrationFile = process.argv[2];
const maxBytes = Number(process.argv[3]);
const size = statSync(migrationFile).size;
if (!Number.isSafeInteger(maxBytes) || size === 0 || size > maxBytes) {
  process.exit(1);
}

const contents = readFileSync(migrationFile, 'utf8');
if (!contents.endsWith('\n')) {
  process.exit(1);
}
const migrations = contents.slice(0, -1).split('\n');
const migrationNamePattern = /^[0-9]{14}_[a-z0-9][a-z0-9_]{0,240}$/u;
const canonical = [...new Set(migrations)].sort();
const valid =
  migrations.length > 0 &&
  migrations.every((migration) => migrationNamePattern.test(migration)) &&
  canonical.length === migrations.length &&
  canonical.every((migration, index) => migration === migrations[index]);
process.exit(valid ? 0 : 1);
NODE
  then
    fail "Applied Prisma migrations returned invalid or excessive output."
  fi
}

run_http_smoke() {
  local kind="$1"
  local url="$2"

  timeout --foreground --kill-after=5s 60s \
    node "$ROOT_DIR/scripts/smoke-http.mjs" "$kind" "$url"
}

run_strict_finalizer_smokes() {
  require_stateful_services_ready
  maxim_topology_prepare_commercial_ocr_target \
    "$EXPECTED_DEPLOY_SHA" \
    COMPOSE_FILES \
    TARGET_HAS_MEDIA_ANALYSIS \
    TARGET_COMMERCIAL_OCR_VERSION
  [[ "$TARGET_HAS_MEDIA_ANALYSIS" -eq 1 ]] ||
    fail "Recovery finalization requires the reviewed media-analysis topology."
  maxim_topology_verify_api_commercial_ocr_version \
    COMPOSE_FILES \
    "$TARGET_COMMERCIAL_OCR_VERSION"

  run_http_smoke json-ok http://127.0.0.1:3001/api/health/live
  run_http_smoke json-ok http://127.0.0.1:3001/api/health/ready
  run_http_smoke json-ok http://127.0.0.1:3002/api/health/live
  run_http_smoke json-ok http://127.0.0.1:3002/api/health/ready
  run_http_smoke json-ok "$PUBLIC_HEALTH_URL/api/health/live"
  run_http_smoke static http://127.0.0.1:3003/app/
  run_http_smoke static "$PUBLIC_HEALTH_URL/app/"
  run_http_smoke static http://127.0.0.1:3004/
  maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required

  SMOKE_RESULTS=(
    "api-local-live"
    "api-local-ready"
    "api-admin-live"
    "api-admin-ready"
    "api-public-live"
    "api-commercial-ocr-version"
    "api-media-analysis-tesseract-rus-eng"
    "api-media-analysis-shadow"
    "api-media-analysis-native-raster"
    "api-media-analysis-internal-ready"
    "miniapp-major-static-local"
    "miniapp-major-static"
    "admin-static"
    "webhook-queues-released"
    "recovery-finalizer-runtime-stable"
  )
}

wait_for_runtime_stability() {
  local started_at="$1"
  local elapsed=$((SECONDS - started_at))

  if ((elapsed < STABILITY_WINDOW_SEC)); then
    sleep "$((STABILITY_WINDOW_SEC - elapsed))"
  fi
}

commit_recovered_release() {
  local release_id
  local component
  local smoke
  local args

  release_id="release-finalized-$(date -u +%Y%m%dT%H%M%SZ)-${EXPECTED_DEPLOY_SHA:0:12}-$$"
  args=(
    commit
    --release-id "$release_id"
    --target-sha "$EXPECTED_DEPLOY_SHA"
    --current-manifest-file "$RECOVERY_BASE_MANIFEST"
    --migrations-file "$MIGRATIONS_FILE"
  )
  for component in api-shared miniapp-major-static admin-static; do
    args+=(
      --component
      "${component}|${EXPECTED_DEPLOY_SHA}|${COMPONENT_IMAGE_REF[$component]}|${COMPONENT_IMAGE_ID[$component]}"
    )
  done
  for smoke in "${SMOKE_RESULTS[@]}"; do
    args+=(--smoke "$smoke")
  done

  release_manifest "${args[@]}" >/dev/null ||
    fail "Could not commit the recovered exact-SHA release manifest."
  release_manifest archive-transition \
    --current-manifest-file "$RECOVERY_BASE_MANIFEST" \
    --disposition recovered >/dev/null ||
    fail "Current release was committed, but the recovery journal could not be archived."
  echo "Release recovery finalized without runtime recreation: $release_id"
}

main() {
  local runtime_before
  local runtime_after
  local stability_started_at

  if [[ "$#" -gt 1 ]]; then
    fail "Usage: $0 [branch]"
  fi
  BRANCH="${1:-main}"
  validate_finalizer_environment
  acquire_deploy_lock
  trap finalizer_cleanup EXIT
  verify_synchronized_checkout
  resolve_recovery_base_manifest
  resolve_target_images

  stability_started_at=$SECONDS
  runtime_before="$(verify_runtime_snapshot)"
  assert_webhook_queue_fence_released
  run_strict_finalizer_smokes
  wait_for_runtime_stability "$stability_started_at"

  verify_target_images_unchanged
  runtime_after="$(verify_runtime_snapshot)"
  [[ "$runtime_after" == "$runtime_before" ]] ||
    fail "Recovery runtime changed or restarted during strict finalizer smokes."
  capture_applied_migrations
  assert_webhook_queue_fence_released
  verify_recovery_base_unchanged
  commit_recovered_release
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
