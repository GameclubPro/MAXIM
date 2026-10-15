#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
# shellcheck source=infra/scripts/lib/legacy-cold-maintenance.sh
source "$ROOT_DIR/infra/scripts/lib/legacy-cold-maintenance.sh"
acquire_deploy_lock
maxim_require_ordinary_effect_authority "$ROOT_DIR" </dev/null
# FLAG: An interrupted SSH/docker client cannot revoke an already-started database
# transaction. Retain the deployment lock beyond the remote process hard deadline.
export MAXIM_FIXED_MODERATOR_PRESERVATION_DEADLINE=$(( $(date +%s%3N) + 75000 ))
PRESERVATION_SETTLE_AT=$((SECONDS + 95))
PRESERVATION_FINISHED=0
finish_preservation() {
  local result=$?
  trap - EXIT
  trap '' INT TERM HUP
  if [[ "$PRESERVATION_FINISHED" != 1 ]]; then
    while ((SECONDS < PRESERVATION_SETTLE_AT)); do sleep 1; done
  fi
  release_deploy_lock
  exit "$result"
}
trap finish_preservation EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
node "$ROOT_DIR/infra/scripts/fixed-moderator-preservation-host.mjs" "$@"
PRESERVATION_FINISHED=1
