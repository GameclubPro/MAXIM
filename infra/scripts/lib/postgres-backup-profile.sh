#!/usr/bin/env bash
# FLAG: Only these named databases are admitted. No arbitrary service/user/database input
# can redirect a guarded producer or restore capacity probe into another project's store.
export MAXIM_BACKUP_PROFILE="${MAXIM_BACKUP_PROFILE:-maxim}"
case "$MAXIM_BACKUP_PROFILE" in
  maxim)
    MAXIM_BACKUP_SERVICE=postgres
    MAXIM_BACKUP_DATABASE=maxim
    MAXIM_BACKUP_PREFIX=maxim
    MAXIM_BACKUP_UNIT_PREFIX=maxim-postgres
    MAXIM_BACKUP_MIGRATIONS_TABLE=_prisma_migrations
    MAXIM_BACKUP_RESTORE_VERIFICATION=isolated_restore_and_authority_schema
    ;;
  eraser)
    MAXIM_BACKUP_SERVICE=eraser-postgres
    MAXIM_BACKUP_DATABASE=eraser
    MAXIM_BACKUP_PREFIX=eraser
    MAXIM_BACKUP_UNIT_PREFIX=maxim-eraser-postgres
    MAXIM_BACKUP_MIGRATIONS_TABLE=eraser_migrations
    MAXIM_BACKUP_RESTORE_VERIFICATION=isolated_restore_and_eraser_schema
    ;;
  *) echo 'Unknown PostgreSQL backup profile.' >&2; return 2 ;;
esac
export MAXIM_BACKUP_SERVICE MAXIM_BACKUP_DATABASE MAXIM_BACKUP_PREFIX MAXIM_BACKUP_UNIT_PREFIX
export MAXIM_BACKUP_MIGRATIONS_TABLE MAXIM_BACKUP_RESTORE_VERIFICATION
readonly MAXIM_BACKUP_SERVICE MAXIM_BACKUP_DATABASE MAXIM_BACKUP_PREFIX MAXIM_BACKUP_UNIT_PREFIX
readonly MAXIM_BACKUP_MIGRATIONS_TABLE MAXIM_BACKUP_RESTORE_VERIFICATION
maxim_backup_profile_directory() {
  if [[ "$MAXIM_BACKUP_PROFILE" == eraser ]]; then printf '%s/eraser\n' "${1%/}"; else printf '%s\n' "$1"; fi
}
maxim_backup_profile_readiness() {
  node "$ROOT_DIR/infra/scripts/probe-postgres-backup-readiness.mjs" "$1" "$2" || return
  if [[ "$MAXIM_BACKUP_PROFILE" == eraser ]]; then
    node "$ROOT_DIR/infra/scripts/check-eraser-backup-readiness.mjs"
  fi
}
