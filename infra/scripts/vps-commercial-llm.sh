#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
# shellcheck source=infra/scripts/lib/legacy-cold-maintenance.sh
source "$ROOT_DIR/infra/scripts/lib/legacy-cold-maintenance.sh"

case "${1:-status}" in
  status|smoke|check-client|workstation-bridge|workstation-pool-bridge|check-workstation|check-workstation-offline)
    nice -n 10 ionice -c 2 -n 7 node infra/scripts/commercial-llm-runtime.mjs "$@"
    ;;
  install|replace|upgrade-slots|stop|enable|disable|recover-cpu-quarantine)
    acquire_deploy_lock
    trap release_deploy_lock EXIT
    maxim_require_ordinary_effect_authority "$ROOT_DIR"
    require_deploy_lock
    nice -n 10 ionice -c 2 -n 7 node infra/scripts/commercial-llm-runtime.mjs "$@"
    ;;
  *)
    echo 'Usage: commercial-llm install|replace|upgrade-slots|enable|disable|stop [--apply] | recover-cpu-quarantine <operation-uuid> [--apply <preview-sha256>] | status | smoke | check-client' >&2
    exit 2
    ;;
esac
