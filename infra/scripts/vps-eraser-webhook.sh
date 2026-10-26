#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source infra/scripts/lib/deploy-lock.sh
# shellcheck source=infra/scripts/lib/legacy-cold-maintenance.sh
source infra/scripts/lib/legacy-cold-maintenance.sh
# shellcheck source=infra/scripts/lib/eraser-deploy.sh
source infra/scripts/lib/eraser-deploy.sh
acquire_deploy_lock
maxim_require_ordinary_effect_authority "$ROOT_DIR"
expected_sha="${1:-}"
[[ "$expected_sha" =~ ^[0-9a-f]{40}$ && "$(git rev-parse HEAD)" == "$expected_sha" ]] || { echo 'Lastik webhook setup requires synchronized exact source.' >&2; exit 2; }
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo 'Lastik webhook setup requires clean source.' >&2; exit 2; }
# FLAG: Tooling can advance independently of the installed component. The locked,
# complete active manifest owns its source; a tooling SHA must never replace it.
node infra/scripts/release-manifest.mjs validate-current >/dev/null
runtime_sha="$(node infra/scripts/release-manifest.mjs field current eraser sourceSha)"
maxim_eraser_smoke "$runtime_sha"
# FLAG: The service CLI uses its own shared Redis MAX limiter and container-only token.
docker compose --env-file .env -p infra -f infra/docker-compose.yml exec -T \
  -e ERASER_WEBHOOK_URL=https://major-maksimov.ru/eraser/webhook \
  eraser node apps/eraser/dist/register-webhook.js
