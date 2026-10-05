#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
node infra/scripts/multibot-preparation-recovery.mjs --validate-args "$@"
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
acquire_deploy_lock
trap release_deploy_lock EXIT
export MAXIM_MULTIBOT_RECOVERY_LOCKED=1
# FLAG: Node owns signal-aware exact-session cleanup. Do not timeout/kill its supervisor.
RECOVERY_NODE_PID=''
RECOVERY_PENDING_SIGNAL=''
forward_recovery_signal() {
  local signal="$1"
  if [[ -z "$RECOVERY_NODE_PID" ]]; then
    RECOVERY_PENDING_SIGNAL="$signal"
    return
  fi
  # Keep the deploy lock until Node has confirmed its own exact cleanup and exited.
  trap '' INT TERM HUP
  kill -s "$signal" "$RECOVERY_NODE_PID" 2>/dev/null || true
  wait "$RECOVERY_NODE_PID" || true
  exit 1
}
trap 'forward_recovery_signal INT' INT
trap 'forward_recovery_signal TERM' TERM
trap 'forward_recovery_signal HUP' HUP
node infra/scripts/multibot-preparation-recovery.mjs "$@" &
RECOVERY_NODE_PID=$!
if [[ -n "$RECOVERY_PENDING_SIGNAL" ]]; then
  forward_recovery_signal "$RECOVERY_PENDING_SIGNAL"
fi
set +e
wait "$RECOVERY_NODE_PID"
RECOVERY_STATUS=$?
set -e
exit "$RECOVERY_STATUS"
