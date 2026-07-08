#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=infra/scripts/lib/deploy-topology.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"

COMPOSE_FILES=(--env-file ".env" -p infra -f "infra/docker-compose.yml")
SCALE_COMPOSE_FILES=(-p infra-scale -f "infra/docker-compose.scale.yml")
ROLLBACK_REF="${1:-}"
PUBLIC_HEALTH_URL="${MAXIM_VPS_PUBLIC_URL:-${MAXIM_PUBLIC_HEALTH_URL:-https://major-maksimov.ru}}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL%/}"

if [[ -z "$ROLLBACK_REF" ]]; then
  echo "Usage: $0 <git-ref> [services...]"
  echo "Example: $0 HEAD@{1} api-enqueue api-moderation api-action api-ingress api-admin"
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

has_requested_api_service() {
  local service
  for service in "${SERVICES[@]}"; do
    if maxim_topology_is_api_service "$service"; then
      return 0
    fi
  done
  return 1
}

if has_requested_api_service; then
  maxim_topology_expand_api_services SERVICES \
    "Runtime rollback includes an API role."
fi

wait_for_url() {
  local url="$1"
  local attempts="${2:-120}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done

  echo "Health check timeout: $url"
  return 1
}

wait_for_postgres() {
  local attempts="${1:-120}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if docker compose "${COMPOSE_FILES[@]}" exec -T postgres pg_isready -U maxim -d maxim >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Postgres readiness timeout."
  docker compose "${COMPOSE_FILES[@]}" logs --tail=120 postgres || true
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

stop_conflicting_scale_stack() {
  local running_services

  running_services="$(docker compose "${SCALE_COMPOSE_FILES[@]}" ps --status running --services 2>/dev/null || true)"
  if [[ -z "$running_services" ]]; then
    return 0
  fi

  echo "Stopping conflicting infra-scale stack before runtime rollback."
  docker compose "${SCALE_COMPOSE_FILES[@]}" down --remove-orphans
}

read_target_prisma_migrations() {
  git ls-tree -r --name-only "$ROLLBACK_REF" -- apps/api/prisma/migrations \
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

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found"
  exit 1
fi

acquire_deploy_lock
ensure_compose_env
stop_conflicting_scale_stack
CURRENT_HEAD="$(git rev-parse --short HEAD)"
TARGET_HEAD="$(git rev-parse --short "$ROLLBACK_REF")"

echo "Runtime rollback: $CURRENT_HEAD -> $TARGET_HEAD"
echo "Services: ${SERVICES[*]}"
docker compose "${COMPOSE_FILES[@]}" up -d postgres
wait_for_postgres 180
ensure_rollback_migrations_compatible
git switch --detach "$ROLLBACK_REF"

docker compose "${COMPOSE_FILES[@]}" up -d postgres redis
docker compose "${COMPOSE_FILES[@]}" build "${API_SERVICES[@]}"
docker compose "${COMPOSE_FILES[@]}" run --rm --no-deps api-ingress \
  ./apps/api/node_modules/.bin/prisma migrate deploy --config apps/api/prisma.config.ts
docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --force-recreate "${SERVICES[@]}"

for service in "${SERVICES[@]}"; do
  wait_for_service_running "$service" 180
done

wait_for_url "http://127.0.0.1:3001/api/health/live" 180
wait_for_url "http://127.0.0.1:3001/api/health/ready" 180
if contains_service "api-admin" "${SERVICES[@]}"; then
  wait_for_url "http://127.0.0.1:3002/api/health/live" 180
  wait_for_url "http://127.0.0.1:3002/api/health/ready" 180
fi
wait_for_url "$PUBLIC_HEALTH_URL/api/health/live" 180

echo "Done: runtime rollback target=$TARGET_HEAD services=${SERVICES[*]}"
