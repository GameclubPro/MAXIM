import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import {
  buildRepairIntentInput,
  evaluateRepairCandidate,
  readRepairCliOptions,
  REPAIR_MISSED_DELETES_USAGE,
  resolveRepairBootstrapMode,
  SCHEDULED_BOT_DELETE_REASON,
  type RepairCandidateRow,
  type RepairCliOptions,
} from './repair-missed-moderation-deletes.util';

for (const envPath of new Set([
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
  resolve(__dirname, '../../../../.env'),
  resolve(__dirname, '../../../../../../../.env'),
])) {
  loadEnv({ path: envPath, override: false, quiet: true });
}

type RepairCursor = {
  createdAt: Date;
  id: string;
};

type RepairStats = {
  scannedRows: number;
  eligibleReasons: number;
  acceptedMessages: number;
  acceptedReasons: number;
  perChatCappedMessages: number;
  globalCappedMessages: number;
  ensuredReasons: number;
  observedReasons: number;
  executableReasons: number;
  failedReasons: number;
  outsideExecutionRolloutReasons: number;
  skippedByPolicy: Record<string, number>;
  scanCapReached: boolean;
};

type RepairIntentRuntime = {
  rolloutMode: string;
  getRolloutForChat(chatId: string): 'off' | 'observed' | 'execute';
  ensureIntent(
    input: ReturnType<typeof buildRepairIntentInput>,
  ): Promise<{ rollout: 'off' | 'observed' | 'execute' }>;
};

type RepairLogger = {
  log(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
};

type ExecuteRuntime = {
  intentService: RepairIntentRuntime;
  logger: RepairLogger;
};

async function loadCandidateBatch(
  prisma: PrismaClient,
  options: RepairCliOptions,
  cursor: RepairCursor | null,
  limit: number,
): Promise<RepairCandidateRow[]> {
  const cursorSql = cursor
    ? Prisma.sql`AND (claim."created_at", claim."id") > (${cursor.createdAt}, ${cursor.id})`
    : Prisma.sql``;
  const chatScopeSql =
    options.chatIds.length > 0
      ? Prisma.sql`AND claim."chat_id" IN (${Prisma.join(options.chatIds)})`
      : Prisma.sql``;
  return prisma.$queryRaw<RepairCandidateRow[]>(Prisma.sql`
    WITH claim_batch AS MATERIALIZED (
      SELECT claim.*
      FROM "moderation_violation_message_claims" claim
      WHERE claim."created_at" >= CAST(${options.since} AS TIMESTAMP)
        AND claim."created_at" <= CAST(${options.until} AS TIMESTAMP)
        ${chatScopeSql}
        ${cursorSql}
      ORDER BY claim."created_at" ASC, claim."id" ASC
      LIMIT ${limit}
    )
    SELECT
      claim."id" AS "claimId",
      claim."created_at" AS "claimCreatedAt",
      claim."chat_id" AS "chatId",
      claim."user_id" AS "userId",
      claim."message_id" AS "messageId",
      claim."rule_code" AS "claimRuleCode",
      claim."update_type" AS "updateType",
      chat."entity_type" AS "entityType",
      chat."bot_id" AS "chatBotId",
      chat."primary_bot_id" AS "chatPrimaryBotId",
      evidence."id" AS "evidenceEventId",
      evidence."created_at" AS "evidenceCreatedAt",
      evidence."bot_id" AS "evidenceBotId",
      evidence."event_type" AS "evidenceEventType",
      evidence."rule_code" AS "evidenceRuleCode",
      evidence."action" AS "evidenceAction",
      evidence."masked_excerpt" AS "evidenceMaskedExcerpt",
      evidence."score" AS "evidenceScore",
      evidence."metadata" AS "evidenceMetadata",
      confirmed_delete."id" AS "confirmedDeleteEventId",
      intent."id" AS "existingIntentId",
      intent."status" AS "existingIntentStatus",
      intent."execute_at" AS "existingIntentExecuteAt",
      intent."origin_bot_id" AS "existingIntentOriginBotId",
      COALESCE(intent_reasons."items", '[]'::jsonb) AS "existingIntentReasons"
    FROM claim_batch claim
    JOIN "chats" chat ON chat."id" = claim."chat_id"
    LEFT JOIN "moderation_delete_intents" intent
      ON intent."chat_id" = claim."chat_id"
      AND intent."message_id" = claim."message_id"
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'reasonKey', reason."reason_key",
          'ruleCode', reason."rule_code",
          'metadata', reason."metadata"
        )
        ORDER BY reason."created_at" ASC, reason."id" ASC
      ) AS "items"
      FROM "moderation_delete_intent_reasons" reason
      WHERE reason."intent_id" = intent."id"
    ) intent_reasons ON TRUE
    LEFT JOIN LATERAL (
      SELECT event.*
      FROM "moderation_events" event
      WHERE event."chat_id" = claim."chat_id"
        AND event."message_id" = claim."message_id"
        AND event."user_id" = claim."user_id"
        AND event."created_at" >= CAST(${options.since} AS TIMESTAMP) - INTERVAL '5 minutes'
        AND event."created_at" <= CAST(${options.until} AS TIMESTAMP) + INTERVAL '1 hour'
        AND (
          event."rule_code" = claim."rule_code"
          OR LEFT(event."rule_code", CHAR_LENGTH(claim."rule_code") + 1) =
            claim."rule_code" || '_'
        )
        AND (
          event."action" <> CAST('DELETE_MESSAGE' AS "SanctionAction")
          OR (
            event."rule_code" = 'BOT_MESSAGE_AUTO_DELETE'
            AND event."metadata"->>'reason' = ${SCHEDULED_BOT_DELETE_REASON}
            AND event."metadata"->>'moderationDeleteIntentId' IS NULL
          )
        )
      ORDER BY
        CASE WHEN event."rule_code" = claim."rule_code" THEN 0 ELSE 1 END,
        event."created_at" ASC,
        event."id" ASC
      LIMIT 1
    ) evidence ON TRUE
    LEFT JOIN LATERAL (
      SELECT deleted."id"
      FROM "moderation_events" deleted
      WHERE deleted."chat_id" = claim."chat_id"
        AND deleted."message_id" = claim."message_id"
        AND deleted."created_at" >= CAST(${options.since} AS TIMESTAMP) - INTERVAL '5 minutes'
        AND deleted."created_at" <= CAST(${options.until} AS TIMESTAMP) + INTERVAL '24 hours'
        AND deleted."action" = CAST('DELETE_MESSAGE' AS "SanctionAction")
        AND NULLIF(BTRIM(deleted."metadata"->>'moderationDeleteIntentId'), '') IS NOT NULL
      ORDER BY deleted."created_at" ASC, deleted."id" ASC
      LIMIT 1
    ) confirmed_delete ON TRUE
    ORDER BY claim."created_at" ASC, claim."id" ASC
  `);
}

async function runRepair(
  prisma: PrismaClient,
  options: RepairCliOptions,
  executeRuntime: ExecuteRuntime | null,
): Promise<RepairStats> {
  const intentService = executeRuntime?.intentService ?? null;
  const logger = executeRuntime?.logger ?? createConsoleRepairLogger();
  const stats: RepairStats = {
    scannedRows: 0,
    eligibleReasons: 0,
    acceptedMessages: 0,
    acceptedReasons: 0,
    perChatCappedMessages: 0,
    globalCappedMessages: 0,
    ensuredReasons: 0,
    observedReasons: 0,
    executableReasons: 0,
    failedReasons: 0,
    outsideExecutionRolloutReasons: 0,
    skippedByPolicy: {},
    scanCapReached: false,
  };
  const acceptedMessageKeys = new Set<string>();
  const rejectedMessageKeys = new Set<string>();
  const perChatMessages = new Map<string, number>();
  let cursor: RepairCursor | null = null;
  let exhausted = false;

  if (options.execute && !intentService) {
    throw new Error('Execute runtime is required for --execute');
  }
  if (
    options.execute &&
    intentService &&
    intentService.rolloutMode !== 'canary' &&
    intentService.rolloutMode !== 'on'
  ) {
    throw new Error(
      `--execute requires MODERATION_DELETE_INTENT_MODE=canary or on; current mode is ${intentService.rolloutMode}`,
    );
  }

  logger.log(
    {
      since: options.since.toISOString(),
      until: options.until.toISOString(),
      execute: options.execute,
      chatIds: options.chatIds,
      globalCap: options.globalCap,
      perChatCap: options.perChatCap,
      batchSize: options.batchSize,
      scanCap: options.scanCap,
      rolloutMode: intentService?.rolloutMode ?? 'dry-run-direct-prisma',
    },
    'Starting bounded moderation delete repair intake',
  );

  while (!exhausted && stats.scannedRows < options.scanCap) {
    const remainingScanRows = options.scanCap - stats.scannedRows;
    const rows = await loadCandidateBatch(
      prisma,
      options,
      cursor,
      Math.min(options.batchSize, remainingScanRows),
    );
    if (rows.length === 0) {
      exhausted = true;
      break;
    }
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.claimCreatedAt, id: last.claimId };
    stats.scannedRows += rows.length;

    for (const candidate of rows) {
      const decision = evaluateRepairCandidate(candidate);
      if (!decision.eligible) {
        stats.skippedByPolicy[decision.reason] = (stats.skippedByPolicy[decision.reason] ?? 0) + 1;
        continue;
      }
      stats.eligibleReasons += 1;
      if (
        options.execute &&
        intentService &&
        intentService.getRolloutForChat(candidate.chatId) !== 'execute'
      ) {
        stats.outsideExecutionRolloutReasons += 1;
        continue;
      }

      const messageKey = `${candidate.chatId}\u0000${candidate.messageId}`;
      if (rejectedMessageKeys.has(messageKey)) {
        continue;
      }
      if (!acceptedMessageKeys.has(messageKey)) {
        if (stats.acceptedMessages >= options.globalCap) {
          rejectedMessageKeys.add(messageKey);
          stats.globalCappedMessages += 1;
          continue;
        }
        const currentChatCount = perChatMessages.get(candidate.chatId) ?? 0;
        if (currentChatCount >= options.perChatCap) {
          rejectedMessageKeys.add(messageKey);
          stats.perChatCappedMessages += 1;
          continue;
        }
        acceptedMessageKeys.add(messageKey);
        perChatMessages.set(candidate.chatId, currentChatCount + 1);
        stats.acceptedMessages += 1;
      }
      stats.acceptedReasons += 1;

      if (!options.execute) {
        continue;
      }
      try {
        const ensured = await intentService!.ensureIntent(
          buildRepairIntentInput(candidate, decision),
        );
        stats.ensuredReasons += 1;
        if (ensured.rollout === 'execute') {
          stats.executableReasons += 1;
        } else {
          stats.observedReasons += 1;
        }
      } catch (error: unknown) {
        stats.failedReasons += 1;
        logger.error(
          {
            claimId: candidate.claimId,
            chatId: candidate.chatId,
            messageId: candidate.messageId,
            ruleCode: candidate.claimRuleCode,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to intake moderation delete repair candidate',
        );
      }
    }

    if (rows.length < Math.min(options.batchSize, remainingScanRows)) {
      exhausted = true;
    }
  }
  stats.scanCapReached = !exhausted && stats.scannedRows >= options.scanCap;

  logger.log(
    {
      since: options.since.toISOString(),
      until: options.until.toISOString(),
      execute: options.execute,
      chatIds: options.chatIds,
      stats,
    },
    options.execute
      ? 'Moderation delete repair intake finished'
      : 'Moderation delete repair dry-run finished; rerun with --execute to persist intents',
  );
  return stats;
}

function createConsoleRepairLogger(): RepairLogger {
  return {
    log: (context, message) => {
      process.stdout.write(`${JSON.stringify({ level: 'info', message, ...context })}\n`);
    },
    error: (context, message) => {
      process.stderr.write(`${JSON.stringify({ level: 'error', message, ...context })}\n`);
    },
  };
}

async function main(): Promise<void> {
  const options = readRepairCliOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${REPAIR_MISSED_DELETES_USAGE}\n`);
    return;
  }
  const bootstrapMode = resolveRepairBootstrapMode(options, process.env.APP_ROLE);
  if (bootstrapMode === 'direct_prisma_read_only') {
    const prisma = createPrismaClient(undefined, {
      application_name: 'moderation-delete-repair-dry-run',
      max: 1,
    });
    try {
      const stats = await runRepair(prisma, options, null);
      if (stats.failedReasons > 0) {
        process.exitCode = 1;
      }
    } finally {
      await prisma.$disconnect();
    }
    return;
  }

  const [
    { NestFactory },
    { Logger },
    { AppModule },
    { ModerationDeleteIntentService },
    { PrismaService },
  ] = await Promise.all([
    import('@nestjs/core'),
    import('nestjs-pino'),
    import('../app.module'),
    import('../moderation/moderation-delete-intent.service'),
    import('../prisma/prisma.service'),
  ]);
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  try {
    const stats = await runRepair(app.get(PrismaService), options, {
      intentService: app.get(ModerationDeleteIntentService),
      logger: app.get(Logger),
    });
    if (stats.failedReasons > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
