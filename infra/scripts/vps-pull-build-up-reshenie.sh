#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_REL_PATH="${SCRIPT_PATH#$ROOT_DIR/}"
ORIGINAL_ARGS=("$@")

PROJECT_NAME="reshenie"
COMPOSE_FILES=(-p "$PROJECT_NAME" -f "infra/docker-compose.reshenie.yml")
BRANCH="${1:-main}"
PRE_PULL_HEAD=""
ENV_FILE=".env.reshenie"

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

reexec_if_current_script_changed() {
  if [[ "${MAXIM_DEPLOY_SCRIPT_REEXECED:-0}" == "1" ]]; then
    return 0
  fi

  if ! diff_in_paths "$SCRIPT_REL_PATH"; then
    return 0
  fi

  echo "Deploy script changed during git pull. Re-executing updated $SCRIPT_REL_PATH..."
  export MAXIM_DEPLOY_SCRIPT_REEXECED=1
  exec "$SCRIPT_PATH" "${ORIGINAL_ARGS[@]}"
}

ensure_compose_env() {
  local tmp_env
  local container_name="reshenie-api-1"

  if [[ -s "$ENV_FILE" ]]; then
    return 0
  fi

  if docker ps --format '{{.Names}}' | grep -qx "$container_name"; then
    echo "Missing $ENV_FILE. Restoring it from $container_name container env..."
    tmp_env="$(mktemp "${ENV_FILE}.restore.XXXXXX")"
    if docker inspect "$container_name" --format '{{range .Config.Env}}{{println .}}{{end}}' \
      | awk '!/^(PATH|NODE_VERSION|YARN_VERSION)=/' >"$tmp_env" && [[ -s "$tmp_env" ]]; then
      mv "$tmp_env" "$ENV_FILE"
      return 0
    fi

    rm -f "$tmp_env"
    echo "Failed to restore $ENV_FILE from $container_name container env."
    return 1
  fi

  echo "Missing $ENV_FILE and no running $container_name container is available for restore."
  echo "Create $ENV_FILE manually from infra/env/reshenie.env.example, then rerun the deploy."
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
    git diff --stat -- . ":(exclude)$ENV_FILE" || true
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
  docker compose "${COMPOSE_FILES[@]}" ps "$service" || true
  docker compose "${COMPOSE_FILES[@]}" logs --tail=120 "$service" || true
  return 1
}

run_migrations() {
  ensure_compose_env
  docker compose "${COMPOSE_FILES[@]}" run --rm --no-deps api \
    ./apps/api/node_modules/.bin/prisma migrate deploy --config apps/api/prisma.config.ts
}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found"
  exit 1
fi

sync_branch
reexec_if_current_script_changed
ensure_compose_env

docker compose "${COMPOSE_FILES[@]}" up -d postgres redis
wait_for_postgres 180

ensure_compose_env
docker compose "${COMPOSE_FILES[@]}" build api miniapp-static

if ! run_migrations; then
  echo "First migration attempt failed. Retrying once in 5 seconds..."
  sleep 5
  run_migrations
fi

docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --force-recreate api miniapp-static
wait_for_service_running api 180
wait_for_service_running miniapp-static 180

wait_for_url "http://127.0.0.1:3011/api/health/live" 180
wait_for_url "http://127.0.0.1:3011/api/health/ready" 180
wait_for_url "https://hook.maxim.play-team.ru/reshenie/api/health/live" 180
wait_for_url "https://hook.maxim.play-team.ru/reshenie/api/health/ready" 180
wait_for_url "https://maxim.play-team.ru/reshenie/api/health/live" 180
wait_for_url "https://maxim.play-team.ru/reshenie/api/health/ready" 180
wait_for_url "https://maxim.play-team.ru/reshenie/app/" 180

curl -i http://127.0.0.1:3011/api/health/live
curl -i http://127.0.0.1:3011/api/health/ready
curl -i https://hook.maxim.play-team.ru/reshenie/api/health/live
curl -i https://hook.maxim.play-team.ru/reshenie/api/health/ready
curl -i https://maxim.play-team.ru/reshenie/api/health/live
curl -i https://maxim.play-team.ru/reshenie/api/health/ready
curl -i https://maxim.play-team.ru/reshenie/app/

echo "Done: branch=$BRANCH project=$PROJECT_NAME services=api miniapp-static"
