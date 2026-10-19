import { pathToFileURL } from 'node:url';
import { buildQuarantinePrivilegesSql } from './webhook-quarantine-audit.mjs';
import { emitOwnerProofPrivilegesSql } from './webhook-owner-proof-audit.mjs';
import { quarantineProofIndexesSql } from './webhook-quarantine-proof-audit.mjs';

export const RECOVERY_KEY_COHORT_SCOPE_CAP = 128;
export const RECOVERY_KEY_COHORT_RECEIPT_CAP_PER_STATUS = 512;
export const RECOVERY_KEY_COHORT_SAVED_KEY_BYTES = 512;
export const RECOVERY_KEY_COHORT_SAVED_BOT_BYTES = 512;
export const RECOVERY_KEY_COHORT_TEXT_BYTES = 8192;
export const RECOVERY_KEY_COHORT_BLOCKER_CAP = 64;
export const recoveryKeyCohortStatusGuardSql = `SELECT
  ARRAY(SELECT enumlabel::text FROM pg_enum WHERE enumtypid = to_regtype('public."WebhookStatus"') ORDER BY enumsortorder)
    = ARRAY['RECEIVED','QUEUED','PROCESSED','DUPLICATE','FAILED','NO_REPLAY_HELD','CANCELLED','QUARANTINED']
  AS recovery_key_cohort_statuses_ready \\gset
\\if :recovery_key_cohort_statuses_ready
\\else
\\echo MAXIM_RECOVERY_KEY_COHORT_STATUSES_INVALID
SELECT 1 / 0;
\\endif
`;
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const jsWhitespace = String.raw`U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'`;
const trim = (value) => `btrim(${value}, ${jsWhitespace})`;
const admitted = (column, cap) =>
  `(${column} IS NOT NULL AND pg_column_compression(${column}) IS NULL AND pg_column_size(${column}) <= ${cap})`;
const textAdmission = (column, cap) => `CASE WHEN ${column} IS NULL THEN 'absent'
  WHEN pg_column_compression(${column}) IS NOT NULL THEN 'compressed_not_inspected'
  WHEN pg_column_size(${column}) > ${cap} THEN 'oversized_not_inspected' ELSE 'bounded' END`;
const boundedText = (column, cap) => `CASE WHEN ${admitted(column, cap)} THEN ${column} END`;

export function validateRecoveryKeyCohortArguments(from, scopeCsv) {
  if (
    typeof from !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(from) ||
    from.startsWith('0000-') ||
    !Number.isFinite(Date.parse(from)) ||
    new Date(from).toISOString() !== from.replace('Z', '.000Z')
  )
    throw new Error('One exact UTC second required');
  if (typeof scopeCsv !== 'string' || scopeCsv.length > RECOVERY_KEY_COHORT_SCOPE_CAP * 22)
    throw new Error('One bounded scope CSV required');
  const scopes = scopeCsv.split(',');
  if (
    scopes.length < 1 ||
    scopes.length > RECOVERY_KEY_COHORT_SCOPE_CAP ||
    scopes.some((scope) => !/^-[1-9][0-9]{0,19}$/u.test(scope)) ||
    new Set(scopes).size !== scopes.length
  )
    throw new Error('One to 128 unique exact negative chat IDs required');
  return scopes;
}

export function buildRecoveryKeyCohortAuditSql(from, scopeCsv, explain = false) {
  const scopes = validateRecoveryKeyCohortArguments(from, scopeCsv);
  if (typeof explain !== 'boolean') throw new Error('One fixed boolean explain flag required');
  const scopeValues = scopes.map((scope, index) => `(${index + 1}, ${literal(scope)})`).join(',\n');
  // FLAG: All eight indexed status/time lanes are capped globally before scope filtering.
  // Saved key attribution is metadata evidence only: source/parser/action equivalence,
  // commit completeness, original-owner settlement and recovery remain unproved.
  // FLAG: Admit the original saved key and bot columns by physical size/compression
  // before any text operation. No source document is read or reconstructed here.
  const control = String.raw`U&'[\0001-\001F\007F-\009F]'`;
  const ordinary = String.raw`^message:message_(created|edited):(-[1-9][0-9]{0,19}):(.+)$`;
  const fields = (names, alias = '') =>
    names.map((name) => (alias ? `${alias}.${name}` : name)).join(', ');
  const sampleFields = ['status', 'id', 'created_at', 'ordinal'];
  const metadataFields = [
    'found',
    'saved_key_admission',
    'saved_key',
    'saved_bot_admission',
    'saved_bot',
    'error_admission',
    'dormant',
    'processed_at',
    'execution_deadline_at',
    'source_disposition_present',
    'legacy_disposition_present',
  ];
  const metadataProjection = [...sampleFields, ...metadataFields];
  const admittedProjection = [...metadataProjection, 'saved_bot_trimmed', 'framing'];
  const unwrappedProjection = [...admittedProjection, 'ordinary_key', 'key_attribution'];
  const parsedProjection = [...unwrappedProjection, 'parts'];
  const classifiedProjection = [
    ...parsedProjection,
    'chat_id',
    'scope_admission',
    'key_attribution_result',
    'publisher_observation',
    'saved_message_kind',
  ];
  const journalFields = [
    'blocker_id',
    'anchor_id',
    'state',
    'state_admission',
    'journal_created_at',
    'deadline_at',
    'resolved_at',
  ];
  const linkFields = [
    'scope_ordinal',
    'receipt_id',
    'receipt_created_at',
    'receipt_status',
    'execution_deadline_at',
    ...journalFields,
    'link_ordinal',
  ];
  const query = `WITH bounds AS MATERIALIZED (
    SELECT ${literal(from)}::timestamp AS from_at, ${literal(from)}::timestamp + interval '5 seconds' AS until_at,
      statement_timestamp() AT TIME ZONE 'UTC' AS observed_at,
      ${literal(from)}::timestamp + interval '35 seconds' <= statement_timestamp() AT TIME ZONE 'UTC' AS closed
  ), requested(scope_ordinal, chat_id) AS (VALUES ${scopeValues}),
  statuses(status) AS (VALUES ('RECEIVED'::"WebhookStatus"),('QUEUED'::"WebhookStatus"),
    ('PROCESSED'::"WebhookStatus"),('DUPLICATE'::"WebhookStatus"),('FAILED'::"WebhookStatus"),
    ('NO_REPLAY_HELD'::"WebhookStatus"),('CANCELLED'::"WebhookStatus"),('QUARANTINED'::"WebhookStatus")),
  heads AS MATERIALIZED (
    SELECT statuses.status, h.id, h.created_at FROM statuses CROSS JOIN bounds CROSS JOIN LATERAL (
      SELECT id, created_at FROM webhook_events
      WHERE status = statuses.status AND created_at >= bounds.from_at AND created_at < bounds.until_at AND bounds.closed
      ORDER BY created_at,id LIMIT 513
    ) h
  ), samples AS MATERIALIZED (
    SELECT ${fields(sampleFields)} FROM (SELECT status,id,created_at, row_number() OVER (PARTITION BY status ORDER BY created_at,id) AS ordinal
      FROM heads) numbered WHERE ordinal <= 512
  ), metadata AS MATERIALIZED (
    SELECT ${fields(sampleFields, 's')}, ${fields(metadataFields, 'm')} FROM samples s LEFT JOIN LATERAL (
      SELECT true AS found,
        ${textAdmission('semantic_key', RECOVERY_KEY_COHORT_SAVED_KEY_BYTES)} AS saved_key_admission,
        ${boundedText('semantic_key', RECOVERY_KEY_COHORT_SAVED_KEY_BYTES)} AS saved_key,
        ${textAdmission('bot_id', RECOVERY_KEY_COHORT_SAVED_BOT_BYTES)} AS saved_bot_admission,
        ${boundedText('bot_id', RECOVERY_KEY_COHORT_SAVED_BOT_BYTES)} AS saved_bot,
        ${textAdmission('error_message', RECOVERY_KEY_COHORT_TEXT_BYTES)} AS error_admission,
        CASE WHEN error_message IS NULL THEN false WHEN ${admitted('error_message', RECOVERY_KEY_COHORT_TEXT_BYTES)}
          THEN error_message = 'DORMANT_BOT_OBSERVATION_V1' END AS dormant,
        processed_at, execution_deadline_at,
        source_disposition_id IS NOT NULL AS source_disposition_present,
        legacy_disposition_id IS NOT NULL AS legacy_disposition_present
      FROM webhook_events WHERE id = s.id OFFSET 0
    ) m ON true
  ), admitted_keys AS MATERIALIZED (
    SELECT ${fields(metadataProjection, 'm')}, ${trim('saved_bot')} AS saved_bot_trimmed,
      CASE WHEN saved_key_admission <> 'bounded' THEN saved_key_admission
        WHEN saved_key ~ ${control} THEN 'control_bearing'
        WHEN saved_key <> ${trim('saved_key')} THEN 'untrimmed'
        WHEN saved_key ~ ${literal(ordinary)} THEN 'ordinary'
        WHEN starts_with(saved_key, 'publisher-observation:v1:') THEN 'publisher_candidate'
        ELSE 'unsupported_framing' END AS framing
    FROM metadata m
  ), unwrapped_keys AS MATERIALIZED (
    SELECT ${fields(admittedProjection, 'a')},
      CASE WHEN framing='ordinary' THEN saved_key
        WHEN framing='publisher_candidate' AND saved_bot_admission='bounded'
          AND saved_bot_trimmed<>'' AND saved_bot_trimmed !~ ${control}
          AND starts_with(saved_key, 'publisher-observation:v1:' || saved_bot_trimmed || ':')
        THEN substring(saved_key FROM length('publisher-observation:v1:' || saved_bot_trimmed || ':')+1) END AS ordinary_key,
      CASE WHEN framing='publisher_candidate' AND (saved_bot_admission<>'bounded'
        OR saved_bot_trimmed='' OR saved_bot_trimmed ~ ${control}) THEN 'publisher_bot_unavailable'
        WHEN framing='publisher_candidate' AND NOT starts_with(saved_key,
          'publisher-observation:v1:' || saved_bot_trimmed || ':') THEN 'publisher_prefix_mismatch'
        ELSE framing END AS key_attribution
    FROM admitted_keys a
  ), parsed_keys AS MATERIALIZED (
    SELECT ${fields(unwrappedProjection, 'u')}, regexp_match(ordinary_key, ${literal(ordinary)}) AS parts FROM unwrapped_keys u
  ), classified AS MATERIALIZED (
    SELECT ${fields(parsedProjection, 'p')}, parts[2] AS chat_id,
      CASE WHEN parts IS NOT NULL THEN 'assigned' ELSE 'unknown' END AS scope_admission,
      CASE WHEN parts IS NOT NULL THEN 'assigned'
        WHEN key_attribution IN ('ordinary','publisher_candidate') THEN 'unsupported_framing'
        ELSE key_attribution END AS key_attribution_result,
      coalesce(framing='publisher_candidate' AND parts IS NOT NULL,false) AS publisher_observation,
      parts[1] AS saved_message_kind
    FROM parsed_keys p
  ), scoped AS MATERIALIZED (
    SELECT r.scope_ordinal, ${fields(classifiedProjection, 'c')} FROM classified c JOIN requested r USING(chat_id)
    WHERE c.scope_admission = 'assigned'
  ), journal_heads AS MATERIALIZED (
    SELECT s.scope_ordinal, s.id AS receipt_id, s.created_at AS receipt_created_at, s.status AS receipt_status,
      s.execution_deadline_at, ${fields(journalFields, 'j')}, row_number() OVER (PARTITION BY s.id ORDER BY j.blocker_id) AS link_ordinal
    FROM scoped s CROSS JOIN LATERAL (
      SELECT blocker_id, anchor_id, ${boundedText('state', 32)} AS state,
        ${textAdmission('state', 32)} AS state_admission, created_at AS journal_created_at,
        deadline_at, resolved_at
      FROM webhook_dependency_quarantines WHERE receipt_id = s.id ORDER BY blocker_id LIMIT 5
    ) j
  ), links AS MATERIALIZED (
    SELECT ${fields(linkFields)}, coalesce(state_admission = 'bounded' AND state IN ('WAITING','EXPIRED','RELEASED')
      AND isfinite(journal_created_at) AND journal_created_at >= receipt_created_at AND journal_created_at <= bounds.observed_at
      AND isfinite(deadline_at) AND deadline_at = execution_deadline_at
      AND CASE WHEN state = 'WAITING' THEN resolved_at IS NULL ELSE isfinite(resolved_at)
        AND resolved_at >= journal_created_at AND resolved_at <= bounds.observed_at END
      AND CASE WHEN state = 'EXPIRED' THEN deadline_at <= resolved_at ELSE true END, false) AS journal_valid
    FROM journal_heads CROSS JOIN bounds WHERE link_ordinal <= 4
  ), blocker_heads AS MATERIALIZED (
    SELECT DISTINCT blocker_id FROM links ORDER BY blocker_id LIMIT 65
  ), blocker_samples AS MATERIALIZED (
    SELECT blocker_id FROM blocker_heads ORDER BY blocker_id LIMIT 64
  ), blockers AS MATERIALIZED (
    SELECT s.blocker_id, b.found,b.created_at,b.semantic_key FROM blocker_samples s LEFT JOIN LATERAL (
      SELECT true AS found, created_at,
        ${boundedText('semantic_key', RECOVERY_KEY_COHORT_SAVED_KEY_BYTES)} AS semantic_key
      FROM webhook_events WHERE id = s.blocker_id OFFSET 0
    ) b ON true
  ), semantic_claim_keys AS MATERIALIZED (
    SELECT b.blocker_id, c.id, true AS from_semantic, false AS from_linked FROM blockers b CROSS JOIN LATERAL (
      SELECT id FROM webhook_execution_claims WHERE kind = 'EXECUTION' AND semantic_key = b.semantic_key
        AND length(b.semantic_key) BETWEEN 1 AND 512 LIMIT 1
    ) c
  ), linked_claim_keys AS MATERIALIZED (
    SELECT b.blocker_id, c.id, false AS from_semantic, true AS from_linked FROM blockers b CROSS JOIN LATERAL (
      SELECT id FROM webhook_execution_claims WHERE webhook_event_id = b.blocker_id AND kind = 'EXECUTION'
      LIMIT 2
    ) c
  ), claim_keys AS MATERIALIZED (
    SELECT blocker_id,id,bool_or(from_semantic) AS from_semantic,bool_or(from_linked) AS from_linked
    FROM (SELECT blocker_id,id,from_semantic,from_linked FROM semantic_claim_keys UNION ALL SELECT blocker_id,id,from_semantic,from_linked FROM linked_claim_keys) all_keys GROUP BY blocker_id,id
  ), claims AS MATERIALIZED (
    SELECT k.blocker_id,k.from_semantic,k.from_linked,c.found,c.kind,c.status,c.enforced,c.webhook_event_id,c.prepared_at,c.business_started_at,c.completed_at,c.command_result_absent,c.lease_absent,c.semantic_key FROM claim_keys k LEFT JOIN LATERAL (
      SELECT true AS found, kind,status,enforced,webhook_event_id,prepared_at,business_started_at,completed_at,
        command_result IS NULL AS command_result_absent,
        lease_token IS NULL AND lease_expires_at IS NULL AS lease_absent,
        ${boundedText('semantic_key', RECOVERY_KEY_COHORT_SAVED_KEY_BYTES)} AS semantic_key
      FROM webhook_execution_claims WHERE id = k.id OFFSET 0
    ) c ON true
  ), blocker_summaries AS MATERIALIZED (
    SELECT b.blocker_id,b.found,b.created_at,
      coalesce((SELECT count(*) = 1 AND bool_and(c.found AND c.from_semantic AND c.from_linked
        AND c.kind = 'EXECUTION' AND c.enforced AND c.status = 'READY' AND c.webhook_event_id = b.blocker_id
        AND c.semantic_key = b.semantic_key AND isfinite(c.prepared_at) AND isfinite(c.business_started_at)
        AND c.prepared_at <= c.business_started_at AND c.business_started_at <= bounds.observed_at
        AND c.completed_at IS NULL AND c.command_result_absent AND c.lease_absent)
        FROM claims c WHERE c.blocker_id = b.blocker_id),false) AS started_unfinished_metadata
    FROM blockers b CROSS JOIN bounds
  ), scope_counts AS MATERIALIZED (
    SELECT r.scope_ordinal,
      (SELECT count(*) FROM scoped s WHERE s.scope_ordinal=r.scope_ordinal) AS receipts,
      (SELECT count(*) FROM scoped s WHERE s.scope_ordinal=r.scope_ordinal AND s.dormant) AS dormant_receipts,
      (SELECT count(*) FROM scoped s WHERE s.scope_ordinal=r.scope_ordinal AND s.publisher_observation) AS publisher_receipts,
      (SELECT count(*) FROM scoped s WHERE s.scope_ordinal=r.scope_ordinal
        AND s.saved_message_kind='created') AS saved_created_key_receipts,
      (SELECT count(*) FROM scoped s WHERE s.scope_ordinal=r.scope_ordinal
        AND s.saved_message_kind='edited') AS saved_edited_key_receipts,
      (SELECT count(*) FROM scoped s WHERE s.scope_ordinal=r.scope_ordinal AND s.dormant IS NULL) AS dormant_classification_unknown,
      (SELECT count(*) FROM scoped s WHERE s.scope_ordinal=r.scope_ordinal AND s.source_disposition_present) AS source_disposition_receipts,
      (SELECT count(*) FROM scoped s WHERE s.scope_ordinal=r.scope_ordinal AND s.legacy_disposition_present) AS legacy_disposition_receipts,
      (SELECT count(DISTINCT receipt_id) FROM links l WHERE l.scope_ordinal=r.scope_ordinal
        AND l.journal_valid AND l.state IN ('WAITING','EXPIRED')) AS blocked_receipts,
      (SELECT count(DISTINCT receipt_id) FROM links l WHERE l.scope_ordinal=r.scope_ordinal
        AND l.journal_valid AND l.state IN ('WAITING','EXPIRED') AND l.deadline_at<=l.receipt_created_at) AS blocked_already_expired_at_receipt,
      (SELECT count(DISTINCT receipt_id) FROM links l WHERE l.scope_ordinal=r.scope_ordinal
        AND l.journal_valid AND l.state IN ('WAITING','EXPIRED') AND l.deadline_at>l.receipt_created_at) AS blocked_deadline_live_at_receipt,
      (SELECT count(DISTINCT receipt_id) FROM links l WHERE l.scope_ordinal=r.scope_ordinal AND l.journal_valid AND l.state='WAITING') AS waiting_receipts,
      (SELECT count(DISTINCT receipt_id) FROM links l WHERE l.scope_ordinal=r.scope_ordinal AND l.journal_valid AND l.state='EXPIRED') AS expired_receipts,
      (SELECT count(DISTINCT receipt_id) FROM links l WHERE l.scope_ordinal=r.scope_ordinal AND l.journal_valid AND l.state='RELEASED') AS released_dependency_receipts,
      EXISTS (SELECT 1 FROM journal_heads j WHERE j.scope_ordinal=r.scope_ordinal AND j.link_ordinal=5)
        OR EXISTS (SELECT 1 FROM links l WHERE l.scope_ordinal=r.scope_ordinal AND NOT l.journal_valid)
        OR EXISTS (SELECT 1 FROM scoped s WHERE s.scope_ordinal=r.scope_ordinal AND s.status='QUARANTINED'
          AND NOT EXISTS (SELECT 1 FROM journal_heads j WHERE j.receipt_id=s.id)) AS journal_coverage_unknown,
      (SELECT count(DISTINCT l.blocker_id) FROM links l JOIN blocker_summaries b USING(blocker_id)
        WHERE l.scope_ordinal=r.scope_ordinal AND b.started_unfinished_metadata) AS started_unfinished_blockers,
      (SELECT count(DISTINCT l.blocker_id) FROM links l LEFT JOIN blocker_summaries b USING(blocker_id)
        WHERE l.scope_ordinal=r.scope_ordinal AND NOT coalesce(b.found,false)) AS blocker_probes_missing_or_omitted,
      (SELECT max(extract(epoch FROM l.receipt_created_at-b.created_at)) FROM links l JOIN blocker_summaries b USING(blocker_id)
        WHERE l.scope_ordinal=r.scope_ordinal AND b.found AND isfinite(b.created_at) AND b.created_at<=l.receipt_created_at) AS max_blocker_age_at_receipt_seconds
    FROM requested r
  ), coverage AS MATERIALIZED (
    SELECT bounds.closed AND NOT EXISTS (SELECT 1 FROM heads GROUP BY status HAVING count(*)>512) AS receipt_selection_complete,
      NOT EXISTS (SELECT 1 FROM classified WHERE scope_admission='unknown') AS scope_assignment_complete
    FROM bounds
  ) SELECT json_build_object(
    'schema_version',1,'audit','webhook_recovery_key_cohort','authority','DIAGNOSTICS_ONLY',
    'basis','all_status_saved_receipt_key_created_at',
    'scope_semantics','saved_message_key_scope_attribution','normalized_crosscheck','NOT_EVALUATED',
    'all_accepted_message_scope_coverage','UNPROVED','from',bounds.from_at,'until',bounds.until_at,'observed_at',bounds.observed_at,
    'window_seconds',5,'closure_grace_seconds',30,'window_closed',bounds.closed,
    'replay_authorized',false,'settlement_authorized',false,'remote_effects_proven',false,
    'execution_progress','UNPROVED','canonical_execution_finished_proof','not_evaluated',
    'source_rebuild','not_evaluated','original_owner_disposition','separate_inventory_and_sealed_postflight_required',
    'scope_ordinals_are_metric_labels',false,
    'caps',json_build_object('scopes',128,'receipts_per_status',512,'receipt_probe_per_status',513,
      'links_per_receipt',4,'link_probe_per_receipt',5,'blockers',64,'blocker_probe',65,
      'semantic_claims_per_blocker',1,'linked_claims_per_blocker',2,'claim_pk_probes',192,
      'saved_key_bytes',512,'saved_bot_bytes',512,'text_bytes',8192),
    'receipt_selection_complete',coverage.receipt_selection_complete,
    'saved_key_scope_assignment_complete',coverage.scope_assignment_complete,
    'saved_key_scope_assignment_unknown_receipts',(SELECT count(*) FROM classified WHERE scope_admission='unknown'),
    'key_attribution_counts',(SELECT json_object_agg(reason,n) FROM (
      SELECT reason,(SELECT count(*) FROM classified c WHERE c.key_attribution_result=reason) AS n
      FROM (VALUES ('assigned'),('absent'),('compressed_not_inspected'),('oversized_not_inspected'),
        ('control_bearing'),('untrimmed'),('unsupported_framing'),('publisher_bot_unavailable'),('publisher_prefix_mismatch')) reasons(reason)) x),
    'saved_bot_admission_counts',(SELECT json_object_agg(reason,n) FROM (
      SELECT reason,(SELECT count(*) FROM classified c WHERE c.saved_bot_admission=reason) AS n
      FROM (VALUES ('bounded'),('absent'),('compressed_not_inspected'),('oversized_not_inspected')) reasons(reason)) x),
    'blocker_probe_truncated',(SELECT count(*)>64 FROM blocker_heads),
    'sampled_receipts',(SELECT count(*) FROM samples),
    'status_rows',(SELECT json_agg(json_build_object('status',status,
      'count_lower_bound',(SELECT count(*) FROM samples s WHERE s.status=statuses.status),
      'truncated',(SELECT count(*)>512 FROM heads h WHERE h.status=statuses.status)) ORDER BY status) FROM statuses),
    'scopes',coalesce((SELECT json_agg(json_build_object(
      'scope_ordinal',scope_ordinal,'saved_message_key_receipts',receipts,'dormant_receipts',dormant_receipts,
      'publisher_observation_receipts',publisher_receipts,
      'saved_created_key_receipts',saved_created_key_receipts,'saved_edited_key_receipts',saved_edited_key_receipts,
      'dormant_classification_unknown_receipts',dormant_classification_unknown,
      'source_disposition_receipts',source_disposition_receipts,'legacy_disposition_receipts',legacy_disposition_receipts,
      'blocked_fresh_receipts_lower_bound',blocked_receipts,
      'blocked_already_expired_at_receipt_lower_bound',blocked_already_expired_at_receipt,
      'blocked_deadline_live_at_receipt_lower_bound',blocked_deadline_live_at_receipt,
      'waiting_receipts_lower_bound',waiting_receipts,
      'expired_receipts_lower_bound',expired_receipts,'released_dependency_receipts_lower_bound',released_dependency_receipts,
      'started_unfinished_blocker_metadata_lower_bound',started_unfinished_blockers,
      'blocker_probes_missing_or_omitted',blocker_probes_missing_or_omitted,
      'max_blocker_age_at_receipt_seconds',max_blocker_age_at_receipt_seconds,
      'receipt_and_dependency_coverage_complete',coverage.receipt_selection_complete AND coverage.scope_assignment_complete
        AND NOT journal_coverage_unknown AND blocker_probes_missing_or_omitted=0,
      'activity',CASE WHEN blocked_receipts>0 THEN 'BLOCKED_FRESH'
        WHEN NOT coverage.receipt_selection_complete OR NOT coverage.scope_assignment_complete OR journal_coverage_unknown
          OR blocker_probes_missing_or_omitted>0 THEN 'COVERAGE_UNKNOWN'
        WHEN receipts=0 THEN 'NO_FRESH_MESSAGE_OBSERVED' ELSE 'PENDING_PROGRESS_UNPROVED' END
    ) ORDER BY scope_ordinal) FROM scope_counts),'[]'::json)
  ) FROM bounds CROSS JOIN coverage;`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

export function emitRecoveryKeyCohortAuditSql(from, scopeCsv, explain = false) {
  const query = buildRecoveryKeyCohortAuditSql(from, scopeCsv, explain);
  return `SET LOCAL timezone = 'UTC';\nSET LOCAL search_path TO pg_catalog, public, pg_temp;\n${recoveryKeyCohortStatusGuardSql}${buildQuarantinePrivilegesSql(true)}${emitOwnerProofPrivilegesSql(true)}${quarantineProofIndexesSql.replace(/;$/u, '')}
\\gset
\\if :quarantine_proof_indexes_ready
\\else
\\echo MAXIM_RECOVERY_KEY_COHORT_INDEXES_INVALID
SELECT 1 / 0;
\\endif
${query}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [from, scopeCsv, option, ...extra] = process.argv.slice(2);
  try {
    if (extra.length || (option !== undefined && option !== '--explain'))
      throw new Error('Invalid options');
    process.stdout.write(emitRecoveryKeyCohortAuditSql(from, scopeCsv, option === '--explain'));
  } catch {
    process.stderr.write(
      'Usage: webhook-recovery-key-cohort-audit.mjs <UTC-second> <private-chat-ID-CSV> [--explain]\n',
    );
    process.exitCode = 2;
  }
}
