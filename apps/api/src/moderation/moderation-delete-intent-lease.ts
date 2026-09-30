import { performance } from 'node:perf_hooks';
import { Prisma } from '../prisma/prisma-client';

export type DeleteIntentLeaseCheck = {
  owned: boolean;
  renewed: boolean;
  remainingBudgetMs: number;
  proofUntilMonotonicMs: number;
};

// FLAG: A healthy lease is a read, never a self-assignment UPDATE. PostgreSQL
// checks ownership on every call; cached deadlines cannot authorize dispatch.
export async function checkOrRenewDeleteIntentLease(
  database: { $queryRaw<T>(query: Prisma.Sql): Promise<T> },
  input: {
    intentId: string;
    leaseToken: string;
    leaseMs: number;
    minimumRemainingMs: number;
  },
): Promise<DeleteIntentLeaseCheck> {
  const renewalThresholdMs = Math.max(Math.ceil((input.leaseMs * 2) / 3), input.minimumRemainingMs);
  const extensionMs = Math.max(input.leaseMs, renewalThresholdMs + Math.ceil(input.leaseMs / 3));
  const startedAt = performance.now();
  const rows = await database.$queryRaw<
    Array<{ renewed: boolean; remainingMs: number }>
  >(Prisma.sql`
    /* storage:delete_lease_check */
    WITH due_candidate AS MATERIALIZED (
      SELECT "id", "lease_expires_at" FROM "moderation_delete_intents"
      WHERE "id" = ${input.intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${input.leaseToken}
        AND "lease_expires_at" <=
          (clock_timestamp() AT TIME ZONE 'UTC') + ${renewalThresholdMs} * INTERVAL '1 millisecond'
      FOR UPDATE
    ), renewed AS (
      UPDATE "moderation_delete_intents" intent
      SET "lease_expires_at" = GREATEST(
        intent."lease_expires_at",
        (clock_timestamp() AT TIME ZONE 'UTC') + ${extensionMs} * INTERVAL '1 millisecond'
      )
      FROM due_candidate
      WHERE intent."id" = due_candidate."id"
        AND due_candidate."lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
        AND intent."status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND intent."lease_token" = ${input.leaseToken}
        AND intent."lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
        AND intent."lease_expires_at" <=
          (clock_timestamp() AT TIME ZONE 'UTC') + ${renewalThresholdMs} * INTERVAL '1 millisecond'
      RETURNING intent."lease_expires_at"
    ), owned AS (
      SELECT TRUE AS renewed, "lease_expires_at" FROM renewed
      UNION ALL
      SELECT FALSE AS renewed, "lease_expires_at" FROM "moderation_delete_intents"
      WHERE "id" = ${input.intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${input.leaseToken}
        AND "lease_expires_at" >
          (clock_timestamp() AT TIME ZONE 'UTC') + ${renewalThresholdMs} * INTERVAL '1 millisecond'
        AND NOT EXISTS (SELECT 1 FROM renewed)
    )
    SELECT renewed,
      (EXTRACT(EPOCH FROM ("lease_expires_at" - (clock_timestamp() AT TIME ZONE 'UTC'))) * 1000)
        ::DOUBLE PRECISION AS "remainingMs"
    FROM owned
  `);
  const row = rows[0];
  const finishedAt = performance.now();
  const elapsedMs = finishedAt - startedAt;
  const remainingBudgetMs =
    row && Number.isFinite(row.remainingMs) ? Math.max(0, row.remainingMs - elapsedMs) : 0;
  return {
    owned: Boolean(row) && remainingBudgetMs > input.minimumRemainingMs,
    renewed: row?.renewed === true,
    remainingBudgetMs,
    proofUntilMonotonicMs: remainingBudgetMs > 0 ? finishedAt + remainingBudgetMs : 0,
  };
}
