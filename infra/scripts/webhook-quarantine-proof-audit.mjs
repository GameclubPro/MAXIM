import { pathToFileURL } from 'node:url';
import {
  buildQuarantinePrivilegesSql,
  validateQuarantineMinute,
} from './webhook-quarantine-audit.mjs';
import { emitOwnerProofPrivilegesSql } from './webhook-owner-proof-audit.mjs';

export const QUARANTINE_PROOF_COMMAND_RESULT_MAX_BYTES = 32768;
export const QUARANTINE_PROOF_ERROR_MAX_BYTES = 8192;
export const QUARANTINE_PROOF_TEXT_MAX_BYTES = 8192;
// FLAG: JavaScript trim includes these exact WhiteSpace and LineTerminator characters.
// Default SQL btrim omits tabs, NBSP and BOM and must not claim runtime shape validity.
const jsWhitespaceSql = String.raw`U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'`;
const nonblank = (value) => `btrim(${value}, ${jsWhitespaceSql}) <> ''`;

// FLAG: Rejected text must remain distinguishable from a genuine SQL NULL. Carry
// admission/presence separately; comparisons and trim never inspect rejected values.
const boundedText = (column) => `CASE WHEN ${column} IS NULL THEN 'absent'
  WHEN pg_column_compression(${column}) IS NOT NULL THEN 'compressed_not_inspected'
  WHEN pg_column_size(${column}) > ${QUARANTINE_PROOF_TEXT_MAX_BYTES} THEN 'oversized_not_inspected'
  ELSE 'bounded' END AS ${column}_admission,
  CASE WHEN pg_column_compression(${column}) IS NULL
    AND pg_column_size(${column}) <= ${QUARANTINE_PROOF_TEXT_MAX_BYTES}
    THEN ${column} ELSE NULL END AS bounded_${column}`;
const uninspected = (admission) =>
  `${admission} IN ('compressed_not_inspected','oversized_not_inspected')`;

const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const indexes = [
  ['webhook_events_pkey', 'webhook_events', ['id'], true, true],
  [
    'webhook_events_status_created_at_id_idx',
    'webhook_events',
    ['status', 'created_at', 'id'],
    false,
    false,
  ],
  [
    'webhook_dependency_quarantines_pkey',
    'webhook_dependency_quarantines',
    ['receipt_id', 'blocker_id'],
    true,
    true,
  ],
  ['webhook_execution_claims_pkey', 'webhook_execution_claims', ['id'], true, true],
  [
    'webhook_execution_claims_kind_semantic_key',
    'webhook_execution_claims',
    ['kind', 'semantic_key'],
    true,
    false,
  ],
  [
    'webhook_execution_claims_event_kind_idx',
    'webhook_execution_claims',
    ['webhook_event_id', 'kind'],
    false,
    false,
  ],
];

// FLAG: Require the complete six lookup definitions, not only names or LIMITs.
export const quarantineProofIndexesSql = `WITH expected(name, parent, keys, is_unique, is_primary) AS (VALUES
${indexes
  .map(
    ([name, parent, keys, unique, primary]) =>
      `(${literal(name)}, ${literal(parent)}, ARRAY[${keys.map(literal)}], ${unique}, ${primary})`,
  )
  .join(',\n')}
)
SELECT NOT EXISTS (
  SELECT 1 FROM expected e
  LEFT JOIN pg_class i ON i.oid = to_regclass('public.' || e.name)
  LEFT JOIN pg_index s ON s.indexrelid = i.oid
  LEFT JOIN pg_am m ON m.oid = i.relam
  LEFT JOIN pg_class parent ON parent.oid = s.indrelid
  WHERE NOT COALESCE(
    i.relkind = 'i' AND i.reltablespace = 0 AND i.reloptions IS NULL
    AND s.indrelid = to_regclass('public.' || e.parent)
    AND parent.relkind = 'r' AND NOT parent.relrowsecurity AND NOT parent.relispartition
    AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent = parent.oid OR inhrelid = parent.oid)
    AND s.indisvalid AND s.indisready AND s.indislive AND NOT s.indisexclusion
    AND NOT s.indnullsnotdistinct AND s.indimmediate
    AND s.indisunique = e.is_unique AND s.indisprimary = e.is_primary
    AND m.amname = 'btree' AND s.indnkeyatts = cardinality(e.keys) AND s.indnatts = cardinality(e.keys)
    AND ARRAY(SELECT pg_get_indexdef(i.oid, n, false) FROM generate_series(1, s.indnkeyatts) n) = e.keys
    AND s.indexprs IS NULL AND s.indpred IS NULL
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indoption::smallint[]) v WHERE v <> 0)
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indclass::oid[]) c
      JOIN pg_opclass o ON o.oid = c WHERE NOT o.opcdefault OR o.opcnamespace <> 'pg_catalog'::regnamespace)
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indkey::smallint[], s.indcollation::oid[]) k(attnum, collation_oid)
      LEFT JOIN pg_attribute a ON a.attrelid = s.indrelid AND a.attnum = k.attnum
      WHERE k.attnum = 0 OR k.collation_oid <> a.attcollation), false)
) AS quarantine_proof_indexes_ready;`;

const receiptStatus = (value) => `CASE WHEN ${value}::text IN
  ('RECEIVED','QUEUED','PROCESSED','DUPLICATE','FAILED','NO_REPLAY_HELD','CANCELLED','QUARANTINED')
  THEN ${value}::text WHEN ${value} IS NULL THEN 'missing' ELSE 'other' END`;
const errorFamily = (value, admission) => `CASE
  WHEN ${admission} IN ('compressed_not_inspected','oversized_not_inspected') THEN ${admission}
  WHEN ${value} IS NULL THEN 'none'
  WHEN ${value} = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required'
    THEN 'legacy_execution_unverified'
  WHEN ${value} = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:CANONICAL_BUSINESS_ALREADY_STARTED; durable-effects recovery required'
    THEN 'canonical_business_started'
  WHEN starts_with(${value}, 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:') THEN 'other_pending_quarantine'
  WHEN starts_with(${value}, 'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:') THEN 'terminal_quarantine'
  WHEN ${value} = 'Handler completion claim changed' THEN 'completion_claim_changed'
  ELSE 'other' END`;

export function buildQuarantineProofAuditSql(minute, explain = false, privateBlockerIds = false) {
  validateQuarantineMinute(minute);
  if (typeof explain !== 'boolean' || typeof privateBlockerIds !== 'boolean')
    throw new Error('Invalid quarantine proof options');
  // FLAG: Capping precedes every deeper lookup: 65->64 receipts, 5->4 links,
  // distinct over at most 256 retained links, then 17->16 blockers and <=3 claims each.
  // Stored keys are diagnostic metadata. Do not reconstruct source or infer replay authority.
  // FLAG: PG16 size/compression inspect TOAST metadata without detoasting. Reject any
  // compressed or oversized journal/text in the table projection before MATERIALIZED
  // storage or value operators; compressed pg_column_size alone cannot bound decoded work.
  const query = `WITH bounds AS MATERIALIZED (
    SELECT '${minute}'::timestamp AS from_at, '${minute}'::timestamp + interval '1 minute' AS until_at,
      statement_timestamp() AT TIME ZONE 'UTC' AS observed_at
  ), receipt_heads AS MATERIALIZED (
    SELECT h.id, h.created_at FROM bounds CROSS JOIN LATERAL (
      SELECT id, created_at FROM webhook_events
      WHERE status = 'QUARANTINED' AND created_at >= bounds.from_at AND created_at < bounds.until_at
      ORDER BY created_at, id LIMIT 65
    ) h WHERE bounds.until_at <= bounds.observed_at
  ), receipt_sample AS MATERIALIZED (
    SELECT * FROM receipt_heads ORDER BY created_at, id LIMIT 64
  ), receipts AS MATERIALIZED (
    SELECT r.id, r.created_at, row_number() OVER (ORDER BY r.created_at, r.id) AS receipt_ordinal,
      m.id IS NOT NULL AS receipt_found, m.bounded_semantic_key AS semantic_key, m.semantic_key_admission
    FROM receipt_sample r LEFT JOIN LATERAL (
      SELECT id, ${boundedText('semantic_key')} FROM webhook_events WHERE id = r.id OFFSET 0
    ) m ON true
  ), journal_heads AS MATERIALIZED (
    SELECT r.receipt_ordinal, j.*,
      row_number() OVER (PARTITION BY r.receipt_ordinal ORDER BY j.blocker_id) AS link_ordinal
    FROM receipts r CROSS JOIN LATERAL (
      SELECT blocker_id, anchor_id,
        CASE WHEN pg_column_compression(state) IS NOT NULL THEN 'compressed_not_inspected'
          WHEN pg_column_size(state) > ${QUARANTINE_PROOF_TEXT_MAX_BYTES} THEN 'oversized_not_inspected'
          WHEN state IN ('WAITING','EXPIRED','RELEASED') THEN state ELSE 'other' END AS state,
        deadline_at, created_at, next_check_at, resolved_at
      FROM webhook_dependency_quarantines WHERE receipt_id = r.id ORDER BY blocker_id LIMIT 5
    ) j
  ), links AS MATERIALIZED (
    SELECT * FROM journal_heads WHERE link_ordinal <= 4
  ), blocker_heads AS MATERIALIZED (
    SELECT DISTINCT blocker_id FROM links ORDER BY blocker_id LIMIT 17
  ), blocker_sample AS MATERIALIZED (
    SELECT blocker_id FROM blocker_heads ORDER BY blocker_id LIMIT 16
  ), blockers AS MATERIALIZED (
    SELECT s.blocker_id, row_number() OVER (ORDER BY s.blocker_id) AS blocker_ordinal,
      b.id IS NOT NULL AS blocker_found, b.bounded_semantic_key AS semantic_key, b.semantic_key_admission, b.status, b.created_at, b.processed_at,
      b.error_message_admission, b.bounded_error_message, b.next_enqueue_at, b.timeout_quarantine_expires_at, b.execution_deadline_at
    FROM blocker_sample s LEFT JOIN LATERAL (
      SELECT id, ${boundedText('semantic_key')}, status, created_at, processed_at, next_enqueue_at,
        timeout_quarantine_expires_at, execution_deadline_at,
        CASE WHEN error_message IS NULL THEN 'absent'
          WHEN pg_column_compression(error_message) IS NOT NULL THEN 'compressed_not_inspected'
          WHEN pg_column_size(error_message) > ${QUARANTINE_PROOF_ERROR_MAX_BYTES} THEN 'oversized_not_inspected'
          ELSE 'bounded' END AS error_message_admission,
        CASE WHEN pg_column_compression(error_message) IS NULL
          AND pg_column_size(error_message) <= ${QUARANTINE_PROOF_ERROR_MAX_BYTES}
          THEN error_message ELSE NULL END AS bounded_error_message
      FROM webhook_events WHERE id = s.blocker_id OFFSET 0
    ) b ON true
  ), semantic_claims AS MATERIALIZED (
    SELECT b.blocker_ordinal, c.id FROM blockers b CROSS JOIN LATERAL (
      SELECT id FROM webhook_execution_claims
      WHERE kind = 'EXECUTION' AND semantic_key = b.semantic_key
        AND b.blocker_found AND length(b.semantic_key) BETWEEN 1 AND 512
      LIMIT 1
    ) c
  ), linked_claims AS MATERIALIZED (
    SELECT b.blocker_ordinal, c.id FROM blockers b CROSS JOIN LATERAL (
      SELECT id FROM webhook_execution_claims
      WHERE webhook_event_id = b.blocker_id AND kind = 'EXECUTION' LIMIT 2
    ) c
  ), claim_keys AS MATERIALIZED (
    SELECT blocker_ordinal, id, bool_or(source = 'semantic') AS from_semantic,
      bool_or(source = 'linked') AS from_linked
    FROM (
      SELECT blocker_ordinal, id, 'semantic' AS source FROM semantic_claims UNION ALL
      SELECT blocker_ordinal, id, 'linked' AS source FROM linked_claims
    ) bounded_keys GROUP BY blocker_ordinal, id
  ), claims AS MATERIALIZED (
    SELECT k.blocker_ordinal, row_number() OVER (PARTITION BY k.blocker_ordinal ORDER BY k.id) AS claim_ordinal,
      k.from_semantic, k.from_linked, c.id IS NOT NULL AS claim_found,
      c.kind, c.bounded_semantic_key AS semantic_key, c.semantic_key_admission, c.webhook_event_id,
      c.bounded_execution_bot_id AS execution_bot_id, c.execution_bot_id_admission, c.enforced, c.status,
      c.prepared_at, c.business_started_at, c.completed_at, c.bounded_lease_token AS lease_token,
      c.lease_token_present, c.lease_token_admission, c.lease_expires_at,
      CASE WHEN c.id IS NULL THEN 'missing' ELSE c.command_result_admission END AS command_result_admission,
      c.bounded_command_result
    FROM claim_keys k LEFT JOIN LATERAL (
      SELECT id, kind, ${boundedText('semantic_key')}, webhook_event_id,
        ${boundedText('execution_bot_id')}, enforced, status, prepared_at, business_started_at, completed_at,
        lease_token IS NOT NULL AS lease_token_present, ${boundedText('lease_token')}, lease_expires_at,
        CASE WHEN command_result IS NULL THEN 'absent'
          WHEN pg_column_compression(command_result) IS NOT NULL THEN 'compressed_not_inspected'
          WHEN pg_column_size(command_result) > ${QUARANTINE_PROOF_COMMAND_RESULT_MAX_BYTES} THEN 'oversized_not_inspected'
          ELSE 'bounded' END AS command_result_admission,
        CASE WHEN pg_column_compression(command_result) IS NULL
          AND pg_column_size(command_result) <= ${QUARANTINE_PROOF_COMMAND_RESULT_MAX_BYTES}
          THEN command_result ELSE NULL END AS bounded_command_result
      FROM webhook_execution_claims WHERE id = k.id OFFSET 0
    ) c ON true
  ), claim_owners AS MATERIALIZED (
    SELECT c.*, o.id AS owner_id, o.bounded_semantic_key AS owner_semantic_key,
      o.semantic_key_admission AS owner_semantic_key_admission, o.status AS owner_status,
      o.processed_at AS owner_processed_at, o.next_enqueue_at AS owner_next_enqueue_at,
      o.timeout_quarantine_expires_at AS owner_timeout_boundary,
      o.error_message_admission AS owner_error_message_admission, o.bounded_error_message AS owner_bounded_error_message
    FROM claims c LEFT JOIN LATERAL (
      SELECT id, ${boundedText('semantic_key')}, status, processed_at, next_enqueue_at, timeout_quarantine_expires_at,
        CASE WHEN error_message IS NULL THEN 'absent'
          WHEN pg_column_compression(error_message) IS NOT NULL THEN 'compressed_not_inspected'
          WHEN pg_column_size(error_message) > ${QUARANTINE_PROOF_ERROR_MAX_BYTES} THEN 'oversized_not_inspected'
          ELSE 'bounded' END AS error_message_admission,
        CASE WHEN pg_column_compression(error_message) IS NULL
          AND pg_column_size(error_message) <= ${QUARANTINE_PROOF_ERROR_MAX_BYTES}
          THEN error_message ELSE NULL END AS bounded_error_message
      FROM webhook_events WHERE id = c.webhook_event_id OFFSET 0
    ) o ON true
  ), marker_checks AS MATERIALIZED (
    SELECT c.*,
      coalesce(jsonb_typeof(bounded_command_result) = 'object', false) AS marker_object,
      coalesce(bounded_command_result->>'kind' = 'EXECUTION_FINISHED', false) AS marker_kind_matches,
      coalesce(bounded_command_result->>'authorityVersion' = 'semantic-owner-lease-v1', false) AS marker_version_matches,
      coalesce(bounded_command_result->'webhookEventId' = to_jsonb(owner_id), false) AS marker_owner_matches,
      CASE WHEN ${uninspected('semantic_key_admission')} THEN NULL
        ELSE coalesce(bounded_command_result->'semanticKey' = to_jsonb(semantic_key), false) END AS marker_semantic_matches,
      CASE WHEN ${uninspected('execution_bot_id_admission')} THEN NULL
        ELSE coalesce(bounded_command_result->'executionBotId' = coalesce(to_jsonb(execution_bot_id), 'null'::jsonb), false) END
        AS marker_executor_matches,
      CASE WHEN isfinite(business_started_at) AND extract(year FROM business_started_at) BETWEEN 1 AND 9999
        THEN coalesce(bounded_command_result->'businessStartedAt' =
          to_jsonb(to_char(business_started_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), false)
        ELSE false END AS marker_started_matches,
      coalesce(jsonb_typeof(bounded_command_result->'finishedAt') = 'string', false) AS marker_finished_string,
      coalesce(isfinite(prepared_at), false) AS prepared_at_finite,
      coalesce(isfinite(business_started_at), false) AS business_started_at_finite,
      CASE WHEN ${uninspected('execution_bot_id_admission')} THEN NULL
        ELSE coalesce(claim_found AND (execution_bot_id IS NULL OR ${nonblank('execution_bot_id')}), false) END AS executor_shape_valid,
      CASE WHEN ${uninspected('lease_token_admission')} THEN NULL
        ELSE claim_found AND (lease_token IS NULL) = (lease_expires_at IS NULL)
          AND (lease_token IS NULL OR ${nonblank('lease_token')})
          AND (lease_expires_at IS NULL OR isfinite(lease_expires_at)) END AS lease_pair_valid,
      CASE WHEN NOT claim_found THEN 'missing'
        WHEN ${uninspected('lease_token_admission')} THEN 'not_inspected'
        WHEN lease_token IS NULL AND lease_expires_at IS NULL THEN 'absent'
        WHEN lease_token IS NULL OR lease_expires_at IS NULL OR NOT (${nonblank('lease_token')})
          OR NOT isfinite(lease_expires_at) THEN 'malformed'
        WHEN lease_expires_at > bounds.observed_at THEN 'unexpired' ELSE 'expired' END AS lease_state
    FROM claim_owners c CROSS JOIN bounds
  ), claim_output AS MATERIALIZED (
    SELECT c.blocker_ordinal, c.claim_ordinal, json_build_object(
      'claim_ordinal', c.claim_ordinal, 'claim_found', c.claim_found,
      'found_by_semantic_key', c.from_semantic, 'found_by_linked_receipt', c.from_linked,
      'kind_is_execution', coalesce(c.kind = 'EXECUTION', false),
      'claim_status', CASE WHEN c.status::text IN ('PENDING','READY','COMPLETED') THEN c.status::text
        WHEN c.status IS NULL THEN 'missing' ELSE 'other' END,
      'enforced', coalesce(c.enforced, false),
      'claim_semantic_key_admission', c.semantic_key_admission,
      'claim_saved_semantic_matches_blocker', CASE
        WHEN ${uninspected('c.semantic_key_admission')} OR ${uninspected('b.semantic_key_admission')} THEN NULL
        ELSE coalesce(c.semantic_key = b.semantic_key, false) END,
      'owner_found', c.owner_id IS NOT NULL,
      'owner_is_blocker', coalesce(c.owner_id = b.blocker_id, false),
      'owner_semantic_key_admission', c.owner_semantic_key_admission,
      'owner_saved_semantic_matches_claim', CASE
        WHEN ${uninspected('c.owner_semantic_key_admission')} OR ${uninspected('c.semantic_key_admission')} THEN NULL
        ELSE coalesce(c.owner_semantic_key = c.semantic_key, false) END,
      'owner_status', ${receiptStatus('c.owner_status')},
      'owner_processed_at', c.owner_processed_at,
      'owner_retry_scheduled', c.owner_next_enqueue_at IS NOT NULL,
      'owner_timeout_boundary', c.owner_timeout_boundary,
      'owner_error_family', CASE WHEN c.owner_id IS NULL THEN 'missing_owner' ELSE ${errorFamily('c.owner_bounded_error_message', 'c.owner_error_message_admission')} END,
      'prepared_at', c.prepared_at, 'prepared_at_finite', c.prepared_at_finite,
      'business_started_at', c.business_started_at, 'business_started_at_finite', c.business_started_at_finite,
      'completed_at', c.completed_at, 'completed_at_finite', coalesce(isfinite(c.completed_at), false),
      'execution_bot_id_admission', c.execution_bot_id_admission, 'executor_shape_valid', c.executor_shape_valid,
      'lease_token_admission', c.lease_token_admission,
      'lease_present', coalesce(c.lease_token_present, false), 'lease_pair_valid', c.lease_pair_valid,
      'lease_state', c.lease_state,
      'finished_marker', json_build_object(
        'admission', c.command_result_admission, 'object', c.marker_object, 'kind_matches', c.marker_kind_matches,
        'version_matches', c.marker_version_matches, 'owner_matches', c.marker_owner_matches,
        'semantic_matches', c.marker_semantic_matches, 'executor_matches', c.marker_executor_matches,
        'business_started_matches', c.marker_started_matches, 'finished_at_string', c.marker_finished_string,
        'matching_metadata', coalesce(c.marker_object AND c.marker_kind_matches AND c.marker_version_matches
          AND c.marker_owner_matches AND c.marker_semantic_matches AND c.marker_executor_matches
          AND c.marker_started_matches AND c.marker_finished_string, false),
        'runtime_validation', 'not_evaluated')
    ) AS item
    FROM marker_checks c JOIN blockers b USING (blocker_ordinal)
  ), blocker_output AS MATERIALIZED (
    SELECT b.blocker_ordinal, json_build_object(
      'blocker_ordinal', b.blocker_ordinal, 'blocker_found', b.blocker_found,
      ${privateBlockerIds ? "'private_blocker_receipt_id', CASE WHEN b.blocker_found AND octet_length(b.blocker_id) BETWEEN 1 AND 128 AND b.blocker_id ~ '^[A-Za-z0-9_-]+$' THEN b.blocker_id ELSE NULL END," : ''}
      'status', ${receiptStatus('b.status')}, 'created_at', b.created_at,
      'processed_at', b.processed_at, 'retry_scheduled', b.next_enqueue_at IS NOT NULL,
      'timeout_boundary', b.timeout_quarantine_expires_at, 'execution_deadline_at', b.execution_deadline_at,
      'error_family', CASE WHEN NOT b.blocker_found THEN 'missing_blocker' ELSE ${errorFamily('b.bounded_error_message', 'b.error_message_admission')} END,
      'saved_semantic_key_admission', b.semantic_key_admission,
      'saved_semantic_key_supported', CASE WHEN ${uninspected('b.semantic_key_admission')} THEN NULL
        ELSE coalesce(length(b.semantic_key) BETWEEN 1 AND 512, false) END,
      'semantic_claim_lookup_state', CASE WHEN NOT b.blocker_found THEN 'missing_blocker'
        WHEN ${uninspected('b.semantic_key_admission')} THEN 'not_inspected'
        WHEN b.semantic_key IS NULL THEN 'missing_key'
        WHEN length(b.semantic_key) NOT BETWEEN 1 AND 512 THEN 'unsupported_key'
        WHEN EXISTS (SELECT 1 FROM semantic_claims s WHERE s.blocker_ordinal = b.blocker_ordinal) THEN 'found'
        ELSE 'not_found' END,
      'semantic_claim_found', CASE WHEN ${uninspected('b.semantic_key_admission')} THEN NULL
        ELSE EXISTS (SELECT 1 FROM semantic_claims s WHERE s.blocker_ordinal = b.blocker_ordinal) END,
      'linked_claims_observed_lower_bound', (SELECT count(*) FROM linked_claims l WHERE l.blocker_ordinal = b.blocker_ordinal),
      'linked_claim_cap_reached', (SELECT count(*) >= 2 FROM linked_claims l WHERE l.blocker_ordinal = b.blocker_ordinal),
      'semantic_linked_disagreement', EXISTS (
        SELECT 1 FROM semantic_claims s JOIN linked_claims l USING (blocker_ordinal)
        WHERE s.blocker_ordinal = b.blocker_ordinal AND s.id <> l.id),
      'semantic_claim_also_linked', EXISTS (
        SELECT 1 FROM semantic_claims s JOIN linked_claims l USING (blocker_ordinal, id)
        WHERE s.blocker_ordinal = b.blocker_ordinal),
      'claims', coalesce((SELECT json_agg(c.item ORDER BY c.claim_ordinal)
        FROM claim_output c WHERE c.blocker_ordinal = b.blocker_ordinal), '[]'::json)
    ) AS item FROM blockers b
  ), receipt_output AS MATERIALIZED (
    SELECT r.receipt_ordinal, json_build_object(
      'receipt_ordinal', r.receipt_ordinal, 'created_at', r.created_at, 'receipt_found', r.receipt_found,
      'saved_semantic_key_admission', r.semantic_key_admission,
      'journal_found', EXISTS (SELECT 1 FROM journal_heads j WHERE j.receipt_ordinal = r.receipt_ordinal),
      'journal_truncated', EXISTS (SELECT 1 FROM journal_heads j WHERE j.receipt_ordinal = r.receipt_ordinal AND j.link_ordinal = 5),
      'links', coalesce((SELECT json_agg(json_build_object(
        'link_ordinal', l.link_ordinal, 'blocker_ordinal', b.blocker_ordinal,
        'proof_omitted_global_cap', b.blocker_ordinal IS NULL,
        'state', l.state,
        'created_at', l.created_at, 'deadline_at', l.deadline_at, 'next_check_at', l.next_check_at,
        'resolved_at', l.resolved_at, 'anchor_is_blocker', l.anchor_id = l.blocker_id,
        'saved_semantic_relation', CASE WHEN b.blocker_ordinal IS NULL THEN 'not_sampled'
          WHEN NOT r.receipt_found THEN 'missing_receipt' WHEN NOT b.blocker_found THEN 'missing_blocker'
          WHEN ${uninspected('r.semantic_key_admission')} OR ${uninspected('b.semantic_key_admission')} THEN 'not_inspected'
          WHEN r.semantic_key IS NULL OR length(r.semantic_key) NOT BETWEEN 1 AND 512
            OR b.semantic_key IS NULL OR length(b.semantic_key) NOT BETWEEN 1 AND 512 THEN 'unknown'
          WHEN r.semantic_key = b.semantic_key THEN 'same_key' ELSE 'different_keys' END
      ) ORDER BY l.link_ordinal) FROM links l LEFT JOIN blockers b ON b.blocker_id = l.blocker_id
        WHERE l.receipt_ordinal = r.receipt_ordinal), '[]'::json)
    ) AS item FROM receipts r
  ) SELECT json_build_object(
    'schema_version', 1, 'audit', 'webhook_quarantine_proof',
    'basis', 'currently_quarantined_receipt_created_at',
    'from', bounds.from_at, 'until', bounds.until_at, 'observed_at', bounds.observed_at,
    'window_closed', bounds.until_at <= bounds.observed_at,
    'read_only', current_setting('transaction_read_only') = 'on', 'authority', 'DIAGNOSTICS_ONLY',
    'replay_authorized', false, 'settlement_authorized', false, 'remote_effects_proven', false,
    'effect_completeness', 'unknown', 'semantic_source_rebuild', 'not_evaluated',
    'finished_timestamp_validation', 'not_evaluated',
    'lease_state_basis', 'stored_expiry_at_observed_at_not_process_liveness',
    'send_delete_sanction_coverage', 'not_evaluated',
    'sample_caps', json_build_object('receipts', 64, 'receipt_probe', 65,
      'links_per_receipt', 4, 'link_probe_per_receipt', 5, 'distinct_blockers', 16,
      'blocker_probe', 17, 'semantic_claims_per_blocker', 1, 'linked_claims_per_blocker', 2,
      'claim_details_total', 48, 'owner_probes_total', 48,
      'command_result_bytes', ${QUARANTINE_PROOF_COMMAND_RESULT_MAX_BYTES},
      'error_message_bytes', ${QUARANTINE_PROOF_ERROR_MAX_BYTES},
      'metadata_text_bytes', ${QUARANTINE_PROOF_TEXT_MAX_BYTES}),
    'sample_complete', bounds.until_at <= bounds.observed_at
      AND (SELECT count(*) <= 64 FROM receipt_heads)
      AND NOT EXISTS (SELECT 1 FROM journal_heads WHERE link_ordinal = 5)
      AND (SELECT count(*) <= 16 FROM blocker_heads)
      AND NOT EXISTS (SELECT 1 FROM linked_claims GROUP BY blocker_ordinal HAVING count(*) = 2),
    'sample_complete_meaning', 'bounded_census_only_not_health_or_effects',
    'receipts_truncated', (SELECT count(*) > 64 FROM receipt_heads),
    'sampled_receipts', (SELECT count(*) FROM receipts),
    'sampled_links', (SELECT count(*) FROM links),
    'missing_journals', (SELECT count(*) FROM receipts r WHERE NOT EXISTS
      (SELECT 1 FROM journal_heads j WHERE j.receipt_ordinal = r.receipt_ordinal)),
    'blocker_cap_reached', (SELECT count(*) > 16 FROM blocker_heads),
    'unique_blockers_observed_lower_bound', (SELECT count(*) FROM blocker_heads),
    'sampled_blockers', (SELECT count(*) FROM blockers),
    'missing_blockers', (SELECT count(*) FROM blockers WHERE NOT blocker_found),
    'missing_claim_details', (SELECT count(*) FROM claims WHERE NOT claim_found),
    'blockers_without_observed_claims', (SELECT count(*) FROM blockers b WHERE NOT EXISTS
      (SELECT 1 FROM claim_keys k WHERE k.blocker_ordinal = b.blocker_ordinal)),
    'missing_owners', (SELECT count(*) FROM claim_owners WHERE owner_id IS NULL),
    'command_results_not_inspected', (SELECT count(*) FROM claims WHERE command_result_admission
      IN ('compressed_not_inspected', 'oversized_not_inspected')),
    'receipts', coalesce((SELECT json_agg(item ORDER BY receipt_ordinal) FROM receipt_output), '[]'::json),
    'blockers', coalesce((SELECT json_agg(item ORDER BY blocker_ordinal) FROM blocker_output), '[]'::json)
  ) FROM bounds;`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

export function emitQuarantineProofAuditSql(minute, explain = false, privateBlockerIds = false) {
  // FLAG: Opaque blocker IDs are opt-in private nomination inputs, never recovery proof.
  // The same capped walk and every ordinary report guard remain in force.
  const query = buildQuarantineProofAuditSql(minute, explain, privateBlockerIds);
  return `SET LOCAL timezone = 'UTC';\nSET LOCAL search_path TO pg_catalog, public, pg_temp;\n${buildQuarantinePrivilegesSql(true)}${emitOwnerProofPrivilegesSql(true)}${quarantineProofIndexesSql.replace(/;$/u, '')}
\\gset
\\if :quarantine_proof_indexes_ready
\\else
\\echo WEBHOOK_QUARANTINE_PROOF_INDEXES_INVALID
SELECT 1 / 0;
\\endif
${query}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [minute, ...options] = process.argv.slice(2);
  try {
    if (
      options.length > 2 ||
      new Set(options).size !== options.length ||
      options.some((option) => option !== '--explain' && option !== '--private-blocker-ids')
    )
      throw new Error('Invalid quarantine proof arguments');
    process.stdout.write(
      emitQuarantineProofAuditSql(
        minute,
        options.includes('--explain'),
        options.includes('--private-blocker-ids'),
      ),
    );
  } catch {
    process.stderr.write(
      'Usage: webhook-quarantine-proof-audit.mjs <UTC-minute> [--explain] [--private-blocker-ids]\n',
    );
    process.exitCode = 2;
  }
}
