#!/usr/bin/env bash

maxim_validate_git_ssh_port() {
  case "${1:-default}" in
    default|22|443) return 0 ;;
    *) echo "MAXIM_DEPLOY_GIT_SSH_PORT must be default, 22, or 443." >&2; return 2 ;;
  esac
}

maxim_configure_git_ssh_transport() {
  local port="${1:-default}"
  local remote_url ssh_command hostname
  maxim_validate_git_ssh_port "$port" || return
  [[ "$port" != default ]] || return 0
  remote_url="$(git remote get-url origin)" || return
  case "$remote_url" in
    git@github.com:*|ssh://git@github.com/*|ssh://git@ssh.github.com:443/*) ;;
    *) echo "Explicit Git SSH transport requires a GitHub SSH origin; origin was not changed." >&2; return 2 ;;
  esac
  # FLAG: preserve the VPS deploy identity; never replace core.sshCommand with bare ssh.
  ssh_command="${GIT_SSH_COMMAND:-}"
  if [[ -z "$ssh_command" ]]; then
    ssh_command="$(git config --get core.sshCommand || true)"
  fi
  if [[ -z "$ssh_command" && -n "${GIT_SSH:-}" ]]; then
    printf -v ssh_command '%q' "$GIT_SSH"
  fi
  ssh_command="${ssh_command:-ssh}"
  hostname=github.com
  [[ "$port" != 443 ]] || hostname=ssh.github.com
  export GIT_SSH_COMMAND="$ssh_command -o HostName=$hostname -o HostKeyAlias=github.com -p $port -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes"
  export GIT_SSH_VARIANT=ssh
}

maxim_prepend_git_ssh_transport() {
  local -n command_ref="$1"
  local port="${2:-default}"
  maxim_validate_git_ssh_port "$port" || return
  [[ "$port" != default ]] || return 0
  # Carry only reviewed function definitions, so the first rollout works on older VPS tooling.
  command_ref="$(declare -f maxim_validate_git_ssh_port)
$(declare -f maxim_configure_git_ssh_transport)
maxim_configure_git_ssh_transport $port && $command_ref"
}
