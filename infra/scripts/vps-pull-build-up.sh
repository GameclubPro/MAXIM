#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

BRANCH="${1:-main}"

if [[ $# -ge 2 ]]; then
  SERVICES=("${@:2}")
else
  SERVICES=("api" "miniapp-static")
fi

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

docker compose -f infra/docker-compose.yml exec -T api npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
docker compose -f infra/docker-compose.yml build "${SERVICES[@]}"
docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate "${SERVICES[@]}"

until curl -fsS http://127.0.0.1:3001/api/health/live >/dev/null; do
  sleep 1
done

curl -i http://127.0.0.1:3001/api/health/live
curl -i https://maxim.play-team.ru/api/health/live

echo "Done: branch=$BRANCH services=${SERVICES[*]}"
