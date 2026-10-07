#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

require_corrective_controller_source() {
  local actual_sha tracked_status
  if [[ ! "${MAXIM_EXPECTED_CONTROLLER_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || \
    ! actual_sha="$(git rev-parse HEAD)" || \
    ! tracked_status="$(git status --porcelain --untracked-files=no)" || \
    [[ "$actual_sha" != "$MAXIM_EXPECTED_CONTROLLER_SHA" || -n "$tracked_status" ]]; then
    echo 'Corrective recovery requires the exact clean controller source.' >&2
    return 2
  fi
}

if [[ $# != 0 ]]; then
  echo 'Corrective recovery accepts only a bounded stdin envelope.' >&2
  exit 2
fi
require_corrective_controller_source
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
acquire_deploy_lock
# FLAG: Recheck controller identity under the inherited shared lock. The envelope
# separately binds the stopped runtime and cannot authorize a new recovery scope.
require_corrective_controller_source
exec node "$ROOT_DIR/infra/scripts/source-abandonment-corrective-host.mjs"
