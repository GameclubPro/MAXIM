#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--apply' ) ]]; then
  echo 'Usage: recover-publication-post-actions-migration [--apply]' >&2
  exit 2
fi
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
acquire_deploy_lock
MAXIM_PUBLICATION_RECOVERY_APP_NAME="maxim-publication-recovery-$(date -u +%s)-${BASHPID}-${RANDOM}"
export MAXIM_PUBLICATION_RECOVERY_APP_NAME
cleanup() {
  local marker
  marker="$(docker inspect --format '{{index .Config.Labels "com.maxim.publication-migration-recovery"}}' "$MAXIM_PUBLICATION_RECOVERY_APP_NAME" 2>/dev/null || true)"
  if [[ "$marker" == "$MAXIM_PUBLICATION_RECOVERY_APP_NAME" ]]; then
    docker rm -f "$MAXIM_PUBLICATION_RECOVERY_APP_NAME" >/dev/null 2>&1 || true
  fi
  docker compose --env-file .env -p infra -f infra/docker-compose.yml exec -T \
    -e PGOPTIONS='-c statement_timeout=2500ms -c lock_timeout=250ms' \
    postgres psql -X -v ON_ERROR_STOP=1 -A -t -U maxim -d maxim \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '$MAXIM_PUBLICATION_RECOVERY_APP_NAME' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  release_deploy_lock
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
timeout --kill-after=5s 240s node infra/scripts/publication-post-actions-migration-recovery.mjs "$@"
