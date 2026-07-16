import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import {
  assertDuplicateCloseNoticeRepairExecutionMode,
  buildDuplicateCloseNoticeRepairIntentInput,
  DUPLICATE_CLOSE_NOTICE_REPAIR_RULE_CODE,
  evaluateDuplicateCloseNoticeRepairCandidate,
  readDuplicateCloseNoticeRepairCliOptions,
  resolveDuplicateCloseNoticeRepairBootstrapMode,
  type DuplicateCloseNoticeRepairCandidate,
  type DuplicateCloseNoticeRepairCliOptions,
} from './repair-duplicate-night-mode-close-notices.util';

for (const envPath of new Set([
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
  resolve(__dirname, '../../../../.env'),
  resolve(__dirname, '../../../../../../../.env'),
])) {
  loadEnv({ path: envPath, override: false, quiet: true });
}

type RepairIntentRuntime = {
  rolloutMode: string;
  getRolloutForChat(chatId: string): 'off' | 'observed' | 'execute';
  ensureIntent(
    input: ReturnType<typeof buildDuplicateCloseNoticeRepairIntentInput>,
  ): Promise<{ rollout: 'off' | 'observed' | 'execute' }>;
};

type RepairLogger = {
  log(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
};

type RepairStats = {
  totalCandidates: number;
  eligibleCandidates: number;
  ensuredIntents: number;
  executableIntents: number;
  observedIntents: number;
  outsideExecutionRollout: number;
  failed: number;
  skippedByPolicy: Record<string, number>;
};

async function loadCandidates(
  prisma: PrismaClient,
  options: DuplicateCloseNoticeRepairCliOptions,
): Promise<DuplicateCloseNoticeRepairCandidate[]> {
  return prisma.$queryRaw<DuplicateCloseNoticeRepairCandidate[]>(Prisma.sql`
    WITH close_events AS (
      SELECT
        event."id",
        event."created_at",
        event."chat_id",
        event."user_id",
        event."message_id",
        event."bot_id",
        chat."entity_type",
        event."masked_excerpt",
        event."score",
        event."metadata"->>'sessionKey' AS "session_key",
        ROW_NUMBER() OVER (
          PARTITION BY event."chat_id", event."metadata"->>'sessionKey'
          ORDER BY event."created_at" DESC, event."id" DESC
        ) AS "newest_rank",
        FIRST_VALUE(event."id") OVER (
          PARTITION BY event."chat_id", event."metadata"->>'sessionKey'
          ORDER BY event."created_at" DESC, event."id" DESC
        ) AS "kept_event_id",
        FIRST_VALUE(event."message_id") OVER (
          PARTITION BY event."chat_id", event."metadata"->>'sessionKey'
          ORDER BY event."created_at" DESC, event."id" DESC
        ) AS "kept_message_id",
        COUNT(*) OVER (
          PARTITION BY event."chat_id", event."metadata"->>'sessionKey'
        ) AS "duplicate_events"
      FROM "moderation_events" event
      JOIN "chats" chat ON chat."id" = event."chat_id"
      WHERE event."rule_code" = 'NIGHT_MODE_CLOSE_NOTICE'
        AND event."created_at" >= ${options.since}
        AND event."created_at" <= ${options.until}
        AND event."message_id" IS NOT NULL
        AND event."metadata"->>'sessionKey' IS NOT NULL
    ), candidate_events AS (
      SELECT *
      FROM close_events
      WHERE "duplicate_events" > 1
        AND "newest_rank" > 1
        AND "message_id" <> "kept_message_id"
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_events" recovery
          WHERE recovery."chat_id" = close_events."chat_id"
            AND recovery."rule_code" = ${DUPLICATE_CLOSE_NOTICE_REPAIR_RULE_CODE}
            AND (
              recovery."message_id" = close_events."message_id"
              OR recovery."metadata"->>'originalEventId' = close_events."id"
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_delete_intents" intent
          JOIN "moderation_delete_intent_reasons" reason
            ON reason."intent_id" = intent."id"
          WHERE intent."chat_id" = close_events."chat_id"
            AND intent."message_id" = close_events."message_id"
            AND (
              reason."reason_key" = ${DUPLICATE_CLOSE_NOTICE_REPAIR_RULE_CODE}
              OR reason."rule_code" = ${DUPLICATE_CLOSE_NOTICE_REPAIR_RULE_CODE}
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_delete_intents" terminal_intent
          WHERE terminal_intent."chat_id" = close_events."chat_id"
            AND terminal_intent."message_id" = close_events."message_id"
            AND terminal_intent."status" IN (
              CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
              CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus"),
              CAST('EXPIRED' AS "ModerationDeleteIntentStatus"),
              CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus")
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_delete_intents" incompatible_intent
          WHERE incompatible_intent."chat_id" = close_events."chat_id"
            AND incompatible_intent."message_id" = close_events."message_id"
            AND incompatible_intent."status" <> CAST(
              'OBSERVED' AS "ModerationDeleteIntentStatus"
            )
            AND (
              incompatible_intent."routing_policy" <> 'origin_only'
              OR (
                incompatible_intent."origin_bot_id" IS NOT NULL
                AND incompatible_intent."origin_bot_id" <> BTRIM(close_events."bot_id")
              )
              OR (
                incompatible_intent."entity_type" IS NOT NULL
                AND incompatible_intent."entity_type" <> CAST('CHAT' AS "ChatEntityType")
              )
              OR (
                incompatible_intent."message_author_kind" IS NOT NULL
                AND incompatible_intent."message_author_kind" <> 'bot'
              )
            )
        )
    ), distinct_messages AS (
      SELECT DISTINCT ON ("chat_id", "message_id") *
      FROM candidate_events
      ORDER BY "chat_id", "message_id", "created_at" ASC, "id" ASC
    )
    SELECT
      "id",
      "created_at" AS "createdAt",
      "chat_id" AS "chatId",
      "user_id" AS "userId",
      "message_id" AS "messageId",
      "bot_id" AS "botId",
      "entity_type" AS "entityType",
      "masked_excerpt" AS "maskedExcerpt",
      "score",
      "session_key" AS "sessionKey",
      "kept_event_id" AS "keptEventId",
      "kept_message_id" AS "keptMessageId",
      "duplicate_events" AS "duplicateEvents"
    FROM distinct_messages
    ORDER BY "created_at" ASC, "id" ASC
    LIMIT ${options.globalCap}
  `);
}

async function runRepair(
  prisma: PrismaClient,
  options: DuplicateCloseNoticeRepairCliOptions,
  executeRuntime: { intentService: RepairIntentRuntime; logger: RepairLogger } | null,
): Promise<{ stats: RepairStats; candidates: DuplicateCloseNoticeRepairCandidate[] }> {
  const intentService = executeRuntime?.intentService ?? null;
  const logger = executeRuntime?.logger ?? createConsoleLogger();
  if (options.execute && !intentService) {
    throw new Error('Execute runtime is required for --execute');
  }
  if (options.execute) {
    assertDuplicateCloseNoticeRepairExecutionMode(intentService!.rolloutMode);
  }

  const candidates = await loadCandidates(prisma, options);
  const stats: RepairStats = {
    totalCandidates: candidates.length,
    eligibleCandidates: 0,
    ensuredIntents: 0,
    executableIntents: 0,
    observedIntents: 0,
    outsideExecutionRollout: 0,
    failed: 0,
    skippedByPolicy: {},
  };

  for (const candidate of candidates) {
    const decision = evaluateDuplicateCloseNoticeRepairCandidate(candidate);
    if (!decision.eligible) {
      stats.skippedByPolicy[decision.reason] = (stats.skippedByPolicy[decision.reason] ?? 0) + 1;
      continue;
    }
    stats.eligibleCandidates += 1;
    if (!options.execute) {
      continue;
    }
    if (intentService!.getRolloutForChat(candidate.chatId) !== 'execute') {
      stats.outsideExecutionRollout += 1;
      continue;
    }

    try {
      const result = await intentService!.ensureIntent(
        buildDuplicateCloseNoticeRepairIntentInput(candidate, decision),
      );
      stats.ensuredIntents += 1;
      if (result.rollout === 'execute') {
        stats.executableIntents += 1;
      } else {
        stats.observedIntents += 1;
      }
    } catch (error: unknown) {
      stats.failed += 1;
      logger.error(
        {
          eventId: candidate.id,
          chatId: candidate.chatId,
          messageId: candidate.messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to intake duplicate night mode close notice delete intent',
      );
    }
  }

  logger.log(
    {
      execute: options.execute,
      since: options.since.toISOString(),
      until: options.until.toISOString(),
      globalCap: options.globalCap,
      capped: candidates.length === options.globalCap,
      rolloutMode: intentService?.rolloutMode ?? 'dry-run-direct-prisma',
      stats,
    },
    options.execute
      ? 'Duplicate night mode close notice repair intake finished'
      : 'Duplicate night mode close notice repair dry-run finished; rerun with --execute to persist intents',
  );
  return { stats, candidates };
}

function renderCandidate(candidate: DuplicateCloseNoticeRepairCandidate): Record<string, unknown> {
  return {
    id: candidate.id,
    createdAt: candidate.createdAt.toISOString(),
    chatId: candidate.chatId,
    messageId: candidate.messageId,
    originBotId: candidate.botId,
    entityType: candidate.entityType,
    sessionKey: candidate.sessionKey,
    keptEventId: candidate.keptEventId,
    keptMessageId: candidate.keptMessageId,
    duplicateEvents: Number(candidate.duplicateEvents),
  };
}

function createConsoleLogger(): RepairLogger {
  return {
    log: (context, message) => {
      process.stdout.write(`${JSON.stringify({ level: 'info', message, ...context })}\n`);
    },
    error: (context, message) => {
      process.stderr.write(`${JSON.stringify({ level: 'error', message, ...context })}\n`);
    },
  };
}

function printResult(result: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  console.log(result);
}

async function main(): Promise<void> {
  const options = readDuplicateCloseNoticeRepairCliOptions(process.argv.slice(2));
  const bootstrapMode = resolveDuplicateCloseNoticeRepairBootstrapMode(
    options,
    process.env.APP_ROLE,
  );
  if (bootstrapMode === 'direct_prisma_read_only') {
    const prisma = createPrismaClient(undefined, {
      application_name: 'duplicate-close-notice-repair-dry-run',
      max: 1,
    });
    try {
      const result = await runRepair(prisma, options, null);
      printResult(
        {
          execute: false,
          since: options.since.toISOString(),
          until: options.until.toISOString(),
          globalCap: options.globalCap,
          stats: result.stats,
          sample: result.candidates.slice(0, options.sampleLimit).map(renderCandidate),
        },
        options.json,
      );
    } finally {
      await prisma.$disconnect();
    }
    return;
  }

  assertDuplicateCloseNoticeRepairExecutionMode(process.env.MODERATION_DELETE_INTENT_MODE);

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
    const result = await runRepair(app.get(PrismaService), options, {
      intentService: app.get(ModerationDeleteIntentService),
      logger: app.get(Logger),
    });
    printResult(
      {
        execute: true,
        since: options.since.toISOString(),
        until: options.until.toISOString(),
        globalCap: options.globalCap,
        stats: result.stats,
        sample: result.candidates.slice(0, options.sampleLimit).map(renderCandidate),
      },
      options.json,
    );
    if (result.stats.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
