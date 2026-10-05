#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--apply' ) ]]; then
  echo 'Usage: recover-multibot-index-migration [--apply]' >&2
  exit 2
fi
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
acquire_deploy_lock
MAXIM_MULTIBOT_INDEX_RECOVERY_APP_NAME="maxim-online-$(node -p 'require("node:crypto").randomUUID()')"
export MAXIM_MULTIBOT_INDEX_RECOVERY_APP_NAME
launcher_pid=''
# FLAG: EXIT invokes this lifecycle function indirectly; real signal fixtures prove
# its reachability and launcher-before-backend ordering.
# shellcheck disable=SC2317
cleanup() {
  local attempt_status="$?"
  local poll
  local launcher_group
  trap - EXIT INT TERM HUP
  # FLAG: Reap the owned launcher before proving backend/container absence. A shell-only
  # signal must not release the lock while that launcher can start the next operation.
  if [[ -n "$launcher_pid" ]]; then
    kill -TERM "$launcher_pid" 2>/dev/null || true
    for ((poll = 0; poll < 40; poll += 1)); do
      if ! kill -0 "$launcher_pid" 2>/dev/null; then break; fi
      sleep 0.1
    done
    if kill -0 "$launcher_pid" 2>/dev/null; then
      launcher_group="$(ps -o pgid= -p "$launcher_pid" | tr -d '[:space:]')"
      if [[ "$launcher_group" != "$launcher_pid" ]]; then
        echo 'MULTIBOT_RECOVERY_LAUNCHER_IDENTITY_UNCONFIRMED; owned launcher cleanup requires review.' >&2
        exit 1
      fi
      # GNU timeout creates this invocation's own process group. Stop its complete
      # launcher tree before backend absence checks, including a blocked Node handler.
      kill -KILL -- "-$launcher_pid" 2>/dev/null || true
    fi
    wait "$launcher_pid" 2>/dev/null || true
    launcher_pid=''
  fi
  if ! timeout --kill-after=5s 50s node infra/scripts/multibot-index-migration-recovery.mjs --cleanup; then
    echo 'MULTIBOT_RECOVERY_CLEANUP_UNCONFIRMED; inspect the exact owned operation before retry.' >&2
    release_deploy_lock
    exit 1
  fi
  release_deploy_lock
  exit "$attempt_status"
}
trap 'cleanup' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
# FLAG: The helper supervises every concurrent operation and verifies exact-session
# cancellation on failure. Do not shorten kill-after below its bounded cleanup window.
timeout --kill-after=30s 3900s node infra/scripts/multibot-index-migration-recovery.mjs "$@" &
launcher_pid="$!"
if wait "$launcher_pid"; then
  attempt_status=0
else
  attempt_status="$?"
fi
launcher_pid=''
exit "$attempt_status"
