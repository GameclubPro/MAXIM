#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

REMOTE_MONITOR_LOCK_FILE="${MAXIM_MONITOR_REMOTE_LOCK_FILE:-/tmp/maxim-vps-monitor-readonly.lock}"
if [[ "$REMOTE_MONITOR_LOCK_FILE" != '/tmp/maxim-vps-monitor-readonly.lock' &&
  ! "$REMOTE_MONITOR_LOCK_FILE" =~ ^/tmp/maxim-vps-monitor-readonly\.test-[A-Za-z0-9_-]+\.lock$ ]]; then
  echo "MAXIM_MONITOR_REMOTE_LOCK_FILE must use the canonical monitor lock path." >&2
  exit 2
fi

if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required for VPS-wide readonly monitor serialization." >&2
  exit 2
fi
exec {REMOTE_MONITOR_LOCK_FD}>>"$REMOTE_MONITOR_LOCK_FILE"
if ! flock -n "$REMOTE_MONITOR_LOCK_FD"; then
  echo "Another VPS-wide readonly monitor is already running." >&2
  exit 3
fi

printf '%s\n' 'MAXIM_REMOTE_MONITOR_LOCK_ACQUIRED'
while IFS=' ' read -r command challenge extra; do
  if [[ "$command" != 'MAXIM_REMOTE_MONITOR_LOCK_PING' ||
    ! "$challenge" =~ ^[1-9][0-9]*-[0-9]+-[1-9][0-9]*$ ||
    -n "$extra" ]]; then
    echo "Invalid readonly monitor lock challenge." >&2
    exit 2
  fi
  printf 'MAXIM_REMOTE_MONITOR_LOCK_ACK %s\n' "$challenge"
done
