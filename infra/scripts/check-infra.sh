#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

node scripts/agent/generate-deploy-impact-bash.mjs --check

while IFS= read -r -d '' script; do
  bash -n "$script"
done < <(find infra/scripts -type f -name '*.sh' -print0)

compose_validation() {
  MAXIM_COMPOSE_SERVICE_ENV_FILE=../.env.example \
    docker compose --env-file .env.example "$@" config --quiet
}

compose_validation -f infra/docker-compose.yml
compose_validation -f infra/docker-compose.yml -f infra/docker-compose.local.yml
compose_validation -f infra/docker-compose.yml -f infra/docker-compose.scale.yml
node --test infra/scripts/*.test.mjs

if command -v shellcheck >/dev/null 2>&1; then
  find infra/scripts -type f -name '*.sh' -print0 | xargs -0 shellcheck
else
  echo "shellcheck not installed; syntax and Compose checks completed" >&2
fi

if command -v actionlint >/dev/null 2>&1; then
  actionlint
else
  echo "actionlint not installed; workflow lint is enforced in CI" >&2
fi
