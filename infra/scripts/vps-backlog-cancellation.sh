#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
if [[ $# != 0 || ! "${MAXIM_EXPECTED_DEPLOY_SHA:-}" =~ ^[0-9a-f]{40}$ || \
  "$(git rev-parse HEAD)" != "$MAXIM_EXPECTED_DEPLOY_SHA" || -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo 'Cancellation requires clean exact synchronized source.' >&2
  exit 2
fi
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
acquire_deploy_lock
exec node "$ROOT_DIR/infra/scripts/backlog-cancellation-host.mjs"
