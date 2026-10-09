#!/usr/bin/env bash

# FLAG: Ordinary starts, recovery cleanup, rollbacks and manifest writes require
# a complete durable host journal. No caller environment disables this. Runtime
# ordering bypasses separately require their immutable SQL hold certificates.
maxim_require_ordinary_effect_authority() {
  local root_dir="$1"
  if ! declare -F require_deploy_lock >/dev/null || ! require_deploy_lock; then
    echo 'Ordinary mutation requires the protected shared deploy lock.' >&2
    return 1
  fi
  # FLAG: A crash before cold admission can leave auxiliary queues paused while
  # the old cold journal is complete. Only the bound recovery controller clears this.
  if [[ -e /var/lib/maxim-deploy/queue-predrain-pending.json || \
    -L /var/lib/maxim-deploy/queue-predrain-pending.json ]]; then
    echo 'Queue pre-drain recovery is pending; restore its queues before ordinary mutation.' >&2
    return 1
  fi
  if [[ ! -f "$root_dir/infra/scripts/legacy-cold-journal.mjs" ]]; then
    echo 'Compatible cold journal tooling is required.' >&2
    return 1
  fi
  node "$root_dir/infra/scripts/legacy-cold-journal.mjs" assert-ordinary-host
}
