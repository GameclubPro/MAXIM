#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${MAXIM_VPS_ENV_FILE:-$ROOT_DIR/.env.vps}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

MAXIM_VPS_SSH_TARGET="${MAXIM_VPS_SSH_TARGET:-maxim-vps}"
MAXIM_VPS_REPO_DIR="${MAXIM_VPS_REPO_DIR:-/var/www/Chat_bot}"
MAXIM_VPS_PUBLIC_URL="${MAXIM_VPS_PUBLIC_URL:-https://maxim.play-team.ru}"

usage() {
  cat <<'USAGE'
Usage:
  ./infra/scripts/vps-connect.sh <command> [args...]

Commands:
  doctor                      Check local SSH config and remote VPS basics
  shell                       Open an interactive shell in the remote repo
  exec <command...>           Run a command in the remote repo
  deploy [branch] [services]  Run the main production deploy script on the VPS
  deploy-scale [branch] [...] Run the split/load-testing deploy script on the VPS
  deploy-reshenie [branch]    Run the standalone Reshenie deploy script on the VPS
  rollback-runtime <ref> [...] Rebuild/recreate API roles from a previous git ref
  health                      Check local-on-VPS and public health endpoints
  ps [services...]            Show main production docker compose status
  logs <service> [tail]       Show main production service logs, default tail=200
  yc-shell                    Open a Yandex Cloud CLI SSH shell, if configured

Per-device config:
  cp infra/env/vps.env.example .env.vps
  edit .env.vps
  ./infra/scripts/vps-connect.sh doctor
USAGE
}

expand_path() {
  local value="$1"

  case "$value" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${value#~/}" ;;
    *) printf '%s' "$value" ;;
  esac
}

shell_quote_args() {
  local arg
  local quoted

  for arg in "$@"; do
    printf -v quoted '%q' "$arg"
    printf '%s ' "$quoted"
  done
}

ssh_args() {
  local args=(
    -o ServerAliveInterval=15
    -o ServerAliveCountMax=3
  )
  local extra_args=()

  if [[ -n "${MAXIM_VPS_SSH_PORT:-}" ]]; then
    args+=(-p "$MAXIM_VPS_SSH_PORT")
  fi

  if [[ -n "${MAXIM_VPS_SSH_KEY:-}" ]]; then
    args+=(-i "$(expand_path "$MAXIM_VPS_SSH_KEY")")
  fi

  if [[ -n "${MAXIM_VPS_SSH_CONFIG:-}" ]]; then
    args+=(-F "$(expand_path "$MAXIM_VPS_SSH_CONFIG")")
  fi

  if [[ -n "${MAXIM_VPS_SSH_EXTRA_ARGS:-}" ]]; then
    # Split simple whitespace-separated extra args. Keep complex SSH options in
    # ~/.ssh/config when quoting is required.
    read -r -a extra_args <<<"$MAXIM_VPS_SSH_EXTRA_ARGS"
    args+=("${extra_args[@]}")
  fi

  printf '%s\0' "${args[@]}"
}

remote_exec() {
  local command="$1"
  local remote_command
  local args=()

  mapfile -d '' -t args < <(ssh_args)
  printf -v remote_command 'cd %q && %s' "$MAXIM_VPS_REPO_DIR" "$command"
  ssh "${args[@]}" "$MAXIM_VPS_SSH_TARGET" "bash -lc $(printf '%q' "$remote_command")"
}

remote_from_args() {
  if [[ $# -eq 0 ]]; then
    echo "Missing remote command."
    usage
    exit 1
  fi

  if [[ $# -eq 1 ]]; then
    remote_exec "$1"
  else
    remote_exec "$(shell_quote_args "$@")"
  fi
}

open_shell() {
  local args=()
  local remote_command

  mapfile -d '' -t args < <(ssh_args)
  printf -v remote_command 'cd %q && exec "${SHELL:-bash}"' "$MAXIM_VPS_REPO_DIR"
  ssh "${args[@]}" -t "$MAXIM_VPS_SSH_TARGET" "bash -lc $(printf '%q' "$remote_command")"
}

deploy_main() {
  local branch="${1:-main}"
  shift || true

  remote_exec "$(shell_quote_args ./infra/scripts/vps-pull-build-up.sh "$branch" "$@")"
}

deploy_scale() {
  local branch="${1:-main}"
  shift || true

  remote_exec "$(shell_quote_args ./infra/scripts/vps-pull-build-up-scale.sh "$branch" "$@")"
}

deploy_reshenie() {
  local branch="${1:-main}"

  remote_exec "$(shell_quote_args ./infra/scripts/vps-pull-build-up-reshenie.sh "$branch")"
}

rollback_runtime() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: $0 rollback-runtime <git-ref> [services...]"
    exit 1
  fi

  remote_exec "$(shell_quote_args ./infra/scripts/vps-runtime-rollback.sh "$@")"
}

health() {
  remote_exec 'curl -fsS --max-time 15 http://127.0.0.1:3001/api/health/live && printf "\n" && curl -fsS --max-time 15 http://127.0.0.1:3001/api/health/ready && printf "\n"'
  curl -fsS --max-time 15 "$MAXIM_VPS_PUBLIC_URL/api/health/live"
  printf '\n'
  curl -fsS --max-time 15 "$MAXIM_VPS_PUBLIC_URL/api/health/ready"
  printf '\n'
}

doctor() {
  local args=()

  if ! command -v ssh >/dev/null 2>&1; then
    echo "ssh not found"
    exit 1
  fi

  mapfile -d '' -t args < <(ssh_args)

  echo "Config:"
  echo "  env_file=$ENV_FILE"
  echo "  ssh_target=$MAXIM_VPS_SSH_TARGET"
  echo "  repo_dir=$MAXIM_VPS_REPO_DIR"
  echo "  public_url=$MAXIM_VPS_PUBLIC_URL"
  echo

  ssh "${args[@]}" -o BatchMode=yes -o ConnectTimeout=10 "$MAXIM_VPS_SSH_TARGET" \
    "cd $(printf '%q' "$MAXIM_VPS_REPO_DIR") && printf 'remote_repo=%s\n' \"\$PWD\" && git rev-parse --short HEAD && docker compose version"
}

yc_shell() {
  local args=(compute ssh --public-address)

  if ! command -v yc >/dev/null 2>&1; then
    echo "yc not found"
    exit 1
  fi

  if [[ -n "${MAXIM_YC_PROFILE:-}" ]]; then
    args=(--profile "$MAXIM_YC_PROFILE" "${args[@]}")
  fi

  if [[ -n "${MAXIM_YC_VM_ID:-}" ]]; then
    args+=(--id "$MAXIM_YC_VM_ID")
  elif [[ -n "${MAXIM_YC_VM_NAME:-}" ]]; then
    args+=(--name "$MAXIM_YC_VM_NAME")
  else
    echo "Set MAXIM_YC_VM_NAME or MAXIM_YC_VM_ID in .env.vps."
    exit 1
  fi

  if [[ -n "${MAXIM_YC_LOGIN:-}" ]]; then
    args+=(--login "$MAXIM_YC_LOGIN")
  fi

  if [[ -n "${MAXIM_YC_IDENTITY_FILE:-}" ]]; then
    args+=(-i "$(expand_path "$MAXIM_YC_IDENTITY_FILE")")
  fi

  yc "${args[@]}"
}

command="${1:-}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$command" in
  doctor)
    doctor
    ;;
  shell)
    open_shell
    ;;
  exec)
    remote_from_args "$@"
    ;;
  deploy)
    deploy_main "$@"
    ;;
  deploy-scale)
    deploy_scale "$@"
    ;;
  deploy-reshenie)
    deploy_reshenie "$@"
    ;;
  rollback-runtime)
    rollback_runtime "$@"
    ;;
  health)
    health
    ;;
  ps)
    remote_exec "$(shell_quote_args docker compose -p infra -f infra/docker-compose.yml ps "$@")"
    ;;
  logs)
    if [[ $# -lt 1 ]]; then
      echo "Usage: $0 logs <service> [tail]"
      exit 1
    fi
    service="$1"
    tail="${2:-200}"
    remote_exec "$(shell_quote_args docker compose -p infra -f infra/docker-compose.yml logs --tail "$tail" "$service")"
    ;;
  yc-shell)
    yc_shell
    ;;
  -h|--help|help|'')
    usage
    ;;
  *)
    echo "Unknown command: $command"
    usage
    exit 1
    ;;
esac
