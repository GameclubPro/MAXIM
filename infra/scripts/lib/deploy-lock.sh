#!/usr/bin/env bash

# FLAG: Every supported runtime mutator must use this fixed, persistent inode.
# Before installing flock-v1, separately prove that no incompatible legacy
# operation is running. An absent legacy directory cannot prove that fact.
# Never unlink this file, clean a legacy lock, or unlock an inherited descriptor.
deploy_lock_file() {
  printf '%s\n' /var/lib/maxim-deploy/deploy.lock
}

validate_deploy_lock_path() {
  local lock_file directory path metadata owner mode links directory_owner allow_create="${1:-0}"
  lock_file="$(deploy_lock_file)"
  directory="${lock_file%/*}"

  if [[ -n "${MAXIM_DEPLOY_LOCK_DIR:-}" ]]; then
    echo 'MAXIM_DEPLOY_LOCK_DIR is no longer supported; the deploy lock path is fixed.' >&2
    return 1
  fi
  if [[ -e /tmp/maxim-main-deploy.lock || -L /tmp/maxim-main-deploy.lock ]]; then
    echo 'Legacy deploy lock exists; refusing admission without removing or adopting it.' >&2
    return 1
  fi

  for path in /var /var/lib /var/lib/maxim-deploy; do
    if [[ ! -d "$path" || -L "$path" ]]; then
      echo 'Deploy lock requires an existing protected directory without symlinks.' >&2
      return 1
    fi
    metadata="$(stat -c '%u %a' -- "$path")" || return 1
    read -r owner mode <<<"$metadata"
    if [[ ! "$owner" =~ ^[0-9]+$ || ! "$mode" =~ ^[0-7]{3,4}$ ]] \
      || (( (8#$mode & 0022) != 0 )) \
      || (( EUID != 0 && owner != 0 && owner != EUID )); then
      echo 'Deploy lock directory has an unsafe owner or write permissions.' >&2
      return 1
    fi
  done
  directory_owner="$(stat -c '%u' -- "$directory")" || return 1
  if [[ ! -e "$lock_file" && ! -L "$lock_file" ]]; then
    if [[ "$allow_create" != 1 || "$directory_owner" != "$EUID" ]]; then
      echo 'The deploy directory owner must provision the persistent lock file first.' >&2
      return 1
    fi
    # Concurrent first admission may create the same file, but never replaces it.
    (umask 077; set -o noclobber; : >"$lock_file") 2>/dev/null || true
  fi
  if [[ ! -f "$lock_file" || -L "$lock_file" ]]; then
    echo 'Deploy lock must be a regular file without symlinks.' >&2
    return 1
  fi
  metadata="$(stat -c '%u %a %h' -- "$lock_file")" || return 1
  read -r owner mode links <<<"$metadata"
  if [[ "$owner" != "$directory_owner" || "$mode" != 600 || "$links" != 1 ]]; then
    echo 'Deploy lock requires directory ownership, mode 0600 and one hard link.' >&2
    return 1
  fi
}

validate_deploy_lock_descriptor() {
  local owner_pid="$BASHPID" lock_file identity descriptor_identity line locked=0
  if [[ "${MAXIM_DEPLOY_LOCK_VERSION:-}" != flock-v1 \
    || "${MAXIM_DEPLOY_LOCK_OWNER_PID:-}" != "$owner_pid" \
    || ! "${MAXIM_DEPLOY_LOCK_FD:-}" =~ ^[1-9][0-9]{1,5}$ \
    || ! "${MAXIM_DEPLOY_LOCK_IDENTITY:-}" =~ ^[0-9]+:[0-9]+$ ]]; then
    echo 'Invalid or foreign inherited deploy lock ownership.' >&2
    return 1
  fi
  lock_file="$(deploy_lock_file)"
  identity="$(stat -c '%d:%i' -- "$lock_file")" || return 1
  descriptor_identity="$(stat -Lc '%d:%i' -- "/proc/$owner_pid/fd/$MAXIM_DEPLOY_LOCK_FD")" || return 1
  if [[ "$identity" != "$MAXIM_DEPLOY_LOCK_IDENTITY" || "$descriptor_identity" != "$identity" ]]; then
    echo 'Deploy lock descriptor no longer refers to the protected inode.' >&2
    return 1
  fi
  # FLAG: A matching open FD/environment alone is not lock authority. fdinfo
  # positively proves the inherited open description still owns the whole lock.
  while IFS= read -r line; do
    if [[ "$line" =~ ^lock:[[:space:]]+[0-9]+:[[:space:]]+FLOCK[[:space:]]+ADVISORY[[:space:]]+WRITE[[:space:]]+[0-9]+[[:space:]]+[^[:space:]]+[[:space:]]+0[[:space:]]+EOF$ ]]; then
      locked=1
    fi
  done <"/proc/$owner_pid/fdinfo/$MAXIM_DEPLOY_LOCK_FD"
  if ((locked != 1)); then
    echo 'Deploy lock descriptor has no exclusive whole-file flock.' >&2
    return 1
  fi
}

require_deploy_lock() {
  validate_deploy_lock_path && validate_deploy_lock_descriptor
}

validate_market_statistics_deploy_admission() {
  local market_scope=0 market_path market_metadata market_owner market_mode market_links
  local market_source_dir="${source_dir:-}" market_release="${release:-}"
  if [[ "${root:-}" == /var/www/svyazka || "$market_source_dir" == /var/www/svyazka/* ]]; then
    market_scope=1
  fi
  for market_path in "$PWD" "${BASH_SOURCE[@]}"; do
    if [[ "$market_path" == /var/www/svyazka || "$market_path" == /var/www/svyazka/* ]]; then
      market_scope=1
    fi
  done
  ((market_scope == 1)) || return 0
  # FLAG: Market's installed statistics floor must fence legacy callers too.
  # This root-owned trust chain is separate from deploy-user-writable releases.
  for market_path in /etc /etc/maxim-deploy /etc/maxim-deploy/market-statistics; do
    [[ -d "$market_path" && ! -L "$market_path" ]] || {
      echo 'Market statistics deployment admission is not installed.' >&2; return 1;
    }
    market_metadata="$(stat -c '%u %a' -- "$market_path")" || return 1
    read -r market_owner market_mode <<<"$market_metadata"
    if [[ "$market_owner" != 0 || ! "$market_mode" =~ ^[0-7]{3,4}$ ]] \
      || (( (8#$market_mode & 0022) != 0 )); then
      echo 'Market statistics deployment admission has an unsafe trust directory.' >&2
      return 1
    fi
  done
  market_path=/etc/maxim-deploy/market-statistics/admission.mjs
  [[ -f "$market_path" && ! -L "$market_path" ]] || return 1
  market_metadata="$(stat -c '%u %a %h' -- "$market_path")" || return 1
  read -r market_owner market_mode market_links <<<"$market_metadata"
  if [[ "$market_owner" != 0 || ! "$market_mode" =~ ^[0-7]{3,4}$ || "$market_links" != 1 ]] \
    || (( (8#$market_mode & 0022) != 0 )); then
    echo 'Market statistics deployment admission has an unsafe installed reader.' >&2
    return 1
  fi
  node "$market_path" --admit "$market_source_dir" "$market_release"
}

require_market_statistics_lock_dispatch() {
  # FLAG: This installed cross-project floor survives MAXIM checkout/re-exec and ref rollback.
  # Inspect reviewed Git bytes without executing candidate code or changing the checkout.
  [[ -e /etc/maxim-deploy/market-statistics || -L /etc/maxim-deploy/market-statistics ]] || return 0
  local target="$1" path size candidate
  for path in infra/scripts/lib/deploy-lock.sh infra/scripts/vps-pull-build-up.sh \
    infra/scripts/vps-runtime-rollback.sh infra/scripts/vps-connect.sh; do
    size="$(git cat-file -s "${target}:${path}" 2>/dev/null)" || {
      echo 'Candidate tooling loses the installed Market statistics admission floor.' >&2; return 1;
    }
    [[ "$size" =~ ^[0-9]{1,6}$ ]] && ((size > 0 && size <= 262144)) || return 1
    candidate="$(git show "${target}:${path}")" || return 1
    case "$path" in
      infra/scripts/lib/deploy-lock.sh)
        grep -Eq '^require_market_statistics_lock_dispatch\(\) \{' <<<"$candidate" \
          && grep -Eq '^validate_market_statistics_deploy_admission\(\) \{' <<<"$candidate" \
          && grep -Eq '^[[:space:]]*node "[$]market_path" --admit "[$]market_source_dir" "[$]market_release"$' <<<"$candidate" \
          && grep -Eq '^[[:space:]]*validate_market_statistics_deploy_admission \|\| return 1$' <<<"$candidate" \
          && grep -Eq '^[[:space:]]*if ! validate_market_statistics_deploy_admission; then$' <<<"$candidate" || return 1
        ;;
      infra/scripts/vps-pull-build-up.sh)
        grep -Eq '^[[:space:]]*require_market_statistics_lock_dispatch "origin/[$]BRANCH" \|\| return 2$' <<<"$candidate" \
          && grep -Eq '^[[:space:]]*require_market_statistics_lock_dispatch "refs/heads/[$]BRANCH" \|\| return 2$' <<<"$candidate" || return 1
        ;;
      infra/scripts/vps-runtime-rollback.sh)
        grep -Eq '^[[:space:]]*require_market_statistics_lock_dispatch "[$]TARGET_FULL_SHA" \|\| exit 1$' <<<"$candidate" || return 1
        ;;
      infra/scripts/vps-connect.sh)
        grep -Eq '^[[:space:]]*require_market_statistics_lock_dispatch "[$]expected_tooling_sha" \|\| exit 1$' <<<"$candidate" || return 1
        ;;
    esac
  done
}

acquire_deploy_lock() {
  local lock_file identity
  if ! command -v flock >/dev/null 2>&1 || ! command -v stat >/dev/null 2>&1; then
    echo 'Linux flock, stat and procfs are required for the deploy lock.' >&2
    return 1
  fi
  if [[ -n "${MAXIM_DEPLOY_LOCK_VERSION:-}${MAXIM_DEPLOY_LOCK_OWNER_PID:-}${MAXIM_DEPLOY_LOCK_FD:-}${MAXIM_DEPLOY_LOCK_IDENTITY:-}" ]]; then
    validate_deploy_lock_path || return 1
    validate_deploy_lock_descriptor || return 1
    trap release_deploy_lock EXIT
    validate_market_statistics_deploy_admission || return 1
    return 0
  fi

  validate_deploy_lock_path 1 || return 1
  lock_file="$(deploy_lock_file)"
  identity="$(stat -c '%d:%i' -- "$lock_file")" || return 1
  exec {MAXIM_DEPLOY_LOCK_FD}<>"$lock_file" || return 1
  if ! flock -n "$MAXIM_DEPLOY_LOCK_FD"; then
    exec {MAXIM_DEPLOY_LOCK_FD}>&-
    unset MAXIM_DEPLOY_LOCK_FD
    echo 'Another supported deploy, rollback or runtime operation holds the deploy lock.' >&2
    return 1
  fi
  export MAXIM_DEPLOY_LOCK_VERSION=flock-v1
  export MAXIM_DEPLOY_LOCK_OWNER_PID="$BASHPID"
  export MAXIM_DEPLOY_LOCK_IDENTITY="$identity"
  export MAXIM_DEPLOY_LOCK_FD
  if ! require_deploy_lock; then
    release_deploy_lock || true
    return 1
  fi
  trap release_deploy_lock EXIT
  if ! validate_market_statistics_deploy_admission; then
    release_deploy_lock || true
    return 1
  fi
}

release_deploy_lock() {
  if [[ -z "${MAXIM_DEPLOY_LOCK_VERSION:-}${MAXIM_DEPLOY_LOCK_OWNER_PID:-}${MAXIM_DEPLOY_LOCK_FD:-}${MAXIM_DEPLOY_LOCK_IDENTITY:-}" ]]; then
    return 0
  fi
  validate_deploy_lock_descriptor || return 1
  # Closing only this process's FD keeps inherited child work fenced. flock -u
  # would release the shared open description while that work is still alive.
  exec {MAXIM_DEPLOY_LOCK_FD}>&-
  unset MAXIM_DEPLOY_LOCK_VERSION MAXIM_DEPLOY_LOCK_OWNER_PID MAXIM_DEPLOY_LOCK_IDENTITY MAXIM_DEPLOY_LOCK_FD
}
