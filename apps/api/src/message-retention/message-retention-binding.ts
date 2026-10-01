import { Prisma } from '../prisma/prisma-client';
import { MESSAGE_RETENTION_RULE } from './message-retention.policy';

export type RetentionBindingRow = {
  intentId: string;
  retentionOwned: boolean;
  chatId: string;
  messageId: string;
  subjectUserId: string | null;
  reasonCount: number;
  retentionReasonCount: number;
  candidateMessageId: string | null;
  candidateIntentId: string | null;
  authorId: string | null;
  activationId: string | null;
  sourceAt: Date | null;
  status: string | null;
  shadowOnly: boolean | null;
  enabled: boolean | null;
  policyActivationId: string | null;
  hours: number | null;
  revision: number | null;
  entityType: string | null;
};

// FLAG: Keep destructive authority in one snapshot and limit reason work to two rows.
export function retentionBindingQuery(intentId: string): Prisma.Sql {
  return Prisma.sql`
      SELECT intent."id" AS "intentId", intent."retention_owned" AS "retentionOwned",
        intent."chat_id" AS "chatId", intent."message_id" AS "messageId",
        intent."subject_user_id" AS "subjectUserId", reasons."reasonCount", reasons."retentionReasonCount",
        candidate."message_id" AS "candidateMessageId", candidate."intent_id" AS "candidateIntentId",
        candidate."author_id" AS "authorId", candidate."activation_id" AS "activationId",
        candidate."source_at" AS "sourceAt", candidate."status", candidate."shadow_only" AS "shadowOnly",
        policy."enabled", policy."activation_id" AS "policyActivationId", policy."hours", policy."revision",
        chat."entity_type" AS "entityType"
      FROM "moderation_delete_intents" intent
      LEFT JOIN "message_retention_candidates" candidate
        ON candidate."chat_id" = intent."chat_id" AND candidate."message_id" = intent."message_id"
      LEFT JOIN "message_retention_policies" policy ON policy."chat_id" = candidate."chat_id"
      LEFT JOIN "chats" chat ON chat."id" = intent."chat_id"
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::int AS "reasonCount",
          COUNT(*) FILTER (WHERE reason."rule_code" = ${MESSAGE_RETENTION_RULE})::int AS "retentionReasonCount"
        FROM (
          SELECT "rule_code" FROM "moderation_delete_intent_reasons"
          WHERE "intent_id" = intent."id" LIMIT 2
        ) reason
      ) reasons
      WHERE intent."id" = ${intentId}
      LIMIT 1
    `;
}
