#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
if [[ $# != 0 || ! "${MAXIM_EXPECTED_DEPLOY_SHA:-}" =~ ^[0-9a-f]{40}$ || \
  "$(git rev-parse HEAD)" != "$MAXIM_EXPECTED_DEPLOY_SHA" ]]; then
  echo 'Cold controller requires the exact synchronized source and a bounded stdin request.' >&2
  exit 2
fi
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
acquire_deploy_lock
# FLAG: Exec preserves the protected lock descriptor through every journal/store
# operation. This entrypoint never invokes the ordinary deploy or replays an event.
exec node "$ROOT_DIR/infra/scripts/legacy-cold-host.mjs"
