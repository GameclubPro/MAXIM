#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_DIR="${MAXIM_BACKUP_DIR:-$ROOT_DIR/infra/data/backups}"
RETENTION_DAYS="${MAXIM_BACKUP_RETENTION_DAYS:-14}"
COMPOSE_FILE="${MAXIM_BACKUP_COMPOSE_FILE:-$ROOT_DIR/infra/docker-compose.yml}"
MIN_FREE_BYTES="${MAXIM_BACKUP_MIN_FREE_BYTES:-2147483648}"
REQUIRE_DEDICATED_FILESYSTEM="${MAXIM_BACKUP_REQUIRE_DEDICATED_FILESYSTEM:-1}"
MODE="${1:-}"

if [[ ! "$RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  echo "MAXIM_BACKUP_RETENTION_DAYS must be a non-negative integer." >&2
  exit 2
fi
if [[ ! "$MIN_FREE_BYTES" =~ ^[0-9]+$ ]]; then
  echo "MAXIM_BACKUP_MIN_FREE_BYTES must be a non-negative integer." >&2
  exit 2
fi
if [[ "$REQUIRE_DEDICATED_FILESYSTEM" != "0" && "$REQUIRE_DEDICATED_FILESYSTEM" != "1" ]]; then
  echo "MAXIM_BACKUP_REQUIRE_DEDICATED_FILESYSTEM must be 0 or 1." >&2
  exit 2
fi
if [[ -n "$MODE" && "$MODE" != "--preflight-only" ]]; then
  echo "Usage: $0 [--preflight-only]" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"
if [[ "$REQUIRE_DEDICATED_FILESYSTEM" == "1" ]] && \
  [[ "$(stat -c %d "$BACKUP_DIR")" == "$(stat -c %d "$ROOT_DIR")" ]]; then
  echo "Refusing to store a PostgreSQL backup on the production application filesystem." >&2
  echo "Mount a separate persistent volume at MAXIM_BACKUP_DIR before retrying." >&2
  exit 1
fi

# Remove expired generations before the capacity check, but preserve the newest completed
# dump/checksum pair until a later run has successfully published its replacement.
LATEST_COMPLETED_DUMP=""
shopt -s nullglob
for completed_dump in "$BACKUP_DIR"/maxim_*.dump; do
  if [[ -f "$completed_dump.sha256" ]]; then
    LATEST_COMPLETED_DUMP="$completed_dump"
  fi
done
shopt -u nullglob

while IFS= read -r -d '' expired_dump; do
  if [[ "$expired_dump" == "$LATEST_COMPLETED_DUMP" ]]; then
    continue
  fi
  rm -f -- "$expired_dump" "$expired_dump.sha256"
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'maxim_*.dump' -mtime "+$RETENTION_DAYS" -print0)
while IFS= read -r -d '' expired_checksum; do
  if [[ "$expired_checksum" == "$LATEST_COMPLETED_DUMP.sha256" ]]; then
    continue
  fi
  rm -f -- "$expired_checksum"
done < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'maxim_*.dump.sha256' \
    -mtime "+$RETENTION_DAYS" -print0
)

DATABASE_BYTES="$(
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U maxim -d maxim -Atqc 'SELECT pg_database_size(current_database())'
)"
DATABASE_BYTES="${DATABASE_BYTES//[[:space:]]/}"
AVAILABLE_BYTES="$(df -PB1 "$BACKUP_DIR" | awk 'NR == 2 { print $4 }')"
if [[ ! "$DATABASE_BYTES" =~ ^[0-9]+$ || ! "$AVAILABLE_BYTES" =~ ^[0-9]+$ ]]; then
  echo "Could not determine PostgreSQL size or backup filesystem capacity." >&2
  exit 1
fi

# A custom dump omits physical index pages, but reserving the full database size keeps
# incompressible data from filling the production filesystem mid-stream.
REQUIRED_BYTES=$((DATABASE_BYTES + MIN_FREE_BYTES))
if ((AVAILABLE_BYTES < REQUIRED_BYTES)); then
  echo "Insufficient free space for a fail-safe PostgreSQL backup." >&2
  echo "Available bytes: $AVAILABLE_BYTES; required bytes: $REQUIRED_BYTES." >&2
  echo "Configure MAXIM_BACKUP_DIR on a separate persistent volume before retrying." >&2
  exit 1
fi

if [[ "$MODE" == "--preflight-only" ]]; then
  echo "PostgreSQL backup capacity preflight passed."
  exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$BACKUP_DIR/maxim_${STAMP}.dump"
CHECKSUM_TARGET="$TARGET.sha256"
TEMP_DUMP="$(mktemp "$BACKUP_DIR/.maxim_${STAMP}.XXXXXX.dump.tmp")"
TEMP_CHECKSUM="$(mktemp "$BACKUP_DIR/.maxim_${STAMP}.XXXXXX.sha256.tmp")"

cleanup() {
  rm -f -- "$TEMP_DUMP" "$TEMP_CHECKSUM"
}
trap cleanup EXIT

docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U maxim -d maxim --format=custom --compress=6 --no-owner --no-privileges > "$TEMP_DUMP"

if [[ ! -s "$TEMP_DUMP" ]]; then
  echo "PostgreSQL backup is empty." >&2
  exit 1
fi

docker compose -f "$COMPOSE_FILE" exec -T postgres pg_restore --list < "$TEMP_DUMP" >/dev/null

CHECKSUM="$(sha256sum "$TEMP_DUMP" | awk '{print $1}')"
printf '%s  %s\n' "$CHECKSUM" "$(basename "$TARGET")" > "$TEMP_CHECKSUM"

mv -- "$TEMP_DUMP" "$TARGET"
mv -- "$TEMP_CHECKSUM" "$CHECKSUM_TARGET"
trap - EXIT

echo "Validated PostgreSQL backup saved to $TARGET"
