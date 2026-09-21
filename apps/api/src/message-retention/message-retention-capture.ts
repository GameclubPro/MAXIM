import { randomUUID } from 'node:crypto';
import { Prisma } from '../prisma/prisma-client';
import {
  MESSAGE_RETENTION_CHAT_LIMIT,
  MESSAGE_RETENTION_SHARD_LIMIT,
  type RetentionCapture,
} from './message-retention.policy';

type LockedAdmission = {
  enabled: boolean;
  captureAfter: Date | null;
  activationId: string;
  hours: number;
  pausedAt: Date | null;
  pendingCount: number;
  quotaPausedAt: Date | null;
  quotaCount: number;
};

export async function captureRetentionMessage(
  tx: Prisma.TransactionClient,
  input: RetentionCapture,
  shadowOnly: boolean,
): Promise<boolean> {
  const eligible = await tx.$queryRaw<Array<{ shard: number }>>(Prisma.sql`
    SELECT p."quota_shard" AS "shard"
    FROM "message_retention_policies" p
    JOIN "chats" chat ON chat."id" = p."chat_id" AND chat."entity_type" = 'CHAT'
    WHERE p."chat_id" = ${input.chatId} AND p."enabled" = TRUE
      AND p."capture_after" <= ${input.sourceAt}
      AND NOT EXISTS (
        SELECT 1 FROM "managed_entity_admin_members" admin
        WHERE admin."chat_id" = p."chat_id" AND admin."user_id" = ${input.authorId}
          AND admin."entity_type" = 'CHAT' AND admin."role" IN ('ADMIN', 'OWNER')
          AND admin."expires_at" > CURRENT_TIMESTAMP
      )
      AND NOT EXISTS (
        SELECT 1 FROM "message_retention_candidates" existing
        WHERE existing."chat_id" = p."chat_id" AND existing."message_id" = ${input.messageId}
      )
  `);
  const shard = eligible[0]?.shard;
  if (shard === undefined) return false;

  // FLAG: Materialization locks quota before policy. The following statement gets a
  // fresh snapshot after lock waits, so mirrored receipts cannot consume duplicate credit.
  const rows = await tx.$queryRaw<LockedAdmission[]>(Prisma.sql`
    WITH quota AS MATERIALIZED (
      SELECT * FROM "message_retention_quotas" WHERE "shard" = ${shard} FOR UPDATE
    )
    SELECT p."enabled", p."capture_after" AS "captureAfter", p."activation_id" AS "activationId",
      p."hours", p."paused_at" AS "pausedAt", p."pending_count" AS "pendingCount",
      q."paused_at" AS "quotaPausedAt", q."pending_count" AS "quotaCount"
    FROM quota q JOIN "message_retention_policies" p ON p."quota_shard" = q."shard"
    WHERE p."chat_id" = ${input.chatId} FOR UPDATE OF p
  `);
  const policy = rows[0];
  if (!policy) throw new Error('Retention admission authority unavailable');
  if (!policy.enabled || !policy.captureAfter || input.sourceAt < policy.captureAfter) return false;
  if (
    policy.pausedAt ||
    policy.quotaPausedAt ||
    policy.pendingCount >= MESSAGE_RETENTION_CHAT_LIMIT * 0.8 ||
    policy.quotaCount >= MESSAGE_RETENTION_SHARD_LIMIT * 0.8
  ) {
    const paused = await tx.$queryRaw<Array<{ changed: number }>>(Prisma.sql`
      WITH new_arrival AS MATERIALIZED (
        SELECT 1 WHERE NOT EXISTS (
          SELECT 1 FROM "message_retention_candidates"
          WHERE "chat_id" = ${input.chatId} AND "message_id" = ${input.messageId}
        )
      ), quota_pause AS (
        UPDATE "message_retention_quotas" SET "paused_at" = CURRENT_TIMESTAMP, "healthy_since" = NULL
        WHERE "shard" = ${shard} AND "paused_at" IS NULL
          AND "pending_count" >= ${MESSAGE_RETENTION_SHARD_LIMIT * 0.8}
          AND EXISTS (SELECT 1 FROM new_arrival)
      ), policy_pause AS (
        UPDATE "message_retention_policies" SET
          "healthy_since" = CASE WHEN "paused_at" IS NULL THEN NULL ELSE "healthy_since" END,
          "paused_at" = COALESCE("paused_at", CURRENT_TIMESTAMP),
          "last_status" = 'capacity_paused', "skipped_count" = "skipped_count" + 1,
          "next_run_at" = LEAST(COALESCE("next_run_at", CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
        WHERE "chat_id" = ${input.chatId} AND EXISTS (SELECT 1 FROM new_arrival)
        RETURNING "chat_id"
      ), pause_audit AS (
        INSERT INTO "audit_logs" ("id", "chat_id", "actor_user_id", "action", "payload", "created_at")
        SELECT ${randomUUID()}, "chat_id", 'system:message-retention', 'MESSAGE_RETENTION_INTAKE_PAUSED',
          jsonb_build_object('startedAt', ${new Date().toISOString()}::text), CURRENT_TIMESTAMP
        FROM policy_pause WHERE ${policy.pausedAt === null}
      ) SELECT COUNT(*)::int AS "changed" FROM policy_pause
    `);
    return policy.pausedAt === null && paused[0]?.changed === 1;
  }

  const dueAt = new Date(input.sourceAt.getTime() + policy.hours * 3_600_000);
  await tx.$executeRaw(Prisma.sql`
    WITH inserted AS (
      INSERT INTO "message_retention_candidates" (
        "chat_id", "message_id", "author_id", "origin_bot_id", "source_at", "activation_id", "shadow_only"
      ) VALUES (${input.chatId}, ${input.messageId}, ${input.authorId}, ${input.originBotId},
        ${input.sourceAt}, ${policy.activationId}, ${shadowOnly})
      ON CONFLICT ("chat_id", "message_id") DO NOTHING RETURNING "chat_id"
    ), charged_quota AS (
      UPDATE "message_retention_quotas" SET "pending_count" = "pending_count" + 1
      WHERE "shard" = ${shard} AND EXISTS (SELECT 1 FROM inserted)
    ) UPDATE "message_retention_policies" SET "pending_count" = "pending_count" + 1,
      "next_run_at" = LEAST(COALESCE("next_run_at", ${dueAt}), ${dueAt})
    WHERE "chat_id" = ${input.chatId} AND EXISTS (SELECT 1 FROM inserted)
  `);
  return false;
}
