import { Prisma } from '../prisma/prisma-client';

export const DELETE_EVIDENCE_SAMPLE_LIMIT = 32;

export function buildDeleteEvidenceReasonsQuery(intentId: string): Prisma.Sql {
  // FLAG: Exact intent + unique reason-key order bounds reads before event metadata.
  return Prisma.sql`SELECT reason."id", reason."reason_key" AS "reasonKey", reason."rule_code" AS "ruleCode",
    reason."moderation_event_id" AS "moderationEventId",
    EXISTS (SELECT 1 FROM "moderation_events" event
      WHERE event."id" = reason."moderation_event_id"
        AND event."chat_id" = intent."chat_id" AND event."message_id" = intent."message_id"
        AND event."user_id" = COALESCE(reason."user_id", intent."subject_user_id")
        AND event."rule_code" = reason."rule_code" AND event."action" = 'DELETE_MESSAGE'
        AND event."metadata"->>'moderationDeleteIntentId' = intent."id"
        AND event."metadata"->>'moderationDeleteReasonKey' = reason."reason_key"
    ) AS "decisionRecorded"
    FROM (SELECT * FROM "moderation_delete_intent_reasons"
      WHERE "intent_id" = ${intentId} ORDER BY "reason_key"
      LIMIT ${DELETE_EVIDENCE_SAMPLE_LIMIT + 1}) reason
    JOIN "moderation_delete_intents" intent ON intent."id" = reason."intent_id"
    ORDER BY reason."reason_key"`;
}

export function buildDeleteEvidenceOriginsQuery(reasonIds: readonly string[]): Prisma.Sql {
  const scalarTime = (path: string) => {
    const field = Prisma.raw(`receipt."normalized_payload"#>'{raw,${path}}'`);
    // FLAG: Cast the extracted JSON value, never the #> path literal.
    return Prisma.sql`CASE WHEN jsonb_typeof(${field}) IN ('string', 'number')
      AND octet_length((${field})::text) <= 130 THEN ${field} ELSE 'null'::jsonb END`;
  };
  // FLAG: The caller already selected at most 32 reason identities. Source and claim
  // are exact primary/unique-key probes; no payload scan or same-chat inference.
  return Prisma.sql`SELECT origin."reason_id" AS "reasonId",
    left(origin."source_webhook_event_id", 129) AS "sourceWebhookEventId",
    left(origin."source_receiving_bot_id", 513) AS "sourceReceivingBotId",
    left(origin."source_execution_bot_id", 513) AS "sourceExecutionBotId",
    origin."source_event_at" AS "sourceEventAt",
    origin."source_observed_at" AS "sourceObservedAt",
    origin."source_evidence_version" AS "sourceEvidenceVersion",
    receipt."id" AS "receiptId", left(receipt."bot_id", 513) AS "receiptBotId",
    receipt."created_at" AS "receiptCreatedAt",
    jsonb_build_object('type', left(receipt."normalized_payload"->>'type', 64),
      'eventTimestampSource', left(receipt."normalized_payload"->>'eventTimestampSource', 64),
      'botId', left(receipt."normalized_payload"->>'botId', 513),
      'message', jsonb_build_object(
        'chatId', left(receipt."normalized_payload"->'message'->>'chatId', 513),
        'messageId', left(receipt."normalized_payload"->'message'->>'messageId', 513)),
      'raw', jsonb_build_object(
        'timestamp', ${scalarTime('timestamp')}, 'created_at', ${scalarTime('created_at')}, 'createdAt', ${scalarTime('createdAt')},
        'data', jsonb_build_object('timestamp', ${scalarTime('data,timestamp')}, 'created_at', ${scalarTime('data,created_at')}, 'createdAt', ${scalarTime('data,createdAt')}),
        'event', jsonb_build_object('timestamp', ${scalarTime('event,timestamp')}, 'created_at', ${scalarTime('event,created_at')}, 'createdAt', ${scalarTime('event,createdAt')}))) AS "sourcePayload",
    claim."id" AS "claimId", claim."webhook_event_id" AS "claimWebhookEventId",
    left(claim."execution_bot_id", 513) AS "claimExecutionBotId", claim."enforced" AS "claimEnforced",
    claim."business_started_at" AS "claimBusinessStartedAt"
    FROM "moderation_delete_reason_origins" origin
    LEFT JOIN "webhook_events" receipt ON receipt."id" = origin."source_webhook_event_id"
    LEFT JOIN "webhook_execution_claims" claim ON claim."kind" = 'EXECUTION'
      AND claim."semantic_key" = receipt."semantic_key"
    WHERE origin."reason_id" IN (${Prisma.join(reasonIds)})`;
}

export function buildDeleteEvidenceFollowupsQuery(intentId: string): Prisma.Sql {
  // FLAG: Project only known scalar evidence; message text, labels and raw JSON stay in SQL.
  return Prisma.sql`SELECT followup."id", followup."chat_id" AS "chatId",
    followup."message_id" AS "messageId", followup."user_id" AS "userId",
    followup."reason_key" AS "reasonKey", followup."rule_code" AS "ruleCode", followup."status",
    followup."source_at" AS "sourceAt", followup."deadline_at" AS "deadlineAt",
    followup."completed_at" AS "completedAt", followup."policy_sha256" AS "policySha256",
    left(followup."envelope"->>'originBotId', 513) AS "originBotId",
    CASE WHEN octet_length(followup."action_plan"::text) <= 4096 THEN
    jsonb_build_object('version', followup."action_plan"->'version',
      'action', followup."action_plan"->'action', 'issuedAtMs', followup."action_plan"->'issuedAtMs',
      'eventId', followup."action_plan"->'eventId', 'noticeKey', followup."action_plan"->'noticeKey',
      'violationCount', followup."action_plan"->'violationCount',
      'muteDurationHours', followup."action_plan"->'muteDurationHours',
      'muteExpiresAtMs', followup."action_plan"->'muteExpiresAtMs') ELSE '{}'::jsonb END AS "plan",
    left(followup."effects"->>'phase', 513) AS "phase", left(followup."effects"->>'eventId', 513) AS "effectEventId",
    left(followup."effects"->>'banBotId', 513) AS "banBotId",
    EXISTS (SELECT 1 FROM "moderation_events" event
      WHERE event."id" = followup."action_plan"->>'eventId'
        AND event."chat_id" = followup."chat_id" AND event."message_id" = followup."message_id"
        AND event."user_id" = followup."user_id"
        AND event."action"::text = followup."action_plan"->>'action'
        AND event."rule_code" = regexp_replace(followup."rule_code", '_DELETE$', '')
        AND event."metadata"->'moderationRuleFollowupId' = to_jsonb(followup."id")
        AND to_jsonb(extract(epoch FROM event."created_at") * 1000) = followup."action_plan"->'issuedAtMs'
    ) AS "decisionRecorded"
    FROM (SELECT * FROM "moderation_rule_followups" WHERE "intent_id" = ${intentId}
      ORDER BY "reason_key" LIMIT ${DELETE_EVIDENCE_SAMPLE_LIMIT + 1}) followup
    ORDER BY followup."reason_key"`;
}

export function buildDeleteEvidenceLedgerQuery(jobIds: readonly string[]): Prisma.Sql {
  // FLAG: Candidate identities are derived from exact saved follow-up keys. Never scan JSON
  // or all actions in a chat to guess a notice; missing keys remain missing evidence.
  return Prisma.sql`SELECT "job_id" AS "jobId", "chat_id" AS "chatId", "bot_id" AS "botId",
    "action_type" AS "actionType", "status", "terminal", "ambiguous",
    "dispatch_started_at" AS "dispatchStartedAt", "completed_at" AS "completedAt",
    "remote_message_id" AS "remoteMessageId",
    CASE WHEN octet_length(("metadata"->'ledgerContext'->'moderationRuleFollowup')::text) <= 4096 THEN jsonb_build_object(
      'version', "metadata"->'ledgerContext'->'moderationRuleFollowup'->'version',
      'id', "metadata"->'ledgerContext'->'moderationRuleFollowup'->'id',
      'issuedAtMs', "metadata"->'ledgerContext'->'moderationRuleFollowup'->'issuedAtMs'
    ) ELSE '{}'::jsonb END AS "followupProof",
    CASE WHEN octet_length(("metadata"->'ledgerContext'->'moderationRuleNotice')::text) <= 4096 THEN jsonb_build_object(
      'version', "metadata"->'ledgerContext'->'moderationRuleNotice'->'version',
      'chatId', "metadata"->'ledgerContext'->'moderationRuleNotice'->'chatId',
      'messageId', "metadata"->'ledgerContext'->'moderationRuleNotice'->'messageId',
      'userId', "metadata"->'ledgerContext'->'moderationRuleNotice'->'userId',
      'reasonKey', "metadata"->'ledgerContext'->'moderationRuleNotice'->'reasonKey',
      'ruleCode', "metadata"->'ledgerContext'->'moderationRuleNotice'->'ruleCode',
      'policySha256', "metadata"->'ledgerContext'->'moderationRuleNotice'->'policySha256',
      'deadlineAtMs', "metadata"->'ledgerContext'->'moderationRuleNotice'->'deadlineAtMs'
    ) ELSE '{}'::jsonb END AS "noticeProof"
    FROM "max_action_ledger" WHERE "job_id" IN (${Prisma.join(jobIds)})`;
}
