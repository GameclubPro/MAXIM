#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi

HOST="${1:-maxim-vps}"
LOCAL_CONF="infra/nginx/maxim.play-team.ru.conf"
REMOTE_TMP="/tmp/maxim.play-team.ru.conf"
REMOTE_CONF="/etc/nginx/sites-available/maxim.play-team.ru.conf"
REMOTE_BACKUP_DIR="/etc/nginx/backups"

if [[ ! -f "$LOCAL_CONF" ]]; then
  echo "Missing local nginx config: $LOCAL_CONF"
  exit 1
fi

CURRENT_CONF="$(mktemp)"
trap 'rm -f "$CURRENT_CONF"' EXIT

if ssh "$HOST" "sudo test -f '${REMOTE_CONF}'"; then
  ssh "$HOST" "sudo cat '${REMOTE_CONF}'" >"$CURRENT_CONF"
  echo "Diff against ${HOST}:${REMOTE_CONF}:"
  diff -u "$CURRENT_CONF" "$LOCAL_CONF" || true
else
  echo "Remote config does not exist yet: ${HOST}:${REMOTE_CONF}"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run only. No remote files changed."
  exit 0
fi

case "${MAXIM_APPLY_NGINX_CONFIRM:-0}" in
  1|true|TRUE|yes|YES)
    ;;
  *)
    echo "Refusing to apply nginx config without MAXIM_APPLY_NGINX_CONFIRM=1. Run with --dry-run first and review the diff." >&2
    exit 2
    ;;
esac

scp "$LOCAL_CONF" "${HOST}:${REMOTE_TMP}"

ssh "$HOST" "REMOTE_TMP='${REMOTE_TMP}' REMOTE_CONF='${REMOTE_CONF}' REMOTE_BACKUP_DIR='${REMOTE_BACKUP_DIR}' bash -s" <<'REMOTE'
set -euo pipefail

backup=""
sudo mkdir -p "${REMOTE_BACKUP_DIR}"
if [[ -f "${REMOTE_CONF}" ]]; then
  backup="${REMOTE_BACKUP_DIR}/$(basename "${REMOTE_CONF}").bak-$(date +%Y%m%d%H%M%S)"
  sudo cp "${REMOTE_CONF}" "${backup}"
fi

restore_backup() {
  if [[ -n "${backup}" && -f "${backup}" ]]; then
    sudo cp "${backup}" "${REMOTE_CONF}"
    sudo nginx -t >/dev/null 2>&1 && sudo systemctl reload nginx || true
  fi
}

sudo install -m 644 "${REMOTE_TMP}" "${REMOTE_CONF}"
if ! sudo nginx -t; then
  restore_backup
  rm -f "${REMOTE_TMP}"
  exit 1
fi

if ! sudo systemctl reload nginx; then
  restore_backup
  rm -f "${REMOTE_TMP}"
  exit 1
fi

rm -f "${REMOTE_TMP}"
REMOTE

echo "Verifying public route split headers..."
curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/api/health/live | grep -i '^x-maxim-ingress: webhook'
curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/api/v1/system/metrics/queues | grep -i '^x-maxim-ingress: admin'
curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/api/v1/safety-desk/queue | grep -Ei '^HTTP/[0-9.]+ 404'
curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/api/v1/support-requests/queue | grep -Ei '^HTTP/[0-9.]+ 404'

if [[ "${MAXIM_VERIFY_LEGACY_PLAY_TEAM_APP:-0}" == "1" ]]; then
  echo "Verifying legacy play-team app security headers..."
  curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/ | grep -i '^location: https://maxim.play-team.ru/app/'
  curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/app/ | grep -i '^strict-transport-security:'
  curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/app/ | grep -i '^x-content-type-options: nosniff'
  curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/app/ | grep -i '^referrer-policy: strict-origin-when-cross-origin'
else
  echo "Skipping legacy play-team /app/ smoke. Set MAXIM_VERIFY_LEGACY_PLAY_TEAM_APP=1 to verify it explicitly."
fi

echo "Done: nginx config applied on ${HOST}"
