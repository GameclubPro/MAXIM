#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source infra/scripts/lib/deploy-lock.sh
# shellcheck source=infra/scripts/lib/legacy-cold-maintenance.sh
source infra/scripts/lib/legacy-cold-maintenance.sh
# shellcheck source=infra/scripts/lib/eraser-deploy.sh
source infra/scripts/lib/eraser-deploy.sh
acquire_deploy_lock
maxim_require_ordinary_effect_authority "$ROOT_DIR"
expected_sha="${1:-}"
mode="${2:-}"
[[ "$expected_sha" =~ ^[0-9a-f]{40}$ && "$(git rev-parse HEAD)" == "$expected_sha" ]] || { echo 'Lastik bootstrap requires synchronized exact source.' >&2; exit 2; }
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo 'Lastik bootstrap requires a clean checkout.' >&2; exit 2; }
mountpoint -q /mnt/maxim-cold || { echo 'Lastik cold storage mount is unavailable.' >&2; exit 1; }
# The bootstrap provisions only the two new empty Lastik directories, never sibling stores.
for store in postgres redis; do
  directory="/mnt/maxim-cold/runtime/eraser/$store"
  [[ ! -L "$directory" ]] || { echo 'Unsafe Lastik store path.' >&2; exit 1; }
  if [[ ! -d "$directory" ]]; then sudo -n install -d -m 0700 "$directory"; fi
done
if [[ "$mode" != --stores-only ]]; then
  [[ -z "$mode" ]] || { echo 'Unknown Lastik bootstrap mode.' >&2; exit 2; }
  if [[ ! -d /var/lib/maxim-secrets ]]; then
    sudo -n install -d -m 0700 -o "$(id -un)" -g "$(id -gn)" /var/lib/maxim-secrets
  fi
  node infra/scripts/eraser-bootstrap.mjs install "$expected_sha"
fi
maxim_eraser_require_secrets
# FLAG: First startup is separate from application deploy; existing containers are not recreated.
bootstrap_compose=(--env-file .env -p infra -f infra/docker-compose.yml)
docker compose "${bootstrap_compose[@]}" up -d --no-recreate eraser-postgres eraser-redis
for attempt in $(seq 1 60); do
  if maxim_eraser_require_stores bootstrap_compose 2>/dev/null; then break; fi
  [[ "$attempt" != 60 ]] || { echo 'Lastik stores did not become healthy.' >&2; exit 1; }
  sleep 1
done
echo 'Lastik stores initialized; deploy the exact green application image next.'
