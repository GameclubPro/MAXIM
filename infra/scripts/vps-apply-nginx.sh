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
  rm -rf "${REMOTE_TMP}" "${REMOTE_SNIPPET_TMP_DIR}"
}

sudo install -d -m 755 "${REMOTE_SNIPPET_DIR}"
for snippet in "${snippets[@]}"; do
  sudo install -m 644 "${REMOTE_SNIPPET_TMP_DIR}/${snippet}" "${REMOTE_SNIPPET_DIR}/${snippet}"
done
sudo install -m 644 "${REMOTE_TMP}" "${REMOTE_CONF}"
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

echo "Verifying public route split headers..."
legacy_live_headers="$(curl -fsS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/api/health/live)"
grep -Ei '^HTTP/[0-9.]+ 200' <<<"$legacy_live_headers"
grep -i '^x-maxim-ingress: webhook' <<<"$legacy_live_headers"
curl -sS --max-time 15 -D - -o /dev/null https://maxim.play-team.ru/api/health/ready | grep -Ei '^HTTP/[0-9.]+ 404'
curl -sS --max-time 15 -D - -o /dev/null https://hook.maxim.play-team.ru/api/health/ready | grep -Ei '^HTTP/[0-9.]+ 404'
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
