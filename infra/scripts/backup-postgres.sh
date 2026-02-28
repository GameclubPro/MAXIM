#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_DIR="$ROOT_DIR/infra/data/backups"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d_%H%M%S)"
TARGET="$BACKUP_DIR/maxim_${STAMP}.sql.gz"

docker compose -f "$ROOT_DIR/infra/docker-compose.yml" exec -T postgres \
  pg_dump -U maxim -d maxim | gzip > "$TARGET"

find "$BACKUP_DIR" -type f -name 'maxim_*.sql.gz' -mtime +14 -delete

echo "Backup saved to $TARGET"
