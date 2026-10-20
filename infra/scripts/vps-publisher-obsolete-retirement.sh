#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
if [[ ! "${MAXIM_EXPECTED_DEPLOY_SHA:-}" =~ ^[0-9a-f]{40}$ || \
  "$(git rev-parse HEAD)" != "$MAXIM_EXPECTED_DEPLOY_SHA" || \
  -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo 'Publisher retirement requires clean exact synchronized tooling source.' >&2
  exit 2
fi
node --input-type=module - "$@" <<'VALIDATE'
import { parseRetirementArgs } from './infra/scripts/publisher-obsolete-retirement-host.mjs';
try { parseRetirementArgs(process.argv.slice(2)); } catch {
  process.stderr.write('Usage: publisher-obsolete-retirement [preview [--after-digest sha256] | apply --reviewed-digest sha256 | stop-preview [--after-digest sha256] | stop-apply --reviewed-digest sha256]\n');
  process.exitCode=2;
}
VALIDATE
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
# shellcheck source=infra/scripts/lib/legacy-cold-maintenance.sh
source "$ROOT_DIR/infra/scripts/lib/legacy-cold-maintenance.sh"
acquire_deploy_lock
if [[ "${1:-preview}" == apply || "${1:-preview}" == stop-apply ]]; then
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || exit $?
fi
# Keep the Bash lock owner alive until the bounded child and its final proof end.
node "$ROOT_DIR/infra/scripts/publisher-obsolete-retirement-host.mjs" "$@"
