#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "Missing .env in project root"
  exit 1
fi

npm ci
npm run build --workspace @maxim/contracts
npm run build --workspace @maxim/api
npm run build --workspace @maxim/miniapp

docker compose -f infra/docker-compose.yml pull

docker compose -f infra/docker-compose.yml up -d --build --remove-orphans

docker compose -f infra/docker-compose.yml exec -T api npm run prisma:migrate:deploy --workspace @maxim/api

echo "Deployment complete"
