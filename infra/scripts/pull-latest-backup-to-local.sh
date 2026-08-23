#!/usr/bin/env bash
# Remote discovery is deliberately constructed as a quoted remote bash program.
# shellcheck disable=SC2016,SC2029
set -euo pipefail
umask 077
export LC_ALL=C

# Operator-side scheduler entry point. Discovery is read-only over SSH; the
# actual transfer and age verification remain owned by pull-backup-to-local.sh.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${MAXIM_VPS_ENV_FILE:-$ROOT_DIR/.env.vps}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

SSH_TARGET="${MAXIM_VPS_SSH_TARGET:-maxim-vps}"
KIND="${MAXIM_BACKUP_PULL_KIND:-postgres}"
REMOTE_DIR="${MAXIM_BACKUP_PULL_REMOTE_DIR:-}"
LOCAL_DIR="${MAXIM_BACKUP_PULL_LOCAL_DIR:-}"
PULL_SCRIPT="${MAXIM_BACKUP_PULL_SCRIPT:-$ROOT_DIR/infra/scripts/pull-backup-to-local.sh}"
RETENTION_DAYS="${MAXIM_BACKUP_LOCAL_RETENTION_DAYS:-14}"
KEEP_COUNT="${MAXIM_BACKUP_LOCAL_KEEP_COUNT:-2}"
REPAIR_PARTIAL="${MAXIM_BACKUP_PULL_REPAIR_PARTIAL:-0}"
DRY_RUN=0

AGE_RECIPIENT_FILE="${MAXIM_BACKUP_AGE_RECIPIENT_FILE:-}"
AGE_RECIPIENT="${MAXIM_BACKUP_AGE_RECIPIENT:-}"
AGE_IDENTITY_FILE="${MAXIM_BACKUP_AGE_IDENTITY_FILE:-}"

usage() {
  cat <<'USAGE'
Usage:
  ./infra/scripts/pull-latest-backup-to-local.sh [options]

Options:
  --kind postgres|karavan Select the MAXIM PostgreSQL or Karavan archive family
  --remote-dir DIR       VPS directory containing validated dump/checksum pairs
  --local-dir DIR        Encrypted operator-PC destination
  --retention-days N     Remove complete encrypted pairs older than N days (default: 14)
  --keep-count N         Always retain N newest complete encrypted pairs (default: 2)
  --ssh-target TARGET    Override MAXIM_VPS_SSH_TARGET
  --repair-partial       Permit --force when a same-name local pair is incomplete
  --dry-run              Discover and report, but do not pull or delete
  --help

Configuration may also be supplied through .env.vps or the environment:
  MAXIM_BACKUP_PULL_REMOTE_DIR=/mnt/maxim-cold/backups/maxim
  MAXIM_BACKUP_PULL_LOCAL_DIR=$HOME/backups/maxim-vps/postgres/encrypted
  (use the Karavan encrypted directory when --kind karavan)
  MAXIM_BACKUP_AGE_RECIPIENT_FILE=$HOME/.config/maxim-backup/recipients.txt
  MAXIM_BACKUP_AGE_IDENTITY_FILE=$HOME/.config/maxim-backup/age-key.txt
  MAXIM_BACKUP_LOCAL_RETENTION_DAYS=14
  MAXIM_BACKUP_LOCAL_KEEP_COUNT=2
  MAXIM_BACKUP_PULL_REPAIR_PARTIAL=0

The postgres family uses maxim_YYYYMMDDTHHMMSSZ.dump in
/mnt/maxim-cold/backups/maxim and the Karavan family uses
karavan-YYYYMMDDTHHMMSSZ.tar.gz in /mnt/maxim-cold/backups/karavan. When the
latest local ACK matches, discovery reads only a canonical checksum sidecar and
file metadata, so an unchanged copy does not force another multi-gigabyte VPS
read. A new or changed candidate receives full sidecar/content verification and
the pull helper's pre/post transfer checks before publication. No plaintext
archive is created or removed by this helper.
USAGE
}

shell_quote() {
  local quoted
  printf -v quoted '%q' "$1"
  printf '%s' "$quoted"
}

die_usage() {
  echo "$1" >&2
  usage >&2
  exit 2
}

expand_path() {
  local value="$1"
  case "$value" in
    "~") printf '%s' "$HOME" ;;
    \~/*) printf '%s/%s' "$HOME" "${value#\~/}" ;;
    *) printf '%s' "$value" ;;
  esac
}

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$path" | awk '{print $1}'
  else
    echo 'sha256sum or shasum is required.' >&2
    return 1
  fi
}

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    echo 'sha256sum or shasum is required.' >&2
    return 1
  fi
}

validate_private_identity() {
  [[ -n "$AGE_IDENTITY_FILE" ]] || die_usage 'An age identity file is required; plaintext verification is disabled.'
  AGE_IDENTITY_FILE="$(expand_path "$AGE_IDENTITY_FILE")"
  [[ -f "$AGE_IDENTITY_FILE" && -r "$AGE_IDENTITY_FILE" ]] || {
    echo "Age identity file is not readable: $AGE_IDENTITY_FILE" >&2
    exit 1
  }
  [[ ! -L "$AGE_IDENTITY_FILE" ]] || {
    echo "Age identity file must not be a symlink: $AGE_IDENTITY_FILE" >&2
    exit 1
  }
  local mode
  mode="$(stat -c '%a' "$AGE_IDENTITY_FILE" 2>/dev/null || stat -f '%Lp' "$AGE_IDENTITY_FILE" 2>/dev/null || true)"
  if [[ ! "$mode" =~ ^[0-7]+$ ]] || ((8#$mode & 077)); then
    echo "Age identity file must not be group/world-readable: $AGE_IDENTITY_FILE" >&2
    exit 1
  fi
}

validate_recipient() {
  if [[ -n "$AGE_RECIPIENT_FILE" && -n "$AGE_RECIPIENT" ]]; then
    die_usage 'Choose one of MAXIM_BACKUP_AGE_RECIPIENT_FILE or MAXIM_BACKUP_AGE_RECIPIENT.'
  fi
  if [[ -n "$AGE_RECIPIENT_FILE" ]]; then
    AGE_RECIPIENT_FILE="$(expand_path "$AGE_RECIPIENT_FILE")"
    [[ -f "$AGE_RECIPIENT_FILE" && -r "$AGE_RECIPIENT_FILE" ]] || {
      echo "Age recipient file is not readable: $AGE_RECIPIENT_FILE" >&2
      exit 1
    }
    [[ ! -L "$AGE_RECIPIENT_FILE" ]] || {
      echo "Age recipient file must not be a symlink: $AGE_RECIPIENT_FILE" >&2
      exit 1
    }
    return 0
  fi
  [[ -n "$AGE_RECIPIENT" ]] || die_usage 'An age recipient is required; plaintext copies are unsupported.'
  [[ "$AGE_RECIPIENT" != *$'\n'* && "$AGE_RECIPIENT" != *$'\r'* ]] || {
    echo 'Age recipient contains a line break.' >&2
    exit 2
  }
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind)
      [[ $# -ge 2 ]] || die_usage '--kind requires postgres or karavan.'
      KIND="$2"
      shift 2
      ;;
    --remote-dir)
      [[ $# -ge 2 ]] || die_usage '--remote-dir requires a value.'
      REMOTE_DIR="$2"
      shift 2
      ;;
    --local-dir)
      [[ $# -ge 2 ]] || die_usage '--local-dir requires a value.'
      LOCAL_DIR="$2"
      shift 2
      ;;
    --retention-days)
      [[ $# -ge 2 ]] || die_usage '--retention-days requires a value.'
      RETENTION_DAYS="$2"
      shift 2
      ;;
    --keep-count)
      [[ $# -ge 2 ]] || die_usage '--keep-count requires a value.'
      KEEP_COUNT="$2"
      shift 2
      ;;
    --ssh-target)
      [[ $# -ge 2 ]] || die_usage '--ssh-target requires a value.'
      SSH_TARGET="$2"
      shift 2
      ;;
    --repair-partial)
      REPAIR_PARTIAL=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die_usage "Unknown argument: $1"
      ;;
  esac
done

case "$KIND" in
  postgres)
    [[ -n "$REMOTE_DIR" ]] || REMOTE_DIR="${MAXIM_POSTGRES_BACKUP_PULL_REMOTE_DIR:-/mnt/maxim-cold/backups/maxim}"
    [[ -n "$LOCAL_DIR" ]] || LOCAL_DIR="$HOME/backups/maxim-vps/postgres/encrypted"
    REMOTE_GLOB='maxim_*.dump'
    NAME_REGEX='^maxim_[0-9]{8}T[0-9]{6}Z\.dump$'
    AGE_REGEX='^maxim_[0-9]{8}T[0-9]{6}Z\.dump\.age$'
    ;;
  karavan)
    [[ -n "$REMOTE_DIR" ]] || REMOTE_DIR="${MAXIM_KARAVAN_BACKUP_PULL_REMOTE_DIR:-/mnt/maxim-cold/backups/karavan}"
    [[ -n "$LOCAL_DIR" ]] || LOCAL_DIR="$HOME/backups/maxim-vps/karavan/encrypted"
    REMOTE_GLOB='karavan-*.tar.gz'
    NAME_REGEX='^karavan-[0-9]{8}T[0-9]{6}Z\.tar\.gz$'
    AGE_REGEX='^karavan-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age$'
    ;;
  *)
    die_usage "Unsupported backup kind: $KIND (expected postgres or karavan)."
    ;;
esac

REMOTE_DIR="${REMOTE_DIR%/}"
[[ -n "$REMOTE_DIR" ]] || die_usage 'A remote backup directory is required.'
[[ "$REMOTE_DIR" == /* && "$REMOTE_DIR" != "/" ]] || die_usage 'The remote backup directory must be an absolute non-root path.'
[[ "$REMOTE_DIR" != *$'\n'* && "$REMOTE_DIR" != *$'\r'* && "$REMOTE_DIR" != *$'\t'* ]] || die_usage 'The remote backup directory contains a control character.'
[[ -n "$LOCAL_DIR" ]] || die_usage 'A local destination directory is required.'
[[ "$SSH_TARGET" != *$'\n'* && "$SSH_TARGET" != *$'\r'* && -n "$SSH_TARGET" ]] || die_usage 'SSH target is invalid.'
[[ "$RETENTION_DAYS" =~ ^[0-9]{1,5}$ ]] || die_usage 'Retention days must be a non-negative integer up to 99999.'
[[ "$KEEP_COUNT" =~ ^[1-9][0-9]{0,3}$ ]] || die_usage 'Keep count must be a positive integer up to 9999.'
[[ "$REPAIR_PARTIAL" == 0 || "$REPAIR_PARTIAL" == 1 ]] || die_usage 'MAXIM_BACKUP_PULL_REPAIR_PARTIAL must be 0 or 1.'

validate_recipient
validate_private_identity

[[ -f "$PULL_SCRIPT" && ! -L "$PULL_SCRIPT" ]] || {
  echo "Tracked encrypted pull helper is missing or is a symlink: $PULL_SCRIPT" >&2
  exit 1
}
command -v ssh >/dev/null 2>&1 || { echo 'ssh is required.' >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo 'flock is required for scheduler overlap protection.' >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || {
  echo 'sha256sum or shasum is required.' >&2
  exit 1
}

mkdir -p -- "$LOCAL_DIR"
LOCAL_DIR="$(cd "$LOCAL_DIR" && pwd -P)"
LOCK_FILE="$LOCAL_DIR/.maxim-latest-backup.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another local backup pull is already running: $LOCK_FILE" >&2
  exit 0
fi

ssh_args=(-o ServerAliveInterval=15 -o ServerAliveCountMax=3)
if [[ -n "${MAXIM_VPS_SSH_PORT:-}" ]]; then
  ssh_args+=(-p "$MAXIM_VPS_SSH_PORT")
fi
if [[ -n "${MAXIM_VPS_SSH_KEY:-}" ]]; then
  ssh_args+=(-i "$(expand_path "$MAXIM_VPS_SSH_KEY")")
fi
if [[ -n "${MAXIM_VPS_SSH_CONFIG:-}" ]]; then
  ssh_args+=(-F "$(expand_path "$MAXIM_VPS_SSH_CONFIG")")
fi
if [[ -n "${MAXIM_VPS_SSH_EXTRA_ARGS:-}" ]]; then
  extra_args=()
  read -r -a extra_args <<<"$MAXIM_VPS_SSH_EXTRA_ARGS"
  ssh_args+=("${extra_args[@]}")
fi
ssh_args+=(-T)

# A previously verified local ACK is only an optimization hint. The remote
# probe still performs a full sidecar/content check unless name, size, SHA, and
# publication metadata identify the same archive.
ACK_HINT_BASENAME=''
ACK_HINT_SIZE=''
ACK_HINT_SHA256=''
shopt -s nullglob
for hint_ack in "$LOCAL_DIR"/*.age.ack; do
  [[ -f "$hint_ack" && ! -L "$hint_ack" ]] || continue
  hint_basename="$(awk -F= '$1 == "source_basename" { print substr($0, index($0, "=") + 1); exit }' "$hint_ack")"
  hint_size="$(awk -F= '$1 == "source_size_bytes" { print substr($0, index($0, "=") + 1); exit }' "$hint_ack")"
  hint_sha256="$(awk -F= '$1 == "source_sha256" { print substr($0, index($0, "=") + 1); exit }' "$hint_ack")"
  if [[ "$hint_basename" =~ $NAME_REGEX && "$hint_size" =~ ^[1-9][0-9]{0,14}$ &&
    "$hint_sha256" =~ ^[0-9a-fA-F]{64} ]]; then
    if [[ -z "$ACK_HINT_BASENAME" || "$hint_basename" > "$ACK_HINT_BASENAME" ]]; then
      ACK_HINT_BASENAME="$hint_basename"
      ACK_HINT_SIZE="$hint_size"
      ACK_HINT_SHA256="${hint_sha256,,}"
    fi
  fi
done
shopt -u nullglob

# Only the timestamped names emitted by the selected producer are eligible.
remote_glob_q="$(shell_quote "$REMOTE_GLOB")"
name_regex_q="$(shell_quote "$NAME_REGEX")"
ack_hint_basename_q="$(shell_quote "$ACK_HINT_BASENAME")"
ack_hint_size_q="$(shell_quote "$ACK_HINT_SIZE")"
ack_hint_sha256_q="$(shell_quote "$ACK_HINT_SHA256")"
remote_discovery_command_with_hint='set -eu; export LC_ALL=C;'
remote_discovery_command_with_hint+=" backup_dir=$(shell_quote "$REMOTE_DIR"); name_glob=$remote_glob_q; name_regex=$name_regex_q; ack_hint_basename=$ack_hint_basename_q; ack_hint_size=$ack_hint_size_q; ack_hint_sha256=$ack_hint_sha256_q;"
remote_discovery_command_with_hint+=' test -d "$backup_dir"; test ! -L "$backup_dir"; mapfile -t candidates < <(printf "%s\\n" "$backup_dir"/$name_glob | LC_ALL=C sort -r);'
remote_discovery_command_with_hint+=' for candidate in "${candidates[@]}"; do [[ -f "$candidate" && ! -L "$candidate" && -s "$candidate" ]] || continue; name="${candidate##*/}"; [[ "$name" =~ $name_regex ]] || continue; sidecar="$candidate.sha256"; [[ -f "$sidecar" && ! -L "$sidecar" ]] || continue;'
remote_discovery_command_with_hint+=' sidecar_line=$(cat -- "$sidecar"); [[ ${#sidecar_line} -le 4096 ]] || continue; read -r sidecar_sha sidecar_name sidecar_extra <<<"$sidecar_line"; [[ "$sidecar_sha" =~ ^[0-9a-fA-F]{64}$ && "$sidecar_name" == "$name" && -z "$sidecar_extra" ]] || continue;'
remote_discovery_command_with_hint+=' metadata=$(stat -c "%s %Y %i" -- "$candidate") || continue; read -r bytes file_mtime file_inode <<<"$metadata"; sidecar_mtime=$(stat -c "%Y" -- "$sidecar") || continue; [[ "$bytes" =~ ^[1-9][0-9]{0,14}$ && "$file_mtime" =~ ^[0-9]+$ && "$file_inode" =~ ^[0-9]+$ && "$sidecar_mtime" =~ ^[0-9]+$ ]] || continue; (( file_mtime <= sidecar_mtime )) || continue;'
remote_discovery_command_with_hint+=' if [[ "$name" == "$ack_hint_basename" && "$bytes" == "$ack_hint_size" && "${sidecar_sha,,}" == "$ack_hint_sha256" ]]; then printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$name" "$bytes" "${sidecar_sha,,}" "$file_mtime" "$sidecar_mtime"; break; fi;'
remote_discovery_command_with_hint+=' (cd "$backup_dir" && sha256sum --check --status -- "$name.sha256") || continue; printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$name" "$bytes" "${sidecar_sha,,}" "$file_mtime" "$sidecar_mtime"; break; done'
discovery_output="$(ssh "${ssh_args[@]}" "$SSH_TARGET" "bash -c $(shell_quote "$remote_discovery_command_with_hint")")"
IFS=$'\t' read -r remote_basename remote_size remote_sha256 remote_mtime remote_sidecar_mtime _ <<<"$discovery_output"
[[ "$remote_basename" =~ $NAME_REGEX ]] || {
  echo "No checksum-backed $KIND backup was found in $REMOTE_DIR." >&2
  exit 2
}
[[ "$remote_size" =~ ^[1-9][0-9]{0,14}$ && "$remote_sha256" =~ ^[0-9a-fA-F]{64}$ ]] || {
  echo 'Remote discovery returned invalid size or SHA-256.' >&2
  exit 1
}
[[ "$remote_mtime" =~ ^[0-9]+$ && "$remote_sidecar_mtime" =~ ^[0-9]+$ ]] || {
  echo 'Remote discovery returned invalid metadata.' >&2
  exit 1
}
remote_sha256="${remote_sha256,,}"
remote_path="$REMOTE_DIR/$remote_basename"

target_path="$LOCAL_DIR/${remote_basename}.age"
checksum_path="$target_path.sha256"
ack_path="$target_path.ack"
for existing_path in "$target_path" "$checksum_path" "$ack_path"; do
  if [[ -L "$existing_path" ]]; then
    echo "Destination path must not be a symlink: $existing_path" >&2
    exit 1
  fi
  if [[ -e "$existing_path" && ! -f "$existing_path" ]]; then
    echo "Destination path is not a regular file: $existing_path" >&2
    exit 1
  fi
done

if [[ -n "$AGE_RECIPIENT_FILE" ]]; then
  recipient_fingerprint="$(sha256_file "$AGE_RECIPIENT_FILE")"
else
  recipient_fingerprint="$(printf '%s' "$AGE_RECIPIENT" | sha256_stream)"
fi

declare -A ACK=()
read_ack() {
  local path="$1"
  local key='' value='' extra=''
  ACK=()
  while IFS='=' read -r key value extra || [[ -n "$key$value$extra" ]]; do
    [[ -n "$key" && -z "$extra" && "$key" =~ ^[a-z0-9_]+$ ]] || return 1
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || return 1
    [[ -z "${ACK[$key]+present}" ]] || return 1
    ACK["$key"]="$value"
  done <"$path"
  [[ "${ACK[version]:-}" == 1 ]] || return 1
  [[ "${ACK[status]:-}" == verified-encrypted ]] || return 1
  [[ "${ACK[source_basename]:-}" == "$remote_basename" ]] || return 1
  [[ "${ACK[source_size_bytes]:-}" == "$remote_size" ]] || return 1
  [[ "${ACK[source_sha256]:-}" == "$remote_sha256" ]] || return 1
  [[ "${ACK[encrypted_basename]:-}" == "${remote_basename}.age" ]] || return 1
  [[ "${ACK[encrypted_sha256]:-}" =~ ^[0-9a-fA-F]{64}$ ]] || return 1
  [[ "${ACK[age_recipient_file_sha256]:-}" == "$recipient_fingerprint" ]] || return 1
  [[ "${ACK[copied_at_utc]:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
}

local_ack_valid=0
if [[ -f "$target_path" && ! -L "$target_path" && -s "$target_path" &&
  -f "$checksum_path" && ! -L "$checksum_path" &&
  -f "$ack_path" && ! -L "$ack_path" ]]; then
  checksum_line="$(cat -- "$checksum_path")"
  read -r encrypted_expected encrypted_name encrypted_extra <<<"$checksum_line"
  if [[ "$encrypted_expected" =~ ^[0-9a-fA-F]{64}$ &&
    "$encrypted_name" == "$(basename "$target_path")" && -z "$encrypted_extra" ]] &&
    (cd "$LOCAL_DIR" && sha256sum --check --status -- "$(basename "$checksum_path")") &&
    read_ack "$ack_path" &&
    [[ "${encrypted_expected,,}" == "${ACK[encrypted_sha256],,}" ]]; then
    local_ack_valid=1
  fi
fi

if [[ "$local_ack_valid" == 1 ]]; then
  echo "Already ACKed encrypted backup: $target_path"
else
  partial=0
  for existing_path in "$target_path" "$checksum_path" "$ack_path"; do
    [[ -e "$existing_path" ]] && partial=1
  done
  if [[ "$partial" == 1 && "$REPAIR_PARTIAL" != 1 ]]; then
    echo "A local archive exists but its ACK/checksum does not match $remote_basename." >&2
    echo "Review it, then rerun with --repair-partial to allow the encrypted helper's --force." >&2
    exit 1
  fi

  if [[ "$DRY_RUN" == 1 ]]; then
    # Discovery fully verified this candidate unless a matching ACK hint selected
    # the already verified local copy, so no second multi-gigabyte read is needed.
    echo "Would pull and encrypt: $remote_path -> $target_path"
  else
    pull_args=(
      --remote-path "$remote_path"
      --local-dir "$LOCAL_DIR"
      --age-identity-file "$AGE_IDENTITY_FILE"
      --require-sidecar
    )
    if [[ -n "$AGE_RECIPIENT_FILE" ]]; then
      pull_args+=(--age-recipient-file "$AGE_RECIPIENT_FILE")
    else
      pull_args+=(--age-recipient "$AGE_RECIPIENT")
    fi
    if [[ "$REPAIR_PARTIAL" == 1 ]]; then
      pull_args+=(--force)
    fi
    echo "Pulling latest checksum-backed backup: $remote_path"
    bash "$PULL_SCRIPT" "${pull_args[@]}"
  fi
fi

retention_now="$(date +%s)"
retention_cutoff=$((retention_now - 10#$RETENTION_DAYS * 86400))
retention_kept=0
retention_candidates=()
shopt -s nullglob
for age_path in "$LOCAL_DIR"/*.age; do
  [[ -f "$age_path" && ! -L "$age_path" ]] || continue
  age_name="$(basename "$age_path")"
  [[ "$age_name" =~ $AGE_REGEX ]] || continue
  age_mtime="$(stat -c '%Y' "$age_path" 2>/dev/null || stat -f '%m' "$age_path" 2>/dev/null || true)"
  [[ "$age_mtime" =~ ^[0-9]+$ ]] || continue
  retention_candidates+=("$age_mtime"$'\t'"$age_name")
done
shopt -u nullglob

if ((${#retention_candidates[@]} > 0)); then
  while IFS=$'\t' read -r age_mtime age_name; do
    [[ -n "$age_name" ]] || continue
    age_path="$LOCAL_DIR/$age_name"
    pair_checksum="$age_path.sha256"
    pair_ack="$age_path.ack"
    pair_complete=0
    if [[ -f "$pair_checksum" && ! -L "$pair_checksum" &&
      -f "$pair_ack" && ! -L "$pair_ack" ]]; then
      if (cd "$LOCAL_DIR" && sha256sum --check --status -- "$(basename "$pair_checksum")") &&
        [[ "$(grep -Fc 'status=verified-encrypted' "$pair_ack" 2>/dev/null || true)" == 1 ]]; then
        pair_complete=1
      fi
    fi
    [[ "$pair_complete" == 1 ]] || continue
    if ((retention_kept < KEEP_COUNT)); then
      retention_kept=$((retention_kept + 1))
      continue
    fi
    ((age_mtime < retention_cutoff)) || continue
    if [[ "$DRY_RUN" == 1 ]]; then
      echo "Would remove expired encrypted backup pair: $age_name"
    else
      rm -f -- "$age_path" "$pair_checksum" "$pair_ack"
      echo "Removed expired encrypted backup pair: $age_name"
    fi
  done < <(printf '%s\n' "${retention_candidates[@]}" | LC_ALL=C sort -rn)
fi
