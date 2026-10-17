import { Prisma } from '../prisma/prisma-client';
import { buildEffectivePublicationDeliveryStatusSql } from './publication-legacy-automated-absence';

export function deliverySchema(schema = 'public'): Prisma.Sql {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid observation schema');
  return Prisma.raw(`"${schema}"`);
}
export function buildPublicationDeliveryIndexesQuery(
  cohort = false,
  schema = 'public',
): Prisma.Sql {
  const required: Array<[string, string, string[], boolean]> = [
    ['managed_broadcast_deliveries_pkey', 'managed_broadcast_deliveries', ['id'], true],
    ['managed_broadcasts_pkey', 'managed_broadcasts', ['id'], true],
    ['publication_occurrences_pkey', 'publication_occurrences', ['id'], true],
    ['publication_content_revisions_pkey', 'publication_content_revisions', ['id'], true],
  ];
  required.push(
    cohort
      ? [
          'managed_broadcast_deliveries_dispatch_status_created_id_idx',
          'managed_broadcast_deliveries',
          ['dispatch_profile', 'status', 'created_at', 'id'],
          false,
        ]
      : ['max_action_ledger_job_id_key', 'max_action_ledger', ['job_id'], true],
  );
  deliverySchema(schema);
  return Prisma.sql`WITH required(index_name,table_name,columns,unique_index) AS (VALUES ${Prisma.join(required.map(([index, table, columns, unique]) => Prisma.sql`(${index},${table},ARRAY[${Prisma.join(columns)}]::text[],${unique}::boolean)`))})
    SELECT bool_and(EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
      JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace
      WHERE i.indexrelid=to_regclass(quote_ident(${schema})||'.'||quote_ident(required.index_name))
      AND i.indrelid=to_regclass(quote_ident(${schema})||'.'||quote_ident(required.table_name))
      AND ns.nspname=${schema} AND c.relnamespace=t.relnamespace
      AND t.relkind='r' AND t.relpersistence='p' AND c.relkind='i' AND c.relpersistence='p'
      AND NOT t.relhassubclass AND NOT t.relispartition
      AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=t.oid)
      AND c.reloptions IS NULL AND c.reltablespace=0 AND NOT i.indisexclusion AND i.indimmediate
      AND i.indisprimary=(right(required.index_name,5)='_pkey')
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indisunique=required.unique_index
      AND am.amname='btree' AND i.indnkeyatts=cardinality(required.columns) AND i.indnatts=cardinality(required.columns)
      AND 0=ALL(i.indoption::smallint[]) AND i.indexprs IS NULL AND i.indpred IS NULL
      AND ARRAY(SELECT pg_get_indexdef(i.indexrelid,n,false) FROM generate_series(1,cardinality(required.columns)) n ORDER BY n)
        = ARRAY(SELECT quote_ident(name) FROM unnest(required.columns) name)
      AND NOT EXISTS (
        SELECT 1 FROM unnest(i.indkey::smallint[],i.indclass::oid[],i.indcollation::oid[])
          AS key_options(attribute_number,operator_class,key_collation)
        JOIN pg_attribute attribute ON attribute.attrelid=i.indrelid AND attribute.attnum=key_options.attribute_number
        JOIN pg_opclass operator_class ON operator_class.oid=key_options.operator_class
        JOIN pg_namespace operator_namespace ON operator_namespace.oid=operator_class.opcnamespace
        WHERE NOT operator_class.opcdefault OR operator_namespace.nspname<>'pg_catalog'
          OR key_options.key_collation<>attribute.attcollation
      ))) AS ready FROM required`;
}
const columns = [
  'id',
  'broadcast_id',
  'occurrence_index',
  'target_chat_id',
  'bot_id',
  'required_bot_id',
  'publication_occurrence_id',
  'content_revision_id',
  'dispatch_profile',
  'status',
  'created_at',
  'attempt_count',
  'remote_message_id',
  'sent_at',
  'legacy_sent_without_remote_id',
  'locked_at',
  'remote_message_verified_at',
  'remote_message_verification_attempt_count',
  'remote_message_verification_absent_count',
  'remote_message_verification_present_count',
  'remote_message_verification_attempted_at',
  'remote_message_verification_next_at',
  'remote_message_verification_source',
  'next_attempt_at',
  'first_deferred_at',
  'last_deferred_at',
  'capacity_deferral_count',
  'rate_limit_deferral_count',
  'dispatch_blocked_at',
  'pin_status',
  'delete_status',
  'post_actions_next_at',
] as const;
const boundedIdentityColumns: ReadonlySet<(typeof columns)[number]> = new Set([
  'broadcast_id',
  'target_chat_id',
  'bot_id',
  'required_bot_id',
  'publication_occurrence_id',
  'content_revision_id',
  'remote_message_id',
]);
export function deliveryScalarProjection(): Prisma.Sql {
  const camel = (name: string) =>
    name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return Prisma.sql`${Prisma.join(columns.map((column) => Prisma.raw(`${boundedIdentityColumns.has(column) ? `CASE WHEN length(delivery."${column}")>512 THEN '' ELSE delivery."${column}" END` : `delivery."${column}"`} AS "${camel(column)}"`)))},
    (delivery.lock_token IS NOT NULL) AS "hasLockToken",
    left(delivery.wait_reason,65) AS "waitReason", left(delivery.dispatch_blocker_code,129) AS "dispatchBlockerCode",
    (delivery.last_error_code='PUBLIK_LEDGER_DISPATCH_V1') IS TRUE AS "hasDispatchMarker",
    (delivery.remote_message_verification_last_error IS NOT NULL) AS "hasVerificationError",
    ${buildEffectivePublicationDeliveryStatusSql()} AS "effectiveStatus"`;
}
export function deliveryParentsCte(schema = 'public'): Prisma.Sql {
  const ns = deliverySchema(schema);
  return Prisma.sql`broadcast_ids AS MATERIALIZED (SELECT DISTINCT "broadcastId" AS id FROM details),
    broadcasts AS MATERIALIZED (SELECT parent.* FROM broadcast_ids CROSS JOIN LATERAL (
      SELECT id,publication_occurrence_id,dispatch_profile,required_bot_id,created_at FROM ${ns}.managed_broadcasts WHERE id=broadcast_ids.id OFFSET 0) parent),
    occurrence_ids AS MATERIALIZED (SELECT DISTINCT "publicationOccurrenceId" AS id FROM details WHERE "publicationOccurrenceId" IS NOT NULL),
    occurrences AS MATERIALIZED (SELECT parent.* FROM occurrence_ids CROSS JOIN LATERAL (
      SELECT id,publication_id,required_bot_id,dispatch_profile,created_at,scheduled_at,delivery_deadline_at,retry_authorized_at,retry_expires_at,
        left(dispatch_blocker_code,129) AS dispatch_blocker_code,dispatch_blocked_at FROM ${ns}.publication_occurrences WHERE id=occurrence_ids.id OFFSET 0) parent),
    content_ids AS MATERIALIZED (SELECT DISTINCT "contentRevisionId" AS id FROM details WHERE "contentRevisionId" IS NOT NULL),
    contents AS MATERIALIZED (SELECT parent.* FROM content_ids CROSS JOIN LATERAL (
      SELECT id,publication_id,created_at FROM ${ns}.publication_content_revisions WHERE id=content_ids.id OFFSET 0) parent)`;
}
export function deliveryParentsProjection(): Prisma.Sql {
  return Prisma.sql`broadcasts.id AS "parentBroadcastId", broadcasts.publication_occurrence_id AS "broadcastOccurrenceId", broadcasts.dispatch_profile AS "broadcastProfile", broadcasts.required_bot_id AS "broadcastRequiredBotId", broadcasts.created_at AS "broadcastCreatedAt",
    occurrences.id AS "parentOccurrenceId", occurrences.publication_id AS "publicationId", occurrences.required_bot_id AS "occurrenceRequiredBotId", occurrences.dispatch_profile AS "occurrenceProfile", occurrences.created_at AS "occurrenceCreatedAt", occurrences.scheduled_at AS "scheduledAt", occurrences.delivery_deadline_at AS "deliveryDeadlineAt", occurrences.retry_authorized_at AS "retryAuthorizedAt", occurrences.retry_expires_at AS "retryExpiresAt", occurrences.dispatch_blocker_code AS "parentBlockerCode", occurrences.dispatch_blocked_at AS "parentBlockedAt",
    contents.id AS "parentContentRevisionId", contents.publication_id AS "contentPublicationId", contents.created_at AS "contentCreatedAt"`;
}
export function deliveryParentsJoin(): Prisma.Sql {
  return Prisma.sql`LEFT JOIN broadcasts ON broadcasts.id=details."broadcastId"
    LEFT JOIN occurrences ON occurrences.id=details."publicationOccurrenceId"
    LEFT JOIN contents ON contents.id=details."contentRevisionId"`;
}
export function buildPublicationDeliveryEvidenceQuery(id: string, schema = 'public'): Prisma.Sql {
  const ns = deliverySchema(schema);
  return Prisma.sql`WITH details AS MATERIALIZED (SELECT ${deliveryScalarProjection()} FROM ${ns}.managed_broadcast_deliveries delivery WHERE delivery.id=${id} AND delivery.dispatch_profile='PUBLIK_V1'), ${deliveryParentsCte(schema)}
    SELECT details.*, ${deliveryParentsProjection()}, (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "observedAt"
    FROM details ${deliveryParentsJoin()}`;
}
export function buildPublicationDeliveryLedgerQuery(
  keys: readonly string[],
  schema = 'public',
): Prisma.Sql {
  if (keys.length < 1 || keys.length > 2) throw new Error('Bounded exact action keys required');
  const ns = deliverySchema(schema);
  return Prisma.sql`SELECT job_id AS "jobId",action_type AS "actionType",chat_id AS "chatId",source_tag AS "sourceTag",bot_id AS "botId",dispatch_bot_id AS "dispatchBotId",status,ambiguous,terminal,
    dispatch_token IS NOT NULL AS "hasDispatchToken",dispatch_started_at AS "dispatchStartedAt",remote_message_id AS "remoteMessageId",first_attempt_at AS "firstAttemptAt",last_attempt_at AS "lastAttemptAt",completed_at AS "completedAt",created_at AS "createdAt",
    CASE WHEN jsonb_typeof(metadata#>'{routing,requiredBotId}')='string' THEN left(metadata#>>'{routing,requiredBotId}',513) END AS "requiredBotId"
    FROM ${ns}.max_action_ledger WHERE job_id IN (${Prisma.join(keys)})`;
}
