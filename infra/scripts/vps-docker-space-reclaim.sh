#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"

MAX_AGE="${MAXIM_DOCKER_RECLAIM_UNTIL:-168h}"
RELEASE_STATE_DIR="${MAXIM_RELEASE_STATE_DIR:-/var/lib/maxim-deploy}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --until)
      [[ $# -ge 2 ]] || {
        echo "--until requires a duration, timestamp, or date." >&2
        exit 2
      }
      MAX_AGE="$2"
      shift 2
      ;;
    --state-dir)
      [[ $# -ge 2 ]] || {
        echo "--state-dir requires a path." >&2
        exit 2
      }
      RELEASE_STATE_DIR="$2"
      shift 2
      ;;
    --help|-h)
      cat <<'USAGE'
Usage: vps-docker-space-reclaim.sh [--dry-run] [--until CUTOFF] [--state-dir PATH]

The default action removes only old, unused immutable MAXIM release images that
are outside retained manifests and container use. --dry-run forwards a read-only
plan to the manifest-aware reclaim tool and never removes images.
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

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
reclaim_args=(
  reclaim
  --state-dir "$RELEASE_STATE_DIR" \
  --until "$MAX_AGE"
)
if [[ "$DRY_RUN" == 1 ]]; then
  reclaim_args+=(--dry-run)
fi
node infra/scripts/release-image-reclaim.mjs "${reclaim_args[@]}"
echo
echo "Shared Docker build cache, containers, volumes, and unrelated images were left untouched."
echo "Docker disk inventory after reclaim:"
df -h / /var/lib/docker 2>/dev/null || df -h /
docker system df
