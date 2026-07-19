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

# These fixed deployment paths are intentionally interpolated into the remote environment.
# shellcheck disable=SC2029
ssh "$HOST" "DOMAIN='${DOMAIN}' REMOTE_TMP='${REMOTE_TMP}' REMOTE_CONF='${REMOTE_CONF}' REMOTE_ENABLED='${REMOTE_ENABLED}' REMOTE_AUTH='${REMOTE_AUTH}' REMOTE_AUTH_SECRET='${REMOTE_AUTH_SECRET}' REMOTE_WEBROOT='${REMOTE_WEBROOT}' bash -s" <<'REMOTE'
set -euo pipefail

CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
BACKUP_DIR="$(mktemp -d /tmp/maxim-admin-nginx.XXXXXX)"
CONF_BACKED_UP=0
ENABLED_BACKED_UP=0

cleanup_backup() {
  sudo rm -rf "${BACKUP_DIR}" || true
}

restore_previous_nginx() {
  local restore_failed=0

  echo "Restoring the previous ${DOMAIN} nginx configuration..." >&2
  sudo rm -f "${REMOTE_CONF}" || restore_failed=1
  if [[ "${CONF_BACKED_UP}" == "1" ]]; then
    sudo cp -a "${BACKUP_DIR}/site-conf" "${REMOTE_CONF}" || restore_failed=1
  fi

  sudo rm -f "${REMOTE_ENABLED}" || restore_failed=1
  if [[ "${ENABLED_BACKED_UP}" == "1" ]]; then
    sudo cp -a "${BACKUP_DIR}/site-enabled" "${REMOTE_ENABLED}" || restore_failed=1
  fi

  if [[ "${restore_failed}" == "0" ]] && sudo nginx -t; then
    if ! sudo systemctl reload nginx; then
      echo "Previous nginx configuration was restored, but nginx reload failed." >&2
      restore_failed=1
    fi
  else
    echo "Previous nginx configuration could not be restored cleanly." >&2
    restore_failed=1
  fi

  return "${restore_failed}"
}

validate_and_reload_nginx() {
  if ! sudo nginx -t; then
    echo "New nginx configuration failed validation." >&2
    if ! restore_previous_nginx; then
      echo "Automatic nginx rollback failed; inspect the host before retrying." >&2
    fi
    return 1
  fi

  if ! sudo systemctl reload nginx; then
    echo "Nginx reload failed after applying the new configuration." >&2
    if ! restore_previous_nginx; then
      echo "Automatic nginx rollback failed; inspect the host before retrying." >&2
    fi
    return 1
  fi
}

trap cleanup_backup EXIT

if sudo test -e "${REMOTE_CONF}" || sudo test -L "${REMOTE_CONF}"; then
  sudo cp -a "${REMOTE_CONF}" "${BACKUP_DIR}/site-conf"
  CONF_BACKED_UP=1
fi

if sudo test -e "${REMOTE_ENABLED}" || sudo test -L "${REMOTE_ENABLED}"; then
  sudo cp -a "${REMOTE_ENABLED}" "${BACKUP_DIR}/site-enabled"
  ENABLED_BACKED_UP=1
fi

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
  validate_and_reload_nginx

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
validate_and_reload_nginx
REMOTE

assert_admin_security_headers() {
  local headers="$1"
  grep -i '^strict-transport-security: max-age=31536000' <<<"$headers"
  grep -i '^x-content-type-options: nosniff' <<<"$headers"
  grep -i '^referrer-policy: strict-origin-when-cross-origin' <<<"$headers"
  grep -i '^x-robots-tag: noindex, nofollow, noarchive' <<<"$headers"
  grep -i '^content-security-policy:' <<<"$headers"
}

admin_root_headers="$(curl -sS --max-time 15 -D - -o /dev/null https://admin.major-maksimov.ru/)"
grep -Ei '^HTTP/[0-9.]+ 401' <<<"$admin_root_headers"
assert_admin_security_headers "$admin_root_headers"

admin_robots_headers="$(curl -fsS --max-time 15 -D - -o /dev/null https://admin.major-maksimov.ru/robots.txt)"
grep -Ei '^HTTP/[0-9.]+ 200' <<<"$admin_robots_headers"
assert_admin_security_headers "$admin_robots_headers"

admin_safety_headers="$(curl -sS --max-time 15 -D - -o /dev/null https://admin.major-maksimov.ru/api/v1/safety-desk/queue)"
grep -Ei '^HTTP/[0-9.]+ 401' <<<"$admin_safety_headers"
grep -i '^cache-control: no-store, no-cache, must-revalidate, max-age=0' <<<"$admin_safety_headers"
assert_admin_security_headers "$admin_safety_headers"

admin_support_headers="$(curl -sS --max-time 15 -D - -o /dev/null https://admin.major-maksimov.ru/api/v1/support-requests/queue)"
grep -Ei '^HTTP/[0-9.]+ 401' <<<"$admin_support_headers"
grep -i '^cache-control: no-store, no-cache, must-revalidate, max-age=0' <<<"$admin_support_headers"
assert_admin_security_headers "$admin_support_headers"

echo "Done: admin.major-maksimov.ru nginx config applied on ${HOST}"
