#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ensure_compose_env() {
  local tmp_env
  local container_name
  local restore_candidates=(
    "infra-api-admin-1"
    "infra-api-ingress-1"
    "infra-api-enqueue-1"
    "infra-api-moderation-1"
    "infra-api-action-1"
    "infra-api-1"
  )

  if [[ -s .env ]]; then
    return 0
  fi

  for container_name in "${restore_candidates[@]}"; do
    if ! docker ps --format '{{.Names}}' | grep -qx "$container_name"; then
      continue
    fi

    echo "Missing .env. Restoring it from $container_name container env..."
    tmp_env="$(mktemp .env.restore.XXXXXX)"
    if docker inspect "$container_name" --format '{{range .Config.Env}}{{println .}}{{end}}' \
      | awk '!/^(PATH|NODE_VERSION|YARN_VERSION)=/' >"$tmp_env" && [[ -s "$tmp_env" ]]; then
      mv "$tmp_env" .env
      return 0
    fi

    rm -f "$tmp_env"
    echo "Failed to restore .env from $container_name container env."
    return 1
  done

  echo "Missing .env in project root"
  exit 1
}

ensure_compose_env

npm ci
npm run build --workspace @maxim/contracts
npm run build --workspace @maxim/api
npm run build --workspace @maxim/miniapp

docker compose -f infra/docker-compose.yml pull

docker compose -f infra/docker-compose.yml up -d --build --remove-orphans

ensure_compose_env
docker compose -f infra/docker-compose.yml exec -T api-ingress sh -lc \
  'cd /app/apps/api && ../../node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma'

echo "Deployment complete"
