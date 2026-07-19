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
LOCAL_CONF="infra/nginx/major-maksimov.ru.conf"
LOCAL_SITE_DIR="infra/www/major-maksimov"
LOCAL_SNIPPET_DIR="infra/nginx/snippets"
REMOTE_CONF_TMP="/tmp/major-maksimov.ru.conf"
REMOTE_SITE_TMP="/tmp/major-maksimov-site"
REMOTE_SNIPPET_TMP_DIR="/tmp/karavan-sse-nginx-snippets"
REMOTE_CONF="/etc/nginx/sites-available/major-maksimov.ru.conf"
REMOTE_ENABLED_CONF="/etc/nginx/sites-enabled/major-maksimov.ru.conf"
REMOTE_SITE_DIR="/var/www/major-maksimov-site"
REMOTE_BACKUP_DIR="/etc/nginx/backups"
REMOTE_SNIPPET_DIR="/etc/nginx/snippets"
KARAVAN_SSE_SNIPPETS=(
  "karavan-sse-locations.conf"
  "karavan-sse-proxy-common.conf"
)

if [[ ! -f "$LOCAL_CONF" ]]; then
  echo "Missing local nginx config: $LOCAL_CONF"
  exit 1
fi

if [[ ! -f "$LOCAL_SITE_DIR/index.html" ]]; then
  echo "Missing local site index: $LOCAL_SITE_DIR/index.html"
  exit 1
fi

for snippet in "${KARAVAN_SSE_SNIPPETS[@]}"; do
  if [[ ! -f "${LOCAL_SNIPPET_DIR}/${snippet}" ]]; then
    echo "Missing local nginx snippet: ${LOCAL_SNIPPET_DIR}/${snippet}"
    exit 1
  fi
done

if grep -Eq 'listen[[:space:]]+4443([[:space:];]|$)' "$LOCAL_CONF"; then
  echo "Refusing to apply $LOCAL_CONF: temporary 4443 listeners must not be shipped."
  exit 1
fi

CURRENT_CONF="$(mktemp)"
trap 'rm -f "$CURRENT_CONF"' EXIT

# Remote paths are fixed locally and intentionally interpolated before SSH execution.
# shellcheck disable=SC2029
if ssh "$HOST" "sudo test -f '${REMOTE_ENABLED_CONF}'"; then
  ssh "$HOST" "sudo cat '${REMOTE_ENABLED_CONF}'" >"$CURRENT_CONF"
  echo "Diff against ${HOST}:${REMOTE_ENABLED_CONF}:"
  diff -u "$CURRENT_CONF" "$LOCAL_CONF" || true
elif ssh "$HOST" "sudo test -f '${REMOTE_CONF}'"; then
  ssh "$HOST" "sudo cat '${REMOTE_CONF}'" >"$CURRENT_CONF"
  echo "Diff against ${HOST}:${REMOTE_CONF}:"
  diff -u "$CURRENT_CONF" "$LOCAL_CONF" || true
else
  echo "Remote config does not exist yet: ${HOST}:${REMOTE_CONF}"
fi

# Snippet names come from the fixed allowlist above and are interpolated locally.
# shellcheck disable=SC2029
for snippet in "${KARAVAN_SSE_SNIPPETS[@]}"; do
  if ssh "$HOST" "sudo test -f '${REMOTE_SNIPPET_DIR}/${snippet}'"; then
    ssh "$HOST" "sudo cat '${REMOTE_SNIPPET_DIR}/${snippet}'" >"$CURRENT_CONF"
    echo "Diff against ${HOST}:${REMOTE_SNIPPET_DIR}/${snippet}:"
    diff -u "$CURRENT_CONF" "${LOCAL_SNIPPET_DIR}/${snippet}" || true
  else
    echo "Remote snippet will be installed: ${HOST}:${REMOTE_SNIPPET_DIR}/${snippet}"
  fi
done

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run only. No remote files changed."
  exit 0
fi

case "${MAXIM_APPLY_MAJOR_SITE_CONFIRM:-0}" in
  1|true|TRUE|yes|YES)
    ;;
  *)
    echo "Refusing to apply major nginx config without MAXIM_APPLY_MAJOR_SITE_CONFIRM=1. Run with --dry-run first and review the diff." >&2
    exit 2
    ;;
esac

scp "$LOCAL_CONF" "${HOST}:${REMOTE_CONF_TMP}"
# The fixed temporary path is intentionally interpolated into the remote command.
# shellcheck disable=SC2029
ssh "$HOST" "rm -rf '${REMOTE_SITE_TMP}' && mkdir -p '${REMOTE_SITE_TMP}'"
scp "$LOCAL_SITE_DIR/index.html" "${HOST}:${REMOTE_SITE_TMP}/index.html"
# The fixed temporary path is intentionally interpolated into the remote command.
# shellcheck disable=SC2029
ssh "$HOST" "rm -rf '${REMOTE_SNIPPET_TMP_DIR}' && mkdir -p '${REMOTE_SNIPPET_TMP_DIR}'"
for snippet in "${KARAVAN_SSE_SNIPPETS[@]}"; do
  scp "${LOCAL_SNIPPET_DIR}/${snippet}" "${HOST}:${REMOTE_SNIPPET_TMP_DIR}/${snippet}"
done

ssh "$HOST" "curl -fsS --max-time 10 http://127.0.0.1:3003/app/ >/dev/null"

# Fixed deployment paths are intentionally interpolated into the remote environment.
# shellcheck disable=SC2029
ssh "$HOST" "\
  REMOTE_CONF_TMP='${REMOTE_CONF_TMP}' \
  REMOTE_SITE_TMP='${REMOTE_SITE_TMP}' \
  REMOTE_SNIPPET_TMP_DIR='${REMOTE_SNIPPET_TMP_DIR}' \
  REMOTE_CONF='${REMOTE_CONF}' \
  REMOTE_ENABLED_CONF='${REMOTE_ENABLED_CONF}' \
  REMOTE_SITE_DIR='${REMOTE_SITE_DIR}' \
  REMOTE_BACKUP_DIR='${REMOTE_BACKUP_DIR}' \
  REMOTE_SNIPPET_DIR='${REMOTE_SNIPPET_DIR}' \
  bash -s" <<'REMOTE'
set -euo pipefail

snippets=(
  "karavan-sse-locations.conf"
  "karavan-sse-proxy-common.conf"
)

timestamp="$(date +%Y%m%d%H%M%S)"
available_backup=""
enabled_backup=""
enabled_link_target=""
enabled_existed=0
enabled_was_symlink=0
site_index_backup=""
site_index_existed=0
NGINX_MUTATED=0
DEPLOYMENT_COMMITTED=0
ROLLBACK_ATTEMPTED=0
ROLLBACK_SUCCEEDED=0

sudo mkdir -p "${REMOTE_BACKUP_DIR}"
if [[ -e "${REMOTE_CONF}" || -L "${REMOTE_CONF}" ]]; then
  available_backup="${REMOTE_BACKUP_DIR}/$(basename "${REMOTE_CONF}").bak-${timestamp}"
  sudo cp -a "${REMOTE_CONF}" "${available_backup}"
fi
if [[ -L "${REMOTE_ENABLED_CONF}" ]]; then
  enabled_existed=1
  enabled_was_symlink=1
  enabled_link_target="$(readlink "${REMOTE_ENABLED_CONF}")"
elif [[ -e "${REMOTE_ENABLED_CONF}" ]]; then
  enabled_existed=1
  enabled_backup="${REMOTE_BACKUP_DIR}/$(basename "${REMOTE_ENABLED_CONF}").enabled.bak-${timestamp}"
  sudo cp -a "${REMOTE_ENABLED_CONF}" "${enabled_backup}"
fi
for snippet in "${snippets[@]}"; do
  if [[ -e "${REMOTE_SNIPPET_DIR}/${snippet}" || -L "${REMOTE_SNIPPET_DIR}/${snippet}" ]]; then
    sudo cp -a "${REMOTE_SNIPPET_DIR}/${snippet}" \
      "${REMOTE_BACKUP_DIR}/${snippet}.bak-${timestamp}"
  fi
done
if [[ -e "${REMOTE_SITE_DIR}/index.html" || -L "${REMOTE_SITE_DIR}/index.html" ]]; then
  site_index_existed=1
  site_index_backup="${REMOTE_BACKUP_DIR}/major-site-index.html.bak-${timestamp}"
  sudo cp -a "${REMOTE_SITE_DIR}/index.html" "${site_index_backup}"
fi

restore_backup() {
  local restore_failed=0

  ROLLBACK_ATTEMPTED=1
  echo "Restoring the previous major-maksimov.ru nginx configuration..." >&2
  if [[ -n "${available_backup}" && ( -e "${available_backup}" || -L "${available_backup}" ) ]]; then
    sudo cp -a "${available_backup}" "${REMOTE_CONF}" || restore_failed=1
  else
    sudo rm -f "${REMOTE_CONF}" || restore_failed=1
  fi

  sudo rm -f "${REMOTE_ENABLED_CONF}" || restore_failed=1
  if [[ "${enabled_existed}" -eq 1 && "${enabled_was_symlink}" -eq 1 ]]; then
    sudo ln -s "${enabled_link_target}" "${REMOTE_ENABLED_CONF}" || restore_failed=1
  elif [[ "${enabled_existed}" -eq 1 && -n "${enabled_backup}" && ( -e "${enabled_backup}" || -L "${enabled_backup}" ) ]]; then
    sudo cp -a "${enabled_backup}" "${REMOTE_ENABLED_CONF}" || restore_failed=1
  fi

  for snippet in "${snippets[@]}"; do
    backup="${REMOTE_BACKUP_DIR}/${snippet}.bak-${timestamp}"
    if [[ -e "${backup}" || -L "${backup}" ]]; then
      sudo cp -a "${backup}" "${REMOTE_SNIPPET_DIR}/${snippet}" || restore_failed=1
    else
      sudo rm -f "${REMOTE_SNIPPET_DIR}/${snippet}" || restore_failed=1
    fi
  done

  if [[ "${site_index_existed}" -eq 1 && -n "${site_index_backup}" && ( -e "${site_index_backup}" || -L "${site_index_backup}" ) ]]; then
    sudo cp -a "${site_index_backup}" "${REMOTE_SITE_DIR}/index.html" || restore_failed=1
  else
    sudo rm -f "${REMOTE_SITE_DIR}/index.html" || restore_failed=1
  fi

  if [[ "${restore_failed}" -eq 0 ]] && sudo nginx -t; then
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

cleanup_tmp() {
  rm -rf "${REMOTE_SITE_TMP}" "${REMOTE_CONF_TMP}" "${REMOTE_SNIPPET_TMP_DIR}"
}

LOCAL_SMOKE_MAX_ATTEMPTS=10
LOCAL_SMOKE_RETRY_DELAY_SECONDS=1
LOCAL_SMOKE_FAILURE_PATH=""
LOCAL_SMOKE_FAILURE_ASSERTION=""

record_local_smoke_failure() {
  LOCAL_SMOKE_FAILURE_PATH="$1"
  LOCAL_SMOKE_FAILURE_ASSERTION="$2"
}

assert_local_smoke_match() {
  local path="$1"
  local assertion="$2"
  local pattern="$3"
  local headers="$4"

  if ! grep -Eqi -- "${pattern}" <<<"${headers}"; then
    record_local_smoke_failure "${path}" "${assertion}"
    return 1
  fi
}

assert_security_headers() {
  local path="$1"
  local headers="$2"

  assert_local_smoke_match "${path}" "header:strict-transport-security" \
    '^strict-transport-security: max-age=31536000' "${headers}" || return 1
  assert_local_smoke_match "${path}" "header:x-content-type-options" \
    '^x-content-type-options: nosniff' "${headers}" || return 1
  assert_local_smoke_match "${path}" "header:referrer-policy" \
    '^referrer-policy: strict-origin-when-cross-origin' "${headers}" || return 1
}

read_local_headers() {
  local path="$1"
  curl --noproxy '*' -sS --max-time 15 --resolve major-maksimov.ru:443:127.0.0.1 \
    -D - -o /dev/null "https://major-maksimov.ru${path}"
}

verify_local_route() {
  local path="$1"
  local expected_status="$2"
  local expected_ingress="$3"
  local expected_cache_control="$4"
  local headers

  if ! headers="$(read_local_headers "${path}")"; then
    record_local_smoke_failure "${path}" "request"
    return 1
  fi
  if [[ -n "${expected_status}" ]]; then
    assert_local_smoke_match "${path}" "status:${expected_status}" \
      "^HTTP/[0-9.]+ ${expected_status}" "${headers}" || return 1
  fi
  if [[ -n "${expected_ingress}" ]]; then
    assert_local_smoke_match "${path}" "header:x-maxim-ingress:${expected_ingress}" \
      "^x-maxim-ingress: ${expected_ingress}" "${headers}" || return 1
  fi
  if [[ -n "${expected_cache_control}" ]]; then
    assert_local_smoke_match "${path}" "header:cache-control" \
      "^cache-control: ${expected_cache_control}" "${headers}" || return 1
  fi
  assert_security_headers "${path}" "${headers}" || return 1
}

verify_local_nginx() {
  verify_local_route "/" "200" "" "" || return 1
  verify_local_route "/robots.txt" "200" "" "public, max-age=3600" || return 1
  verify_local_route "/ios-canary/ping.txt" "200" "" \
    "no-store, no-cache, must-revalidate, max-age=0" || return 1
  verify_local_route "/api/health/live" "200" "webhook" "" || return 1
  verify_local_route "/api/v1/channels" "401" "admin" "" || return 1
  verify_local_route "/api/v1/channels/" "401" "admin" "" || return 1
  verify_local_route "/api/v1/chats/" "401" "admin" "" || return 1
  verify_local_route "/api/v1/system/metrics/queues" "" "admin" "" || return 1
}

verify_local_nginx_with_retry() {
  local attempt

  for ((attempt = 1; attempt <= LOCAL_SMOKE_MAX_ATTEMPTS; attempt += 1)); do
    LOCAL_SMOKE_FAILURE_PATH=""
    LOCAL_SMOKE_FAILURE_ASSERTION=""
    if verify_local_nginx; then
      return 0
    fi

    echo "Local nginx smoke attempt ${attempt}/${LOCAL_SMOKE_MAX_ATTEMPTS} failed: path=${LOCAL_SMOKE_FAILURE_PATH:-unknown} assertion=${LOCAL_SMOKE_FAILURE_ASSERTION:-unknown}." >&2
    if [[ "${attempt}" -lt "${LOCAL_SMOKE_MAX_ATTEMPTS}" ]]; then
      sleep "${LOCAL_SMOKE_RETRY_DELAY_SECONDS}"
    fi
  done

  return 1
}

finalize_remote_deploy() {
  local exit_status=$?

  trap - EXIT
  if [[ "${exit_status}" -ne 0 && "${NGINX_MUTATED}" -eq 1 && \
    "${DEPLOYMENT_COMMITTED}" -eq 0 && "${ROLLBACK_ATTEMPTED}" -eq 0 ]]; then
    echo "Major nginx deployment failed after runtime mutation; rolling back." >&2
    if ! restore_backup; then
      echo "Automatic nginx rollback failed; inspect the host before retrying." >&2
    fi
  fi

  if [[ "${ROLLBACK_ATTEMPTED}" -eq 1 && "${ROLLBACK_SUCCEEDED}" -eq 0 ]]; then
    echo "Rollback backups retained under ${REMOTE_BACKUP_DIR} with timestamp ${timestamp}." >&2
  fi
  if ! cleanup_tmp; then
    echo "Failed to remove temporary major nginx deployment files." >&2
    if [[ "${exit_status}" -eq 0 ]]; then
      exit_status=1
    fi
  fi

  exit "${exit_status}"
}

trap finalize_remote_deploy EXIT

sudo install -d -m 755 "${REMOTE_SITE_DIR}" "${REMOTE_SNIPPET_DIR}"
NGINX_MUTATED=1
sudo install -m 644 "${REMOTE_SITE_TMP}/index.html" "${REMOTE_SITE_DIR}/index.html"
for snippet in "${snippets[@]}"; do
  sudo install -m 644 "${REMOTE_SNIPPET_TMP_DIR}/${snippet}" "${REMOTE_SNIPPET_DIR}/${snippet}"
done
sudo install -m 644 "${REMOTE_CONF_TMP}" "${REMOTE_CONF}"
sudo rm -f "${REMOTE_ENABLED_CONF}"
sudo ln -s "${REMOTE_CONF}" "${REMOTE_ENABLED_CONF}"

if ! sudo nginx -t; then
  if ! restore_backup; then
    echo "Automatic nginx rollback failed; inspect the host before retrying." >&2
  fi
  cleanup_tmp
  exit 1
fi

if ! sudo systemctl reload nginx; then
  if ! restore_backup; then
    echo "Automatic nginx rollback failed; inspect the host before retrying." >&2
  fi
  cleanup_tmp
  exit 1
fi

if ! verify_local_nginx_with_retry; then
  echo "New nginx configuration failed the local route/header smoke; rolling back." >&2
  if ! restore_backup; then
    echo "Automatic nginx rollback failed; inspect the host before retrying." >&2
  fi
  cleanup_tmp
  exit 1
fi

DEPLOYMENT_COMMITTED=1
cleanup_tmp
REMOTE

assert_major_security_headers() {
  local headers="$1"
  grep -i '^strict-transport-security: max-age=31536000' <<<"$headers"
  grep -i '^x-content-type-options: nosniff' <<<"$headers"
  grep -i '^referrer-policy: strict-origin-when-cross-origin' <<<"$headers"
}

echo "Verifying major-maksimov.ru root..."
curl -fsS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/ | grep -Ei '^HTTP/[0-9.]+ 200'
curl -fsS --max-time 15 https://major-maksimov.ru/ | grep -F 'Бот-модератор для чатов MAX' >/dev/null

echo "Verifying major-maksimov.ru app route..."
curl -fsS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/app/ | grep -Ei '^HTTP/[0-9.]+ 200'
curl -fsS --max-time 15 https://major-maksimov.ru/app/ | grep -F 'https://major-maksimov.ru/app/' >/dev/null
curl -fsS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/ios-canary/ping.txt | grep -Ei '^HTTP/[0-9.]+ 200'
major_robots_headers="$(curl -fsS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/robots.txt)"
grep -Ei '^HTTP/[0-9.]+ 200' <<<"$major_robots_headers"
assert_major_security_headers "$major_robots_headers"
major_live_headers="$(curl -fsS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/health/live)"
grep -Ei '^HTTP/[0-9.]+ 200' <<<"$major_live_headers"
grep -i '^x-maxim-ingress: webhook' <<<"$major_live_headers"
assert_major_security_headers "$major_live_headers"
curl -sS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/health/ready | grep -Ei '^HTTP/[0-9.]+ 404'
metrics_headers="$(curl -sS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/v1/system/metrics/queues)"
grep -i '^x-maxim-ingress: admin' <<<"$metrics_headers"
assert_major_security_headers "$metrics_headers"
channels_headers="$(curl -sS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/v1/channels)"
grep -Ei '^HTTP/[0-9.]+ 401' <<<"$channels_headers"
grep -i '^x-maxim-ingress: admin' <<<"$channels_headers"
assert_major_security_headers "$channels_headers"
channels_trailing_headers="$(curl -sS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/v1/channels/)"
grep -Ei '^HTTP/[0-9.]+ 401' <<<"$channels_trailing_headers"
grep -i '^x-maxim-ingress: admin' <<<"$channels_trailing_headers"
assert_major_security_headers "$channels_trailing_headers"
chats_trailing_headers="$(curl -sS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/v1/chats/)"
grep -Ei '^HTTP/[0-9.]+ 401' <<<"$chats_trailing_headers"
grep -i '^x-maxim-ingress: admin' <<<"$chats_trailing_headers"
assert_major_security_headers "$chats_trailing_headers"
curl -sS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/v1/safety-desk/queue | grep -Ei '^HTTP/[0-9.]+ 404'
curl -sS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/v1/support-requests/queue | grep -Ei '^HTTP/[0-9.]+ 404'
karavan_sse_headers="$(
  curl -sS --max-time 5 -D - -o /dev/null \
    https://major-maksimov.ru/karavan/api/v1/client/orders/stream
)"
grep -Ei '^HTTP/[0-9.]+ 401' <<<"$karavan_sse_headers"
grep -Ei '^content-type: application/json' <<<"$karavan_sse_headers"
grep -Ei '^x-maxim-ingress: karavan-sse' <<<"$karavan_sse_headers"
grep -Ei '^x-accel-buffering: no' <<<"$karavan_sse_headers"

echo "Verifying app.major-maksimov.ru canonical redirect..."
curl -fsS --max-time 15 -D - -o /dev/null https://app.major-maksimov.ru/app/ | grep -i '^location: https://major-maksimov.ru/app/'

echo "Done: major-maksimov.ru public site applied on ${HOST}"
