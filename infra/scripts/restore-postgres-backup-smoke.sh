#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_DIR="${MAXIM_BACKUP_DIR:-$ROOT_DIR/infra/data/backups}"
POSTGRES_IMAGE="${MAXIM_BACKUP_POSTGRES_IMAGE:-postgres:16-alpine}"
COMPOSE_FILE="${MAXIM_BACKUP_COMPOSE_FILE:-$ROOT_DIR/infra/docker-compose.yml}"
RESTORE_DATA_ROOT="${MAXIM_RESTORE_SMOKE_DATA_ROOT:-$BACKUP_DIR/restore-smoke-data}"
MIN_FREE_BYTES="${MAXIM_RESTORE_SMOKE_MIN_FREE_BYTES:-2147483648}"
REQUIRED_PERCENT="${MAXIM_RESTORE_SMOKE_REQUIRED_PERCENT:-125}"
REQUIRE_DEDICATED_FILESYSTEM="${MAXIM_RESTORE_SMOKE_REQUIRE_DEDICATED_FILESYSTEM:-1}"
MODE=""
DUMP_PATH=""

for argument in "$@"; do
  case "$argument" in
    --preflight-only)
      MODE="--preflight-only"
      ;;
    *)
      if [[ -n "$DUMP_PATH" ]]; then
        echo "Usage: $0 [dump-path] [--preflight-only]" >&2
        exit 2
      fi
      DUMP_PATH="$argument"
      ;;
  esac
done

if [[ ! "$MIN_FREE_BYTES" =~ ^[0-9]+$ || ! "$REQUIRED_PERCENT" =~ ^[0-9]+$ ]]; then
  echo "Restore-smoke capacity limits must be non-negative integers." >&2
  exit 2
fi
if ((REQUIRED_PERCENT < 100)); then
  echo "MAXIM_RESTORE_SMOKE_REQUIRED_PERCENT must be at least 100." >&2
  exit 2
fi
if [[ "$REQUIRE_DEDICATED_FILESYSTEM" != "0" && "$REQUIRE_DEDICATED_FILESYSTEM" != "1" ]]; then
  echo "MAXIM_RESTORE_SMOKE_REQUIRE_DEDICATED_FILESYSTEM must be 0 or 1." >&2
  exit 2
fi

if [[ -z "$DUMP_PATH" ]]; then
  DUMP_PATH="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'maxim_*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d ' ' -f 2-)"
fi

if [[ -z "$DUMP_PATH" || ! -f "$DUMP_PATH" || ! -s "$DUMP_PATH" ]]; then
  echo "No completed PostgreSQL backup was found for restore smoke." >&2
  exit 2
fi

DUMP_DIR="$(cd "$(dirname "$DUMP_PATH")" && pwd)"
DUMP_PATH="$DUMP_DIR/$(basename "$DUMP_PATH")"
CHECKSUM_PATH="$DUMP_PATH.sha256"
if [[ ! -f "$CHECKSUM_PATH" ]]; then
  echo "Backup checksum is missing: $CHECKSUM_PATH" >&2
  exit 2
fi

(
  cd "$DUMP_DIR"
  sha256sum --check --status "$(basename "$CHECKSUM_PATH")"
)

mkdir -p "$RESTORE_DATA_ROOT"
if [[ "$REQUIRE_DEDICATED_FILESYSTEM" == "1" ]] && \
  [[ "$(stat -c %d "$RESTORE_DATA_ROOT")" == "$(stat -c %d "$ROOT_DIR")" ]]; then
  echo "Refusing to restore a full PostgreSQL backup on the production application filesystem." >&2
  echo "Mount a separate disposable volume at MAXIM_RESTORE_SMOKE_DATA_ROOT." >&2
  exit 1
fi
DATABASE_BYTES="$(
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U maxim -d maxim -Atqc 'SELECT pg_database_size(current_database())'
)"
DATABASE_BYTES="${DATABASE_BYTES//[[:space:]]/}"
AVAILABLE_BYTES="$(df -PB1 "$RESTORE_DATA_ROOT" | awk 'NR == 2 { print $4 }')"
if [[ ! "$DATABASE_BYTES" =~ ^[0-9]+$ || ! "$AVAILABLE_BYTES" =~ ^[0-9]+$ ]]; then
  echo "Could not determine PostgreSQL size or restore filesystem capacity." >&2
  exit 1
fi

REQUIRED_BYTES=$(((DATABASE_BYTES * REQUIRED_PERCENT + 99) / 100 + MIN_FREE_BYTES))
if ((AVAILABLE_BYTES < REQUIRED_BYTES)); then
  echo "Insufficient free space for an isolated PostgreSQL restore smoke." >&2
  echo "Available bytes: $AVAILABLE_BYTES; required bytes: $REQUIRED_BYTES." >&2
  echo "Configure MAXIM_RESTORE_SMOKE_DATA_ROOT on a separate disposable volume." >&2
  exit 1
fi

if [[ "$MODE" == "--preflight-only" ]]; then
  echo "PostgreSQL restore-smoke capacity and archive preflight passed."
  exit 0
fi

CONTAINER_NAME="maxim-postgres-restore-smoke-$$-$RANDOM"
RESTORE_DATA_DIR="$(mktemp -d "$RESTORE_DATA_ROOT/maxim-restore-smoke.XXXXXX")"
cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -rf -- "$RESTORE_DATA_DIR" || true
}
trap cleanup EXIT

docker run --detach --rm \
  --name "$CONTAINER_NAME" \
  --env POSTGRES_PASSWORD=restore-smoke-only \
  --mount "type=bind,source=$RESTORE_DATA_DIR,target=/var/lib/postgresql/data" \
  "$POSTGRES_IMAGE" >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER_NAME" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "Disposable PostgreSQL did not become ready." >&2
  exit 1
fi

docker exec -i "$CONTAINER_NAME" pg_restore --list < "$DUMP_PATH" >/dev/null
docker exec "$CONTAINER_NAME" createdb -U postgres maxim_restore_smoke
docker exec -i "$CONTAINER_NAME" pg_restore \
  -U postgres \
  -d maxim_restore_smoke \
  --exit-on-error \
  --no-owner \
  --no-privileges < "$DUMP_PATH"

HAS_MIGRATIONS_TABLE="$(
  docker exec "$CONTAINER_NAME" psql -U postgres -d maxim_restore_smoke -Atqc \
    "SELECT CASE WHEN to_regclass('public._prisma_migrations') IS NULL THEN 0 ELSE 1 END"
)"
if [[ "$HAS_MIGRATIONS_TABLE" != 1 ]]; then
  echo "Restore smoke did not find the Prisma migration table." >&2
  exit 1
fi

echo "PostgreSQL restore smoke passed for $DUMP_PATH"
