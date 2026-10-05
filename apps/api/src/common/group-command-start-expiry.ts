import type { MaxUpdate } from '@maxim/contracts';
import { Prisma, type WebhookEvent, type WebhookExecutionClaim } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { hasWebhookReplayFence } from '../webhook/webhook-execution-deadline';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import { MULTIBOT_EXECUTION_AUTHORITY_VERSION } from '../webhook/webhook-semantic-authority';
import { buildGroupCommandKey, buildLegacyStartLedgerKey } from './group-command-authority.service';
import { groupCommandNoticeLedgerKey } from './group-command-notice-delivery';
import { isManagedEntityHandshakeStartCommand } from './managed-entity-handshake-command.util';

const MAX_MIRRORS = 64;
const validDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());
const safeTerminal = (event: WebhookEvent) =>
  (event.status === 'PROCESSED' || event.status === 'DUPLICATE') &&
  validDate(event.processedAt) &&
  event.nextEnqueueAt === null &&
  event.queueName === null &&
  !hasWebhookReplayFence(event);

function isObservation(command: WebhookExecutionClaim, cutoff: Date): boolean {
  return (
    command.kind === 'COMMAND' &&
    command.enforced &&
    command.status === 'PENDING' &&
    command.executionBotId === null &&
    command.businessStartedAt === null &&
    command.commandResult === null &&
    command.completedAt === null &&
    command.leaseToken === null &&
    command.leaseExpiresAt === null &&
    validDate(command.preparedAt) &&
    validDate(command.createdAt) &&
    command.createdAt.getTime() > cutoff.getTime()
  );
}

function finishedOwnerId(
  execution: WebhookExecutionClaim,
  semanticKey: string,
  cutoff: Date,
): string | null {
  const journal = execution.commandResult as Record<string, unknown> | null;
  if (
    execution.kind !== 'EXECUTION' ||
    !execution.enforced ||
    execution.semanticKey !== semanticKey ||
    execution.status !== 'COMPLETED' ||
    execution.leaseToken !== null ||
    execution.leaseExpiresAt !== null ||
    !execution.executionBotId ||
    !validDate(execution.createdAt) ||
    execution.createdAt.getTime() <= cutoff.getTime() ||
    !validDate(execution.preparedAt) ||
    !validDate(execution.businessStartedAt) ||
    !validDate(execution.completedAt) ||
    !journal ||
    journal.kind !== 'EXECUTION_FINISHED' ||
    journal.authorityVersion !== MULTIBOT_EXECUTION_AUTHORITY_VERSION ||
    journal.semanticKey !== semanticKey ||
    journal.executionBotId !== execution.executionBotId ||
    journal.businessStartedAt !== execution.businessStartedAt.toISOString() ||
    typeof journal.webhookEventId !== 'string' ||
    !journal.webhookEventId ||
    typeof journal.finishedAt !== 'string' ||
    !Number.isFinite(Date.parse(journal.finishedAt)) ||
    Date.parse(journal.finishedAt) < execution.businessStartedAt.getTime() ||
    Date.parse(journal.finishedAt) !== execution.completedAt.getTime() ||
    (execution.webhookEventId !== null && execution.webhookEventId !== journal.webhookEventId)
  )
    return null;
  return journal.webhookEventId;
}

type Candidate = { commandId: string; eventId: string; semanticKey: string; cutoff: Date };

// FLAG: A denied observer is not command completion: another bot may still have rights.
// Only an untouched post-cutover observation, its immutable elapsed deadline and exact
// completed shared handler proof permit silent SQL settlement. Assigned/attempted commands
// and historical or ambiguous evidence remain pinned; this helper never sends or replays.
export async function expireUnclaimedGroupStarts(
  prisma: PrismaService,
  cutoff: Date,
  cursor: { id: string; createdAt: Date } | undefined,
  batchSize: number,
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500)
    throw new Error('Start expiry requires a bounded retention batch');
  // FLAG: Reuse the indexed terminal window and its cursor, rather than scanning command history.
  const candidates = await prisma.$queryRaw<Candidate[]>(Prisma.sql`
    WITH candidate_ids AS MATERIALIZED (
      SELECT "id", "semantic_key", "created_at", "execution_deadline_at" FROM "webhook_events"
      WHERE "status" IN ('PROCESSED'::"WebhookStatus", 'DUPLICATE'::"WebhookStatus")
        AND "created_at" < ${cutoff}
        ${cursor ? Prisma.sql`AND ("created_at", "id") > (${cursor.createdAt}, ${cursor.id})` : Prisma.empty}
      ORDER BY "created_at" ASC, "id" ASC LIMIT ${batchSize}
    ), migration_cutoff AS MATERIALIZED (
      SELECT finished_at AS "cutoff" FROM _prisma_migrations
      WHERE migration_name = '20261005020000_add_multibot_order_fences'
        AND rolled_back_at IS NULL AND finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1
    )
    SELECT command."id" AS "commandId", candidate."id" AS "eventId",
      candidate."semantic_key" AS "semanticKey", migration."cutoff"
    FROM candidate_ids candidate CROSS JOIN migration_cutoff migration
    CROSS JOIN LATERAL (
      SELECT "id" FROM "webhook_execution_claims"
      WHERE "webhook_event_id" = candidate."id" AND "kind" = 'COMMAND'
        AND "enforced" IS TRUE AND "status" = 'PENDING'::"WebhookExecutionClaimStatus"
        AND "execution_bot_id" IS NULL AND "business_started_at" IS NULL
        AND "command_result" IS NULL AND "completed_at" IS NULL
        AND "lease_token" IS NULL AND "lease_expires_at" IS NULL
        AND "prepared_at" IS NOT NULL AND "created_at" > migration."cutoff"
      ORDER BY "id" ASC LIMIT 1
    ) command
    WHERE candidate."semantic_key" IS NOT NULL AND candidate."created_at" > migration."cutoff"
      AND candidate."execution_deadline_at" <= clock_timestamp() AT TIME ZONE 'UTC'
    ORDER BY candidate."created_at" ASC, candidate."id" ASC
  `);
  let expired = 0;
  for (const candidate of candidates) {
    if (
      typeof candidate.commandId !== 'string' ||
      typeof candidate.eventId !== 'string' ||
      typeof candidate.semanticKey !== 'string' ||
      !validDate(candidate.cutoff)
    )
      continue;
    expired += await expireCandidate(prisma, candidate);
  }
  return expired;
}

async function expireCandidate(prisma: PrismaService, candidate: Candidate): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '1s'`;
      const executionBefore = await tx.webhookExecutionClaim.findUnique({
        where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: candidate.semanticKey } },
      });
      if (!executionBefore) return 0;
      const mirrors = await tx.webhookEvent.findMany({
        where: { semanticKey: candidate.semanticKey },
        select: { id: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: MAX_MIRRORS + 1,
      });
      if (mirrors.length > MAX_MIRRORS || !mirrors.some(({ id }) => id === candidate.eventId))
        return 0;
      // FLAG: Match body-retention's event-before-claim lock order. Never wait for a live worker;
      // a skipped mirror is missing proof, not permission to ignore its active processing.
      const lockedEvents = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "webhook_events" WHERE "id" IN (${Prisma.join(mirrors.map(({ id }) => id))})
        ORDER BY "id" ASC FOR UPDATE SKIP LOCKED
      `);
      if (lockedEvents.length !== mirrors.length) return 0;
      const lockedClaims = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "webhook_execution_claims"
        WHERE "id" IN (${candidate.commandId}, ${executionBefore.id})
        ORDER BY "id" ASC FOR UPDATE SKIP LOCKED
      `);
      if (lockedClaims.length !== 2) return 0;
      const command = await tx.webhookExecutionClaim.findUnique({
        where: { id: candidate.commandId },
      });
      const execution = await tx.webhookExecutionClaim.findUnique({
        where: { id: executionBefore.id },
      });
      const events = await tx.webhookEvent.findMany({
        where: { semanticKey: candidate.semanticKey },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: MAX_MIRRORS + 1,
      });
      const owner = events.find(({ id }) => id === candidate.eventId);
      if (
        !command ||
        !execution ||
        !owner ||
        command.webhookEventId !== owner.id ||
        !isObservation(command, candidate.cutoff) ||
        owner.createdAt.getTime() <= candidate.cutoff.getTime() ||
        !validDate(owner.executionDeadlineAt) ||
        events.length !== lockedEvents.length ||
        events.some(
          (event) => !lockedEvents.some(({ id }) => id === event.id) || !safeTerminal(event),
        )
      )
        return 0;
      const update = owner.normalizedPayload as unknown as MaxUpdate;
      if (
        !isManagedEntityHandshakeStartCommand(update) ||
        update.type !== 'message_created' ||
        typeof update.message?.chatId !== 'string' ||
        !update.message.chatId.trim() ||
        typeof update.message.messageId !== 'string' ||
        !update.message.messageId.trim() ||
        command.semanticKey !==
          buildGroupCommandKey(update.message.chatId, update.message.messageId) ||
        buildWebhookSemanticEventKey(update) !== candidate.semanticKey ||
        events.some(
          (event) =>
            !isManagedEntityHandshakeStartCommand(event.normalizedPayload) ||
            buildWebhookSemanticEventKey(event.normalizedPayload) !== candidate.semanticKey,
        )
      )
        return 0;
      const finishedId = finishedOwnerId(execution, candidate.semanticKey, candidate.cutoff);
      if (!finishedId) return 0;
      if (execution.webhookEventId !== null) {
        if (!events.some((event) => event.id === finishedId && safeTerminal(event))) return 0;
      } else if (
        await tx.webhookEvent.findUnique({ where: { id: finishedId }, select: { id: true } })
      ) {
        // FLAG: SetNull tombstones retain the original journal identity; an existing mismatched
        // owner cannot be treated as a body that was safely removed by retention.
        return 0;
      }
      const ledgerKeys = [groupCommandNoticeLedgerKey(command.semanticKey)];
      for (const event of events) {
        const payload = event.normalizedPayload as unknown as MaxUpdate;
        if (
          typeof payload.botId !== 'string' ||
          !payload.botId.trim() ||
          payload.botId !== event.botId ||
          (typeof payload.updateId !== 'string' && typeof payload.updateId !== 'number') ||
          !String(payload.updateId).trim() ||
          event.dedupKey !== `${payload.botId}:${payload.updateId}`
        )
          return 0;
        ledgerKeys.push(
          buildLegacyStartLedgerKey(update.message.chatId, String(payload.updateId), payload.botId),
        );
      }
      if (
        await tx.maxActionLedgerEntry.findFirst({
          where: { jobId: { in: ledgerKeys } },
          select: { id: true },
        })
      )
        return 0;
      const result = JSON.stringify({ action: 'START_EXPIRED', applied: false, noticeText: null });
      // FLAG: Locked receipts/claims fix the proof. Recheck the deadline, migration cutoff,
      // semantic mirrors and send-ledger absence with database time in the final statement.
      return tx.$executeRaw(Prisma.sql`
        UPDATE "webhook_execution_claims" command
        SET "status" = 'COMPLETED'::"WebhookExecutionClaimStatus",
          "completed_at" = clock_timestamp() AT TIME ZONE 'UTC',
          "updated_at" = clock_timestamp() AT TIME ZONE 'UTC', "command_result" = ${result}::jsonb
        WHERE command."id" = ${command.id} AND command."kind" = 'COMMAND'
          AND command."semantic_key" = ${command.semanticKey} AND command."webhook_event_id" = ${owner.id}
          AND command."enforced" IS TRUE AND command."status" = 'PENDING'::"WebhookExecutionClaimStatus"
          AND command."execution_bot_id" IS NULL AND command."business_started_at" IS NULL
          AND command."command_result" IS NULL AND command."completed_at" IS NULL
          AND command."lease_token" IS NULL AND command."lease_expires_at" IS NULL
          AND command."prepared_at" = ${command.preparedAt} AND command."created_at" > ${candidate.cutoff}
          AND EXISTS (
            SELECT 1 FROM _prisma_migrations WHERE migration_name = '20261005020000_add_multibot_order_fences'
              AND rolled_back_at IS NULL
              AND date_trunc('milliseconds', finished_at AT TIME ZONE 'UTC') = ${candidate.cutoff}
          )
          AND EXISTS (
            SELECT 1 FROM "webhook_events" WHERE "id" = ${owner.id}
              AND "semantic_key" = ${candidate.semanticKey} AND "created_at" > ${candidate.cutoff}
              AND "execution_deadline_at" = ${owner.executionDeadlineAt}
              AND "execution_deadline_at" <= clock_timestamp() AT TIME ZONE 'UTC'
          )
          AND NOT EXISTS (
            SELECT 1 FROM "webhook_events" mirror WHERE mirror."semantic_key" = ${candidate.semanticKey}
              AND (mirror."status" NOT IN ('PROCESSED'::"WebhookStatus", 'DUPLICATE'::"WebhookStatus")
                OR mirror."processed_at" IS NULL OR mirror."next_enqueue_at" IS NOT NULL
                OR mirror."queue_name" IS NOT NULL OR mirror."timeout_quarantine_expires_at" IS NOT NULL
                OR COALESCE(mirror."error_message", '') ILIKE '%ambiguous%'
                OR COALESCE(mirror."error_message", '') LIKE 'WEBHOOK_HOT_PATH_TIMEOUT%QUARANTINED%')
          )
          AND NOT EXISTS (
            SELECT 1 FROM "max_action_ledger" WHERE "job_id" IN (${Prisma.join(ledgerKeys)})
          )
      `);
    },
    { maxWait: 1_000, timeout: 5_000 },
  );
}
