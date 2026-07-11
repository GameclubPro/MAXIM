#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

MAX_AGE="${MAXIM_DOCKER_RECLAIM_UNTIL:-168h}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found" >&2
  exit 1
fi

echo "Docker disk inventory before reclaim:"
df -h / /var/lib/docker 2>/dev/null || df -h /
docker system df
echo
echo "Running containers and their images:"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
echo
echo "Pruning build cache older than $MAX_AGE. Docker volumes are never pruned."
docker builder prune --all --force --filter "until=$MAX_AGE"
echo
echo "Pruning unused images older than $MAX_AGE. Running-container images are retained."
docker image prune --all --force --filter "until=$MAX_AGE"
echo
echo "Docker disk inventory after reclaim:"
df -h / /var/lib/docker 2>/dev/null || df -h /
docker system df
