#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=infra/scripts/lib/monitor-process-tree.sh
source "$ROOT_DIR/infra/scripts/lib/monitor-process-tree.sh"

if [[ $# -lt 1 ]]; then
  echo "Monitor process guardian requires a command." >&2
  exit 2
fi
guardian_pid="$BASHPID"
guardian_identity="$(monitor_read_process_identity "$guardian_pid")" || {
  echo "Could not bind the monitor process guardian to its identity." >&2
  exit 2
}
IFS=$'\t' read -r observed_pid state _ppid pgrp session guardian_starttime <<<"$guardian_identity"
if [[ "$observed_pid" != "$guardian_pid" ||
  "$pgrp" != "$guardian_pid" ||
  "$session" != "$guardian_pid" ||
  "$state" == 'Z' ||
  "$state" == 'X' ||
  "$state" == 'x' ]]; then
  echo "Monitor process guardian must be the isolated session leader." >&2
  exit 2
fi

# The wrapper supervises and signals the complete session. Keep its identity anchor alive while
# the command or any descendant remains, even if Bash signals the asynchronous job leader first.
trap '' HUP INT TERM
exec {GUARDIAN_STDIN_FD}<&0
(
  trap - HUP INT TERM
  export MAXIM_MONITOR_PARENT_PID="$guardian_pid"
  export MAXIM_MONITOR_PARENT_STARTTIME="$guardian_starttime"
  exec "$@" <&"$GUARDIAN_STDIN_FD"
) &
command_pid=$!
status=0
wait "$command_pid" || status=$?
exec {GUARDIAN_STDIN_FD}<&-

empty_observations=0
while ((empty_observations < 5)); do
  if monitor_owned_session_has_descendants "$guardian_pid" "$guardian_starttime"; then
    empty_observations=0
  else
    empty_observations=$((empty_observations + 1))
  fi
  sleep 0.05
done
exit "$status"
