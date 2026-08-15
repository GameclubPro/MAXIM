#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=infra/scripts/lib/deploy-topology.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"
# shellcheck source=infra/scripts/lib/webhook-rollout-quiescence.sh
source "$ROOT_DIR/infra/scripts/lib/webhook-rollout-quiescence.sh"
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"

COMPOSE_FILES=(--env-file ".env" -p infra -f "infra/docker-compose.yml")
SCALE_COMPOSE_FILES=(-p infra-scale -f "infra/docker-compose.scale.yml")
RELEASE_STATE_DIR="${MAXIM_RELEASE_STATE_DIR:-/var/lib/maxim-deploy}"
RELEASE_RETAIN="${MAXIM_RELEASE_RETAIN:-5}"
PUBLIC_HEALTH_URL="${MAXIM_VPS_PUBLIC_URL:-${MAXIM_PUBLIC_HEALTH_URL:-https://major-maksimov.ru}}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL%/}"
SOURCE_RELEASE_ID="${1:-}"

usage() {
  cat <<'USAGE'
Usage:
  ./infra/scripts/vps-release-rollback.sh <release-id> [components...]

Components (default: all):
  api-shared miniapp-major-static admin-static

This rollback uses already-built immutable images. It does not switch Git refs, build images,
or run Prisma migrations.
USAGE
}

if [[ -z "$SOURCE_RELEASE_ID" ]]; then
  usage
  exit 1
fi
shift || true
REQUESTED_COMPONENTS=("$@")

contains_service() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    if [[ "$item" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 not found" >&2
    exit 1
  fi
}

validate_positive_int() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$name must be a positive integer." >&2
    exit 2
  fi
}

validate_positive_int "MAXIM_RELEASE_RETAIN" "$RELEASE_RETAIN"
if [[ "$RELEASE_RETAIN" -lt 5 ]]; then
  echo "MAXIM_RELEASE_RETAIN must be at least 5." >&2
  exit 2
fi
RUNNING_ATTEMPTS="${MAXIM_ROLLBACK_RUNNING_ATTEMPTS:-180}"
SMOKE_ATTEMPTS="${MAXIM_ROLLBACK_SMOKE_ATTEMPTS:-90}"
SMOKE_TIMEOUT_MS="${MAXIM_ROLLBACK_SMOKE_TIMEOUT_MS:-3000}"
validate_positive_int "MAXIM_ROLLBACK_RUNNING_ATTEMPTS" "$RUNNING_ATTEMPTS"
validate_positive_int "MAXIM_ROLLBACK_SMOKE_ATTEMPTS" "$SMOKE_ATTEMPTS"
validate_positive_int "MAXIM_ROLLBACK_SMOKE_TIMEOUT_MS" "$SMOKE_TIMEOUT_MS"

require_command docker
require_command node
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'; then
  echo "Node 24 is required for immutable release rollback." >&2
  exit 1
fi

if [[ ! -s .env ]]; then
  echo "Missing .env; immutable release rollback cannot safely resolve Compose services." >&2
  exit 1
fi

acquire_deploy_lock
PLAN_FILE="$(mktemp)"
SOURCE_MIGRATIONS_FILE="$(mktemp)"
APPLIED_MIGRATIONS_FILE="$(mktemp)"
ROLLBACK_RUNTIME_STARTED=0
ROLLBACK_MANIFEST_RECORDED=0
RECOVERY_BASE_MANIFEST=""
RECOVERY_REQUIRES_API_FENCE=0

invalidate_stale_release_inventory() {
  local current_manifest="$RELEASE_STATE_DIR/current.json"
  local invalid_manifest

  [[ "$ROLLBACK_RUNTIME_STARTED" -eq 1 && "$ROLLBACK_MANIFEST_RECORDED" -eq 0 ]] || return 0
  [[ -f "$current_manifest" ]] || return 0
  invalid_manifest="$RELEASE_STATE_DIR/current.invalid-release-rollback-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
  if mv "$current_manifest" "$invalid_manifest"; then
    echo "Invalidated stale release inventory after incomplete immutable rollback: $invalid_manifest" >&2
  else
    echo "CRITICAL: failed to invalidate stale release inventory: $current_manifest" >&2
  fi
}

cleanup() {
  maxim_webhook_rollout_warn_if_paused
  invalidate_stale_release_inventory
  rm -f "$PLAN_FILE" "$SOURCE_MIGRATIONS_FILE" "$APPLIED_MIGRATIONS_FILE"
  release_deploy_lock
}
trap cleanup EXIT

select_release_recovery_base() {
  local recovery_status

  if MAXIM_RELEASE_STATE_DIR="$RELEASE_STATE_DIR" \
    node infra/scripts/release-manifest.mjs validate-current >/dev/null 2>&1; then
    return 0
  fi
  if [[ -e "$RELEASE_STATE_DIR/current.json" ]]; then
    echo "Current release manifest exists but is invalid; refusing immutable rollback." >&2
    return 1
  fi
  if RECOVERY_BASE_MANIFEST="$(
    MAXIM_RELEASE_STATE_DIR="$RELEASE_STATE_DIR" \
      node infra/scripts/release-manifest.mjs recovery-base
  )"; then
    if [[ "$MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE" != "1" ]]; then
      echo "An interrupted release manifest requires explicit recovery adoption." >&2
      echo "Set MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1 for this reviewed retry." >&2
      RECOVERY_BASE_MANIFEST=""
      return 1
    fi
    case "$(basename "$RECOVERY_BASE_MANIFEST")" in
      current.invalid-release-rollback-static-*)
        RECOVERY_REQUIRES_API_FENCE=0
        ;;
      *)
        RECOVERY_REQUIRES_API_FENCE=1
        ;;
    esac
    echo "Adopting the single validated interrupted release manifest."
    return 0
  else
    recovery_status=$?
  fi
  RECOVERY_BASE_MANIFEST=""
  if [[ "$recovery_status" -eq 3 ]]; then
    echo "A valid current or interrupted release manifest is required for rollback." >&2
    return 1
  fi
  return "$recovery_status"
}

begin_release_runtime_transition() {
  local transition_kind=release-rollback-static

  if [[ -n "$RECOVERY_BASE_MANIFEST" ]]; then
    return 0
  fi
  if [[ "$SELECT_API" -eq 1 ]]; then
    transition_kind=release-rollback-api
  fi
  if ! RECOVERY_BASE_MANIFEST="$(
    MAXIM_RELEASE_STATE_DIR="$RELEASE_STATE_DIR" \
      node infra/scripts/release-manifest.mjs begin-transition --kind "$transition_kind"
  )"; then
    RECOVERY_BASE_MANIFEST=""
    echo "Could not journal the current release before immutable rollback mutation." >&2
    return 1
  fi
  echo "Current release inventory journaled before immutable rollback mutation."
}

archive_recovery_base_manifest() {
  [[ -n "$RECOVERY_BASE_MANIFEST" ]] || return 0
  if ! MAXIM_RELEASE_STATE_DIR="$RELEASE_STATE_DIR" \
    node infra/scripts/release-manifest.mjs archive-transition \
      --current-manifest-file "$RECOVERY_BASE_MANIFEST" \
      --disposition recovered >/dev/null; then
    echo "CRITICAL: could not archive the consumed release recovery manifest." >&2
    return 1
  fi
  RECOVERY_BASE_MANIFEST=""
}

select_release_recovery_base

running_scale_services="$(docker compose "${SCALE_COMPOSE_FILES[@]}" ps --status running --services 2>/dev/null || true)"
if [[ -n "$running_scale_services" ]]; then
  echo "Refusing immutable rollback while infra-scale is running: $running_scale_services" >&2
  exit 1
fi

MAXIM_RELEASE_STATE_DIR="$RELEASE_STATE_DIR" \
  node infra/scripts/release-rollback-plan.mjs "$SOURCE_RELEASE_ID" "${REQUESTED_COMPONENTS[@]}" \
  >"$PLAN_FILE"

TARGET_SHA=""
ROLLBACK_RELEASE_ID=""
SOURCE_MANIFEST_RELEASE_ID=""
SELECT_API=0
SELECT_MINIAPP=0
SELECT_ADMIN=0
SELECTED_COMPONENTS=()
SERVICES=()
TARGET_HAS_MEDIA_ANALYSIS=0
TARGET_HAS_MEDIA_ANALYSIS_RASTER_SMOKE=0
TARGET_COMMERCIAL_OCR_VERSION=""
declare -A COMPONENT_SOURCE_SHA=()
declare -A COMPONENT_IMAGE_REF=()
declare -A COMPONENT_IMAGE_ID=()

while IFS=$'\t' read -r record field1 field2 field3 field4 extra; do
  case "$record" in
    source-release-id)
      SOURCE_MANIFEST_RELEASE_ID="$field1"
      ;;
    rollback-release-id)
      ROLLBACK_RELEASE_ID="$field1"
      ;;
    target-sha)
      TARGET_SHA="$field1"
      ;;
    component)
      SELECTED_COMPONENTS+=("$field1")
      COMPONENT_SOURCE_SHA["$field1"]="$field2"
      COMPONENT_IMAGE_REF["$field1"]="$field3"
      COMPONENT_IMAGE_ID["$field1"]="$field4"
      case "$field1" in
        api-shared)
          SELECT_API=1
          export MAXIM_API_IMAGE="$field3"
          ;;
        miniapp-major-static)
          SELECT_MINIAPP=1
          export MAXIM_MINIAPP_MAJOR_IMAGE="$field3"
          ;;
        admin-static)
          SELECT_ADMIN=1
          export MAXIM_ADMIN_IMAGE="$field3"
          ;;
        *)
          echo "Rollback plan returned an unknown component: $field1" >&2
          exit 1
          ;;
      esac
      ;;
    service)
      SERVICES+=("$field1")
      ;;
    '')
      ;;
    *)
      echo "Rollback plan returned an unknown record: $record" >&2
      exit 1
      ;;
  esac
  if [[ -n "${extra:-}" ]]; then
    echo "Rollback plan returned an invalid extra field for $record." >&2
    exit 1
  fi
done <"$PLAN_FILE"

if [[ -z "$TARGET_SHA" || -z "$ROLLBACK_RELEASE_ID" || -z "$SOURCE_MANIFEST_RELEASE_ID" ]]; then
  echo "Rollback plan is incomplete." >&2
  exit 1
fi
if [[ "${#SELECTED_COMPONENTS[@]}" -eq 0 || "${#SERVICES[@]}" -eq 0 ]]; then
  echo "Rollback plan selected no components or services." >&2
  exit 1
fi
if [[ -n "$RECOVERY_BASE_MANIFEST" && "$RECOVERY_REQUIRES_API_FENCE" -eq 1 && \
      "$SELECT_API" -ne 1 ]]; then
  echo "Interrupted API release recovery requires selecting api-shared for queue fencing." >&2
  exit 1
fi

if [[ "$SELECT_API" -eq 1 ]]; then
  require_command git
  API_SOURCE_SHA="${COMPONENT_SOURCE_SHA[api-shared]}"
  if ! git cat-file -e "${API_SOURCE_SHA}^{commit}" 2>/dev/null; then
    echo "API component source commit is not available locally: $API_SOURCE_SHA" >&2
    echo "Fetch the immutable API source object without changing the VPS worktree, then retry." >&2
    exit 1
  fi
  if maxim_topology_git_compose_has_service "$API_SOURCE_SHA" "$MAXIM_MEDIA_ANALYSIS_SERVICE"; then
    TARGET_HAS_MEDIA_ANALYSIS=1
    if maxim_topology_git_has_commercial_ocr_raster_smoke "$API_SOURCE_SHA"; then
      TARGET_HAS_MEDIA_ANALYSIS_RASTER_SMOKE=1
    fi
  else
    topology_status=$?
    if [[ "$topology_status" -ne 1 ]]; then
      exit "$topology_status"
    fi
    maxim_topology_remove_service SERVICES "$MAXIM_MEDIA_ANALYSIS_SERVICE"
    echo "API rollback target predates $MAXIM_MEDIA_ANALYSIS_SERVICE; the role will be removed."
  fi
  maxim_topology_prepare_commercial_ocr_target \
    "$API_SOURCE_SHA" \
    COMPOSE_FILES \
    TARGET_HAS_MEDIA_ANALYSIS \
    TARGET_COMMERCIAL_OCR_VERSION
fi

for component in "${SELECTED_COMPONENTS[@]}"; do
  image_ref="${COMPONENT_IMAGE_REF[$component]}"
  expected_image_id="${COMPONENT_IMAGE_ID[$component]}"
  if ! actual_image_id="$(docker image inspect --format '{{.Id}}' "$image_ref" 2>/dev/null)"; then
    echo "Rollback image does not exist locally: $component -> $image_ref" >&2
    exit 1
  fi
  if [[ "$actual_image_id" != "$expected_image_id" ]]; then
    echo "Rollback image id mismatch for $component: $image_ref" >&2
    echo "Manifest: $expected_image_id" >&2
    echo "Docker:   $actual_image_id" >&2
    exit 1
  fi
done

if [[ "$SELECT_API" -eq 1 ]]; then
  if ! docker compose "${COMPOSE_FILES[@]}" ps --status running --services | grep -qx postgres; then
    echo "Postgres is not running; refusing API rollback instead of starting a stateful service." >&2
    exit 1
  fi
  if ! docker compose "${COMPOSE_FILES[@]}" exec -T postgres pg_isready -U maxim -d maxim >/dev/null; then
    echo "Postgres is not ready; refusing immutable API rollback." >&2
    exit 1
  fi
  if ! docker compose "${COMPOSE_FILES[@]}" ps --status running --services | grep -qx redis; then
    echo "Redis is not running; refusing API rollback instead of starting a stateful service." >&2
    exit 1
  fi
  if ! docker compose "${COMPOSE_FILES[@]}" exec -T redis redis-cli ping | grep -qx PONG; then
    echo "Redis is not ready; refusing immutable API rollback." >&2
    exit 1
  fi

  if ! docker compose "${COMPOSE_FILES[@]}" exec -T postgres psql -U maxim -d maxim -Atc \
    "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name;" \
    >"$APPLIED_MIGRATIONS_FILE"; then
    echo "Could not read applied Prisma migrations; refusing immutable API rollback." >&2
    exit 1
  fi

  ensure_commit_has_applied_migrations() {
    local commit_sha="$1"
    local commit_label="$2"
    local migration
    local missing_migrations=()

    git ls-tree -r --name-only "$commit_sha" -- apps/api/prisma/migrations \
      | sed -n 's#^apps/api/prisma/migrations/\([^/][^/]*\)/migration\.sql$#\1#p' \
      | sort -u >"$SOURCE_MIGRATIONS_FILE"

    while IFS= read -r migration; do
      [[ -n "$migration" ]] || continue
      if ! grep -Fxq "$migration" "$SOURCE_MIGRATIONS_FILE"; then
        missing_migrations+=("$migration")
      fi
    done <"$APPLIED_MIGRATIONS_FILE"

    if [[ "${#missing_migrations[@]}" -gt 0 ]]; then
      echo "$commit_label $commit_sha is missing applied Prisma migrations:" >&2
      printf '  %s\n' "${missing_migrations[@]}" >&2
      echo "Refusing before any container recreate." >&2
      return 1
    fi
    echo "Prisma compatibility preflight passed for $commit_label $commit_sha."
  }

  ensure_commit_has_applied_migrations "$API_SOURCE_SHA" "API component source"
fi

wait_for_service_running() {
  local service="$1"
  local attempt
  for ((attempt = 1; attempt <= RUNNING_ATTEMPTS; attempt += 1)); do
    if docker compose "${COMPOSE_FILES[@]}" ps --status running --services | grep -qx "$service"; then
      return 0
    fi
    sleep 1
  done
  echo "Service failed to reach running state: $service" >&2
  docker compose "${COMPOSE_FILES[@]}" logs --tail=120 "$service" || true
  return 1
}

wait_for_strict_smoke() {
  local mode="$1"
  local url="$2"
  local marker="${3:-}"
  local attempt
  local output=""
  local args=(scripts/smoke-http.mjs "$mode" "$url")
  [[ -z "$marker" ]] || args+=("$marker")

  for ((attempt = 1; attempt <= SMOKE_ATTEMPTS; attempt += 1)); do
    if output="$(MAXIM_SMOKE_TIMEOUT_MS="$SMOKE_TIMEOUT_MS" node "${args[@]}" 2>&1)"; then
      printf '%s\n' "$output"
      return 0
    fi
    sleep 2
  done
  echo "Strict smoke did not recover: $url" >&2
  [[ -z "$output" ]] || printf '%s\n' "$output" >&2
  return 1
}

recreate_service() {
  local service="$1"
  ROLLBACK_RUNTIME_STARTED=1
  echo "Recreating $service from immutable release image..."
  docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --no-build --force-recreate "$service"
  wait_for_service_running "$service"
}

remove_incompatible_media_analysis_container() {
  local container_list
  local container_ids=()

  if ! container_list="$(
    docker ps -a -q \
      --filter "label=com.docker.compose.project=infra" \
      --filter "label=com.docker.compose.service=$MAXIM_MEDIA_ANALYSIS_SERVICE"
  )"; then
    echo "Could not inspect the current $MAXIM_MEDIA_ANALYSIS_SERVICE container." >&2
    return 1
  fi
  if [[ -z "$container_list" ]]; then
    return 0
  fi
  mapfile -t container_ids <<<"$container_list"
  ROLLBACK_RUNTIME_STARTED=1
  echo "Stopping and removing $MAXIM_MEDIA_ANALYSIS_SERVICE for the pre-feature API target..."
  docker stop --time 30 "${container_ids[@]}" >/dev/null
  docker rm -f "${container_ids[@]}" >/dev/null
}

verify_service_image_id() {
  local service="$1"
  local expected_image_id="$2"
  local container_id
  local actual_image_id
  container_id="$(docker compose "${COMPOSE_FILES[@]}" ps -q "$service")"
  if [[ -z "$container_id" ]]; then
    echo "Cannot verify image for missing service container: $service" >&2
    return 1
  fi
  actual_image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
  if [[ "$actual_image_id" != "$expected_image_id" ]]; then
    echo "$service runs $actual_image_id, expected $expected_image_id." >&2
    return 1
  fi
}

recovery_base_field() {
  MAXIM_RELEASE_STATE_DIR="$RELEASE_STATE_DIR" \
    node infra/scripts/release-manifest.mjs field current "$1" "$2" \
      --current-manifest-file "$RECOVERY_BASE_MANIFEST"
}

verify_inherited_api_component() {
  local expected_image_id="$1"
  local service

  # Static-only rollback must remain image-only. The active production topology is fixed here and
  # every inherited role must already be running on the manifest image before static mutation.
  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    verify_service_image_id "$service" "$expected_image_id"
  done
}

verify_inherited_release_components() {
  local component
  local expected_image_id

  for component in api-shared miniapp-major-static admin-static; do
    if contains_service "$component" "${SELECTED_COMPONENTS[@]}"; then
      continue
    fi
    expected_image_id="$(recovery_base_field "$component" imageId)"
    case "$component" in
      api-shared)
        verify_inherited_api_component "$expected_image_id"
        ;;
      miniapp-major-static)
        verify_service_image_id miniapp-major-static "$expected_image_id"
        ;;
      admin-static)
        verify_service_image_id admin-static "$expected_image_id"
        ;;
    esac
  done
}

begin_release_runtime_transition
ROLLBACK_RUNTIME_STARTED=1
verify_inherited_release_components

SMOKE_RESULTS=()
if [[ "$SELECT_API" -eq 1 ]]; then
  maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES
  if [[ "$TARGET_HAS_MEDIA_ANALYSIS" -eq 0 ]]; then
    remove_incompatible_media_analysis_container
  else
    maxim_topology_stop_media_analysis_before_api_transition COMPOSE_FILES
  fi

  maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
  recreate_service api-action
  maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
  recreate_service api-admin
  maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
  recreate_service api-ingress
  if [[ "$TARGET_HAS_MEDIA_ANALYSIS" -eq 1 ]]; then
    maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
    recreate_service "$MAXIM_MEDIA_ANALYSIS_SERVICE"
  fi

  # FLAG: Keep every webhook consumer and producer stopped until non-webhook API roles are fenced.
  for service in \
    api-moderation \
    api-moderation-critical \
    api-moderation-join \
    api-moderation-realtime-b \
    api-moderation-realtime-c \
    api-moderation-realtime-d \
    api-moderation-background; do
    maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
    recreate_service "$service"
  done
  maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
  recreate_service api-enqueue
  maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
fi

for service in "${SERVICES[@]}"; do
  if maxim_topology_is_api_service "$service"; then
    verify_service_image_id "$service" "${COMPONENT_IMAGE_ID[api-shared]}"
  fi
done
if [[ "$SELECT_API" -eq 1 && "$TARGET_HAS_MEDIA_ANALYSIS" -eq 1 ]]; then
  maxim_topology_verify_api_commercial_ocr_version \
    COMPOSE_FILES \
    "$TARGET_COMMERCIAL_OCR_VERSION"
fi
if [[ "$SELECT_API" -eq 1 ]]; then
  wait_for_strict_smoke json-ok http://127.0.0.1:3001/api/health/live
  wait_for_strict_smoke json-ok http://127.0.0.1:3002/api/health/live
  SMOKE_RESULTS+=(api-local-live api-admin-live)
  maxim_webhook_resume_after_api_fence COMPOSE_FILES
fi
if [[ "$SELECT_MINIAPP" -eq 1 ]]; then
  recreate_service miniapp-major-static
  verify_service_image_id miniapp-major-static "${COMPONENT_IMAGE_ID[miniapp-major-static]}"
fi
if [[ "$SELECT_ADMIN" -eq 1 ]]; then
  recreate_service admin-static
  verify_service_image_id admin-static "${COMPONENT_IMAGE_ID[admin-static]}"
fi

if [[ "$SELECT_API" -eq 1 ]]; then
  wait_for_strict_smoke json-ok http://127.0.0.1:3001/api/health/ready
  wait_for_strict_smoke json-ok http://127.0.0.1:3002/api/health/ready
  wait_for_strict_smoke json-ok "$PUBLIC_HEALTH_URL/api/health/live"
  SMOKE_RESULTS+=(api-local-ready api-admin-ready api-public-live)
  if [[ "$TARGET_HAS_MEDIA_ANALYSIS" -eq 1 ]]; then
    if [[ "$TARGET_HAS_MEDIA_ANALYSIS_RASTER_SMOKE" -eq 1 ]]; then
      maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required
    else
      maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES if-present
    fi
    SMOKE_RESULTS+=(
      api-commercial-ocr-version
      api-media-analysis-tesseract-rus-eng
      api-media-analysis-shadow
    )
    if [[ "$TARGET_HAS_MEDIA_ANALYSIS_RASTER_SMOKE" -eq 1 ]]; then
      SMOKE_RESULTS+=(
        api-media-analysis-native-raster
        api-media-analysis-internal-ready
      )
    fi
  fi
fi
if [[ "$SELECT_MINIAPP" -eq 1 ]]; then
  wait_for_strict_smoke static https://major-maksimov.ru/app/
  SMOKE_RESULTS+=(miniapp-major-static)
fi
if [[ "$SELECT_ADMIN" -eq 1 ]]; then
  wait_for_strict_smoke static http://127.0.0.1:3004/
  SMOKE_RESULTS+=(admin-static)
fi

verify_inherited_release_components

COMMIT_ARGS=(
  commit
  --release-id "$ROLLBACK_RELEASE_ID"
  --target-sha "$TARGET_SHA"
  --retain "$RELEASE_RETAIN"
  --emergency-reason "immutable rollback to $SOURCE_MANIFEST_RELEASE_ID"
)
if [[ "$SELECT_API" -eq 1 ]]; then
  COMMIT_ARGS+=(--migrations-file "$APPLIED_MIGRATIONS_FILE")
fi
if [[ -n "$RECOVERY_BASE_MANIFEST" ]]; then
  COMMIT_ARGS+=(--current-manifest-file "$RECOVERY_BASE_MANIFEST")
fi
for component in "${SELECTED_COMPONENTS[@]}"; do
  COMMIT_ARGS+=(
    --component
    "${component}|${COMPONENT_SOURCE_SHA[$component]}|${COMPONENT_IMAGE_REF[$component]}|${COMPONENT_IMAGE_ID[$component]}"
  )
done
for smoke in "${SMOKE_RESULTS[@]}"; do
  COMMIT_ARGS+=(--smoke "$smoke")
done

MAXIM_RELEASE_STATE_DIR="$RELEASE_STATE_DIR" \
  node infra/scripts/release-manifest.mjs "${COMMIT_ARGS[@]}" >/dev/null
ROLLBACK_MANIFEST_RECORDED=1
archive_recovery_base_manifest

echo "Done: immutable rollback release=$ROLLBACK_RELEASE_ID source=$SOURCE_MANIFEST_RELEASE_ID components=${SELECTED_COMPONENTS[*]}"
