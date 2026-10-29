import { pathToFileURL } from 'node:url';

// FLAG: Map exact reviewed codes only. A new or malformed code stays OTHER_RULE;
// prefixes, suffixes and saved free text must never become report categories.
const ruleFamilies = {
  LINK: ['LINK_BLOCKED', 'LINK_BLOCKED_DELETE', 'LINK_HISTORY_RECOVERY'],
  PROFANITY: ['PROFANITY', 'PROFANITY_DELETE'],
  COMMERCIAL_TEXT: ['COMMERCIAL_AD', 'COMMERCIAL_AD_DELETE'],
  COMMERCIAL_AI: ['COMMERCIAL_LLM_DELETE'],
  COMMERCIAL_OCR: ['COMMERCIAL_OCR_DELETE', 'COMMERCIAL_OCR_MESSAGE_ACTION'],
  STOP_WORD: ['MESSAGE_BLOCKED_WORD', 'MESSAGE_BLOCKED_WORD_DELETE'],
  STOP_DOMAIN: ['MESSAGE_BLOCKED_DOMAIN', 'MESSAGE_BLOCKED_DOMAIN_DELETE'],
  STOP_WORD_GUARD: ['STOP_WORD_GUARD_REJECTED'],
  STOP_DOMAIN_GUARD: ['STOP_DOMAIN_GUARD_REJECTED'],
  STOP_OCR_GUARD: ['STOP_OCR_GUARD_REJECTED'],
  STOP_WORD_CAPABILITY: ['STOP_WORD_CAPABILITY_DEFERRED'],
  STOP_DOMAIN_CAPABILITY: ['STOP_DOMAIN_CAPABILITY_DEFERRED'],
  STOP_OCR_CAPABILITY: ['STOP_OCR_CAPABILITY_DEFERRED'],
  PHONE: ['PHONE_NUMBER_BLOCKED', 'PHONE_NUMBER_BLOCKED_DELETE'],
  MESSAGE_LENGTH: ['MESSAGE_TOO_LONG', 'MESSAGE_TOO_LONG_DELETE'],
  MESSAGE_RATE: ['MESSAGE_RATE_LIMIT', 'MESSAGE_RATE_LIMIT_DELETE'],
  MESSAGE_COUNT: ['MESSAGE_COUNT_LIMIT', 'MESSAGE_COUNT_LIMIT_DELETE'],
  MEDIA_POLICY: [
    'PHOTO_BLOCKED',
    'PHOTO_BLOCKED_DELETE',
    'VIDEO_BLOCKED',
    'VIDEO_BLOCKED_DELETE',
    'FILE_BLOCKED',
    'FILE_BLOCKED_DELETE',
    'FORWARDED_MESSAGE_BLOCKED',
    'FORWARDED_MESSAGE_BLOCKED_DELETE',
  ],
  VOICE: ['VOICE_BLOCKED', 'VOICE_BLOCKED_DELETE'],
  PHOTO_RATE: ['PHOTO_RATE_LIMIT', 'PHOTO_RATE_LIMIT_DELETE'],
  STICKER_RATE: ['STICKER_RATE_LIMIT', 'STICKER_RATE_LIMIT_DELETE'],
  DUPLICATE: ['DUPLICATE_DELETE', 'DUPLICATE_MESSAGE_ACTION'],
  REQUIRED_SUBSCRIPTION: ['REQUIRED_SUBSCRIPTION', 'REQUIRED_SUBSCRIPTION_DELETE'],
  INVITATION_ACCESS: ['INVITATION_ACCESS_REQUIRED', 'INVITATION_ACCESS_DELETE'],
  MUTE_STATE: ['MUTE_ACTIVE_DELETE'],
  GLOBAL_SPAMMER: ['GLOBAL_SPAMMER_MESSAGE_DELETE', 'GLOBAL_SPAMMER_KICK'],
  BOT_ACCOUNT: ['BOT_ACCOUNT_MESSAGE_DELETE', 'BOT_ACCOUNT_KICK'],
  LOCAL_BLOCK: ['LOCAL_ADMIN_BLOCK', 'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE'],
  CLOSED_CHAT: ['NIGHT_MODE_DELETE', 'MANUAL_GROUP_CLOSE_DELETE'],
  MANUAL_SANCTION: ['MANUAL_BAN', 'MANUAL_MUTE', 'MANUAL_UNBAN', 'MANUAL_UNMUTE'],
  SERVICE_CLEANUP: [
    'ADMIN_COMMAND_CLEANUP',
    'BOT_MESSAGE_AUTO_DELETE',
    'NIGHT_MODE_CLOSE_NOTICE_CLEANUP',
    'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
    'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
    'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
    'PARTICIPANT_REPORT_COUNTER_CLEANUP',
  ],
};
const ruleFamilySql = Object.entries(ruleFamilies)
  .map(
    ([family, codes]) =>
      `WHEN rule_code IN (${codes.map((code) => `'${code}'`).join(', ')}) THEN '${family}'`,
  )
  .join('\n      ');

// FLAG: Admit fixed diagnostics only. Neither rule values nor source/error text may
// become an output category, including malformed or future metadata.
const stopWordsRejectionReasons = [
  'policy_disabled',
  'policy_changed',
  'source_changed',
  'rule_unmatched',
  'author_protected',
  'author_absent',
  'identity_changed',
  'participant_immune',
  'sanction_disabled',
  'delete_receipt_missing',
  'runtime_disabled',
  'binding_invalid',
  'binding_stale',
  'deadline_expired',
  'permission_changed',
];
const rejectionReasonsSql = stopWordsRejectionReasons.map((reason) => `'${reason}'`).join(', ');

function validateBotId(botId) {
  if (
    botId !== null &&
    (typeof botId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(botId) || botId.startsWith('--'))
  )
    throw new Error('Expected one bounded bot identifier');
}

export function parseModerationOutcomesAuditArgs(args) {
  let rest = args;
  let botId = null;
  if (rest[0] === '--bot') {
    botId = rest[1];
    validateBotId(botId);
    rest = rest.slice(2);
  }
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--explain'))
    throw new Error('Usage: moderation-outcomes-audit.mjs [--bot <bot-id>] [--explain]');
  return { explain: rest[0] === '--explain', botId };
}

export function buildModerationOutcomesIndexReadinessSql(botId = null) {
  validateBotId(botId);
  const perBot = botId !== null;
  const indexName = perBot
    ? 'moderation_events_bot_id_created_at_idx'
    : 'moderation_events_created_at_idx';
  return `SELECT EXISTS (
  SELECT 1 FROM pg_index definition
  JOIN pg_class index_relation ON index_relation.oid = definition.indexrelid
  JOIN pg_am method ON method.oid = index_relation.relam
  WHERE definition.indexrelid = to_regclass('public.${indexName}')
    AND definition.indrelid = to_regclass('public.moderation_events')
    AND definition.indisvalid AND definition.indisready AND definition.indislive
    AND method.amname = 'btree' AND definition.indnkeyatts = ${perBot ? 2 : 1} AND definition.indnatts = ${perBot ? 2 : 1}
    AND definition.indpred IS NULL AND definition.indexprs IS NULL
    AND pg_get_indexdef(definition.indexrelid, 1, true) = '${perBot ? 'bot_id' : 'created_at'}'
    AND definition.indoption[0] = 0
    ${
      perBot
        ? `AND pg_get_indexdef(definition.indexrelid, 2, true) = 'created_at'
    AND definition.indoption[1] = 3
    AND NOT definition.indisunique AND NOT definition.indisprimary AND NOT definition.indisexclusion
    AND NOT definition.indnullsnotdistinct AND definition.indimmediate
    AND index_relation.relkind = 'i' AND index_relation.reltablespace = 0 AND index_relation.reloptions IS NULL
    AND EXISTS (
      SELECT 1 FROM pg_class parent WHERE parent.oid = definition.indrelid
        AND parent.relkind = 'r' AND NOT parent.relrowsecurity AND NOT parent.relispartition
        AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent = parent.oid OR inhrelid = parent.oid)
    )
    AND definition.indcollation[0] = 'pg_catalog.default'::regcollation
    AND definition.indcollation[1] = 0`
        : ''
    }
    AND NOT EXISTS (
      SELECT 1 FROM unnest(definition.indclass) class_oid
      JOIN pg_opclass operator_class ON operator_class.oid = class_oid
      WHERE NOT operator_class.opcdefault OR operator_class.opcnamespace <> 'pg_catalog'::regnamespace
    )
) AND EXISTS (
  SELECT 1 FROM pg_attribute attribute
  WHERE attribute.attrelid = to_regclass('public.moderation_events')
    AND attribute.attname = 'created_at' AND NOT attribute.attisdropped
    AND attribute.atttypid = 'timestamp without time zone'::regtype
    AND attribute.atttypmod = 3
) ${
    perBot
      ? `AND EXISTS (
  SELECT 1 FROM pg_attribute attribute
  WHERE attribute.attrelid = to_regclass('public.moderation_events')
    AND attribute.attname = 'bot_id' AND NOT attribute.attisdropped
    AND attribute.atttypid = 'text'::regtype AND attribute.atttypmod = -1
    AND attribute.attcollation = 'pg_catalog.default'::regcollation
)`
      : ''
  } AS moderation_outcomes_index_ready \\gset
\\if :moderation_outcomes_index_ready
\\else
-- FLAG: PostgreSQL 16 psql ignores a supplied exit code on \\quit. An actual
-- SQL error under ON_ERROR_STOP must refuse admission before report execution.
\\echo MAXIM_MODERATION_OUTCOMES_INDEX_INVALID
SELECT 1 / 0;
\\endif
`;
}

export function buildModerationOutcomesAuditSql(explain = false, botId = null) {
  if (typeof explain !== 'boolean') throw new Error('Expected a fixed EXPLAIN flag');
  validateBotId(botId);
  // FLAG: Cap the sole indexed base-table walk at 513 rows and admit bounded proof
  // metadata before any materialization. The report contains only fixed evidence
  // categories and timestamps, never identities or free text.
  // A persisted MUTE proves installation, not current activation or later enforcement. Only
  // its independent verified DELETE marker proves enforcement; queue/API counters do not.
  // Only uncompressed object metadata up to 32 KiB reaches proof inspection. Rejected
  // metadata remains explicit and never becomes a positive or negative remote receipt.
  // FLAG: Singleton ANY retains the leading bot ordering path. Plain scalar equality
  // lets PostgreSQL select the global time index and filter an unbounded competing bot.
  const query = `WITH candidates AS MATERIALIZED (
  SELECT action, operator, event_type, rule_code, created_at${botId === null ? '' : ', bot_id'},
    CASE WHEN metadata IS NULL THEN 'ABSENT'
      WHEN pg_column_compression(metadata) IS NOT NULL THEN 'COMPRESSED_NOT_INSPECTED'
      WHEN pg_column_size(metadata) > 32768 THEN 'OVERSIZED_NOT_INSPECTED'
      WHEN jsonb_typeof(metadata) <> 'object' THEN 'NON_OBJECT'
      ELSE 'BOUNDED_OBJECT' END AS metadata_admission,
    CASE WHEN pg_column_compression(metadata) IS NULL AND pg_column_size(metadata) <= 32768
      THEN CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata END END AS proof
  FROM moderation_events
  WHERE created_at >= statement_timestamp() - interval '60 minutes'
    AND created_at <= statement_timestamp()
    ${botId === null ? '' : `AND bot_id = ANY(ARRAY[${explain ? '$1' : `'${botId}'`}]::text[])`}
  ORDER BY ${botId === null ? '' : 'bot_id, '}created_at DESC LIMIT 513
), sample AS MATERIALIZED (
  SELECT * FROM candidates ORDER BY created_at DESC LIMIT 512
), classified AS MATERIALIZED (
  SELECT created_at, action, rule_code, metadata_admission,
    CASE WHEN rule_code = 'COMMERCIAL_OCR_DELETE' AND proof->>'source' = 'image_text_ocr'
      AND proof->>'matchedRuleCode' IN ('MESSAGE_BLOCKED_WORD', 'MESSAGE_BLOCKED_DOMAIN')
      THEN true ELSE false END AS stop_words_ocr,
    CASE
      WHEN action = 'BAN' AND operator = 'BOT'
        AND proof->'sanctionApplied' = 'true'::jsonb
        THEN 'BAN_REMOTE_CONFIRMED'
      WHEN action = 'BAN' AND operator = 'ADMIN' AND event_type = 'MEMBER_ACTION'
        AND rule_code = 'MANUAL_BAN' AND proof->>'mode' = 'MAX_BLOCK'
        THEN 'BAN_REMOTE_CONFIRMED'
      WHEN action = 'BAN' AND operator = 'ADMIN' AND event_type = 'MEMBER_ACTION'
        AND rule_code = 'MANUAL_BAN' AND proof->>'mode' = 'MAX_REMOVE_ONLY'
        THEN 'MEMBER_REMOVAL_REMOTE_CONFIRMED'
      WHEN action = 'BAN' THEN 'BAN_EVENT_UNVERIFIED'
      WHEN action = 'MUTE' AND ((operator = 'BOT'
        AND proof->'sanctionApplied' = 'true'::jsonb)
        OR (operator = 'ADMIN' AND event_type = 'MEMBER_ACTION' AND rule_code = 'MANUAL_MUTE'))
        THEN 'MUTE_INSTALLED'
      WHEN action = 'MUTE' THEN 'MUTE_EVENT_UNVERIFIED'
      WHEN action = 'DELETE_MESSAGE' AND operator = 'BOT' AND rule_code = 'MUTE_ACTIVE_DELETE'
        AND proof->'moderationDeleteVerified' = 'true'::jsonb
        THEN 'MUTE_ENFORCEMENT_REMOTE_CONFIRMED'
      WHEN action = 'DELETE_MESSAGE' AND rule_code = 'MUTE_ACTIVE_DELETE'
        THEN 'MUTE_ENFORCEMENT_EVENT_UNVERIFIED'
      ELSE 'OTHER_EVENT'
    END AS evidence,
    CASE WHEN action = 'DELETE_MESSAGE' AND operator = 'BOT'
      AND proof->'moderationDeleteVerified' = 'true'::jsonb
      THEN true ELSE false END AS delete_remote_confirmed,
    CASE WHEN operator = 'ADMIN' THEN 'ADMIN'
      WHEN operator = 'BOT' THEN 'BOT' ELSE 'UNKNOWN' END AS origin
  FROM sample
), grouped AS (
  SELECT evidence, origin, count(*) AS count_lower_bound,
    min(created_at) AS oldest_recorded_at, max(created_at) AS newest_recorded_at
  FROM classified WHERE evidence <> 'OTHER_EVENT' GROUP BY evidence, origin
), voice_classified AS MATERIALIZED (
  SELECT created_at,
    CASE WHEN action = 'DELETE_MESSAGE' AND operator = 'BOT'
      AND proof->'moderationDeleteVerified' = 'true'::jsonb
      THEN 'VOICE_DELETE_REMOTE_CONFIRMED'
      ELSE 'VOICE_EVENT_WITHOUT_DELETE_PROOF' END AS evidence
  FROM sample WHERE rule_code IN ('VOICE_BLOCKED', 'VOICE_BLOCKED_DELETE')
), voice_grouped AS (
  SELECT evidence, count(*) AS count_lower_bound,
    min(created_at) AS oldest_recorded_at, max(created_at) AS newest_recorded_at
  FROM voice_classified GROUP BY evidence
), family_classified AS MATERIALIZED (
  SELECT created_at, origin,
    CASE WHEN stop_words_ocr THEN 'STOP_OCR'
      ${ruleFamilySql}
      ELSE 'OTHER_RULE' END AS rule_family,
    CASE WHEN action IN ('NONE', 'WARN', 'DELETE_MESSAGE', 'MUTE', 'KICK', 'BAN')
      THEN action::text ELSE 'UNKNOWN' END AS action,
    CASE WHEN evidence <> 'OTHER_EVENT' THEN evidence
      WHEN delete_remote_confirmed THEN 'DELETE_REMOTE_CONFIRMED'
      WHEN action = 'DELETE_MESSAGE' THEN 'DELETE_EVENT_UNVERIFIED'
      WHEN action = 'KICK' THEN 'KICK_EVENT_UNVERIFIED'
      WHEN action = 'WARN' THEN 'WARN_EVENT_WITHOUT_DELIVERY_PROOF'
      WHEN action = 'NONE' THEN 'DECISION_EVENT_ONLY'
      ELSE 'UNKNOWN_ACTION_EVENT' END AS evidence
  FROM classified
), family_grouped AS (
  SELECT rule_family, action, origin, evidence, count(*) AS count_lower_bound,
    min(created_at) AS oldest_recorded_at, max(created_at) AS newest_recorded_at
  FROM family_classified GROUP BY rule_family, action, origin, evidence
), metadata_grouped AS (
  SELECT metadata_admission, count(*) AS count_lower_bound
  FROM classified GROUP BY metadata_admission
), stop_words_classified AS MATERIALIZED (
  SELECT created_at,
    CASE WHEN rule_code IN ('MESSAGE_BLOCKED_WORD', 'MESSAGE_BLOCKED_WORD_DELETE', 'STOP_WORD_GUARD_REJECTED', 'STOP_WORD_CAPABILITY_DEFERRED') THEN 'WORD'
      WHEN rule_code IN ('MESSAGE_BLOCKED_DOMAIN', 'MESSAGE_BLOCKED_DOMAIN_DELETE', 'STOP_DOMAIN_GUARD_REJECTED', 'STOP_DOMAIN_CAPABILITY_DEFERRED') THEN 'DOMAIN'
      ELSE 'OCR' END AS source,
    CASE WHEN operator = 'BOT' AND action = 'NONE'
      AND rule_code IN ('STOP_WORD_CAPABILITY_DEFERRED', 'STOP_DOMAIN_CAPABILITY_DEFERRED', 'STOP_OCR_CAPABILITY_DEFERRED')
      AND proof->>'stopWordsRejectionReason' = 'permission_changed' THEN 'GUARD_DEFERRED'
      WHEN operator = 'BOT' AND action = 'NONE'
      AND rule_code IN ('STOP_WORD_GUARD_REJECTED', 'STOP_DOMAIN_GUARD_REJECTED', 'STOP_OCR_GUARD_REJECTED')
      THEN 'GUARD_REJECTED'
      WHEN operator = 'BOT' AND action = 'DELETE_MESSAGE'
        AND proof->'moderationDeleteVerified' = 'true'::jsonb THEN 'DELETE_REMOTE_CONFIRMED'
      WHEN operator = 'BOT' AND action IN ('NONE', 'WARN', 'MUTE', 'BAN')
        AND rule_code IN ('MESSAGE_BLOCKED_WORD', 'MESSAGE_BLOCKED_DOMAIN') THEN 'DETECTED'
      ELSE 'OUTCOME_UNKNOWN' END AS evidence,
    CASE WHEN operator = 'BOT' AND action = 'NONE'
      AND rule_code IN ('STOP_WORD_GUARD_REJECTED', 'STOP_DOMAIN_GUARD_REJECTED', 'STOP_OCR_GUARD_REJECTED',
        'STOP_WORD_CAPABILITY_DEFERRED', 'STOP_DOMAIN_CAPABILITY_DEFERRED', 'STOP_OCR_CAPABILITY_DEFERRED')
      AND proof->>'stopWordsRejectionReason' IN (${rejectionReasonsSql})
      THEN proof->>'stopWordsRejectionReason' ELSE 'UNSPECIFIED' END AS rejection_reason
  FROM sample WHERE rule_code IN (
    'MESSAGE_BLOCKED_WORD', 'MESSAGE_BLOCKED_WORD_DELETE', 'MESSAGE_BLOCKED_DOMAIN', 'MESSAGE_BLOCKED_DOMAIN_DELETE',
    'STOP_WORD_GUARD_REJECTED', 'STOP_DOMAIN_GUARD_REJECTED', 'STOP_OCR_GUARD_REJECTED',
    'STOP_WORD_CAPABILITY_DEFERRED', 'STOP_DOMAIN_CAPABILITY_DEFERRED', 'STOP_OCR_CAPABILITY_DEFERRED')
    OR (rule_code = 'COMMERCIAL_OCR_DELETE' AND proof->>'source' = 'image_text_ocr'
      AND proof->>'matchedRuleCode' IN ('MESSAGE_BLOCKED_WORD', 'MESSAGE_BLOCKED_DOMAIN'))
), stop_words_grouped AS (
  SELECT source, evidence, rejection_reason, count(*) AS count_lower_bound,
    min(created_at) AS oldest_recorded_at, max(created_at) AS newest_recorded_at
  FROM stop_words_classified GROUP BY source, evidence, rejection_reason
)
SELECT json_build_object(
  'schema_version', 3, 'audit', 'recent_moderation_outcomes',
  'window_start_at', statement_timestamp() - interval '60 minutes',
  'window_end_at', statement_timestamp(), 'window_basis', 'event_recorded_at',
  'sample_cap', 512, 'sampled_events', (SELECT count(*) FROM sample),
  'sample_truncated', (SELECT count(*) > 512 FROM candidates),
  'sample_complete', (SELECT count(*) <= 512 FROM candidates),
  'oldest_recorded_at', (SELECT min(created_at) FROM sample),
  'newest_recorded_at', (SELECT max(created_at) FROM sample),
  'sample_span_seconds', (SELECT extract(epoch FROM max(created_at) - min(created_at)) FROM sample),
  'selection_basis', '${botId === null ? 'GLOBAL_LATEST_RECORDED_EVENTS' : 'ONE_BOT_LATEST_RECORDED_EVENTS'}',
  'bot_scope', '${botId === null ? 'ALL_RECORDED_BOTS' : 'ONE_REQUESTED_BOT'}',
  'null_bot_events_in_scope', ${botId === null ? 'true' : 'false'},
  'denominator_basis', 'SAMPLED_EVENTS_NOT_UNIQUE_ACTIONS_OR_ELIGIBLE_INPUTS',
  'rule_family_counts_additive', true, 'compatibility_rows_overlap_rule_families', true,
  'rule_eligible_inputs_observed', false, 'rule_policy_checked', false,
  'bot_chat_coverage_proven', false, 'action_latency_proven', false,
  'metadata_inspection_max_bytes', 32768,
  'other_events', (SELECT count(*) FROM classified WHERE evidence = 'OTHER_EVENT'),
  'all_attempts_observed', false, 'current_mute_state_proven', false,
  'voice_eligible_inputs_observed', false, 'voice_policy_checked', false,
  'fleet_health_proven', false,
  'stop_words_detection_coverage_proven', false, 'stop_words_all_guard_rejections_observed', false,
  'stop_words_rows', coalesce((SELECT json_agg(stop_words_grouped ORDER BY source, evidence, rejection_reason) FROM stop_words_grouped), '[]'::json),
  'metadata_rows', coalesce((SELECT json_agg(metadata_grouped ORDER BY metadata_admission) FROM metadata_grouped), '[]'::json),
  'rule_family_rows', coalesce((SELECT json_agg(family_grouped ORDER BY rule_family, action, origin, evidence) FROM family_grouped), '[]'::json),
  'voice_rows', coalesce((SELECT json_agg(voice_grouped ORDER BY evidence) FROM voice_grouped), '[]'::json),
  'rows', coalesce((SELECT json_agg(grouped ORDER BY evidence, origin) FROM grouped), '[]'::json)
);`;
  // FLAG: A literal scoped EXPLAIN would publish the requested identifier in its
  // Index Cond. Its generic prepared plan exposes only $1 and never executes rows.
  if (explain && botId !== null)
    return `SET LOCAL plan_cache_mode = force_generic_plan;
PREPARE moderation_outcomes_scoped_plan(text) AS ${query}
EXPLAIN (FORMAT JSON) EXECUTE moderation_outcomes_scoped_plan('${botId}');
DEALLOCATE moderation_outcomes_scoped_plan;\n`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { explain, botId } = parseModerationOutcomesAuditArgs(process.argv.slice(2));
  process.stdout.write(
    buildModerationOutcomesIndexReadinessSql(botId) +
      buildModerationOutcomesAuditSql(explain, botId),
  );
}
