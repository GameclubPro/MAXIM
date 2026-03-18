#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILES=(-f "infra/docker-compose.yml")
BRANCH="${1:-main}"
PRE_PULL_HEAD=""

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

has_pulled_changes() {
  [[ -n "$PRE_PULL_HEAD" ]] && [[ "$PRE_PULL_HEAD" != "$(git rev-parse HEAD)" ]]
}

diff_in_paths() {
  if ! has_pulled_changes; then
    return 1
  fi

  if git diff --quiet "$PRE_PULL_HEAD" HEAD -- "$@" >/dev/null 2>&1; then
    return 1
  fi

  case $? in
    1) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_compose_env() {
  local tmp_env

  if [[ -s .env ]]; then
    return 0
  fi

  if docker ps --format '{{.Names}}' | grep -qx 'infra-api-1'; then
    echo "Missing .env. Restoring it from infra-api-1 container env..."
    tmp_env="$(mktemp .env.restore.XXXXXX)"
    if docker inspect infra-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \
      | awk '!/^(PATH|NODE_VERSION|YARN_VERSION)=/' >"$tmp_env" && [[ -s "$tmp_env" ]]; then
      mv "$tmp_env" .env
      return 0
    fi

    rm -f "$tmp_env"
    echo "Failed to restore /var/www/Chat_bot/.env from infra-api-1 container env."
    return 1
  fi

  echo "Missing /var/www/Chat_bot/.env and infra-api-1 is unavailable for restore."
  echo "Create .env manually, then rerun the deploy."
  return 1
}

sync_branch() {
  local stash_name
  local tracked_status

  git fetch origin "$BRANCH"

  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git checkout "$BRANCH"
  else
    git checkout -b "$BRANCH" "origin/$BRANCH"
  fi

  PRE_PULL_HEAD="$(git rev-parse HEAD)"
  tracked_status="$(git status --porcelain --untracked-files=no)"

  if [[ -n "$tracked_status" ]]; then
    if git diff --quiet "origin/$BRANCH" -- && git diff --cached --quiet "origin/$BRANCH" --; then
      stash_name="codex-sync-${BRANCH}-$(date +%Y%m%d-%H%M%S)"
      echo "Worktree matches origin/$BRANCH but blocks ff-only pull. Stashing snapshot: $stash_name"
      git stash push -m "$stash_name" >/dev/null
      git pull --ff-only origin "$BRANCH"
      git stash drop stash@{0} >/dev/null || true
      return 0
    fi

    echo "VPS worktree has local changes that do not match origin/$BRANCH."
    git status --short
    git diff --stat -- . ':(exclude).env' || true
    return 1
  fi

  git pull --ff-only origin "$BRANCH"
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
  ensure_compose_env
  docker compose "${COMPOSE_FILES[@]}" run --rm --no-deps api npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found"
  exit 1
fi

sync_branch
ensure_compose_env

BUILD_API_IMAGE=0
if contains_service "api" "${SERVICES[@]}"; then
  BUILD_API_IMAGE=1
elif diff_in_paths apps/api packages/contracts package.json package-lock.json tsconfig.base.json; then
  BUILD_API_IMAGE=1
  echo "API-related changes detected. Building api image for migrations, but api service recreation was not requested."
fi

docker compose "${COMPOSE_FILES[@]}" up -d postgres redis
wait_for_postgres 180

if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
  ensure_compose_env
  docker compose "${COMPOSE_FILES[@]}" build api
fi

if ! run_migrations; then
  echo "First migration attempt failed. Retrying once in 5 seconds..."
  sleep 5
  run_migrations
fi

SERVICES_TO_BUILD=()
for service in "${SERVICES[@]}"; do
  if [[ "$service" == "api" ]] && [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
    continue
  fi
  SERVICES_TO_BUILD+=("$service")
done

if [[ "${#SERVICES_TO_BUILD[@]}" -gt 0 ]]; then
  docker compose "${COMPOSE_FILES[@]}" build "${SERVICES_TO_BUILD[@]}"
fi

ensure_compose_env
docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --force-recreate "${SERVICES[@]}"

wait_for_url "http://127.0.0.1:3001/api/health/live" 180
wait_for_url "https://maxim.play-team.ru/api/health/live" 180

curl -i http://127.0.0.1:3001/api/health/live
curl -i https://maxim.play-team.ru/api/health/live

if contains_service "miniapp-static" "${SERVICES[@]}"; then
  curl -i https://maxim.play-team.ru/app/
fi

echo "Done: branch=$BRANCH services=${SERVICES[*]}"
