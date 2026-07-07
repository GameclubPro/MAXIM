#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

HOST="${1:-maxim-vps}"
LOCAL_CONF="infra/nginx/major-maksimov.ru.conf"
LOCAL_SITE_DIR="infra/www/major-maksimov"
REMOTE_CONF_TMP="/tmp/major-maksimov.ru.conf"
REMOTE_SITE_TMP="/tmp/major-maksimov-site"
REMOTE_CONF="/etc/nginx/sites-available/major-maksimov.ru.conf"
REMOTE_SITE_DIR="/var/www/major-maksimov-site"

if [[ ! -f "$LOCAL_CONF" ]]; then
  echo "Missing local nginx config: $LOCAL_CONF"
  exit 1
fi

if [[ ! -f "$LOCAL_SITE_DIR/index.html" ]]; then
  echo "Missing local site index: $LOCAL_SITE_DIR/index.html"
  exit 1
fi

if grep -Eq 'listen[[:space:]]+4443([[:space:];]|$)' "$LOCAL_CONF"; then
  echo "Refusing to apply $LOCAL_CONF: temporary 4443 listeners must not be shipped."
  exit 1
fi

scp "$LOCAL_CONF" "${HOST}:${REMOTE_CONF_TMP}"
ssh "$HOST" "rm -rf '${REMOTE_SITE_TMP}' && mkdir -p '${REMOTE_SITE_TMP}'"
scp "$LOCAL_SITE_DIR/index.html" "${HOST}:${REMOTE_SITE_TMP}/index.html"

ssh "$HOST" "curl -fsS --max-time 10 http://127.0.0.1:3003/app/ >/dev/null"

ssh "$HOST" "\
  sudo mkdir -p /etc/nginx/backups && \
  if [[ -f '${REMOTE_CONF}' ]]; then \
    sudo cp '${REMOTE_CONF}' \"/etc/nginx/backups/major-maksimov.ru.conf.bak-\$(date +%Y%m%d%H%M%S)\"; \
  fi && \
  sudo install -d -m 755 '${REMOTE_SITE_DIR}' && \
  sudo install -m 644 '${REMOTE_SITE_TMP}/index.html' '${REMOTE_SITE_DIR}/index.html' && \
  sudo install -m 644 '${REMOTE_CONF_TMP}' '${REMOTE_CONF}' && \
  sudo ln -sfn '${REMOTE_CONF}' /etc/nginx/sites-enabled/major-maksimov.ru.conf && \
  sudo nginx -t && \
  sudo systemctl reload nginx && \
  rm -rf '${REMOTE_SITE_TMP}' '${REMOTE_CONF_TMP}'"

echo "Verifying major-maksimov.ru root..."
curl -fsS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/ | grep -Ei '^HTTP/[0-9.]+ 200'
curl -fsS --max-time 15 https://major-maksimov.ru/ | grep -F 'Бот-модератор для чатов MAX' >/dev/null

echo "Verifying major-maksimov.ru app route..."
curl -fsS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/app/ | grep -Ei '^HTTP/[0-9.]+ 200'
curl -fsS --max-time 15 https://major-maksimov.ru/app/ | grep -F 'https://major-maksimov.ru/app/' >/dev/null
curl -fsS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/ios-canary/ping.txt | grep -Ei '^HTTP/[0-9.]+ 200'
curl -fsS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/health/live | grep -i '^x-maxim-ingress: webhook'
curl -sS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/v1/safety-desk/queue | grep -Ei '^HTTP/[0-9.]+ 404'
curl -sS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/v1/support-requests/queue | grep -Ei '^HTTP/[0-9.]+ 404'

echo "Verifying app.major-maksimov.ru canonical redirect..."
curl -fsS --max-time 15 -D - -o /dev/null https://app.major-maksimov.ru/app/ | grep -i '^location: https://major-maksimov.ru/app/'

echo "Done: major-maksimov.ru public site applied on ${HOST}"
