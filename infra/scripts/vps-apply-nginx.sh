#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

HOST="${1:-maxim-vps}"
LOCAL_CONF="infra/nginx/maxim.play-team.ru.conf"
REMOTE_TMP="/tmp/maxim.play-team.ru.conf"
REMOTE_CONF="/etc/nginx/sites-available/maxim.play-team.ru.conf"

if [[ ! -f "$LOCAL_CONF" ]]; then
  echo "Missing local nginx config: $LOCAL_CONF"
  exit 1
fi

scp "$LOCAL_CONF" "${HOST}:${REMOTE_TMP}"

ssh "$HOST" "sudo install -m 644 '${REMOTE_TMP}' '${REMOTE_CONF}' && sudo nginx -t && sudo systemctl reload nginx && rm -f '${REMOTE_TMP}'"

echo "Verifying public route split headers..."
curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/api/health/live | grep -i '^x-maxim-ingress: webhook'
curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/api/v1/system/metrics/queues | grep -i '^x-maxim-ingress: admin'

echo "Verifying public site security headers..."
curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/ | grep -i '^location: https://maxim.play-team.ru/app/'
curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/app/ | grep -i '^strict-transport-security:'
curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/app/ | grep -i '^x-content-type-options: nosniff'
curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/app/ | grep -i '^referrer-policy: strict-origin-when-cross-origin'

echo "Done: nginx config applied on ${HOST}"
