#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

AUDIT_LOCK_FILE=/tmp/maxim-postgres-audit.lock

if [[ "${1:-}" != '--apply' ]]; then
  if [[ $# -ne 0 ]]; then
    echo "Usage: $0 [--apply]" >&2
    exit 2
  fi
  cat <<'PREVIEW'
Preview only; no database state changed.

The apply step creates or hardens the passwordless maxim_audit login intended for
local Docker-socket access under the production pg_hba rules, with:
  - NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS
  - connection limit 1 and no password
  - SELECT only on webhook_events/moderation_events and pg_read_all_stats membership
  - INHERIT only so the pg_read_all_stats membership takes effect
  - read-only/time/parallel/memory/temp defaults used as a server-side backstop

Run with --apply during a reviewed maintenance step.
PREVIEW
  exit 0
fi

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 [--apply]" >&2
  exit 2
fi

for required_command in docker flock timeout; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "$required_command is required to provision the PostgreSQL audit role." >&2
    exit 1
  fi
done

exec {AUDIT_LOCK_FD}>>"$AUDIT_LOCK_FILE"
if ! flock -n "$AUDIT_LOCK_FD"; then
  echo "Refusing to change the PostgreSQL audit role while a bounded audit is running." >&2
  exit 75
fi

timeout --signal=TERM --kill-after=2s 12s \
  docker compose --env-file .env -p infra -f infra/docker-compose.yml exec -T postgres \
    env PGAPPNAME=maxim-audit-role-provision \
      PGOPTIONS='-c statement_timeout=5s -c lock_timeout=1s -c idle_in_transaction_session_timeout=5s' \
    psql -X --no-password -v ON_ERROR_STOP=1 -U maxim -d maxim <<'SQL'
BEGIN;

DO $provision$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maxim_audit') THEN
    CREATE ROLE maxim_audit
      LOGIN
      NOSUPERUSER
      INHERIT
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS
      CONNECTION LIMIT 1
      PASSWORD NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members memberships
    JOIN pg_roles granted_role ON granted_role.oid = memberships.roleid
    JOIN pg_roles member_role ON member_role.oid = memberships.member
    WHERE member_role.rolname = 'maxim_audit'
      AND granted_role.rolname NOT IN ('pg_read_all_data', 'pg_read_all_stats')
  ) THEN
    RAISE EXCEPTION 'maxim_audit has unexpected role memberships; review manually';
  END IF;
END
$provision$;

ALTER ROLE maxim_audit
  LOGIN
  NOSUPERUSER
  INHERIT
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS
  CONNECTION LIMIT 1
  PASSWORD NULL;

REVOKE pg_read_all_data FROM maxim_audit;
REVOKE ALL PRIVILEGES ON DATABASE maxim FROM maxim_audit;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM maxim_audit;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM maxim_audit;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM maxim_audit;

GRANT CONNECT ON DATABASE maxim TO maxim_audit;
GRANT USAGE ON SCHEMA public TO maxim_audit;
GRANT SELECT ON TABLE public.webhook_events, public.moderation_events TO maxim_audit;
GRANT pg_read_all_stats TO maxim_audit;

ALTER ROLE maxim_audit RESET ALL;
ALTER ROLE maxim_audit IN DATABASE maxim RESET ALL;
ALTER ROLE maxim_audit SET default_transaction_read_only = on;
ALTER ROLE maxim_audit SET statement_timeout = '5s';
ALTER ROLE maxim_audit SET lock_timeout = '1s';
ALTER ROLE maxim_audit SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE maxim_audit SET idle_session_timeout = '60s';
ALTER ROLE maxim_audit SET max_parallel_workers_per_gather = 0;
ALTER ROLE maxim_audit SET jit = off;
ALTER ROLE maxim_audit SET work_mem = '1MB';
ALTER ROLE maxim_audit SET temp_file_limit = '8MB';

DO $verify$
BEGIN
  IF NOT pg_has_role('maxim_audit', 'pg_read_all_stats', 'member')
    OR pg_has_role('maxim_audit', 'pg_read_all_data', 'member')
    OR NOT has_schema_privilege('maxim_audit', 'public', 'USAGE')
    OR has_schema_privilege('maxim_audit', 'public', 'CREATE')
    OR NOT has_table_privilege('maxim_audit', 'public.webhook_events', 'SELECT')
    OR NOT has_table_privilege('maxim_audit', 'public.moderation_events', 'SELECT')
  THEN
    RAISE EXCEPTION 'maxim_audit privilege attestation failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members memberships
    JOIN pg_roles granted_role ON granted_role.oid = memberships.roleid
    JOIN pg_roles member_role ON member_role.oid = memberships.member
    WHERE member_role.rolname = 'maxim_audit'
      AND granted_role.rolname <> 'pg_read_all_stats'
  ) THEN
    RAISE EXCEPTION 'maxim_audit has unexpected role memberships after provisioning';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE grantee = 'maxim_audit'
      AND NOT (
        table_schema = 'public'
        AND table_name IN ('webhook_events', 'moderation_events')
        AND privilege_type = 'SELECT'
      )
  ) THEN
    RAISE EXCEPTION 'maxim_audit has unexpected direct table privileges';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname !~ '^pg_toast'
      AND (
        (
          NOT (
            namespace.nspname = 'public'
            AND relation.relname IN ('webhook_events', 'moderation_events')
          )
          AND (
            has_table_privilege('maxim_audit', relation.oid, 'SELECT')
            OR EXISTS (
              SELECT 1
              FROM pg_attribute attribute
              WHERE attribute.attrelid = relation.oid
                AND attribute.attnum > 0
                AND NOT attribute.attisdropped
                AND has_column_privilege(
                  'maxim_audit',
                  relation.oid,
                  attribute.attnum,
                  'SELECT'
                )
            )
          )
        )
        OR has_table_privilege(
          'maxim_audit',
          relation.oid,
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
        OR EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          WHERE attribute.attrelid = relation.oid
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
            AND has_column_privilege(
              'maxim_audit',
              relation.oid,
              attribute.attnum,
              'INSERT,UPDATE,REFERENCES'
            )
        )
      )
  ) THEN
    RAISE EXCEPTION 'maxim_audit has unexpected effective user-relation privileges';
  END IF;
END
$verify$;

COMMIT;
SQL

echo 'PostgreSQL audit role is provisioned with bounded read-only defaults.'
