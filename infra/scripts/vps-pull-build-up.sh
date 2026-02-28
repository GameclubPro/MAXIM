#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILES=(-f "infra/docker-compose.yml")
BRANCH="${1:-main}"

if [[ $# -ge 2 ]]; then
  SERVICES=("${@:2}")
else
  SERVICES=("api" "miniapp-static")
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

run_migrations() {
  docker compose "${COMPOSE_FILES[@]}" run --rm --no-deps api npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found"
  exit 1
fi

git fetch origin "$BRANCH"

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout "$BRANCH"
else
  git checkout -b "$BRANCH" "origin/$BRANCH"
fi

git pull --ff-only origin "$BRANCH"

docker compose "${COMPOSE_FILES[@]}" up -d postgres redis
wait_for_postgres 180

docker compose "${COMPOSE_FILES[@]}" build api

if ! run_migrations; then
  echo "First migration attempt failed. Retrying once in 5 seconds..."
  sleep 5
  run_migrations
fi

docker compose "${COMPOSE_FILES[@]}" build "${SERVICES[@]}"
docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --force-recreate "${SERVICES[@]}"

wait_for_url "http://127.0.0.1:3001/api/health/live" 180
wait_for_url "https://maxim.play-team.ru/api/health/live" 180

curl -i http://127.0.0.1:3001/api/health/live
curl -i https://maxim.play-team.ru/api/health/live

if contains_service "miniapp-static" "${SERVICES[@]}"; then
  curl -i https://maxim.play-team.ru/app/
fi

echo "Done: branch=$BRANCH services=${SERVICES[*]}"
