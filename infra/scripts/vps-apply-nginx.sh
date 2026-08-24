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
LOCAL_SNIPPET_DIR="infra/nginx/snippets"
REMOTE_TMP="/tmp/maxim.play-team.ru.conf"
REMOTE_SNIPPET_TMP_DIR="/tmp/karavan-sse-nginx-snippets"
REMOTE_CONF="/etc/nginx/sites-available/maxim.play-team.ru.conf"
REMOTE_ENABLED_CONF="/etc/nginx/sites-enabled/maxim.play-team.ru.conf"
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

for snippet in "${KARAVAN_SSE_SNIPPETS[@]}"; do
  if [[ ! -f "${LOCAL_SNIPPET_DIR}/${snippet}" ]]; then
    echo "Missing local nginx snippet: ${LOCAL_SNIPPET_DIR}/${snippet}"
    exit 1
  fi
done

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

case "${MAXIM_APPLY_NGINX_CONFIRM:-0}" in
  1|true|TRUE|yes|YES)
    ;;
  *)
    echo "Refusing to apply nginx config without MAXIM_APPLY_NGINX_CONFIRM=1. Run with --dry-run first and review the diff." >&2
    exit 2
    ;;
esac

scp "$LOCAL_CONF" "${HOST}:${REMOTE_TMP}"
# The fixed temporary path is intentionally interpolated into the remote command.
# shellcheck disable=SC2029
ssh "$HOST" "rm -rf '${REMOTE_SNIPPET_TMP_DIR}' && mkdir -p '${REMOTE_SNIPPET_TMP_DIR}'"
for snippet in "${KARAVAN_SSE_SNIPPETS[@]}"; do
  scp "${LOCAL_SNIPPET_DIR}/${snippet}" "${HOST}:${REMOTE_SNIPPET_TMP_DIR}/${snippet}"
done

# Fixed deployment paths are intentionally interpolated into the remote environment.
# shellcheck disable=SC2029
ssh "$HOST" "\
  REMOTE_TMP='${REMOTE_TMP}' \
  REMOTE_SNIPPET_TMP_DIR='${REMOTE_SNIPPET_TMP_DIR}' \
  REMOTE_CONF='${REMOTE_CONF}' \
  REMOTE_ENABLED_CONF='${REMOTE_ENABLED_CONF}' \
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

restore_backup() {
  local restore_failed=0

  ROLLBACK_ATTEMPTED=1
  echo "Restoring the previous maxim.play-team.ru nginx configuration..." >&2
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
  rm -rf "${REMOTE_TMP}" "${REMOTE_SNIPPET_TMP_DIR}"
}

LOCAL_SMOKE_MAX_ATTEMPTS=10
LOCAL_SMOKE_RETRY_DELAY_SECONDS=1
LOCAL_SMOKE_FAILURE_ROUTE=""
LOCAL_SMOKE_FAILURE_ASSERTION=""

record_local_smoke_failure() {
  LOCAL_SMOKE_FAILURE_ROUTE="$1"
  LOCAL_SMOKE_FAILURE_ASSERTION="$2"
}

assert_local_smoke_match() {
  local route="$1"
  local assertion="$2"
  local pattern="$3"
  local headers="$4"

  if ! grep -Eqi -- "${pattern}" <<<"${headers}"; then
    record_local_smoke_failure "${route}" "${assertion}"
    return 1
  fi
}

assert_local_security_headers() {
  local route="$1"
  local headers="$2"

  assert_local_smoke_match "${route}" "header:strict-transport-security" \
    '^strict-transport-security: max-age=31536000' "${headers}" || return 1
  assert_local_smoke_match "${route}" "header:x-content-type-options" \
    '^x-content-type-options: nosniff' "${headers}" || return 1
  assert_local_smoke_match "${route}" "header:referrer-policy" \
    '^referrer-policy: strict-origin-when-cross-origin' "${headers}" || return 1
}

read_local_headers() {
  local host="$1"
  local path="$2"
  local request_method="${3:-GET}"
  local method_args=()

  case "${request_method}" in
    GET)
      ;;
    HEAD)
      method_args=(-I)
      ;;
    *)
      return 1
      ;;
  esac

  curl --noproxy '*' -sS --max-time 15 --resolve "${host}:443:127.0.0.1" \
    "${method_args[@]}" -D - -o /dev/null "https://${host}${path}"
}

verify_local_route() {
  local host="$1"
  local path="$2"
  local expected_status="$3"
  local expected_ingress="$4"
  local require_security_headers="$5"
  local request_method="${6:-GET}"
  local route="${host}${path}"
  local headers

  if ! headers="$(read_local_headers "${host}" "${path}" "${request_method}")"; then
    record_local_smoke_failure "${route}" "request"
    return 1
  fi
  if [[ -n "${expected_status}" ]]; then
    assert_local_smoke_match "${route}" "status:${expected_status}" \
      "^HTTP/[0-9.]+ ${expected_status}([[:space:]]|$)" "${headers}" || return 1
  fi
  if [[ -n "${expected_ingress}" ]]; then
    assert_local_smoke_match "${route}" "header:x-maxim-ingress:${expected_ingress}" \
      "^x-maxim-ingress: ${expected_ingress}" "${headers}" || return 1
  fi
  if [[ "${require_security_headers}" -eq 1 ]]; then
    assert_local_security_headers "${route}" "${headers}" || return 1
  fi
}

verify_local_redirect() {
  local host="$1"
  local path="$2"
  local expected_location="$3"
  local route="${host}${path}"
  local headers

  if ! headers="$(read_local_headers "${host}" "${path}")"; then
    record_local_smoke_failure "${route}" "request"
    return 1
  fi
  assert_local_smoke_match "${route}" "status:308" \
    '^HTTP/[0-9.]+ 308([[:space:]]|$)' "${headers}" || return 1
  assert_local_smoke_match "${route}" "location:${expected_location}" \
    "^location: ${expected_location}[[:space:]]*$" "${headers}" || return 1
  assert_local_security_headers "${route}" "${headers}" || return 1
}

verify_local_nginx() {
  local host
  local hosts=("maxim.play-team.ru" "hook.maxim.play-team.ru")

  for host in "${hosts[@]}"; do
    verify_local_route "${host}" "/api/health/live" "200" "webhook" 0 || return 1
    verify_local_route "${host}" "/api/health/ready" "404" "" 1 || return 1
    verify_local_route "${host}" "/api/v1/safety-desk/queue" "404" "" 1 || return 1
    verify_local_route "${host}" "/api/v1/support-requests/queue" "404" "" 1 || return 1
  done

  verify_local_route "maxim.play-team.ru" "/api/v1/system/metrics/queues" "" "admin" 0 || return 1
  verify_local_route "maxim.play-team.ru" "/karavan/api/v1/_mutation-tunnel" "" \
    "karavan-mutation-tunnel" 1 "HEAD" || return 1
  verify_local_route "maxim.play-team.ru" "/karavan/api/v1/seller/uploads" "" \
    "karavan-upload" 1 "HEAD" || return 1
  verify_local_route "maxim.play-team.ru" "/karavan/api/v1/client/orders/stream" "" \
    "karavan-sse" 1 "HEAD" || return 1
  verify_local_redirect "maxim.play-team.ru" "/" "https://major-maksimov.ru/app/" || return 1
  verify_local_redirect "maxim.play-team.ru" "/app/" "https://major-maksimov.ru/app/" || return 1
}

verify_local_nginx_with_retry() {
  local attempt

  for ((attempt = 1; attempt <= LOCAL_SMOKE_MAX_ATTEMPTS; attempt += 1)); do
    LOCAL_SMOKE_FAILURE_ROUTE=""
    LOCAL_SMOKE_FAILURE_ASSERTION=""
    if verify_local_nginx; then
      return 0
    fi

    echo "Local legacy nginx smoke attempt ${attempt}/${LOCAL_SMOKE_MAX_ATTEMPTS} failed: route=${LOCAL_SMOKE_FAILURE_ROUTE:-unknown} assertion=${LOCAL_SMOKE_FAILURE_ASSERTION:-unknown}." >&2
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
    echo "Legacy nginx deployment failed after runtime mutation; rolling back." >&2
    if ! restore_backup; then
      echo "Automatic nginx rollback failed; inspect the host before retrying." >&2
    fi
  fi

  if [[ "${ROLLBACK_ATTEMPTED}" -eq 1 && "${ROLLBACK_SUCCEEDED}" -eq 0 ]]; then
    echo "Rollback backups retained under ${REMOTE_BACKUP_DIR} with timestamp ${timestamp}." >&2
  fi
  if ! cleanup_tmp; then
    echo "Failed to remove temporary legacy nginx deployment files." >&2
    if [[ "${exit_status}" -eq 0 ]]; then
      exit_status=1
    fi
  fi

  exit "${exit_status}"
}

trap finalize_remote_deploy EXIT

NGINX_MUTATED=1
sudo install -d -m 755 "${REMOTE_SNIPPET_DIR}"
for snippet in "${snippets[@]}"; do
  sudo install -m 644 "${REMOTE_SNIPPET_TMP_DIR}/${snippet}" "${REMOTE_SNIPPET_DIR}/${snippet}"
done
sudo install -m 644 "${REMOTE_TMP}" "${REMOTE_CONF}"
sudo rm -f "${REMOTE_ENABLED_CONF}"
sudo ln -s "${REMOTE_CONF}" "${REMOTE_ENABLED_CONF}"
sudo nginx -t

sudo systemctl reload nginx

if ! verify_local_nginx_with_retry; then
  echo "New legacy nginx configuration failed the local SNI route/header smoke." >&2
  exit 1
fi

DEPLOYMENT_COMMITTED=1
REMOTE

echo "Verifying public route split headers..."
legacy_live_headers="$(curl -fsS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/api/health/live)"
grep -Ei '^HTTP/[0-9.]+ 200' <<<"$legacy_live_headers"
grep -i '^x-maxim-ingress: webhook' <<<"$legacy_live_headers"
curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/api/health/ready | grep -Ei '^HTTP/[0-9.]+ 404'
curl -sS --max-time 15 -D - -o /dev/null https://hook.maxim.play-team.ru/api/health/ready | grep -Ei '^HTTP/[0-9.]+ 404'
curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/api/v1/system/metrics/queues | grep -i '^x-maxim-ingress: admin'
curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/api/v1/safety-desk/queue | grep -Ei '^HTTP/[0-9.]+ 404'
curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/api/v1/support-requests/queue | grep -Ei '^HTTP/[0-9.]+ 404'

echo "Verifying legacy play-team app redirects to the canonical mini app..."
legacy_root_headers="$(curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/)"
grep -Ei '^HTTP/[0-9.]+ 308' <<<"$legacy_root_headers"
grep -i '^location: https://major-maksimov.ru/app/' <<<"$legacy_root_headers"
legacy_app_headers="$(curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/app/)"
grep -Ei '^HTTP/[0-9.]+ 308' <<<"$legacy_app_headers"
grep -i '^location: https://major-maksimov.ru/app/' <<<"$legacy_app_headers"
grep -i '^strict-transport-security:' <<<"$legacy_app_headers"
grep -i '^x-content-type-options: nosniff' <<<"$legacy_app_headers"
grep -i '^referrer-policy: strict-origin-when-cross-origin' <<<"$legacy_app_headers"

echo "Done: nginx config applied on ${HOST}"
