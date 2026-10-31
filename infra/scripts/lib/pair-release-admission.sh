#!/usr/bin/env bash

# FLAG: major-karavan-release-v1 is a host admission protocol, never a product-lock bypass.
# The fixed inode is never unlinked or explicitly unlocked; child work keeps its inherited fence.
pair_release_admission_directory() { printf '%s\n' /var/lib/major-karavan-release; }
pair_release_admission_root_uid() { printf '%s\n' 0; }

_pair_release_error() { printf '[pair-release-admission] %s\n' "$*" >&2; }

_pair_release_sync() {
  node -e 'const fs = require("node:fs"); for (const path of process.argv.slice(1)) { const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }' "$@"
}

_pair_release_value() {
  local key="$1" file="$2"
  awk -F= -v key="$key" '$1 == key { count++; value=substr($0,index($0,"=")+1) } END { if(count!=1) exit 1; print value }' "$file"
}

_pair_release_process() {
  local pid="$1" raw rest cwd boot
  local -a fields
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 70
  IFS= read -r raw <"/proc/$pid/stat" || return 70
  rest="${raw##*) }"
  read -r -a fields <<<"$rest"
  [[ "${fields[0]:-}" != Z && "${fields[19]:-}" =~ ^[0-9]+$ ]] || return 70
  cwd="$(readlink -e "/proc/$pid/cwd")" || return 70
  IFS= read -r boot </proc/sys/kernel/random/boot_id || return 70
  printf '%s %s %s\n' "${fields[19]}" "$boot" "$(printf '%s' "$cwd" | sha256sum | cut -d' ' -f1)"
}

_pair_release_paths() {
  local directory state item owner mode links expected_owner root_uid
  directory="$(pair_release_admission_directory)"
  state="$directory/state"
  root_uid="$(pair_release_admission_root_uid)"
  for item in /var /var/lib "$directory" "$state"; do
    [[ -d "$item" && ! -L "$item" ]] || { _pair_release_error 'protected admission directory is not installed'; return 70; }
    read -r owner mode < <(stat -c '%u %a' -- "$item") || return 70
    [[ "$owner" =~ ^[0-9]+$ && "$mode" =~ ^[0-7]{3,4}$ ]] || return 70
    (( (8#$mode & 0022) == 0 )) || return 70
    if [[ "$item" == "$state" ]]; then
      [[ "$owner" == "$EUID" || "$EUID" == 0 ]] && [[ "$mode" == 700 ]] || return 70
    elif [[ "$item" == "$directory" ]]; then
      [[ "$owner" == "$root_uid" ]] || return 70
    fi
  done
  expected_owner="$(stat -c '%u' -- "$state")" || return 70
  for item in "$directory/protocol-v1" "$directory/admission.sh" "$directory/state.mjs" "$state/admission.lock"; do
    [[ -f "$item" && ! -L "$item" ]] || { _pair_release_error 'protected admission files are not installed'; return 70; }
    read -r owner mode links < <(stat -c '%u %a %h' -- "$item") || return 70
    [[ "$links" == 1 ]] || return 70
    if [[ "$item" == "$state/admission.lock" ]]; then
      [[ "$owner" == "$expected_owner" && "$mode" == 600 ]] || return 70
    else
      [[ "$owner" == "$root_uid" && "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 0022) == 0 )) || return 70
    fi
  done
  [[ "$(cat "$directory/protocol-v1")" == major-karavan-release-v1 ]] || return 70
}

pair_release_admission_state() {
  _pair_release_paths || return 70
  timeout --signal=TERM --kill-after=2 10 node "$(pair_release_admission_directory)/state.mjs" "$@"
}

pair_release_admission_assert() {
  local token="${1:-${PAIR_RELEASE_ADMISSION_TOKEN:-}}" directory owner_file pid start boot cwd fd identity observed before after
  [[ "$token" =~ ^[A-Za-z0-9._:-]{16,128}$ ]] || return 70
  _pair_release_paths || return 70
  directory="$(pair_release_admission_directory)"
  owner_file="$directory/state/admission.owner"
  [[ -f "$owner_file" && ! -L "$owner_file" ]] || return 70
  [[ "$(stat -c '%u:%a:%h' -- "$owner_file")" == "$(stat -c '%u' -- "$directory/state"):600:1" ]] || return 70
  before="$(sha256sum "$owner_file")" || return 70
  [[ "$(_pair_release_value token "$owner_file")" == "$token" && "$(_pair_release_value protocol "$owner_file")" == major-karavan-release-v1 ]] || return 70
  [[ "$(_pair_release_value mode "$owner_file")" != bootstrap ]] || { _pair_release_error 'source bootstrap is incomplete'; return 70; }
  pid="$(_pair_release_value pid "$owner_file")" || return 70
  fd="$(_pair_release_value fd "$owner_file")" || return 70
  identity="$(_pair_release_value inode "$owner_file")" || return 70
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$fd" =~ ^[1-9][0-9]{1,5}$ && "$identity" =~ ^[0-9]+:[0-9]+$ ]] || return 70
  read -r start boot cwd < <(_pair_release_process "$pid") || return 70
  [[ "$start" == "$(_pair_release_value start "$owner_file")" && "$boot" == "$(_pair_release_value boot "$owner_file")" && "$cwd" == "$(_pair_release_value cwd "$owner_file")" ]] || return 70
  observed="$(stat -c '%d:%i' -- "$directory/state/admission.lock")" || return 70
  [[ "$identity" == "$observed" && "$(stat -Lc '%d:%i' -- "/proc/$pid/fd/$fd")" == "$identity" ]] || return 70
  grep -Eq '^lock:[[:space:]]+[0-9]+:[[:space:]]+FLOCK[[:space:]]+ADVISORY[[:space:]]+WRITE[[:space:]]+[0-9]+[[:space:]]+[^[:space:]]+[[:space:]]+0[[:space:]]+EOF$' "/proc/$pid/fdinfo/$fd" || return 70
  if [[ -n "${PAIR_RELEASE_EXPECTED_STATE_SHA256:-}" ]]; then
    [[ "$PAIR_RELEASE_EXPECTED_STATE_SHA256" =~ ^[a-f0-9]{64}$ && "$(_pair_release_value initial_state "$owner_file")" == "$PAIR_RELEASE_EXPECTED_STATE_SHA256" ]] || return 70
  fi
  after="$(sha256sum "$owner_file")" || return 70
  [[ "$before" == "$after" ]] || return 70
}

pair_release_admission_acquire() {
  local product="$1" token="${2:-${PAIR_RELEASE_ADMISSION_TOKEN:-}}" directory owner_file original current initial temporary start boot cwd
  local operation_mode="${3:-runtime}" target="${4:-${MAXIM_EXPECTED_DEPLOY_SHA:-}}"
  local owner_pid="$BASHPID"
  [[ "$product" == major || "$product" == karavan ]] || return 70
  [[ "$operation_mode" == runtime || "$operation_mode" == tooling ]] && [[ -z "$target" || "$target" =~ ^[a-f0-9]{40}$ ]] || return 70
  _pair_release_paths || return 70
  directory="$(pair_release_admission_directory)"
  owner_file="$directory/state/admission.owner"
  if [[ -n "${PAIR_RELEASE_ADMISSION_TOKEN:-}" ]]; then
    [[ "$token" == "$PAIR_RELEASE_ADMISSION_TOKEN" ]] && pair_release_admission_assert "$token" || return 70
    return 0
  fi
  if [[ -n "$token" && -f "$owner_file" && ! -L "$owner_file" && "$(_pair_release_value token "$owner_file" 2>/dev/null)" == "$token" ]]; then
    pair_release_admission_assert "$token" || return 70
    export PAIR_RELEASE_ADMISSION_TOKEN="$token"
    return 0
  fi
  [[ -z "$token" || "$token" =~ ^[A-Za-z0-9._:-]{16,128}$ ]] || return 70
  original="$(stat -c '%d:%i' -- "$directory/state/admission.lock")" || return 70
  exec {PAIR_RELEASE_ADMISSION_FD}<>"$directory/state/admission.lock" || return 70
  if ! flock -n "$PAIR_RELEASE_ADMISSION_FD"; then
    exec {PAIR_RELEASE_ADMISSION_FD}>&-
    unset PAIR_RELEASE_ADMISSION_FD
    _pair_release_error 'another Major or Karavan operation holds admission'
    return 75
  fi
  current="$(stat -c '%d:%i' -- "$directory/state/admission.lock")" || return 70
  [[ "$original" == "$current" ]] || return 70
  # FLAG: A freed kernel lock does not prove that an interrupted independent SSH action ended.
  # Preserve uncertain owner evidence; only the bounded evidence reconciliation may archive it.
  if [[ -e "$owner_file" || -L "$owner_file" ]]; then
    exec {PAIR_RELEASE_ADMISSION_FD}>&-; unset PAIR_RELEASE_ADMISSION_FD
    _pair_release_error 'previous admission owner is unresolved; reconcile its outcome before publication'
    return 70
  fi
  if ! initial="$(pair_release_admission_state --fingerprint)" || ! [[ "$initial" =~ ^[a-f0-9]{64}$ ]]; then
    exec {PAIR_RELEASE_ADMISSION_FD}>&-; unset PAIR_RELEASE_ADMISSION_FD; return 70
  fi
  if [[ -n "${PAIR_RELEASE_EXPECTED_STATE_SHA256:-}" && "$PAIR_RELEASE_EXPECTED_STATE_SHA256" != "$initial" ]]; then
    exec {PAIR_RELEASE_ADMISSION_FD}>&-; unset PAIR_RELEASE_ADMISSION_FD
    _pair_release_error 'pair state changed after planning; publication refused'
    return 70
  fi
  if [[ -z "$token" ]]; then IFS= read -r token </proc/sys/kernel/random/uuid; fi
  read -r start boot cwd < <(_pair_release_process "$owner_pid") || return 70
  temporary="$owner_file.$owner_pid.$RANDOM.tmp"
  (umask 077; set -o noclobber; printf 'protocol=major-karavan-release-v1\ntoken=%s\nproduct=%s\nmode=%s\ntarget=%s\npid=%s\nstart=%s\nboot=%s\ncwd=%s\nfd=%s\ninode=%s\ninitial_state=%s\nstarted_at=%s\n' "$token" "$product" "$operation_mode" "$target" "$owner_pid" "$start" "$boot" "$cwd" "$PAIR_RELEASE_ADMISSION_FD" "$original" "$initial" "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" >"$temporary") || return 70
  # FLAG: Root maintenance shares the operator's admission. Publish the same owner
  # identity required by assert; a root-owned record would strand the fence before work.
  if [[ "$EUID" == 0 ]]; then
    chown --no-dereference --reference="$directory/state" -- "$temporary" || return 70
  fi
  [[ -f "$temporary" && ! -L "$temporary" && "$(stat -c '%u:%a:%h' -- "$temporary")" == "$(stat -c '%u' -- "$directory/state"):600:1" ]] || return 70
  _pair_release_sync "$temporary" || return 70
  mv -T -- "$temporary" "$owner_file" || return 70
  _pair_release_sync "$directory/state" || return 70
  export PAIR_RELEASE_ADMISSION_TOKEN="$token" PAIR_RELEASE_ADMISSION_OWNER_PID="$owner_pid" PAIR_RELEASE_ADMISSION_FD
  pair_release_admission_assert "$token"
}

pair_release_admission_release() {
  [[ "${PAIR_RELEASE_ADMISSION_OWNER_PID:-}" == "$BASHPID" ]] || return 0
  pair_release_admission_assert || return 70
  rm -- "$(pair_release_admission_directory)/state/admission.owner" || return 70
  _pair_release_sync "$(pair_release_admission_directory)/state" || return 70
  exec {PAIR_RELEASE_ADMISSION_FD}>&-
  unset PAIR_RELEASE_ADMISSION_FD PAIR_RELEASE_ADMISSION_TOKEN PAIR_RELEASE_ADMISSION_OWNER_PID
}

pair_release_admission_candidate() {
  local target="$1" helper="$2" source
  _pair_release_paths || return 70
  source="$(git show "${target}:${helper}")" || return 70
  grep -Fq 'major-karavan-release-v1' <<<"$source" && grep -Eq '^pair_release_admission_acquire\(\)' <<<"$source" && grep -Eq '^pair_release_admission_assert\(\)' <<<"$source"
}

pair_release_admission_reconcile() (
  set -euo pipefail
  [[ "$#" == 5 || "$#" == 6 ]] || exit 2
  _pair_release_paths || exit 70
  local directory item owner mode links proof archive
  directory="$(pair_release_admission_directory)"
  exec {PAIR_RELEASE_RECONCILE_FD}<>"$directory/state/admission.lock"
  flock -n "$PAIR_RELEASE_RECONCILE_FD" || exit 75
  for item in /var/lib/maxim-deploy/deploy.lock /var/www/max-delivery-platform/var/ops/karavan-production-operation.lock; do
    [[ -f "$item" && ! -L "$item" ]] || exit 70
    read -r owner mode links < <(stat -c '%u %a %h' "$item")
    [[ "$owner" == "$EUID" && "$links" == 1 && "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 0022) == 0 )) || exit 70
  done
  exec {PAIR_RELEASE_RECONCILE_MAJOR_FD}<>/var/lib/maxim-deploy/deploy.lock
  flock -n "$PAIR_RELEASE_RECONCILE_MAJOR_FD" || exit 75
  exec {PAIR_RELEASE_RECONCILE_KARAVAN_FD}<>/var/www/max-delivery-platform/var/ops/karavan-production-operation.lock
  flock -n "$PAIR_RELEASE_RECONCILE_KARAVAN_FD" || exit 75
  proof="$(timeout --signal=TERM --kill-after=2 10 node "$directory/state.mjs" --reconcile-proof "$@")" || exit 70
  [[ "$1" =~ ^[a-f0-9]{64}$ && "$(sha256sum "$directory/state/admission.owner" | cut -d' ' -f1)" == "$1" ]] || exit 70
  archive="$directory/state/reconciled"
  if [[ ! -e "$archive" && ! -L "$archive" ]]; then (umask 077; mkdir "$archive"); fi
  [[ -d "$archive" && ! -L "$archive" && "$(stat -c '%u:%a' "$archive")" == "$EUID:700" && ! -e "$archive/$1.owner" && ! -L "$archive/$1.owner" ]] || exit 70
  (umask 077; set -o noclobber; printf '%s\n' "$proof" >"$archive/$1.proof.json")
  _pair_release_sync "$archive/$1.proof.json" "$archive"
  mv -T -- "$directory/state/admission.owner" "$archive/$1.owner"
  _pair_release_sync "$archive/$1.owner" "$archive" "$directory/state"
  printf '%s\n' "$proof"
)

if [[ "${BASH_SOURCE[0]:-}" == "$0" ]]; then
  case "${1:-}" in
    state) [[ "$#" == 1 ]] && pair_release_admission_state ;;
    verify)
      [[ "$#" == 1 ]] && _pair_release_paths || exit 70
      if [[ -f "$(pair_release_admission_directory)/state/admission.owner" && "$(_pair_release_value mode "$(pair_release_admission_directory)/state/admission.owner")" == bootstrap ]]; then
        _pair_release_error 'source bootstrap is incomplete'; exit 70
      fi
      ;;
    reconcile) shift; pair_release_admission_reconcile "$@" ;;
    *) _pair_release_error 'usage: pair-release-admission.sh state|verify|reconcile'; exit 2 ;;
  esac
fi
