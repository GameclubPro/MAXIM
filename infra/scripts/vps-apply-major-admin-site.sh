#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

HOST="${1:-maxim-vps}"
DOMAIN="admin.major-maksimov.ru"
LOCAL_CONF="infra/nginx/admin.major-maksimov.ru.conf"
REMOTE_TMP="/tmp/admin.major-maksimov.ru.conf"
REMOTE_CONF="/etc/nginx/sites-available/admin.major-maksimov.ru.conf"
REMOTE_ENABLED="/etc/nginx/sites-enabled/admin.major-maksimov.ru.conf"
REMOTE_AUTH="/etc/nginx/htpasswd-maxim-admin"
REMOTE_AUTH_SECRET="/root/maxim-admin-basic-auth-password.txt"
REMOTE_WEBROOT="/var/www/html"

if [[ ! -f "$LOCAL_CONF" ]]; then
  echo "Missing local nginx config: $LOCAL_CONF"
  exit 1
fi

scp "$LOCAL_CONF" "${HOST}:${REMOTE_TMP}"

ssh "$HOST" "DOMAIN='${DOMAIN}' REMOTE_TMP='${REMOTE_TMP}' REMOTE_CONF='${REMOTE_CONF}' REMOTE_ENABLED='${REMOTE_ENABLED}' REMOTE_AUTH='${REMOTE_AUTH}' REMOTE_AUTH_SECRET='${REMOTE_AUTH_SECRET}' REMOTE_WEBROOT='${REMOTE_WEBROOT}' bash -s" <<'REMOTE'
set -euo pipefail

CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"

sudo mkdir -p "${REMOTE_WEBROOT}/.well-known/acme-challenge"

if [[ ! -f "${REMOTE_AUTH}" ]]; then
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl not found; create ${REMOTE_AUTH} manually" >&2
    exit 1
  fi

  pass="${ADMIN_BASIC_AUTH_PASSWORD:-}"
  if [[ -z "${pass}" && -s "${REMOTE_AUTH_SECRET}" ]]; then
    pass="$(sudo cat "${REMOTE_AUTH_SECRET}")"
  fi
  if [[ -z "${pass}" ]]; then
    pass="$(openssl rand -base64 24)"
    printf '%s\n' "${pass}" | sudo tee "${REMOTE_AUTH_SECRET}" >/dev/null
    sudo chmod 600 "${REMOTE_AUTH_SECRET}"
  fi

  hash="$(openssl passwd -apr1 "${pass}")"
  printf 'maxim:%s\n' "${hash}" | sudo tee "${REMOTE_AUTH}" >/dev/null
  sudo chmod 644 "${REMOTE_AUTH}"
  echo "Created ${REMOTE_AUTH} user maxim. Password is stored in ${REMOTE_AUTH_SECRET}."
fi

if [[ ! -s "${CERT_DIR}/fullchain.pem" || ! -s "${CERT_DIR}/privkey.pem" ]]; then
  sudo tee "${REMOTE_CONF}" >/dev/null <<HTTP_ONLY
server {
  listen 80;
  listen [::]:80;
  server_name ${DOMAIN};
  server_tokens off;

  location ^~ /.well-known/acme-challenge/ {
    root ${REMOTE_WEBROOT};
    default_type text/plain;
    try_files \$uri =404;
  }

  location / {
    return 200 "admin.major-maksimov.ru certificate bootstrap\n";
  }
}
HTTP_ONLY

  sudo ln -sfn "${REMOTE_CONF}" "${REMOTE_ENABLED}"
  sudo nginx -t
  sudo systemctl reload nginx

  if ! command -v certbot >/dev/null 2>&1; then
    echo "certbot not found; install certbot or issue ${DOMAIN} certificate manually" >&2
    exit 1
  fi

  sudo certbot certonly \
    --webroot \
    -w "${REMOTE_WEBROOT}" \
    -d "${DOMAIN}" \
    --non-interactive \
    --agree-tos \
    --register-unsafely-without-email \
    --keep-until-expiring
fi

sudo install -m 644 "${REMOTE_TMP}" "${REMOTE_CONF}"
sudo ln -sfn "${REMOTE_CONF}" "${REMOTE_ENABLED}"
rm -f "${REMOTE_TMP}"
sudo nginx -t
sudo systemctl reload nginx
REMOTE

echo "Done: admin.major-maksimov.ru nginx config applied on ${HOST}"
