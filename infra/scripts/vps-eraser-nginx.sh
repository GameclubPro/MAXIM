#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source infra/scripts/lib/deploy-lock.sh
# shellcheck source=infra/scripts/lib/legacy-cold-maintenance.sh
source infra/scripts/lib/legacy-cold-maintenance.sh
acquire_deploy_lock
maxim_require_ordinary_effect_authority "$ROOT_DIR"

expected_sha="${1:-}"
mode="${2:-}"
[[ "$#" -ge 1 && "$#" -le 2 && ( -z "$mode" || "$mode" == --apply ) ]] || { echo 'Usage: vps-eraser-nginx.sh <exact-sha> [--apply]' >&2; exit 2; }
[[ "$expected_sha" =~ ^[a-f0-9]{40}$ && "$(git rev-parse HEAD)" == "$expected_sha" ]] || { echo 'Lastik nginx requires synchronized exact source.' >&2; exit 2; }
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo 'Lastik nginx requires a clean source checkout.' >&2; exit 2; }

CONFIG=/etc/nginx/sites-available/major-maksimov.ru.conf
ENABLED=/etc/nginx/sites-enabled/major-maksimov.ru.conf
BACKUPS=/etc/nginx/backups
DEPLOY_STATE=/var/lib/maxim-deploy
HELPER="$ROOT_DIR/infra/scripts/eraser-nginx.mjs"
NODE="$(command -v node)"
umask 077
STAGE="$(mktemp -d /tmp/maxim-eraser-nginx.XXXXXXXX)"
MUTATION_INTENT=0
COMMITTED=0
BACKUP=""
SMOKE_FAILED=0

finish() {
  local status=$? preserve="$SMOKE_FAILED"
  trap - EXIT INT TERM HUP
  if [[ "$MUTATION_INTENT" == 1 && "$COMMITTED" == 0 ]]; then
    if [[ -s "$STAGE/installed.json" ]] && "$NODE" "$HELPER" verify "$CONFIG" "$ENABLED" "$STAGE/installed.json"; then
      echo 'Lastik nginx verification failed; rolling back owned site bytes.' >&2
      # FLAG: The unprivileged shell owns receipts inside its private staging directory.
      # shellcheck disable=SC2024
      if sudo -n "$NODE" "$HELPER" swap "$CONFIG" "$ENABLED" "$STAGE/installed.json" "$BACKUP" >"$STAGE/rollback.json" \
        && timeout --foreground --kill-after=2s 15s sudo -n nginx -t \
        && timeout --foreground --kill-after=2s 15s sudo -n systemctl reload nginx \
        && "$NODE" "$HELPER" verify "$CONFIG" "$ENABLED" "$STAGE/rollback.json"; then
        echo 'Previous nginx site bytes restored; enabled symlink was preserved.' >&2
      else
        echo 'Lastik nginx rollback failed; preserve evidence and inspect before retrying.' >&2
        preserve=1
      fi
    elif "$NODE" "$HELPER" verify "$CONFIG" "$ENABLED" "$STAGE/original.json" 2>/dev/null; then
      echo 'Lastik nginx replacement did not change the active file.' >&2
    else
      # FLAG: Unknown third-party bytes or link identity are never overwritten by rollback.
      echo 'Lastik nginx rollback refused: live configuration or symlink changed.' >&2
      preserve=1
    fi
    status=1
  fi
  if [[ "$preserve" == 1 ]]; then
    echo "Preserved Lastik nginx evidence: $STAGE; backup: $BACKUP" >&2
  else
    rm -rf -- "$STAGE"
  fi
  release_deploy_lock || status=1
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

"$NODE" "$HELPER" snapshot "$CONFIG" "$ENABLED" "$STAGE/original.json"
"$NODE" "$HELPER" render "$CONFIG" "$STAGE/candidate.conf"
changed=0
if diff -u --label current-major-site --label lastik-only-patch "$CONFIG" "$STAGE/candidate.conf"; then
  echo 'Lastik nginx blocks already match this exact patch.'
else
  diff_status=$?
  [[ "$diff_status" == 1 ]] || exit "$diff_status"
  changed=1
fi
"$NODE" "$HELPER" verify "$CONFIG" "$ENABLED" "$STAGE/original.json"
if [[ -z "$mode" ]]; then
  echo 'Preview only. Existing site, snippets, headers and limits were not changed.'
  exit 0
fi

"$NODE" "$ROOT_DIR/infra/scripts/release-manifest.mjs" validate-current --state-dir "$DEPLOY_STATE" >"$STAGE/release.json"
curl --noproxy '*' -fsS --connect-timeout 2 --max-time 5 \
  http://127.0.0.1:3005/health -o "$STAGE/health.json"
"$NODE" "$HELPER" health "$STAGE/health.json" "$STAGE/release.json"
timeout --foreground --kill-after=2s 15s sudo -n nginx -t
if [[ "$changed" == 1 ]]; then
  [[ ! -L "$BACKUPS" ]] || { echo 'Nginx backup directory must not be a symlink.' >&2; exit 1; }
  sudo -n mkdir -p -- "$BACKUPS"
  BACKUP="$BACKUPS/major-maksimov.ru.conf.$(basename "$STAGE").bak"
  "$NODE" "$HELPER" verify "$CONFIG" "$ENABLED" "$STAGE/original.json"
  sudo -n cp -a -- "$CONFIG" "$BACKUP"
  # FLAG: The atomic helper rechecks content, inode and enabled link immediately before rename.
  MUTATION_INTENT=1
  # FLAG: Keep the receipt owned by the staging user, not root.
  # shellcheck disable=SC2024
  sudo -n "$NODE" "$HELPER" swap "$CONFIG" "$ENABLED" "$STAGE/original.json" "$STAGE/candidate.conf" >"$STAGE/installed.json"
  timeout --foreground --kill-after=2s 15s sudo -n nginx -t
  timeout --foreground --kill-after=2s 15s sudo -n systemctl reload nginx
else
  cp -- "$STAGE/original.json" "$STAGE/installed.json"
fi

SMOKE_MAX_ATTEMPTS=5
SMOKE_ATTEMPT=0
SMOKE_BODY=""

record_smoke_failure() {
  SMOKE_FAILED=1
  echo "Lastik nginx smoke attempt $SMOKE_ATTEMPT/$SMOKE_MAX_ATTEMPTS failed: path=$1 assertion=$2 status=$3 curl_exit=$4." >&2
}

smoke_request() {
  local expected_status="$1" path="$2" method="$3" status curl_exit
  local -a request=(--noproxy '*' -sS --connect-timeout 2 --max-time 5 --max-filesize 65536
    --resolve major-maksimov.ru:443:127.0.0.1 -w '%{http_code}')
  if [[ "$method" == POST ]]; then
    SMOKE_BODY="$STAGE/smoke-$SMOKE_ATTEMPT-forbidden.json"
    # FLAG: A too-short wrong secret cannot authenticate or reach MAX/chat effects.
    request+=(-X POST -H 'Content-Type: application/json' -H 'X-Max-Bot-Api-Secret: invalid'
      --data '{}' -o "$SMOKE_BODY")
  else
    request+=(-o /dev/null)
  fi
  # FLAG: This function is reached through `if`; every failed command needs an explicit return.
  if status="$(curl "${request[@]}" "https://major-maksimov.ru$path")"; then
    curl_exit=0
  else
    curl_exit=$?
    [[ "$status" =~ ^[0-9]{3}$ ]] || status=invalid
    record_smoke_failure "$path" transport "$status" "$curl_exit"
    return 1
  fi
  [[ "$status" =~ ^[0-9]{3}$ ]] || status=invalid
  if [[ "$status" != "$expected_status" ]]; then
    record_smoke_failure "$path" "status:$expected_status" "$status" "$curl_exit"
    return 1
  fi
  return 0
}

verify_namespace_smoke() {
  local path
  smoke_request 403 /eraser/webhook POST || return 1
  if ! "$NODE" "$HELPER" forbidden "$SMOKE_BODY" 2>"$STAGE/smoke-$SMOKE_ATTEMPT-forbidden.stderr"; then
    record_smoke_failure /eraser/webhook forbidden-body 403 0
    return 1
  fi
  for path in /eraser /eraser/ /eraser/internal/v1/runtime /eraser/health; do
    smoke_request 404 "$path" GET || return 1
  done
  smoke_request 403 /eraser/webhook GET || return 1
}

smoke_ready=0
for ((SMOKE_ATTEMPT = 1; SMOKE_ATTEMPT <= SMOKE_MAX_ATTEMPTS; SMOKE_ATTEMPT += 1)); do
  # FLAG: Retry only readiness observations of this invocation's unchanged installed bytes.
  "$NODE" "$HELPER" verify "$CONFIG" "$ENABLED" "$STAGE/installed.json" || exit 1
  if verify_namespace_smoke; then
    smoke_ready=1
    break
  fi
  "$NODE" "$HELPER" verify "$CONFIG" "$ENABLED" "$STAGE/installed.json" || exit 1
  if ((SMOKE_ATTEMPT < SMOKE_MAX_ATTEMPTS)); then sleep 1; fi
done
[[ "$smoke_ready" == 1 ]] || { echo 'Lastik nginx namespace readiness attempts exhausted.' >&2; exit 1; }
"$NODE" "$HELPER" verify "$CONFIG" "$ENABLED" "$STAGE/installed.json"
COMMITTED=1
echo 'Lastik nginx patch and local authenticated-route isolation checks passed.'
