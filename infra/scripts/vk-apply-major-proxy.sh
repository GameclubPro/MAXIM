#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

HOST="${1:-ubuntu@185.241.192.181}"
SSH_KEY="${VK_PROXY_SSH_KEY:-$HOME/.ssh/id_rsa_vk_maxim_proxy}"
LOCAL_CONF="infra/vk-proxy/nginx/major-maksimov-proxy.conf"
LOCAL_SITE_DIR="infra/www/major-maksimov"
REMOTE_SITE_DIR="/var/www/major-maksimov-public"
REMOTE_CONF="/etc/nginx/sites-available/major-maksimov-proxy.conf"

if [[ ! -f "$SSH_KEY" ]]; then
  echo "Missing SSH key: $SSH_KEY"
  exit 1
fi

if [[ ! -f "$LOCAL_CONF" ]]; then
  echo "Missing nginx config: $LOCAL_CONF"
  exit 1
fi

if [[ ! -f "$LOCAL_SITE_DIR/index.html" ]]; then
  echo "Missing public site index: $LOCAL_SITE_DIR/index.html"
  exit 1
fi

scp -i "$SSH_KEY" "$LOCAL_SITE_DIR/index.html" "$HOST:/tmp/major-index.html"
scp -i "$SSH_KEY" "bot.webp" "$HOST:/tmp/bot.webp"
scp -i "$SSH_KEY" "$LOCAL_CONF" "$HOST:/tmp/major-maksimov-proxy.conf"

ssh -i "$SSH_KEY" "$HOST" "\
  sudo install -d -m 0755 '${REMOTE_SITE_DIR}' /etc/nginx/backups && \
  if [[ -f '${REMOTE_CONF}' ]]; then \
    sudo cp '${REMOTE_CONF}' \"/etc/nginx/backups/major-maksimov-proxy.conf.bak-\$(date +%Y%m%d%H%M%S)\"; \
  fi && \
  sudo install -m 0644 /tmp/major-index.html '${REMOTE_SITE_DIR}/index.html' && \
  sudo install -m 0644 /tmp/bot.webp '${REMOTE_SITE_DIR}/bot.webp' && \
  sudo install -m 0644 /tmp/major-maksimov-proxy.conf '${REMOTE_CONF}' && \
  sudo ln -sfn '${REMOTE_CONF}' /etc/nginx/sites-enabled/major-maksimov-proxy.conf && \
  sudo rm -f /etc/nginx/sites-enabled/default && \
  sudo nginx -t && \
  sudo systemctl reload nginx && \
  rm -f /tmp/major-index.html /tmp/bot.webp /tmp/major-maksimov-proxy.conf"

echo "Verifying VK proxy routes..."
curl -fsS --max-time 20 -D - -o /dev/null https://app.major-maksimov.ru/ | grep -E '^HTTP/|^HTTP/2 200|^HTTP/1.1 200'
curl -fsS --max-time 20 https://app.major-maksimov.ru/ | grep -F 'Бот-модератор для чатов MAX' >/dev/null
curl -fsS --max-time 20 -D - -o /dev/null https://app.major-maksimov.ru/app/ | grep -E '^HTTP/|^HTTP/2 200|^HTTP/1.1 200'
curl -fsS --max-time 20 -D - -o /dev/null https://app.major-maksimov.ru/api/health/live | grep -i '^x-maxim-vk-proxy: api'

echo "Done: VK major proxy applied on ${HOST}"
