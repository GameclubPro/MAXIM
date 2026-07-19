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
NGINX_MUTATED=0
DEPLOYMENT_COMMITTED=0
ROLLBACK_ATTEMPTED=0
ROLLBACK_SUCCEEDED=0

finalize_remote_deploy() {
  local exit_status=$?

  trap - EXIT
  if [[ "${exit_status}" -ne 0 && "${NGINX_MUTATED}" -eq 1 && \
    "${DEPLOYMENT_COMMITTED}" -eq 0 && "${ROLLBACK_ATTEMPTED}" -eq 0 ]]; then
    echo "Admin nginx deployment failed after runtime mutation; rolling back." >&2
    if ! restore_previous_nginx; then
      echo "Automatic nginx rollback failed; inspect the host before retrying." >&2
    fi
  fi

  if [[ "${ROLLBACK_ATTEMPTED}" -eq 1 && "${ROLLBACK_SUCCEEDED}" -eq 0 ]]; then
    echo "Rollback backup retained at ${BACKUP_DIR}." >&2
  elif ! sudo rm -rf "${BACKUP_DIR}"; then
    echo "Failed to remove temporary nginx backup ${BACKUP_DIR}." >&2
    if [[ "${exit_status}" -eq 0 ]]; then
      exit_status=1
    fi
  fi

  exit "${exit_status}"
}

restore_previous_nginx() {
  local restore_failed=0

  ROLLBACK_ATTEMPTED=1
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

  if [[ "${restore_failed}" -eq 0 ]]; then
    ROLLBACK_SUCCEEDED=1
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

LOCAL_ADMIN_SMOKE_MAX_ATTEMPTS=10
LOCAL_ADMIN_SMOKE_RETRY_DELAY_SECONDS=1
LOCAL_ADMIN_SMOKE_FAILURE_PATH=""
LOCAL_ADMIN_SMOKE_FAILURE_ASSERTION=""

record_local_admin_smoke_failure() {
  LOCAL_ADMIN_SMOKE_FAILURE_PATH="$1"
  LOCAL_ADMIN_SMOKE_FAILURE_ASSERTION="$2"
}

assert_local_admin_smoke_match() {
  local path="$1"
  local assertion="$2"
  local pattern="$3"
  local headers="$4"

  if ! grep -Eqi -- "${pattern}" <<<"${headers}"; then
    record_local_admin_smoke_failure "${path}" "${assertion}"
    return 1
  fi
}

assert_admin_security_headers_local() {
  local path="$1"
  local headers="$2"

  assert_local_admin_smoke_match "${path}" "header:strict-transport-security" \
    '^strict-transport-security: max-age=31536000' "${headers}" || return 1
  assert_local_admin_smoke_match "${path}" "header:x-content-type-options" \
    '^x-content-type-options: nosniff' "${headers}" || return 1
  assert_local_admin_smoke_match "${path}" "header:referrer-policy" \
    '^referrer-policy: strict-origin-when-cross-origin' "${headers}" || return 1
  assert_local_admin_smoke_match "${path}" "header:x-robots-tag" \
    '^x-robots-tag: noindex, nofollow, noarchive' "${headers}" || return 1
  assert_local_admin_smoke_match "${path}" "header:content-security-policy" \
    '^content-security-policy:' "${headers}" || return 1
}

read_local_admin_headers() {
  local path="$1"
  curl --noproxy '*' -sS --max-time 15 --resolve "${DOMAIN}:443:127.0.0.1" \
    -D - -o /dev/null "https://${DOMAIN}${path}"
}

verify_local_admin_route() {
  local path="$1"
  local expected_status="$2"
  local expected_cache_control="$3"
  local headers

  if ! headers="$(read_local_admin_headers "${path}")"; then
    record_local_admin_smoke_failure "${path}" "request"
    return 1
  fi
  assert_local_admin_smoke_match "${path}" "status:${expected_status}" \
    "^HTTP/[0-9.]+ ${expected_status}" "${headers}" || return 1
  if [[ -n "${expected_cache_control}" ]]; then
    assert_local_admin_smoke_match "${path}" "header:cache-control" \
      "^cache-control: ${expected_cache_control}" "${headers}" || return 1
  fi
  assert_admin_security_headers_local "${path}" "${headers}" || return 1
}

verify_local_admin_nginx() {
  verify_local_admin_route "/" "401" "" || return 1
  verify_local_admin_route "/robots.txt" "200" "public, max-age=3600" || return 1
  verify_local_admin_route "/api/v1/safety-desk/queue" "401" \
    "no-store, no-cache, must-revalidate, max-age=0" || return 1
  verify_local_admin_route "/api/v1/support-requests/queue" "401" \
    "no-store, no-cache, must-revalidate, max-age=0" || return 1
}

verify_local_admin_nginx_with_retry() {
  local attempt

  for ((attempt = 1; attempt <= LOCAL_ADMIN_SMOKE_MAX_ATTEMPTS; attempt += 1)); do
    LOCAL_ADMIN_SMOKE_FAILURE_PATH=""
    LOCAL_ADMIN_SMOKE_FAILURE_ASSERTION=""
    if verify_local_admin_nginx; then
      return 0
    fi

    echo "Local admin nginx smoke attempt ${attempt}/${LOCAL_ADMIN_SMOKE_MAX_ATTEMPTS} failed: path=${LOCAL_ADMIN_SMOKE_FAILURE_PATH:-unknown} assertion=${LOCAL_ADMIN_SMOKE_FAILURE_ASSERTION:-unknown}." >&2
    if [[ "${attempt}" -lt "${LOCAL_ADMIN_SMOKE_MAX_ATTEMPTS}" ]]; then
      sleep "${LOCAL_ADMIN_SMOKE_RETRY_DELAY_SECONDS}"
    fi
  done

  return 1
}

trap finalize_remote_deploy EXIT

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
  if ! command -v certbot >/dev/null 2>&1; then
    echo "certbot not found; install certbot or issue ${DOMAIN} certificate manually" >&2
    exit 1
  fi

  NGINX_MUTATED=1
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

  if ! sudo certbot certonly \
    --webroot \
    -w "${REMOTE_WEBROOT}" \
    -d "${DOMAIN}" \
    --non-interactive \
    --agree-tos \
    --register-unsafely-without-email \
    --keep-until-expiring; then
    echo "Certificate bootstrap failed for ${DOMAIN}." >&2
    exit 1
  fi
fi

NGINX_MUTATED=1
sudo install -m 644 "${REMOTE_TMP}" "${REMOTE_CONF}"
sudo ln -sfn "${REMOTE_CONF}" "${REMOTE_ENABLED}"
validate_and_reload_nginx
if ! verify_local_admin_nginx_with_retry; then
  echo "New ${DOMAIN} nginx configuration failed the local route/header smoke." >&2
  if ! restore_previous_nginx; then
    echo "Automatic nginx rollback failed; inspect the host before retrying." >&2
  fi
  rm -f "${REMOTE_TMP}"
  exit 1
fi
DEPLOYMENT_COMMITTED=1
rm -f "${REMOTE_TMP}"
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
