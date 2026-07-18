#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_DIR="${MAXIM_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
TEMP_DIR="$(mktemp -d)"
ENABLE_BACKUP_TIMER="${MAXIM_ENABLE_POSTGRES_BACKUP_TIMER:-0}"
ENABLE_RESTORE_TIMER="${MAXIM_ENABLE_POSTGRES_RESTORE_SMOKE_TIMER:-0}"
BACKUP_ENV_FILE="/etc/maxim-postgres-backup.env"

cleanup() {
  rm -rf -- "$TEMP_DIR"
}
trap cleanup EXIT

cat > "$TEMP_DIR/maxim-postgres-backup.service" <<EOF
[Unit]
Description=MAXIM validated PostgreSQL backup
Requires=docker.service
After=docker.service
ConditionPathExists=$ROOT_DIR/infra/scripts/backup-postgres.sh

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
EnvironmentFile=-/etc/maxim-postgres-backup.env
ExecStart=$ROOT_DIR/infra/scripts/backup-postgres.sh
UMask=0077
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF

cat > "$TEMP_DIR/maxim-postgres-backup.timer" <<'EOF'
[Unit]
Description=Run MAXIM PostgreSQL backup daily

[Timer]
OnCalendar=*-*-* 03:20:00
RandomizedDelaySec=20m
Persistent=true
Unit=maxim-postgres-backup.service

[Install]
WantedBy=timers.target
EOF

cat > "$TEMP_DIR/maxim-postgres-restore-smoke.service" <<EOF
[Unit]
Description=MAXIM isolated PostgreSQL restore smoke
Requires=docker.service
After=docker.service maxim-postgres-backup.service
ConditionPathExists=$ROOT_DIR/infra/scripts/restore-postgres-backup-smoke.sh

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
EnvironmentFile=-/etc/maxim-postgres-backup.env
ExecStart=$ROOT_DIR/infra/scripts/restore-postgres-backup-smoke.sh
UMask=0077
Nice=15
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF

cat > "$TEMP_DIR/maxim-postgres-restore-smoke.timer" <<'EOF'
[Unit]
Description=Verify a MAXIM PostgreSQL backup can be restored weekly

[Timer]
OnCalendar=Sun *-*-* 05:30:00
RandomizedDelaySec=30m
Persistent=true
Unit=maxim-postgres-restore-smoke.service

[Install]
WantedBy=timers.target
EOF

for unit in "$TEMP_DIR"/*; do
  sudo install -o root -g root -m 0644 "$unit" "$UNIT_DIR/$(basename "$unit")"
done

sudo systemctl daemon-reload
if [[ "$ENABLE_BACKUP_TIMER" == "1" ]]; then
  if ! sudo test -f "$BACKUP_ENV_FILE"; then
    echo "Refusing to enable backup timer without $BACKUP_ENV_FILE." >&2
    exit 2
  fi
  sudo systemctl enable --now maxim-postgres-backup.timer
else
  echo "Backup timer installed but left disabled. Configure $BACKUP_ENV_FILE and a separate backup volume, then run the service once before enabling the timer."
fi

if [[ "$ENABLE_RESTORE_TIMER" == "1" ]]; then
  if ! sudo test -f "$BACKUP_ENV_FILE"; then
    echo "Refusing to enable restore-smoke timer without $BACKUP_ENV_FILE." >&2
    exit 2
  fi
  sudo systemctl enable --now maxim-postgres-restore-smoke.timer
else
  echo "Restore-smoke timer installed but left disabled. Enable it only with a separate disposable volume sized for a full restore."
fi

sudo systemctl list-timers --all \
  maxim-postgres-backup.timer maxim-postgres-restore-smoke.timer --no-pager
