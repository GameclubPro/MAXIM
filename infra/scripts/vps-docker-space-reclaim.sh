#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"

MAX_AGE="${MAXIM_DOCKER_RECLAIM_UNTIL:-168h}"
RELEASE_STATE_DIR="${MAXIM_RELEASE_STATE_DIR:-/var/lib/maxim-deploy}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || \
  ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'; then
  echo "Node 24 is required for release image reclaim." >&2
  exit 1
fi

acquire_deploy_lock

echo "Docker disk inventory before reclaim:"
df -h / /var/lib/docker 2>/dev/null || df -h /
docker system df
echo
echo "Running containers and their images:"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
echo
echo "Removing only unused immutable MAXIM release images outside retained manifests and container use."
node infra/scripts/release-image-reclaim.mjs reclaim \
  --state-dir "$RELEASE_STATE_DIR" \
  --until "$MAX_AGE"
echo
echo "Shared Docker build cache, containers, volumes, and unrelated images were left untouched."
echo "Docker disk inventory after reclaim:"
df -h / /var/lib/docker 2>/dev/null || df -h /
docker system df
