#!/usr/bin/env bash
# Remote commands are assembled as quoted strings and evaluated by the remote
# bash explicitly; these ShellCheck diagnostics are intentional at those seams.
# shellcheck disable=SC2016,SC2029
set -euo pipefail
umask 077
export LC_ALL=C

# Operator-side helper. It deliberately has no VPS-side mutation or Docker/Compose
# dependency: the remote artifact must already be complete before it is pulled.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${MAXIM_VPS_ENV_FILE:-$ROOT_DIR/.env.vps}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

SSH_TARGET="${MAXIM_VPS_SSH_TARGET:-maxim-vps}"
LOCAL_DIR=""
REMOTE_PATH=""
AGE_RECIPIENT_FILE="${MAXIM_BACKUP_AGE_RECIPIENT_FILE:-}"
AGE_RECIPIENT="${MAXIM_BACKUP_AGE_RECIPIENT:-}"
AGE_IDENTITY_FILE="${MAXIM_BACKUP_AGE_IDENTITY_FILE:-}"
MAX_BYTES="${MAXIM_BACKUP_PULL_MAX_BYTES:-107374182400}"
MIN_FREE_BYTES="${MAXIM_BACKUP_PULL_MIN_FREE_BYTES:-1073741824}"
REQUIRE_SIDECAR=0
FORCE=0

usage() {
  cat <<'USAGE'
Usage:
  ./infra/scripts/pull-backup-to-local.sh \
    --remote-path /absolute/path/to/backup \
    --local-dir /path/on/operator-pc \
    --age-recipient-file /path/to/age-recipients.txt \
    --age-identity-file /path/to/age-identity.txt \
    [--require-sidecar] [--max-bytes BYTES] [--min-free-bytes BYTES] [--force]

Required values may also be provided through:
  MAXIM_BACKUP_PULL_REMOTE_PATH
  MAXIM_BACKUP_PULL_LOCAL_DIR
  MAXIM_BACKUP_AGE_RECIPIENT_FILE (preferred) or MAXIM_BACKUP_AGE_RECIPIENT
  MAXIM_BACKUP_AGE_IDENTITY_FILE (private key stays on this PC)
  MAXIM_BACKUP_PULL_MAX_BYTES (default: 107374182400)
  MAXIM_BACKUP_PULL_MIN_FREE_BYTES (default: 1073741824)

Set max-bytes to 0 only after reviewing the source size and local capacity.

SSH settings are read from .env.vps using the same names as vps-connect.sh:
  MAXIM_VPS_SSH_TARGET, MAXIM_VPS_SSH_PORT, MAXIM_VPS_SSH_KEY,
  MAXIM_VPS_SSH_CONFIG, MAXIM_VPS_SSH_EXTRA_ARGS

The target can also be overridden with --ssh-target.

The source is never removed or changed. The SSH stream is encrypted directly into
the destination staging file; no plaintext backup is written to local disk. The
destination is an age-encrypted file with a .age suffix, a SHA-256 sidecar, and a
verified .ack manifest.
USAGE
}

expand_path() {
  local value="$1"
  case "$value" in
    "~") printf '%s' "$HOME" ;;
    \~/*) printf '%s/%s' "$HOME" "${value#\~/}" ;;
    *) printf '%s' "$value" ;;
  esac
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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote-path)
      [[ $# -ge 2 ]] || die_usage '--remote-path requires a value.'
      REMOTE_PATH="$2"
      shift 2
      ;;
    --local-dir)
      [[ $# -ge 2 ]] || die_usage '--local-dir requires a value.'
      LOCAL_DIR="$2"
      shift 2
      ;;
    --age-recipient-file)
      [[ $# -ge 2 ]] || die_usage '--age-recipient-file requires a value.'
      AGE_RECIPIENT_FILE="$2"
      shift 2
      ;;
    --age-recipient)
      [[ $# -ge 2 ]] || die_usage '--age-recipient requires a value.'
      AGE_RECIPIENT="$2"
      shift 2
      ;;
    --age-identity-file)
      [[ $# -ge 2 ]] || die_usage '--age-identity-file requires a value.'
      AGE_IDENTITY_FILE="$2"
      shift 2
      ;;
    --max-bytes)
      [[ $# -ge 2 ]] || die_usage '--max-bytes requires a value.'
      MAX_BYTES="$2"
      shift 2
      ;;
    --min-free-bytes)
      [[ $# -ge 2 ]] || die_usage '--min-free-bytes requires a value.'
      MIN_FREE_BYTES="$2"
      shift 2
      ;;
    --require-sidecar)
      REQUIRE_SIDECAR=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --ssh-target)
      [[ $# -ge 2 ]] || die_usage '--ssh-target requires a value.'
      SSH_TARGET="$2"
      shift 2
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

REMOTE_PATH="${REMOTE_PATH:-${MAXIM_BACKUP_PULL_REMOTE_PATH:-}}"
LOCAL_DIR="${LOCAL_DIR:-${MAXIM_BACKUP_PULL_LOCAL_DIR:-}}"

[[ -n "$REMOTE_PATH" ]] || die_usage 'A remote backup path is required.'
[[ -n "$LOCAL_DIR" ]] || die_usage 'A local destination directory is required.'
[[ "$REMOTE_PATH" == /* ]] || die_usage 'The remote path must be absolute.'
[[ "$REMOTE_PATH" != */ ]] || die_usage 'The remote path must name a file, not a directory.'
[[ "$REMOTE_PATH" != *$'\n'* && "$REMOTE_PATH" != *$'\r'* ]] || die_usage 'The remote path contains a line break.'
[[ -n "$SSH_TARGET" ]] || die_usage 'SSH target cannot be empty.'
[[ "$MAX_BYTES" =~ ^[0-9]{1,15}$ ]] || die_usage 'Max bytes must be a non-negative integer up to 15 digits.'
[[ "$MIN_FREE_BYTES" =~ ^[0-9]{1,15}$ ]] || die_usage 'Minimum free bytes must be a non-negative integer up to 15 digits.'
[[ -n "$AGE_IDENTITY_FILE" ]] || die_usage 'An age identity file is required for plaintext-free verification.'
AGE_IDENTITY_FILE="$(expand_path "$AGE_IDENTITY_FILE")"
[[ -f "$AGE_IDENTITY_FILE" && -r "$AGE_IDENTITY_FILE" ]] || {
  echo "Age identity file is not readable: $AGE_IDENTITY_FILE" >&2
  exit 1
}
[[ ! -L "$AGE_IDENTITY_FILE" ]] || {
  echo "Age identity file must not be a symlink: $AGE_IDENTITY_FILE" >&2
  exit 1
}
identity_mode="$(stat -c '%a' "$AGE_IDENTITY_FILE" 2>/dev/null || stat -f '%Lp' "$AGE_IDENTITY_FILE" 2>/dev/null || true)"
if [[ ! "$identity_mode" =~ ^[0-7]+$ ]] || ((8#$identity_mode & 077)); then
  echo "Age identity file must not be group/world-readable: $AGE_IDENTITY_FILE" >&2
  exit 1
fi

if [[ -n "$AGE_RECIPIENT_FILE" && -n "$AGE_RECIPIENT" ]]; then
  die_usage 'Choose one of --age-recipient-file or --age-recipient.'
fi
if [[ -n "$AGE_RECIPIENT_FILE" ]]; then
  AGE_RECIPIENT_FILE="$(expand_path "$AGE_RECIPIENT_FILE")"
  [[ -f "$AGE_RECIPIENT_FILE" && -r "$AGE_RECIPIENT_FILE" ]] || {
    echo "Age recipient file is not readable: $AGE_RECIPIENT_FILE" >&2
    exit 1
  }
  AGE_ARGS=(-R "$AGE_RECIPIENT_FILE")
elif [[ -n "$AGE_RECIPIENT" ]]; then
  [[ "$AGE_RECIPIENT" != *$'\n'* && "$AGE_RECIPIENT" != *$'\r'* ]] || {
    echo 'Age recipient contains a line break.' >&2
    exit 2
  }
  AGE_ARGS=(-r "$AGE_RECIPIENT")
else
  die_usage 'An age recipient is required; plaintext copies are intentionally unsupported.'
fi

command -v ssh >/dev/null 2>&1 || { echo 'ssh is required.' >&2; exit 1; }
command -v age >/dev/null 2>&1 || {
  echo 'age is required for local encryption (install age on the operator PC).' >&2
  exit 1
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
  # Keep complex SSH options in ~/.ssh/config; this is the same simple split used
  # by vps-connect.sh for ordinary per-device options.
  extra_args=()
  read -r -a extra_args <<<"$MAXIM_VPS_SSH_EXTRA_ARGS"
  ssh_args+=("${extra_args[@]}")
fi
# Keep this last so an accidental -t/-tt in per-device options cannot corrupt the
# binary stream with a pseudo-terminal.
ssh_args+=(-T)

quoted_remote_path="$(shell_quote "$REMOTE_PATH")"
remote_probe_command="set -eu; export LC_ALL=C; test -f $quoted_remote_path; test ! -L $quoted_remote_path; bytes=\$(wc -c < $quoted_remote_path); checksum=\$(sha256sum -- $quoted_remote_path | awk '{print \$1}'); case \"\$bytes\" in (''|*[!0-9]*) exit 1;; esac; printf '%s %s\\n' \"\$bytes\" \"\$checksum\""

remote_probe() {
  ssh "${ssh_args[@]}" "$SSH_TARGET" "bash -c $(shell_quote "$remote_probe_command")"
}

probe_before="$(remote_probe)"
read -r remote_size remote_sha256 _ <<<"$probe_before"
[[ "$remote_size" =~ ^[0-9]{1,15}$ && "$remote_sha256" =~ ^[0-9a-fA-F]{64}$ ]] || {
  echo 'Remote probe returned invalid size or SHA-256.' >&2
  exit 1
}
remote_sha256="${remote_sha256,,}"

if [[ "$REQUIRE_SIDECAR" == 1 ]]; then
  quoted_sidecar="$(shell_quote "${REMOTE_PATH}.sha256")"
  sidecar_command="set -eu; export LC_ALL=C; test -f $quoted_sidecar; cd $(shell_quote "$(dirname "$REMOTE_PATH")"); sha256sum --check --status $(shell_quote "$(basename "${REMOTE_PATH}.sha256")")"
  ssh "${ssh_args[@]}" "$SSH_TARGET" "bash -c $(shell_quote "$sidecar_command")"
fi

if ((10#$MAX_BYTES > 0 && 10#$remote_size > 10#$MAX_BYTES)); then
  echo "Remote backup exceeds the configured transfer limit ($MAX_BYTES bytes)." >&2
  exit 1
fi

mkdir -p -- "$LOCAL_DIR"
LOCAL_DIR="$(cd "$LOCAL_DIR" && pwd -P)"
base_name="$(basename -- "$REMOTE_PATH")"
[[ "$base_name" != '.' && "$base_name" != '..' && -n "$base_name" ]] || {
  echo 'Could not derive a safe destination name.' >&2
  exit 2
}
[[ "$base_name" != *$'\n'* && "$base_name" != *$'\r'* ]] || {
  echo 'The remote basename contains a line break.' >&2
  exit 2
}

target_path="$LOCAL_DIR/${base_name}.age"
checksum_path="${target_path}.sha256"
ack_path="${target_path}.ack"
for existing_path in "$target_path" "$checksum_path" "$ack_path"; do
  if [[ -e "$existing_path" && ! -f "$existing_path" ]]; then
    echo "Destination path is not a regular file: $existing_path" >&2
    exit 1
  fi
done
if [[ "$FORCE" != 1 && ( -e "$target_path" || -e "$checksum_path" || -e "$ack_path" ) ]]; then
  echo "Destination already exists; use --force only after reviewing it: $target_path" >&2
  exit 1
fi

available_bytes="$(df -Pk "$LOCAL_DIR" | awk 'NR == 2 { print $4 * 1024 }')"
if [[ ! "$available_bytes" =~ ^[0-9]+$ ]]; then
  echo 'Could not determine local destination free space.' >&2
  exit 1
fi
required_bytes=$((10#$remote_size + 10#$MIN_FREE_BYTES))
if ((available_bytes < required_bytes)); then
  echo "Insufficient local free space for encrypted staging (need $required_bytes bytes)." >&2
  exit 1
fi

temp_dir="$(mktemp -d "$LOCAL_DIR/.pull-backup.XXXXXX")"
cleanup() {
  rm -rf -- "$temp_dir"
}
trap cleanup EXIT

encrypted_path="$temp_dir/${base_name}.age"

echo "Pulling $REMOTE_PATH from $SSH_TARGET (remote size $remote_size bytes)." >&2
# Encrypt the SSH stream directly. No plaintext backup is written to local disk.
ssh "${ssh_args[@]}" "$SSH_TARGET" "bash -c $(shell_quote "cat -- $quoted_remote_path")" |
  age "${AGE_ARGS[@]}" >"$encrypted_path"

# A second remote probe detects an artifact that changed while it was being read.
probe_after="$(remote_probe)"
read -r remote_size_after remote_sha256_after _ <<<"$probe_after"
if [[ "$remote_size_after" != "$remote_size" || "${remote_sha256_after,,}" != "$remote_sha256" ]]; then
  echo 'Remote backup changed during transfer; refusing to publish the copy.' >&2
  exit 1
fi

# Decrypt only into streaming hash/count consumers. This proves the encrypted
# artifact contains exactly the bytes identified by the remote pre-probe.
local_size="$(age -d -i "$AGE_IDENTITY_FILE" "$encrypted_path" | wc -c)"
local_size="${local_size//[[:space:]]/}"
local_sha256="$(age -d -i "$AGE_IDENTITY_FILE" "$encrypted_path" | sha256_stream)"
if [[ "$local_size" != "$remote_size" || "${local_sha256,,}" != "$remote_sha256" ]]; then
  echo 'Encrypted backup failed local decrypted size/SHA-256 verification.' >&2
  exit 1
fi

encrypted_sha256="$(sha256_file "$encrypted_path")"
[[ "$encrypted_sha256" =~ ^[0-9a-fA-F]{64}$ ]] || {
  echo 'Could not calculate encrypted backup SHA-256.' >&2
  exit 1
}

if [[ "$FORCE" == 1 ]]; then
  mv -f -- "$encrypted_path" "$target_path"
else
  mv -- "$encrypted_path" "$target_path"
fi
printf '%s  %s\n' "${encrypted_sha256,,}" "$(basename "$target_path")" >"$temp_dir/checksum"
if [[ "$FORCE" == 1 ]]; then
  mv -f -- "$temp_dir/checksum" "$checksum_path"
else
  mv -- "$temp_dir/checksum" "$checksum_path"
fi

recipient_fingerprint=''
if [[ -n "$AGE_RECIPIENT_FILE" ]]; then
  recipient_fingerprint="$(sha256_file "$AGE_RECIPIENT_FILE")"
else
  recipient_fingerprint="$(printf '%s' "$AGE_RECIPIENT" | sha256_stream)"
fi
ack_temp="$temp_dir/ack"
{
  printf 'version=1\n'
  printf 'status=verified-encrypted\n'
  printf 'source_basename=%s\n' "$base_name"
  printf 'source_size_bytes=%s\n' "$remote_size"
  printf 'source_sha256=%s\n' "$remote_sha256"
  printf 'encrypted_basename=%s\n' "$(basename "$target_path")"
  printf 'encrypted_sha256=%s\n' "${encrypted_sha256,,}"
  printf 'age_recipient_file_sha256=%s\n' "$recipient_fingerprint"
  printf 'copied_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$ack_temp"
if [[ "$FORCE" == 1 ]]; then
  mv -f -- "$ack_temp" "$ack_path"
else
  mv -- "$ack_temp" "$ack_path"
fi

trap - EXIT
cleanup
printf 'Verified encrypted backup: %s\n' "$target_path"
printf 'Checksum: %s\n' "$checksum_path"
printf 'ACK: %s\n' "$ack_path"
