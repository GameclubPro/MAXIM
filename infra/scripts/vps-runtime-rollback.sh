#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=infra/scripts/lib/deploy-topology.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
# shellcheck source=infra/scripts/lib/deploy-disk-capacity.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-disk-capacity.sh"

COMPOSE_FILES=(--env-file ".env" -p infra -f "infra/docker-compose.yml")
SCALE_COMPOSE_FILES=(-p infra-scale -f "infra/docker-compose.scale.yml")
ROLLBACK_REF="${1:-}"
RELEASE_STATE_DIR="${MAXIM_RELEASE_STATE_DIR:-/var/lib/maxim-deploy}"
RELEASE_RETAIN="${MAXIM_RELEASE_RETAIN:-5}"
PUBLIC_HEALTH_URL="${MAXIM_VPS_PUBLIC_URL:-${MAXIM_PUBLIC_HEALTH_URL:-https://major-maksimov.ru}}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL%/}"
PRESERVED_COMPOSE_FILE=""
PRESERVED_MIGRATION_COMPOSE_FILE=""
RELEASE_MANIFEST_HELPER=""
SMOKE_HELPER=""
APPLIED_MIGRATIONS_FILE=""
TARGET_HAS_MEDIA_ANALYSIS=0
ROLLBACK_RUNTIME_STARTED=0
MANIFEST_RECORDED=0

if [[ -z "$ROLLBACK_REF" ]]; then
  echo "Usage: $0 <git-ref> [services...]"
  echo "Only production API role names are accepted; any API role expands to every shared-image role."
  exit 1
fi
shift || true

API_SERVICES=("${MAXIM_PRODUCTION_API_SERVICES[@]}")

if [[ $# -gt 0 ]]; then
  SERVICES=("$@")
else
  SERVICES=("${API_SERVICES[@]}")
fi

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

validate_requested_api_services() {
  local service
  for service in "${SERVICES[@]}"; do
    if ! maxim_topology_is_api_service "$service"; then
      echo "Runtime ref rollback supports API roles only; refusing service: $service" >&2
      exit 2
    fi
  done
}

validate_requested_api_services
maxim_topology_expand_api_services SERVICES \
  "Runtime rollback uses the shared API image."

if ! TARGET_FULL_SHA="$(git rev-parse --verify --end-of-options "${ROLLBACK_REF}^{commit}" 2>/dev/null)"; then
  echo "Cannot resolve rollback ref to an exact commit: $ROLLBACK_REF" >&2
  exit 2
fi
if maxim_topology_git_compose_has_service "$TARGET_FULL_SHA" "$MAXIM_MEDIA_ANALYSIS_SERVICE"; then
  TARGET_HAS_MEDIA_ANALYSIS=1
else
  topology_status=$?
  if [[ "$topology_status" -ne 1 ]]; then
    exit "$topology_status"
  fi
  maxim_topology_remove_service SERVICES "$MAXIM_MEDIA_ANALYSIS_SERVICE"
  echo "Runtime rollback target predates $MAXIM_MEDIA_ANALYSIS_SERVICE; the role will be removed."
fi

validate_release_retain() {
  if [[ ! "$RELEASE_RETAIN" =~ ^[1-9][0-9]*$ ]] || [[ "$RELEASE_RETAIN" -lt 5 ]]; then
    echo "MAXIM_RELEASE_RETAIN must be an integer of at least 5." >&2
    exit 2
  fi
}

invalidate_stale_release_inventory() {
  local current_manifest="$RELEASE_STATE_DIR/current.json"
  local invalid_manifest

  [[ "$ROLLBACK_RUNTIME_STARTED" -eq 1 && "$MANIFEST_RECORDED" -eq 0 ]] || return 0
  [[ -f "$current_manifest" ]] || return 0
  invalid_manifest="$RELEASE_STATE_DIR/current.invalid-runtime-rollback-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
  if mv "$current_manifest" "$invalid_manifest"; then
    echo "Invalidated stale release inventory after incomplete runtime rollback: $invalid_manifest" >&2
  else
    echo "CRITICAL: failed to invalidate stale release inventory: $current_manifest" >&2
  fi
}

cleanup() {
  invalidate_stale_release_inventory
  [[ -z "$PRESERVED_COMPOSE_FILE" ]] || rm -f "$PRESERVED_COMPOSE_FILE"
  [[ -z "$PRESERVED_MIGRATION_COMPOSE_FILE" ]] || rm -f "$PRESERVED_MIGRATION_COMPOSE_FILE"
  [[ -z "$RELEASE_MANIFEST_HELPER" ]] || rm -f "$RELEASE_MANIFEST_HELPER"
  [[ -z "$SMOKE_HELPER" ]] || rm -f "$SMOKE_HELPER"
  [[ -z "$APPLIED_MIGRATIONS_FILE" ]] || rm -f "$APPLIED_MIGRATIONS_FILE"
  release_deploy_lock
}

wait_for_url() {
  local url="$1"
  local attempts="${2:-120}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS --connect-timeout 5 --max-time 15 "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done

  echo "Health check timeout: $url"
  return 1
}

wait_for_service_running() {
  local service="$1"
  local attempts="${2:-120}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if docker compose "${COMPOSE_FILES[@]}" ps --status running --services | grep -qx "$service"; then
      return 0
    fi
    sleep 1
  done

  echo "Service failed to reach running state: $service"
  docker compose "${COMPOSE_FILES[@]}" logs --tail=120 "$service" || true
  return 1
}

ensure_compose_env() {
  if [[ -s .env ]]; then
    return 0
  fi

  echo "Missing .env; runtime rollback cannot safely recreate API roles."
  exit 1
}

refuse_conflicting_scale_stack() {
  local running_services

  running_services="$(docker compose "${SCALE_COMPOSE_FILES[@]}" ps --status running --services 2>/dev/null || true)"
  if [[ -z "$running_services" ]]; then
    return 0
  fi

  echo "Refusing runtime rollback while infra-scale is running: $running_services" >&2
  return 1
}

ensure_stateful_services_ready() {
  local running_services

  running_services="$(docker compose "${COMPOSE_FILES[@]}" ps --status running --services)"
  if ! grep -qx postgres <<<"$running_services"; then
    echo "Postgres is not running; refusing runtime rollback instead of starting it." >&2
    return 1
  fi
  if ! docker compose "${COMPOSE_FILES[@]}" exec -T postgres pg_isready -U maxim -d maxim >/dev/null; then
    echo "Postgres is not ready; refusing runtime rollback." >&2
    return 1
  fi
  if ! grep -qx redis <<<"$running_services"; then
    echo "Redis is not running; refusing runtime rollback instead of starting it." >&2
    return 1
  fi
  if ! docker compose "${COMPOSE_FILES[@]}" exec -T redis redis-cli ping | grep -qx PONG; then
    echo "Redis is not ready; refusing runtime rollback." >&2
    return 1
  fi
}

read_target_prisma_migrations() {
  git ls-tree -r --name-only "$TARGET_FULL_SHA" -- apps/api/prisma/migrations \
    | sed -n 's#^apps/api/prisma/migrations/\([^/][^/]*\)/migration\.sql$#\1#p' \
    | sort -u
}

read_applied_prisma_migrations() {
  docker compose "${COMPOSE_FILES[@]}" exec -T postgres psql -U maxim -d maxim -Atc \
    "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name;"
}

ensure_rollback_migrations_compatible() {
  local target_migrations
  local applied_migrations
  local migration
  local missing=()

  target_migrations="$(read_target_prisma_migrations)"
  if ! applied_migrations="$(read_applied_prisma_migrations)"; then
    echo "Could not read applied Prisma migrations; refusing runtime rollback." >&2
    return 1
  fi

  if [[ -z "$applied_migrations" ]]; then
    echo "No applied Prisma migrations found; rollback migration preflight passed."
    return 0
  fi

  if [[ -z "$target_migrations" ]]; then
    echo "Rollback target $ROLLBACK_REF has no Prisma migrations; refusing with applied DB migrations present." >&2
    return 1
  fi

  while IFS= read -r migration; do
    [[ -n "$migration" ]] || continue
    if ! grep -Fxq "$migration" <<<"$target_migrations"; then
      missing+=("$migration")
    fi
  done <<<"$applied_migrations"

  if [[ "${#missing[@]}" -gt 0 ]]; then
    cat >&2 <<EOF
Rollback target $ROLLBACK_REF is missing Prisma migrations already applied in the database:
${missing[*]}
Refusing rollback before changing git ref. Choose a compatible target or perform an explicit DB rollback plan.
EOF
    return 1
  fi

  echo "Rollback migration preflight passed for target $ROLLBACK_REF."
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

strict_smoke_json_ok() {
  MAXIM_SMOKE_TIMEOUT_MS="${MAXIM_ROLLBACK_SMOKE_TIMEOUT_MS:-3000}" \
    node "$SMOKE_HELPER" json-ok "$1"
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

record_runtime_rollback_release() {
  local release_id
  local args=()

  read_applied_prisma_migrations >"$APPLIED_MIGRATIONS_FILE"
  release_id="runtime-rollback-$(date -u +%Y%m%dT%H%M%S%NZ)-${TARGET_FULL_SHA:0:12}-$$"
  args=(
    commit
    --release-id "$release_id"
    --target-sha "$TARGET_FULL_SHA"
    --migrations-file "$APPLIED_MIGRATIONS_FILE"
    --retain "$RELEASE_RETAIN"
    --emergency-reason "ref-based API rollback from $ROLLBACK_REF"
    --component "api-shared|${TARGET_FULL_SHA}|${ROLLBACK_API_IMAGE}|${ROLLBACK_API_IMAGE_ID}"
    --smoke api-local-live
    --smoke api-local-ready
    --smoke api-admin-live
    --smoke api-admin-ready
    --smoke api-public-live
  )
  if [[ "$TARGET_HAS_MEDIA_ANALYSIS" -eq 1 ]]; then
    args+=(--smoke api-media-analysis-tesseract-rus-eng)
  fi
  MAXIM_RELEASE_STATE_DIR="$RELEASE_STATE_DIR" node "$RELEASE_MANIFEST_HELPER" "${args[@]}" >/dev/null
  MANIFEST_RECORDED=1
  echo "Release manifest committed: $release_id"
}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found"
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || \
  ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'; then
  echo "Node 24 is required for runtime rollback." >&2
  exit 1
fi
validate_release_retain
if [[ ! -s infra/scripts/release-manifest.mjs || ! -s scripts/smoke-http.mjs ]]; then
  echo "Current checkout is missing release manifest or strict smoke tooling." >&2
  exit 1
fi
if ! MAXIM_RELEASE_STATE_DIR="$RELEASE_STATE_DIR" \
  node infra/scripts/release-manifest.mjs show current >/dev/null; then
  echo "A valid current release manifest is required before ref-based rollback." >&2
  exit 1
fi

acquire_deploy_lock
trap cleanup EXIT
ensure_compose_env
refuse_conflicting_scale_stack
ensure_stateful_services_ready
PRESERVED_COMPOSE_FILE="$(mktemp "$ROOT_DIR/infra/.runtime-rollback-compose.XXXXXX.yml")"
PRESERVED_MIGRATION_COMPOSE_FILE="$(mktemp "$ROOT_DIR/infra/.runtime-rollback-no-build.XXXXXX.yml")"
RELEASE_MANIFEST_HELPER="$(mktemp --suffix=.mjs)"
SMOKE_HELPER="$(mktemp --suffix=.mjs)"
APPLIED_MIGRATIONS_FILE="$(mktemp)"
cp infra/docker-compose.yml "$PRESERVED_COMPOSE_FILE"
cp infra/docker-compose.runtime-no-build.yml "$PRESERVED_MIGRATION_COMPOSE_FILE"
cp infra/scripts/release-manifest.mjs "$RELEASE_MANIFEST_HELPER"
cp scripts/smoke-http.mjs "$SMOKE_HELPER"
COMPOSE_FILES=(--env-file "$ROOT_DIR/.env" -p infra -f "$PRESERVED_COMPOSE_FILE")
MIGRATION_COMPOSE_FILES=("${COMPOSE_FILES[@]}" -f "$PRESERVED_MIGRATION_COMPOSE_FILE")
CURRENT_HEAD="$(git rev-parse --short HEAD)"
TARGET_HEAD="${TARGET_FULL_SHA:0:12}"
ROLLBACK_API_IMAGE="maxim-api:runtime-rollback-${TARGET_FULL_SHA}"

echo "Runtime rollback: $CURRENT_HEAD -> $TARGET_HEAD"
echo "Services: ${SERVICES[*]}"
ensure_rollback_migrations_compatible
maxim_check_deploy_disk_capacity 1 0
git switch --detach "$TARGET_FULL_SHA"
maxim_topology_refuse_untracked_api_build_inputs

export MAXIM_API_IMAGE="$ROLLBACK_API_IMAGE"
maxim_topology_build_shared_api_image "$ROLLBACK_API_IMAGE" "$TARGET_FULL_SHA"
ROLLBACK_API_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$ROLLBACK_API_IMAGE")"
ROLLBACK_RUNTIME_STARTED=1
MAXIM_MIGRATION_API_IMAGE="$ROLLBACK_API_IMAGE" \
  docker compose "${MIGRATION_COMPOSE_FILES[@]}" run --rm --no-deps --pull never api-ingress \
  ./node_modules/.bin/prisma migrate deploy --config apps/api/prisma.config.ts
if [[ "$TARGET_HAS_MEDIA_ANALYSIS" -eq 0 ]]; then
  remove_incompatible_media_analysis_container
fi
docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --no-build --force-recreate "${SERVICES[@]}"

for service in "${SERVICES[@]}"; do
  wait_for_service_running "$service" 180
  verify_service_image_id "$service" "$ROLLBACK_API_IMAGE_ID"
done

wait_for_url "http://127.0.0.1:3001/api/health/live" 180
wait_for_url "http://127.0.0.1:3001/api/health/ready" 180
if contains_service "api-admin" "${SERVICES[@]}"; then
  wait_for_url "http://127.0.0.1:3002/api/health/live" 180
  wait_for_url "http://127.0.0.1:3002/api/health/ready" 180
fi
wait_for_url "$PUBLIC_HEALTH_URL/api/health/live" 180
strict_smoke_json_ok "http://127.0.0.1:3001/api/health/live"
strict_smoke_json_ok "http://127.0.0.1:3001/api/health/ready"
strict_smoke_json_ok "http://127.0.0.1:3002/api/health/live"
strict_smoke_json_ok "http://127.0.0.1:3002/api/health/ready"
strict_smoke_json_ok "$PUBLIC_HEALTH_URL/api/health/live"
if [[ "$TARGET_HAS_MEDIA_ANALYSIS" -eq 1 ]]; then
  maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES
fi
record_runtime_rollback_release

echo "Done: runtime rollback target=$TARGET_HEAD services=${SERVICES[*]}"
