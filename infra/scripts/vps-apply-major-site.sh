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
ssh "$HOST" "rm -rf '${REMOTE_SITE_TMP}' && mkdir -p '${REMOTE_SITE_TMP}'"
scp "$LOCAL_SITE_DIR/index.html" "${HOST}:${REMOTE_SITE_TMP}/index.html"
ssh "$HOST" "rm -rf '${REMOTE_SNIPPET_TMP_DIR}' && mkdir -p '${REMOTE_SNIPPET_TMP_DIR}'"
for snippet in "${KARAVAN_SSE_SNIPPETS[@]}"; do
  scp "${LOCAL_SNIPPET_DIR}/${snippet}" "${HOST}:${REMOTE_SNIPPET_TMP_DIR}/${snippet}"
done

ssh "$HOST" "curl -fsS --max-time 10 http://127.0.0.1:3003/app/ >/dev/null"

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
  if [[ -n "${available_backup}" && -e "${available_backup}" ]]; then
    sudo cp -a "${available_backup}" "${REMOTE_CONF}"
  else
    sudo rm -f "${REMOTE_CONF}"
  fi

  sudo rm -f "${REMOTE_ENABLED_CONF}"
  if [[ "${enabled_existed}" -eq 1 && "${enabled_was_symlink}" -eq 1 ]]; then
    sudo ln -s "${enabled_link_target}" "${REMOTE_ENABLED_CONF}"
  elif [[ "${enabled_existed}" -eq 1 && -n "${enabled_backup}" && -e "${enabled_backup}" ]]; then
    sudo cp -a "${enabled_backup}" "${REMOTE_ENABLED_CONF}"
  fi

  for snippet in "${snippets[@]}"; do
    backup="${REMOTE_BACKUP_DIR}/${snippet}.bak-${timestamp}"
    if [[ -e "${backup}" ]]; then
      sudo cp -a "${backup}" "${REMOTE_SNIPPET_DIR}/${snippet}"
    else
      sudo rm -f "${REMOTE_SNIPPET_DIR}/${snippet}"
    fi
  done

  sudo nginx -t >/dev/null 2>&1 && sudo systemctl reload nginx || true
}

cleanup_tmp() {
  rm -rf "${REMOTE_SITE_TMP}" "${REMOTE_CONF_TMP}" "${REMOTE_SNIPPET_TMP_DIR}"
}

sudo install -d -m 755 "${REMOTE_SITE_DIR}" "${REMOTE_SNIPPET_DIR}"
sudo install -m 644 "${REMOTE_SITE_TMP}/index.html" "${REMOTE_SITE_DIR}/index.html"
for snippet in "${snippets[@]}"; do
  sudo install -m 644 "${REMOTE_SNIPPET_TMP_DIR}/${snippet}" "${REMOTE_SNIPPET_DIR}/${snippet}"
done
sudo install -m 644 "${REMOTE_CONF_TMP}" "${REMOTE_CONF}"
sudo rm -f "${REMOTE_ENABLED_CONF}"
sudo ln -s "${REMOTE_CONF}" "${REMOTE_ENABLED_CONF}"

if ! sudo nginx -t; then
  restore_backup
  cleanup_tmp
  exit 1
fi

if ! sudo systemctl reload nginx; then
  restore_backup
  cleanup_tmp
  exit 1
fi

cleanup_tmp
REMOTE

echo "Verifying major-maksimov.ru root..."
curl -fsS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/ | grep -Ei '^HTTP/[0-9.]+ 200'
curl -fsS --max-time 15 https://major-maksimov.ru/ | grep -F 'Бот-модератор для чатов MAX' >/dev/null

echo "Verifying major-maksimov.ru app route..."
curl -fsS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/app/ | grep -Ei '^HTTP/[0-9.]+ 200'
curl -fsS --max-time 15 https://major-maksimov.ru/app/ | grep -F 'https://major-maksimov.ru/app/' >/dev/null
curl -fsS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/ios-canary/ping.txt | grep -Ei '^HTTP/[0-9.]+ 200'
major_live_headers="$(curl -fsS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/health/live)"
grep -Ei '^HTTP/[0-9.]+ 200' <<<"$major_live_headers"
grep -i '^x-maxim-ingress: webhook' <<<"$major_live_headers"
curl -sS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/health/ready | grep -Ei '^HTTP/[0-9.]+ 404'
curl -sS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/v1/system/metrics/queues | grep -i '^x-maxim-ingress: admin'
channels_headers="$(curl -sS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/v1/channels)"
grep -Ei '^HTTP/[0-9.]+ 401' <<<"$channels_headers"
grep -i '^x-maxim-ingress: admin' <<<"$channels_headers"
channels_trailing_headers="$(curl -sS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/v1/channels/)"
grep -Ei '^HTTP/[0-9.]+ 401' <<<"$channels_trailing_headers"
grep -i '^x-maxim-ingress: admin' <<<"$channels_trailing_headers"
chats_trailing_headers="$(curl -sS --max-time 15 -D - -o /dev/null https://major-maksimov.ru/api/v1/chats/)"
grep -Ei '^HTTP/[0-9.]+ 401' <<<"$chats_trailing_headers"
grep -i '^x-maxim-ingress: admin' <<<"$chats_trailing_headers"
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
