#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"

COMPOSE_FILES=(--env-file .env -p infra -f infra/docker-compose.yml)
CONTROL_HELPER="$ROOT_DIR/infra/scripts/legacy-vk-publish-queue-cleanup.cjs"
COMMAND_TIMEOUT_SEC="${MAXIM_LEGACY_VK_QUEUE_CLEANUP_TIMEOUT_SEC:-120}"
ACTION=preview

usage() {
  cat <<'USAGE'
Usage:
  ./infra/scripts/vps-retire-legacy-vk-publish-queue.sh [--apply]

The default is a read-only preview. Apply refuses a live legacy worker, pauses only
vk-parsing-publish, rechecks worker and active counts, and obliterates without force.
An active job leaves the queue paused and the command fails closed. No database state,
vk-parsing-sync work, or vk-parsing-publisher work is changed.
USAGE
}

parse_args() {
  if [[ $# -eq 0 ]]; then
    return 0
  fi
  if [[ $# -eq 1 && "$1" == "--apply" ]]; then
    ACTION=apply
    return 0
  fi
  if [[ $# -eq 1 && ( "$1" == "--help" || "$1" == "-h" ) ]]; then
    usage
    exit 0
  fi
  usage >&2
  exit 2
}

require_preconditions() {
  local api_admin_ids=()

  [[ -f .env ]] || {
    echo "Production Compose env is unavailable." >&2
    return 1
  }
  [[ -s "$CONTROL_HELPER" ]] || {
    echo "Legacy VK publish queue cleanup helper is unavailable." >&2
    return 1
  }
  command -v docker >/dev/null 2>&1 || {
    echo "docker not found." >&2
    return 1
  }
  command -v timeout >/dev/null 2>&1 || {
    echo "timeout not found." >&2
    return 1
  }
  if [[ ! "$COMMAND_TIMEOUT_SEC" =~ ^[1-9][0-9]{1,2}$ ]] ||
    ((10#$COMMAND_TIMEOUT_SEC < 30 || 10#$COMMAND_TIMEOUT_SEC > 600)); then
    echo "MAXIM_LEGACY_VK_QUEUE_CLEANUP_TIMEOUT_SEC must be between 30 and 600." >&2
    return 1
  fi
  mapfile -t api_admin_ids < <(
    docker compose "${COMPOSE_FILES[@]}" ps --status running -q api-admin 2>/dev/null
  )
  if [[ "${#api_admin_ids[@]}" -ne 1 || -z "${api_admin_ids[0]}" ]]; then
    echo "Exactly one running api-admin container is required." >&2
    return 1
  fi
}

run_control() {
  local output
  local output_bytes
  local status

  set +e
  output="$({
    timeout --foreground --kill-after=5s "${COMMAND_TIMEOUT_SEC}s" \
      docker compose "${COMPOSE_FILES[@]}" exec -T api-admin node - "$ACTION" \
      <"$CONTROL_HELPER"
  })"
  status=$?
  set -e

  output_bytes="$(printf '%s' "$output" | wc -c)"
  if [[ ! "$output_bytes" =~ ^[0-9]+$ || "$output_bytes" -lt 2 || "$output_bytes" -gt 16384 ]]; then
    echo "Legacy VK publish queue cleanup returned invalid output." >&2
    return 1
  fi
  printf '%s\n' "$output"
  return "$status"
}

parse_args "$@"
require_preconditions
acquire_deploy_lock
run_control
