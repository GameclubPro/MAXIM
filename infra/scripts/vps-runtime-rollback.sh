#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILES=(-p infra -f "infra/docker-compose.yml")
ROLLBACK_REF="${1:-}"
PUBLIC_HEALTH_URL="${MAXIM_VPS_PUBLIC_URL:-${MAXIM_PUBLIC_HEALTH_URL:-https://major-maksimov.ru}}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL%/}"

if [[ -z "$ROLLBACK_REF" ]]; then
  echo "Usage: $0 <git-ref> [services...]"
  echo "Example: $0 HEAD@{1} api-enqueue api-moderation api-action api-ingress api-admin"
  exit 1
fi
shift || true

API_SERVICES=(
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
  "api-action"
)

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

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found"
  exit 1
fi

ensure_compose_env
CURRENT_HEAD="$(git rev-parse --short HEAD)"
TARGET_HEAD="$(git rev-parse --short "$ROLLBACK_REF")"

echo "Runtime rollback: $CURRENT_HEAD -> $TARGET_HEAD"
echo "Services: ${SERVICES[*]}"
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
wait_for_url "$PUBLIC_HEALTH_URL/api/health/ready" 180

echo "Done: runtime rollback target=$TARGET_HEAD services=${SERVICES[*]}"
