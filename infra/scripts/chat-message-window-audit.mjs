import { pathToFileURL } from 'node:url';
import { buildWebhookCohortIndexSql } from './webhook-cohort-audit.mjs';

export function validateChatMessageWindow(chatId, from, slice = null) {
  if (
    !/^-[1-9][0-9]{0,19}$/u.test(chatId ?? '') ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/u.test(from ?? '') ||
    !Number.isFinite(Date.parse(from)) ||
    new Date(from).toISOString() !== from.replace('Z', '.000Z')
  ) {
    throw new Error('Expected a negative chat ID and an exact UTC minute.');
  }
  if (slice !== null && (!Number.isInteger(slice) || slice < 0 || slice > 11)) {
    throw new Error('Expected a five-second slice from 0 through 11.');
  }
}

export function parseChatMessageWindowAuditArgs(args) {
  const [chatId, from, ...options] = args;
  let explain = false;
  let slice = null;
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] === '--explain' && !explain) {
      explain = true;
    } else if (
      options[index] === '--slice' &&
      slice === null &&
      /^(?:[0-9]|1[01])$/u.test(options[index + 1] ?? '')
    ) {
      slice = Number(options[++index]);
    } else {
      throw new Error(
        'Usage: chat-message-window-audit.mjs <chat-id> <UTC-minute> [--slice <0..11>] [--explain]',
      );
    }
  }
  validateChatMessageWindow(chatId, from, slice);
  return { chatId, from, explain, slice };
}

// FLAG: Hashing must not detoast a new unbounded source. Inspect only original,
// uncompressed JSON datums up to 64 KiB; rejected storage remains explicit unknown.
const hashSourceAdmission = (column) => `CASE WHEN ${column} IS NULL THEN 'absent'
  WHEN pg_column_compression(${column}) IS NOT NULL THEN 'compressed_not_inspected'
  WHEN pg_column_size(${column}) > 65536 THEN 'oversized_not_inspected'
  WHEN jsonb_typeof(${column}) <> 'object' THEN 'non_object'
  ELSE 'bounded_object' END`;

export function buildChatMessageWindowIndexSql() {
  return (
    buildWebhookCohortIndexSql() +
    `SELECT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.moderation_delete_intents_chat_message_key')
      AND i.indrelid = to_regclass('public.moderation_delete_intents')
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indisunique
      AND i.indnkeyatts = 2 AND i.indexprs IS NULL AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid, 1, false) = 'chat_id'
      AND pg_get_indexdef(i.indexrelid, 2, false) = 'message_id'
  ) AS message_window_intent_index_ready \\gset
\\if :message_window_intent_index_ready
\\else
\\echo MAXIM_MESSAGE_WINDOW_INTENT_INDEX_UNAVAILABLE
SELECT 1 / 0;
\\endif
SELECT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.moderation_delete_intent_reasons_intent_reason_key')
      AND i.indrelid = to_regclass('public.moderation_delete_intent_reasons')
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indisunique
      AND i.indnkeyatts = 2 AND i.indexprs IS NULL AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid, 1, false) = 'intent_id'
      AND pg_get_indexdef(i.indexrelid, 2, false) = 'reason_key'
  ) AS message_window_reason_index_ready \\gset
\\if :message_window_reason_index_ready
\\else
\\echo MAXIM_MESSAGE_WINDOW_REASON_INDEX_UNAVAILABLE
SELECT 1 / 0;
\\endif
`
  );
}

export function buildChatMessageWindowAuditSql(chatId, from, explain = false, slice = null) {
  validateChatMessageWindow(chatId, from, slice);
  const fromExpression =
    slice === null
      ? `'${from}'::timestamptz`
      : `('${from}'::timestamptz + interval '${slice * 5} seconds')`;
  const untilExpression =
    slice === null
      ? `('${from}'::timestamptz + interval '1 minute')`
      : `('${from}'::timestamptz + interval '${(slice + 1) * 5} seconds')`;
  // FLAG: Select covered status/time heads before loading any JSON. The per-status
  // sentinel makes truncation explicit; no message body, user ID, URL or raw error
  // leaves this report. Hashes permit comparison with an independently read source.
  // FLAG: raw_payload is independently sampled (normally 1%). The retained source
  // consumed by moderation is normalized_payload.raw; prefer it when available.
  // FLAG: Failure families describe the latest persisted failure, never its first
  // attempt or a current probe. Match fixed code/text pairs; never emit raw errors.
  const query = `WITH bounds AS MATERIALIZED (
  SELECT ${fromExpression} AT TIME ZONE 'UTC' AS from_at,
    ${untilExpression} AT TIME ZONE 'UTC' AS until_at
), statuses(status) AS (VALUES
  ('RECEIVED'::"WebhookStatus"), ('QUEUED'::"WebhookStatus"),
  ('PROCESSED'::"WebhookStatus"), ('DUPLICATE'::"WebhookStatus"),
  ('FAILED'::"WebhookStatus"), ('NO_REPLAY_HELD'::"WebhookStatus"),
  ('CANCELLED'::"WebhookStatus"), ('QUARANTINED'::"WebhookStatus")
), candidates AS MATERIALIZED (
  SELECT statuses.status, head.id, head.created_at FROM statuses CROSS JOIN bounds
  CROSS JOIN LATERAL (
    SELECT id, created_at FROM webhook_events
    WHERE status = statuses.status AND created_at >= bounds.from_at AND created_at < bounds.until_at
    ORDER BY created_at, id LIMIT 513
  ) head
), samples AS MATERIALIZED (
  SELECT * FROM (
    SELECT *, row_number() OVER (PARTITION BY status ORDER BY created_at, id) AS ordinal
    FROM candidates
  ) ranked WHERE ordinal <= 512
), details AS MATERIALIZED (
  SELECT samples.status, samples.created_at, metadata.processed_at, metadata.queued_at,
    metadata.normalized_payload, metadata.error_message,
    CASE WHEN jsonb_typeof(metadata.normalized_payload->'raw') = 'object'
      THEN metadata.normalized_payload->'raw' ELSE metadata.raw_payload END AS source_payload,
    CASE WHEN jsonb_typeof(metadata.normalized_payload->'raw') = 'object'
      THEN 'normalized_raw' ELSE 'sampled_raw' END AS source_basis,
    CASE WHEN jsonb_typeof(metadata.normalized_payload->'raw') = 'object'
      THEN metadata.normalized_hash_admission ELSE metadata.raw_hash_admission END AS source_hash_admission,
    CASE WHEN metadata.normalized_hash_admission = 'bounded_object'
      THEN metadata.normalized_payload END AS bounded_normalized_payload,
    CASE WHEN jsonb_typeof(metadata.normalized_payload->'raw') = 'object'
      THEN CASE WHEN metadata.normalized_hash_admission = 'bounded_object'
        THEN metadata.normalized_payload->'raw' END
      ELSE CASE WHEN metadata.raw_hash_admission = 'bounded_object'
        THEN metadata.raw_payload END END AS bounded_source_payload
  FROM samples CROSS JOIN LATERAL (
    SELECT processed_at, queued_at, normalized_payload, raw_payload, error_message,
      ${hashSourceAdmission('normalized_payload')} AS normalized_hash_admission,
      ${hashSourceAdmission('raw_payload')} AS raw_hash_admission
    FROM webhook_events WHERE id = samples.id OFFSET 0
  ) metadata
  WHERE metadata.normalized_payload->'message'->>'chatId' = '${chatId}'
), source_fields AS NOT MATERIALIZED (
  SELECT details.*,
    CASE WHEN jsonb_typeof(bounded_source_payload->'message'->'body'->'text') = 'string'
      THEN bounded_source_payload->'message'->'body'->>'text' END AS source_body_text,
    -- FLAG: Display-label precedence is raw sender.name, otherwise the trimmed
    -- concatenation of first_name and last_name. Never search arbitrary payload fields.
    CASE WHEN jsonb_typeof(bounded_source_payload->'message'->'sender'->'name') = 'string'
      THEN bounded_source_payload->'message'->'sender'->>'name'
      ELSE nullif(btrim(concat_ws(' ',
        CASE WHEN jsonb_typeof(bounded_source_payload->'message'->'sender'->'first_name') = 'string'
          THEN bounded_source_payload->'message'->'sender'->>'first_name' END,
        CASE WHEN jsonb_typeof(bounded_source_payload->'message'->'sender'->'last_name') = 'string'
          THEN bounded_source_payload->'message'->'sender'->>'last_name' END)), '')
      END AS source_sender_label
  FROM details
), projected AS (
  SELECT status, created_at, queued_at, processed_at, source_basis,
    md5(normalized_payload->'message'->>'messageId') AS message_hash,
    md5(normalized_payload->'message'->>'senderId') AS sender_hash,
    CASE WHEN normalized_payload->>'type' IN ('message_created', 'message_edited', 'message_removed')
      THEN normalized_payload->>'type' ELSE 'other' END AS update_type,
    source_hash_admission,
    CASE WHEN source_hash_admission <> 'bounded_object' THEN 'source_not_admitted'
      WHEN source_body_text IS NULL THEN 'absent_or_non_string'
      WHEN octet_length(source_body_text) > 8192 THEN 'oversized_not_inspected'
      ELSE 'bounded_string' END AS source_body_text_hash_admission,
    CASE WHEN octet_length(source_body_text) <= 8192
      THEN md5(source_body_text) END AS source_body_text_md5,
    CASE WHEN source_hash_admission <> 'bounded_object' THEN 'source_not_admitted'
      WHEN source_sender_label IS NULL THEN 'absent_or_non_string'
      WHEN octet_length(source_sender_label) > 256 THEN 'oversized_not_inspected'
      ELSE 'bounded_string' END AS source_sender_label_hash_admission,
    CASE WHEN octet_length(source_sender_label) <= 256
      THEN md5(source_sender_label) END AS source_sender_label_md5,
    CASE WHEN octet_length(source_body_text) <= 8192 THEN
      source_body_text ~* '(^|[[:space:]])(https?://)?(www[.])?max[.]ru/join/[A-Za-z0-9_-]+([[:space:]]|$|[.,!?])'
      END AS plain_max_join_url,
    CASE WHEN bounded_normalized_payload IS NOT NULL AND bounded_source_payload IS NOT NULL THEN
      coalesce(bounded_normalized_payload->>'type' = 'message_removed'
        AND jsonb_typeof(bounded_normalized_payload->'botId') = 'string'
        AND bounded_normalized_payload->>'botId' <> ''
        AND coalesce(bounded_normalized_payload->'message'->>'postId', '') = ''
        AND coalesce(bounded_normalized_payload->'message'->>'entityType', '') <> 'channel'
        AND bounded_source_payload->>'update_type' = 'message_removed'
        AND bounded_source_payload->>'chat_id' = '${chatId}'
        AND jsonb_typeof(bounded_source_payload->'message_id') = 'string'
        AND bounded_source_payload->>'message_id' = bounded_normalized_payload->'message'->>'messageId'
        AND bounded_source_payload->>'message_id' <> ''
        AND (bounded_source_payload->'post_id' IS NULL OR bounded_source_payload->'post_id' = 'null'::jsonb), false)
      END AS raw_message_removed_exact,
    CASE WHEN error_message = 'DORMANT_BOT_OBSERVATION_V1' THEN 'dormant_observation'
      WHEN error_message LIKE 'NO_EXECUTABLE_OWNER; deadline=%' THEN 'no_executable_owner'
      WHEN error_message LIKE 'WEBHOOK_HOT_PATH_TIMEOUT%QUARANTINED:%' THEN 'timeout_quarantine'
      WHEN error_message IS NULL THEN 'none' ELSE 'other' END AS diagnostic_family,
    jsonb_typeof(source_payload->'message'->'body'->'attachments') AS raw_attachment_shape,
    coalesce((SELECT jsonb_agg(CASE WHEN attachment->>'type' IN
      ('audio', 'voice', 'audio_message', 'ptt', 'image', 'video', 'sticker', 'file', 'share', 'inline_keyboard')
      THEN attachment->>'type' ELSE 'other' END ORDER BY ordinal)
      FROM generate_series(0, 31) AS positions(ordinal)
      CROSS JOIN LATERAL (SELECT source_payload->'message'->'body'->'attachments'->ordinal AS attachment) entry
      WHERE jsonb_typeof(source_payload->'message'->'body'->'attachments') = 'array' AND attachment IS NOT NULL), '[]'::jsonb) AS raw_attachment_types,
    CASE WHEN jsonb_typeof(source_payload->'message'->'body'->'attachments') = 'array'
      THEN jsonb_array_length(source_payload->'message'->'body'->'attachments') > 32 ELSE false END AS attachments_truncated,
    (SELECT json_build_object('status', intent.status,
      'attempt_count', intent.attempt_count, 'last_status_code', intent.last_status_code,
      'last_failure_family', CASE
        WHEN intent.last_error_code = 'delete_pre_dispatch_guard_rejected'
          AND intent.last_error = 'MAX direct message lookup returned a response without the requested id'
          THEN 'predispatch_exact_source_missing_id'
        WHEN intent.last_error_code = 'delete_pre_dispatch_guard_rejected'
          AND intent.last_error = 'Message limits author access unavailable'
          THEN 'predispatch_author_access_unavailable'
        WHEN intent.last_error_code = 'delete_pre_dispatch_guard_rejected'
          THEN 'predispatch_other'
        WHEN intent.last_error_code = 'route_lookup_failed' THEN 'route_lookup_failed'
        WHEN intent.last_error_code IN (
          'max_action_executor_proof_rejected', 'unverified_message_not_found',
          'delete_candidates_exhausted', 'no_delete_capable_bot', 'predelete_presence_unknown',
          'moderation_state_delete_no_longer_authorized', 'closed_chat_delete_no_longer_authorized',
          'snapshot_missing', 'not_admin_or_owner', 'entity_type_unknown',
          'missing_chat_delete_permission', 'missing_channel_delete_permission',
          'chat_not_found', 'no_active_membership', 'snapshot_stale',
          'access_state_unconfirmed', 'access_denied', 'bot_not_actionable')
          THEN intent.last_error_code
        WHEN intent.last_error_code = 'message_limits_delete_no_longer_authorized'
          THEN 'message_limits_no_longer_authorized'
        WHEN intent.last_error_code IS NULL AND intent.last_error IS NULL THEN 'none'
        ELSE 'other' END,
      'dispatch_started_at', intent.delete_dispatch_started_at,
      'remote_succeeded_at', intent.remote_delete_succeeded_at,
      'completed_at', intent.completed_at, 'retry_until_at', intent.retry_until_at,
      'last_attempt_at', intent.last_attempt_at, 'next_attempt_at', intent.next_attempt_at,
      'reason_sample', (SELECT json_build_object(
        'voice_blocked', coalesce(bool_or(rule_code = 'VOICE_BLOCKED_DELETE'), false),
        'link_blocked', coalesce(bool_or(rule_code = 'LINK_BLOCKED_DELETE'), false),
        'mute_active', coalesce(bool_or(rule_code = 'MUTE_ACTIVE_DELETE'), false),
        'night_mode', coalesce(bool_or(rule_code = 'NIGHT_MODE_DELETE'), false),
        'manual_close', coalesce(bool_or(rule_code = 'MANUAL_GROUP_CLOSE_DELETE'), false),
        'truncated', count(*) > 64)
        FROM (SELECT rule_code FROM moderation_delete_intent_reasons
          WHERE intent_id = intent.id ORDER BY reason_key LIMIT 65) bounded_reasons))
     FROM moderation_delete_intents intent
     WHERE intent.chat_id = '${chatId}'
       AND intent.message_id = normalized_payload->'message'->>'messageId') AS delete_intent
  FROM source_fields
)
SELECT json_build_object(
  'schema_version', 4, 'audit', 'chat_message_window', 'observed_at', statement_timestamp(),
  'from_at', (SELECT from_at FROM bounds), 'until_at', (SELECT until_at FROM bounds),
  'window_seconds', ${slice === null ? 60 : 5}, 'slice', ${slice === null ? 'NULL' : slice},
  'window_closed', (SELECT until_at <= statement_timestamp() AT TIME ZONE 'UTC' FROM bounds),
  'per_status_cap', 512, 'sampled_receipts', (SELECT count(*) FROM samples),
  'sample_truncated', EXISTS (SELECT 1 FROM candidates GROUP BY status HAVING count(*) > 512),
  'matched_receipts', (SELECT count(*) FROM details),
  'policy_checked', false, 'remote_effect_proven', false,
  'rows', coalesce((SELECT json_agg(projected ORDER BY created_at, message_hash, status) FROM projected), '[]'::json)
);`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { chatId, from, explain, slice } = parseChatMessageWindowAuditArgs(process.argv.slice(2));
  process.stdout.write(
    buildChatMessageWindowIndexSql() + buildChatMessageWindowAuditSql(chatId, from, explain, slice),
  );
}
