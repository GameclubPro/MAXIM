#!/usr/bin/env bash
set -euo pipefail
# Remote commands are passed through explicit shell_quote boundaries.
# shellcheck disable=SC2016,SC2029
umask 077
export LC_ALL=C

# Operator-side emergency/maintenance path. It never writes a backup volume on
# the VPS: the only remote data operation is a read-only pg_dump stream.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${MAXIM_VPS_ENV_FILE:-$ROOT_DIR/.env.vps}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

SSH_TARGET="${MAXIM_VPS_SSH_TARGET:-maxim-vps}"
REMOTE_REPO_DIR="${MAXIM_VPS_REPO_DIR:-/var/www/Chat_bot}"
REMOTE_COMPOSE_FILE="${MAXIM_LIVE_POSTGRES_COMPOSE_FILE:-infra/docker-compose.yml}"
REMOTE_DB_USER="${MAXIM_LIVE_POSTGRES_DB_USER:-maxim}"
REMOTE_DB_NAME="${MAXIM_LIVE_POSTGRES_DB_NAME:-maxim}"
LOCAL_DIR=""
OUTPUT_NAME=""
AGE_RECIPIENT_FILE="${MAXIM_BACKUP_AGE_RECIPIENT_FILE:-}"
AGE_RECIPIENT="${MAXIM_BACKUP_AGE_RECIPIENT:-}"
AGE_IDENTITY_FILE="${MAXIM_BACKUP_AGE_IDENTITY_FILE:-}"
MIN_FREE_BYTES="${MAXIM_LIVE_POSTGRES_MIN_FREE_BYTES:-2147483648}"
MAX_DURATION_SEC="${MAXIM_LIVE_POSTGRES_MAX_DURATION_SEC:-21600}"
RETENTION_DAYS="${MAXIM_LIVE_POSTGRES_RETENTION_DAYS:-14}"
KEEP_COUNT="${MAXIM_LIVE_POSTGRES_KEEP_COUNT:-2}"
RATE_LIMIT_BYTES_PER_SEC="${MAXIM_LIVE_POSTGRES_RATE_LIMIT_BYTES_PER_SEC:-10485760}"
REQUIRE_READY="${MAXIM_LIVE_POSTGRES_REQUIRE_READY:-1}"
FORCE=0

usage() {
  cat <<'USAGE'
Usage:
  ./infra/scripts/stream-live-postgres-backup-to-local.sh \
    --local-dir /path/to/encrypted-live-backups \
    --age-recipient-file /path/to/recipients.txt \
    --age-identity-file /path/to/age-key.txt \
    [--output-name maxim_YYYYMMDDTHHMMSSZ.dump] [--force]

Optional settings:
  --remote-repo-dir DIR       VPS checkout (default: /var/www/Chat_bot)
  --compose-file FILE         Compose file relative to the checkout
  --local-dir DIR             Operator-PC encrypted destination
  --min-free-bytes BYTES      Local reserve (default: 2147483648)
  --max-duration-sec SECONDS  SSH/pg_dump wall-clock limit (default: 21600)
  --rate-limit BYTES_PER_SEC  Throttle the dump stream (default: 10485760; 0 disables)
  --allow-degraded             Permit a run while API readiness is degraded (manual only)
  --retention-days N          Remove complete live pairs older than N days (default: 14)
  --keep-count N              Always retain N newest complete live pairs (default: 2)
  --ssh-target TARGET         Override MAXIM_VPS_SSH_TARGET

This is a reviewed maintenance path for a primary database; schedule it only
with an external readiness/queue-lag watchdog or a standby. The remote command
acquires the shared deploy lock, runs
`docker compose ... exec -T postgres pg_dump`, and writes no dump file on the VPS.
The SSH stream is encrypted directly into a local temporary age file. Plaintext
never touches local disk; restore-list, size, and SHA checks consume decrypt pipes.
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
  [[ -n "$AGE_IDENTITY_FILE" ]] ||
    die_usage 'An age identity file is required; plaintext verification is disabled.'
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
    die_usage 'Choose one of --age-recipient-file or --age-recipient.'
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
  [[ -n "$AGE_RECIPIENT" ]] ||
    die_usage 'An age recipient is required; plaintext copies are unsupported.'
  [[ "$AGE_RECIPIENT" != *$'\n'* && "$AGE_RECIPIENT" != *$'\r'* ]] || {
    echo 'Age recipient contains a line break.' >&2
    exit 2
  }
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local-dir)
      [[ $# -ge 2 ]] || die_usage '--local-dir requires a value.'
      LOCAL_DIR="$2"
      shift 2
      ;;
    --output-name)
      [[ $# -ge 2 ]] || die_usage '--output-name requires a value.'
      OUTPUT_NAME="$2"
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
    --remote-repo-dir)
      [[ $# -ge 2 ]] || die_usage '--remote-repo-dir requires a value.'
      REMOTE_REPO_DIR="$2"
      shift 2
      ;;
    --compose-file)
      [[ $# -ge 2 ]] || die_usage '--compose-file requires a value.'
      REMOTE_COMPOSE_FILE="$2"
      shift 2
      ;;
    --min-free-bytes)
      [[ $# -ge 2 ]] || die_usage '--min-free-bytes requires a value.'
      MIN_FREE_BYTES="$2"
      shift 2
      ;;
    --max-duration-sec)
      [[ $# -ge 2 ]] || die_usage '--max-duration-sec requires a value.'
      MAX_DURATION_SEC="$2"
      shift 2
      ;;
    --rate-limit)
      [[ $# -ge 2 ]] || die_usage '--rate-limit requires a value.'
      RATE_LIMIT_BYTES_PER_SEC="$2"
      shift 2
      ;;
    --allow-degraded)
      REQUIRE_READY=0
      shift
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
    --force)
      FORCE=1
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

[[ -n "$LOCAL_DIR" ]] || die_usage 'A local destination directory is required.'
[[ "$REMOTE_REPO_DIR" == /* && "$REMOTE_REPO_DIR" != "/" ]] ||
  die_usage 'The remote repository directory must be an absolute non-root path.'
[[ "$REMOTE_REPO_DIR" != *$'\n'* && "$REMOTE_REPO_DIR" != *$'\r'* && "$REMOTE_REPO_DIR" != *$'\t'* ]] ||
  die_usage 'The remote repository directory contains a control character.'
[[ "$REMOTE_COMPOSE_FILE" != *$'\n'* && "$REMOTE_COMPOSE_FILE" != *$'\r'* && "$REMOTE_COMPOSE_FILE" != *$'\t'* ]] ||
  die_usage 'The remote Compose file contains a control character.'
[[ "$REMOTE_COMPOSE_FILE" != -* ]] || die_usage 'The remote Compose file cannot start with a dash.'
[[ "$SSH_TARGET" != *$'\n'* && "$SSH_TARGET" != *$'\r'* && -n "$SSH_TARGET" ]] ||
  die_usage 'SSH target is invalid.'
[[ "$REMOTE_DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,62}$ ]] || die_usage 'Remote DB user is invalid.'
[[ "$REMOTE_DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,62}$ ]] || die_usage 'Remote DB name is invalid.'
[[ "$MIN_FREE_BYTES" =~ ^[0-9]{1,15}$ ]] ||
  die_usage 'Minimum free bytes must be a non-negative integer up to 15 digits.'
[[ "$MAX_DURATION_SEC" =~ ^[0-9]{2,7}$ ]] ||
  die_usage 'Maximum duration must be an integer up to 7 digits.'
((10#$MAX_DURATION_SEC >= 60)) ||
  die_usage 'Maximum duration must be at least 60 seconds.'
[[ "$RATE_LIMIT_BYTES_PER_SEC" =~ ^[0-9]{1,12}$ ]] ||
  die_usage 'Rate limit must be a non-negative integer up to 12 digits.'
[[ "$REQUIRE_READY" == 0 || "$REQUIRE_READY" == 1 ]] ||
  die_usage 'Readiness guard must be 0 or 1.'
[[ "$RETENTION_DAYS" =~ ^[0-9]{1,5}$ ]] ||
  die_usage 'Retention days must be a non-negative integer up to 99999.'
[[ "$KEEP_COUNT" =~ ^[1-9][0-9]{0,3}$ ]] ||
  die_usage 'Keep count must be a positive integer up to 9999.'
[[ "$FORCE" == 0 || "$FORCE" == 1 ]] || die_usage 'Force must be 0 or 1.'

if [[ -z "$OUTPUT_NAME" ]]; then
  OUTPUT_NAME="maxim_$(date -u +%Y%m%dT%H%M%SZ).dump"
fi
[[ "$OUTPUT_NAME" =~ ^maxim_[0-9]{8}T[0-9]{6}Z\.dump$ ]] ||
  die_usage 'Output name must match maxim_YYYYMMDDTHHMMSSZ.dump.'
PG_APP_NAME="maxim-live-backup-$(date -u +%Y%m%dT%H%M%SZ)-$$"
[[ "$PG_APP_NAME" =~ ^[A-Za-z0-9_-]{1,63}$ ]] ||
  die_usage 'Generated PostgreSQL application name is invalid.'

validate_recipient
validate_private_identity

for command_name in age ssh flock timeout pg_restore; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is missing: $command_name" >&2
    exit 1
  }
done
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || {
  echo 'sha256sum or shasum is required.' >&2
  exit 1
}
if ((10#$RATE_LIMIT_BYTES_PER_SEC > 0)); then
  command -v pv >/dev/null 2>&1 || {
    echo 'pv is required when a positive stream rate limit is configured.' >&2
    exit 1
  }
fi

mkdir -p -- "$LOCAL_DIR"
LOCAL_DIR="$(cd "$LOCAL_DIR" && pwd -P)"
LOCK_PATH="$LOCAL_DIR/.live-postgres-stream.lock"
exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  echo "Another live PostgreSQL stream is already running: $LOCK_PATH" >&2
  exit 75
fi

TARGET_PATH="$LOCAL_DIR/$OUTPUT_NAME.age"
CHECKSUM_PATH="$TARGET_PATH.sha256"
ACK_PATH="$TARGET_PATH.ack"
for existing_path in "$TARGET_PATH" "$CHECKSUM_PATH" "$ACK_PATH"; do
  if [[ -L "$existing_path" ]]; then
    echo "Destination path must not be a symlink: $existing_path" >&2
    exit 1
  fi
  if [[ -e "$existing_path" && ! -f "$existing_path" ]]; then
    echo "Destination path is not a regular file: $existing_path" >&2
    exit 1
  fi
done
if [[ "$FORCE" != 1 && ( -e "$TARGET_PATH" || -e "$CHECKSUM_PATH" || -e "$ACK_PATH" ) ]]; then
  echo "Destination already exists; use --force only after review: $TARGET_PATH" >&2
  exit 1
fi

remote_repo_q="$(shell_quote "$REMOTE_REPO_DIR")"
remote_compose_q="$(shell_quote "$REMOTE_COMPOSE_FILE")"
remote_user_q="$(shell_quote "$REMOTE_DB_USER")"
remote_db_q="$(shell_quote "$REMOTE_DB_NAME")"

ssh_args=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=20 -T)
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
# Keep TTY disabled even if a local extra-args value contains -t/-tt.
ssh_args+=(-T)

cleanup_remote_dump() {
  local cleanup_sql
  local cleanup_command
  cleanup_sql="SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '$PG_APP_NAME';"
  cleanup_command="set -euo pipefail; cd $(shell_quote "$REMOTE_REPO_DIR"); docker compose --env-file .env -p infra -f $(shell_quote "$REMOTE_COMPOSE_FILE") exec -T postgres psql -w -U $(shell_quote "$REMOTE_DB_USER") -d $(shell_quote "$REMOTE_DB_NAME") -Atqc $(shell_quote "$cleanup_sql") >/dev/null"
  timeout --foreground --signal=TERM --kill-after=5s 30s \
    ssh "${ssh_args[@]}" "$SSH_TARGET" "bash -c $(shell_quote "$cleanup_command")" \
    >/dev/null 2>&1 || true
}

cleanup_all() {
  local status=$?
  trap - EXIT
  cleanup_remote_dump
  cleanup_temp
  exit "$status"
}
trap cleanup_all EXIT

if ((REQUIRE_READY == 1)); then
  if ! ssh "${ssh_args[@]}" "$SSH_TARGET" \
    'curl -fsS --max-time 10 http://127.0.0.1:3001/api/health/ready >/dev/null'; then
    echo 'Refusing live PostgreSQL stream while API readiness is degraded.' >&2
    echo 'Wait for /api/health/ready to return 200 or use --allow-degraded for a reviewed manual run.' >&2
    exit 75
  fi
fi

remote_preflight_command="set -euo pipefail; cd $remote_repo_q; test -r infra/scripts/lib/deploy-lock.sh; source infra/scripts/lib/deploy-lock.sh; acquire_deploy_lock; docker compose --env-file .env -p infra -f $remote_compose_q exec -T postgres psql -w -U $remote_user_q -d $remote_db_q -Atqc 'SELECT pg_database_size(current_database());'"
# The command is intentionally shell-quoted before the remote bash parses it.
# shellcheck disable=SC2029
database_bytes="$(ssh "${ssh_args[@]}" "$SSH_TARGET" "bash -c $(shell_quote "$remote_preflight_command")")"
database_bytes="${database_bytes//[[:space:]]/}"
[[ "$database_bytes" =~ ^[1-9][0-9]{0,14}$ ]] || {
  echo 'Remote PostgreSQL size preflight returned invalid data.' >&2
  exit 1
}

available_bytes="$(df -Pk "$LOCAL_DIR" | awk 'NR == 2 { print $4 * 1024 }')"
[[ "$available_bytes" =~ ^[0-9]+$ ]] || {
  echo 'Could not determine local destination free space.' >&2
  exit 1
}
required_bytes=$((10#$database_bytes + 10#$MIN_FREE_BYTES))
if ((available_bytes < required_bytes)); then
  echo "Insufficient local free space for live PostgreSQL stream (need $required_bytes bytes)." >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d "$LOCAL_DIR/.live-postgres-stream.XXXXXX")"
ENCRYPTED_TEMP="$TEMP_DIR/$OUTPUT_NAME.age"
REMOTE_STDERR="$TEMP_DIR/remote.stderr"
cleanup_temp() {
  if [[ -n "${TEMP_DIR:-}" && -d "$TEMP_DIR" ]]; then
    rm -rf -- "$TEMP_DIR"
  fi
}
trap cleanup_temp EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup_all EXIT

REMOTE_STREAM_SCRIPT="$(cat <<'REMOTE_STREAM'
set -euo pipefail
repo_dir="$1"
compose_file="$2"
db_user="$3"
db_name="$4"
app_name="$5"
cd "$repo_dir"
test -r infra/scripts/lib/deploy-lock.sh
# shellcheck source=/dev/null
source infra/scripts/lib/deploy-lock.sh
acquire_deploy_lock
docker compose --env-file .env -p infra -f "$compose_file" exec -T postgres \
  sh -lc 'exec env PGAPPNAME="$3" ionice -c2 -n7 nice -n19 pg_dump \
    --no-password -U "$1" -d "$2" \
    --format=custom --compress=gzip:3 --no-owner --no-privileges \
    --lock-wait-timeout=10s' -- "$db_user" "$db_name" "$app_name"
REMOTE_STREAM
)"

rate_limit_stream() {
  if ((10#$RATE_LIMIT_BYTES_PER_SEC > 0)); then
    pv -q -L "$RATE_LIMIT_BYTES_PER_SEC"
  else
    cat
  fi
}

echo "Streaming live PostgreSQL snapshot to $TARGET_PATH (database size $database_bytes bytes)." >&2
if ! timeout --foreground --signal=TERM --kill-after=5m "${MAX_DURATION_SEC}s" \
  ssh "${ssh_args[@]}" "$SSH_TARGET" \
  "bash -s -- $remote_repo_q $remote_compose_q $remote_user_q $remote_db_q $(shell_quote "$PG_APP_NAME")" \
  2>"$REMOTE_STDERR" < <(printf '%s' "$REMOTE_STREAM_SCRIPT") |
  rate_limit_stream |
  if [[ -n "$AGE_RECIPIENT_FILE" ]]; then
    age -R "$AGE_RECIPIENT_FILE" >"$ENCRYPTED_TEMP"
  else
    age -r "$AGE_RECIPIENT" >"$ENCRYPTED_TEMP"
  fi
then
  echo 'Live PostgreSQL stream failed; no destination files were published.' >&2
  if [[ -s "$REMOTE_STDERR" ]]; then
    sed -n '1,120p' "$REMOTE_STDERR" |
      sed -E 's/((password|token|secret|private[_-]?key|authorization|api[_-]?key)[[:space:]=:]+)[^[:space:]]+/\1REDACTED/Ig' >&2
  fi
  exit 1
fi
[[ -s "$ENCRYPTED_TEMP" ]] || {
  echo 'Live PostgreSQL stream produced an empty encrypted file.' >&2
  exit 1
}

RESTORE_SUMMARY_PATH="$TEMP_DIR/restore-summary"
set +e
# pg_restore --list may stop after reading the TOC, so age can receive SIGPIPE
# (141). The full decrypt/hash pass below still consumes the entire archive.
age -d -i "$AGE_IDENTITY_FILE" "$ENCRYPTED_TEMP" |
  pg_restore --list |
  awk 'BEGIN { entries = 0; prisma = 0 }
    /^[[:space:]]*[0-9]+;/ { entries++ }
    /_prisma_migrations/ { prisma = 1 }
    END { printf "%d %d\n", entries, prisma }' >"$RESTORE_SUMMARY_PATH"
restore_statuses=("${PIPESTATUS[@]}")
set -e
age_status="${restore_statuses[0]:-255}"
restore_status="${restore_statuses[1]:-255}"
summary_status="${restore_statuses[2]:-255}"
if [[ "$restore_status" != 0 || "$summary_status" != 0 ||
  ("$age_status" != 0 && "$age_status" != 141) ]]; then
  echo 'Restore-list verification failed; no destination files were published.' >&2
  exit 1
fi
restore_summary="$(cat -- "$RESTORE_SUMMARY_PATH")"
read -r restore_entries restore_has_prisma _ <<<"$restore_summary"
[[ "$restore_entries" =~ ^[1-9][0-9]*$ && "$restore_has_prisma" == 1 ]] || {
  echo 'Restore-list verification failed or Prisma migration table is missing.' >&2
  exit 1
}

plain_size="$(age -d -i "$AGE_IDENTITY_FILE" "$ENCRYPTED_TEMP" | wc -c)"
plain_size="${plain_size//[[:space:]]/}"
plain_sha256="$(age -d -i "$AGE_IDENTITY_FILE" "$ENCRYPTED_TEMP" | sha256_stream)"
[[ "$plain_size" =~ ^[1-9][0-9]{0,14}$ && "$plain_sha256" =~ ^[0-9a-fA-F]{64}$ ]] || {
  echo 'Decrypted live dump size or SHA-256 is invalid.' >&2
  exit 1
}
encrypted_sha256="$(sha256_file "$ENCRYPTED_TEMP")"
[[ "$encrypted_sha256" =~ ^[0-9a-fA-F]{64}$ ]] || {
  echo 'Encrypted live dump SHA-256 is invalid.' >&2
  exit 1
}

recipient_fingerprint=''
if [[ -n "$AGE_RECIPIENT_FILE" ]]; then
  recipient_fingerprint="$(sha256_file "$AGE_RECIPIENT_FILE")"
else
  recipient_fingerprint="$(printf '%s' "$AGE_RECIPIENT" | sha256_stream)"
fi

CHECKSUM_TEMP="$TEMP_DIR/checksum"
ACK_TEMP="$TEMP_DIR/ack"
printf '%s  %s\n' "${encrypted_sha256,,}" "$(basename "$TARGET_PATH")" >"$CHECKSUM_TEMP"
{
  printf 'version=1\n'
  printf 'status=verified-encrypted\n'
  printf 'source_kind=live-postgres\n'
  printf 'source_basename=%s\n' "$OUTPUT_NAME"
  printf 'source_size_bytes=%s\n' "$plain_size"
  printf 'source_sha256=%s\n' "${plain_sha256,,}"
  printf 'encrypted_basename=%s\n' "$(basename "$TARGET_PATH")"
  printf 'encrypted_sha256=%s\n' "${encrypted_sha256,,}"
  printf 'age_recipient_file_sha256=%s\n' "$recipient_fingerprint"
  printf 'remote_database_size_bytes=%s\n' "$database_bytes"
  printf 'postgres_application_name=%s\n' "$PG_APP_NAME"
  printf 'stream_rate_limit_bytes_per_sec=%s\n' "$RATE_LIMIT_BYTES_PER_SEC"
  printf 'restore_list_entries=%s\n' "$restore_entries"
  printf 'restore_list_prisma_migrations=1\n'
  printf 'copied_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$ACK_TEMP"

sync -f "$ENCRYPTED_TEMP"
sync -f "$CHECKSUM_TEMP"
sync -f "$ACK_TEMP"
if [[ "$FORCE" == 1 ]]; then
  mv -f -- "$CHECKSUM_TEMP" "$CHECKSUM_PATH"
  mv -f -- "$ACK_TEMP" "$ACK_PATH"
  mv -f -- "$ENCRYPTED_TEMP" "$TARGET_PATH"
else
  mv -- "$CHECKSUM_TEMP" "$CHECKSUM_PATH"
  mv -- "$ACK_TEMP" "$ACK_PATH"
  mv -- "$ENCRYPTED_TEMP" "$TARGET_PATH"
fi
sync -f "$LOCAL_DIR"

retention_cutoff=$(( $(date -u +%s) - 10#$RETENTION_DAYS * 86400 ))
retention_kept=0
retention_candidates=()
shopt -s nullglob
for age_path in "$LOCAL_DIR"/maxim_*.dump.age; do
  [[ -f "$age_path" && ! -L "$age_path" ]] || continue
  age_name="$(basename -- "$age_path")"
  [[ "$age_name" =~ ^maxim_[0-9]{8}T[0-9]{6}Z\.dump\.age$ ]] || continue
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
    [[ -f "$pair_checksum" && ! -L "$pair_checksum" &&
      -f "$pair_ack" && ! -L "$pair_ack" ]] || continue

    checksum_line="$(cat -- "$pair_checksum")"
    checksum_lines="$(wc -l <"$pair_checksum" | tr -d '[:space:]')"
    read -r expected_sha expected_name extra_field <<<"$checksum_line"
    [[ "$checksum_lines" == 1 && "$checksum_line" == "$expected_sha  $age_name" &&
      "$expected_sha" =~ ^[0-9a-fA-F]{64}$ &&
      "$expected_name" == "$age_name" && -z "$extra_field" ]] || continue
    (cd "$LOCAL_DIR" && sha256sum --check --status -- "$(basename -- "$pair_checksum")") || continue
    ack_encrypted_name="$(awk -F= '$1 == "encrypted_basename" { print substr($0, index($0, "=") + 1); exit }' "$pair_ack")"
    ack_encrypted_sha="$(awk -F= '$1 == "encrypted_sha256" { print substr($0, index($0, "=") + 1); exit }' "$pair_ack")"
    ack_version="$(awk -F= '$1 == "version" { print substr($0, index($0, "=") + 1); exit }' "$pair_ack")"
    ack_status="$(awk -F= '$1 == "status" { print substr($0, index($0, "=") + 1); exit }' "$pair_ack")"
    ack_source_kind="$(awk -F= '$1 == "source_kind" { print substr($0, index($0, "=") + 1); exit }' "$pair_ack")"
    [[ "$ack_version" == 1 && "$ack_encrypted_name" == "$age_name" &&
      "${ack_encrypted_sha,,}" == "${expected_sha,,}" && "$ack_status" == verified-encrypted &&
      "$ack_source_kind" == live-postgres ]] || continue

    if ((retention_kept < KEEP_COUNT)); then
      retention_kept=$((retention_kept + 1))
      continue
    fi
    ((age_mtime < retention_cutoff)) || continue
    rm -f -- "$age_path" "$pair_checksum" "$pair_ack"
    echo "Removed expired live encrypted PostgreSQL pair: $age_name" >&2
  done < <(printf '%s\n' "${retention_candidates[@]}" | LC_ALL=C sort -rn)
fi

cleanup_remote_dump
trap - EXIT HUP INT TERM
cleanup_temp
printf 'Verified live encrypted PostgreSQL dump: %s\n' "$TARGET_PATH"
printf 'Checksum: %s\n' "$CHECKSUM_PATH"
printf 'ACK: %s\n' "$ACK_PATH"
