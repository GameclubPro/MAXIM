import { Prisma } from '../prisma/prisma-client';

export function buildSafetyDeskDeleteCohortIndexQuery(): Prisma.Sql {
  // FLAG: Runtime uses public; isolated native fixtures use their first schema. Both
  // relations must exist in that exact schema, so search-path fallback cannot attest them.
  return Prisma.sql`WITH required(index_name, table_name, columns, is_unique, is_primary) AS (VALUES
    ('moderation_delete_intents_status_created_id_idx', 'moderation_delete_intents',
      ARRAY['status', 'created_at', 'id'], false, false),
    ('moderation_delete_intents_pkey', 'moderation_delete_intents', ARRAY['id'], true, true)
  ) SELECT bool_and(EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class index_relation ON index_relation.oid = i.indexrelid
    JOIN pg_class table_relation ON table_relation.oid = i.indrelid
    JOIN pg_namespace namespace ON namespace.oid = table_relation.relnamespace
    JOIN pg_am access_method ON access_method.oid = index_relation.relam
    WHERE namespace.nspname = current_schema()
      AND index_relation.relnamespace = table_relation.relnamespace
      AND table_relation.relkind = 'r' AND table_relation.relpersistence = 'p'
      AND NOT table_relation.relhassubclass AND NOT table_relation.relispartition
      AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = table_relation.oid)
      AND index_relation.relkind = 'i' AND index_relation.relpersistence = 'p'
      AND index_relation.reloptions IS NULL AND index_relation.reltablespace = 0
      AND i.indexrelid = to_regclass(format('%I.%I', current_schema(), required.index_name))
      AND i.indrelid = to_regclass(format('%I.%I', current_schema(), required.table_name))
      AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indisunique = required.is_unique AND i.indisprimary = required.is_primary
      AND NOT i.indisexclusion AND i.indimmediate
      AND access_method.amname = 'btree'
      AND i.indnkeyatts = cardinality(required.columns)
      AND i.indnatts = cardinality(required.columns)
      AND 0 = ALL(i.indoption::smallint[])
      AND i.indexprs IS NULL AND i.indpred IS NULL
      AND ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, false)
        FROM generate_series(1, cardinality(required.columns)) n ORDER BY n) =
        ARRAY(SELECT quote_ident(column_name) FROM unnest(required.columns) column_name)
      AND NOT EXISTS (
        SELECT 1 FROM unnest(i.indkey::smallint[], i.indclass::oid[], i.indcollation::oid[])
          AS key_options(attribute_number, operator_class, collation_oid)
        JOIN pg_attribute attribute ON attribute.attrelid = i.indrelid
          AND attribute.attnum = key_options.attribute_number
        JOIN pg_opclass operator_class ON operator_class.oid = key_options.operator_class
        JOIN pg_namespace operator_namespace ON operator_namespace.oid = operator_class.opcnamespace
        WHERE NOT operator_class.opcdefault OR operator_namespace.nspname <> 'pg_catalog'
          OR key_options.collation_oid <> attribute.attcollation
      )
  )) AS ready FROM required`;
}

export function buildSafetyDeskDeleteCohortQuery(): Prisma.Sql {
  // FLAG: Include OBSERVED without treating observation as authority. Cap each immutable
  // created-at partition before receipt reads; the sentinel never loads receipt metadata.
  // FLAG: Inline the stable statement clock so PostgreSQL estimates the actual recent
  // range and keeps the ordered index head; a generic range can read/sort every match.
  return Prisma.sql`WITH bounds AS NOT MATERIALIZED (
    SELECT (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS observed_at,
      (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '930 seconds' AS from_at,
      (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '30 seconds' AS until_at
  ), statuses(status) AS (VALUES
    ('OBSERVED'::"ModerationDeleteIntentStatus"), ('PENDING'::"ModerationDeleteIntentStatus"),
    ('IN_PROGRESS'::"ModerationDeleteIntentStatus"), ('RETRYABLE'::"ModerationDeleteIntentStatus"),
    ('WAITING_CAPABILITY'::"ModerationDeleteIntentStatus"), ('AMBIGUOUS'::"ModerationDeleteIntentStatus"),
    ('SUCCEEDED'::"ModerationDeleteIntentStatus"), ('ALREADY_ABSENT'::"ModerationDeleteIntentStatus"),
    ('EXPIRED'::"ModerationDeleteIntentStatus"), ('FAILED_TERMINAL'::"ModerationDeleteIntentStatus")
  ), heads AS MATERIALIZED (
    SELECT statuses.status, head.id, head.created_at
    FROM statuses CROSS JOIN bounds
    LEFT JOIN LATERAL (
      SELECT id, created_at FROM moderation_delete_intents
      WHERE status = statuses.status AND created_at >= bounds.from_at AND created_at < bounds.until_at
      ORDER BY status, created_at, id LIMIT 513
    ) head ON true
  ), samples AS MATERIALIZED (
    SELECT * FROM (
      SELECT *, row_number() OVER (PARTITION BY status ORDER BY created_at, id) AS ordinal
      FROM heads WHERE id IS NOT NULL
    ) ranked WHERE ordinal <= 512
  ), details AS MATERIALIZED (
    SELECT samples.status, samples.id, samples.created_at, metadata.*
    FROM samples CROSS JOIN LATERAL (
      SELECT execute_at, next_attempt_at, retry_until_at, delete_dispatch_started_at,
        remote_delete_succeeded_at, completed_at, absence_verified_at, lease_expires_at,
        CASE WHEN length(remote_delete_succeeded_bot_id) > 512 THEN repeat(' ', 513)
          ELSE remote_delete_succeeded_bot_id END AS remote_delete_succeeded_bot_id,
        CASE WHEN length(succeeded_bot_id) > 512 THEN repeat(' ', 513) ELSE succeeded_bot_id END AS succeeded_bot_id,
        CASE WHEN length(absence_verified_bot_id) > 512 THEN repeat(' ', 513)
          ELSE absence_verified_bot_id END AS absence_verified_bot_id,
        CASE WHEN length(absence_verification_code) > 512 THEN repeat(' ', 513)
          ELSE absence_verification_code END AS absence_verification_code,
        NULLIF(btrim(lease_token), '') IS NOT NULL AS has_lease
      FROM moderation_delete_intents WHERE id = samples.id OFFSET 0
    ) metadata
  ), status_counts AS MATERIALIZED (
    SELECT status, least(count(id), 512)::integer AS sample_count, count(id) > 512 AS truncated
    FROM heads GROUP BY status
  ) SELECT bounds.observed_at AS "observedAt", bounds.from_at AS "windowStartedAt",
    bounds.until_at AS "windowEndedAt", status_counts.status,
    status_counts.sample_count AS "sampleCount", status_counts.truncated,
    details.id, details.created_at AS "createdAt", details.execute_at AS "executeAt",
    details.next_attempt_at AS "nextAttemptAt", details.retry_until_at AS "retryUntilAt",
    details.delete_dispatch_started_at AS "deleteDispatchStartedAt",
    details.remote_delete_succeeded_at AS "remoteDeleteSucceededAt",
    details.remote_delete_succeeded_bot_id AS "remoteDeleteSucceededBotId",
    details.succeeded_bot_id AS "succeededBotId", details.completed_at AS "completedAt",
    details.absence_verified_at AS "absenceVerifiedAt",
    details.absence_verified_bot_id AS "absenceVerifiedBotId",
    details.absence_verification_code AS "absenceVerificationCode",
    details.lease_expires_at AS "leaseExpiresAt", details.has_lease AS "hasLease"
  FROM status_counts CROSS JOIN bounds LEFT JOIN details ON details.status = status_counts.status
  ORDER BY status_counts.status, details.created_at, details.id`;
}
