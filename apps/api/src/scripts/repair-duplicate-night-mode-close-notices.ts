import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { EventType, Operator, Prisma, SanctionAction } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_LOOKBACK_HOURS = 12;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_SAMPLE_LIMIT = 30;
const MAX_DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPAIR_RULE_CODE = 'NIGHT_MODE_CLOSE_NOTICE_RECOVERY_DELETE';
const REPAIR_REASON = 'Repair duplicate night mode close notice';
const APP_CLOSE_TIMEOUT_MS = 5_000;

type CliOptions = {
  since: Date;
  until: Date;
  dryRun: boolean;
  json: boolean;
  limit?: number;
  concurrency: number;
  sampleLimit: number;
};

type RepairCandidateRow = {
  id: string;
  createdAt: Date;
  chatId: string;
  userId: string;
  messageId: string;
  botId: string | null;
  maskedExcerpt: string | null;
  score: number;
  sessionKey: string;
  keptEventId: string;
  keptMessageId: string | null;
  duplicateEvents: number | bigint;
};

type RepairStats = {
  totalCandidates: number;
  deleted: number;
  alreadyResolved: number;
  tooOld: number;
  noPermission: number;
  failed: number;
};

function readCliOptions(argv: readonly string[]): CliOptions {
  const now = new Date();
  const since =
    readDateOption(argv, '--since') ??
    new Date(now.getTime() - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000);
  const until = readDateOption(argv, '--until') ?? now;
  const limit = readPositiveIntOption(argv, '--limit');
  const concurrency = readPositiveIntOption(argv, '--concurrency') ?? DEFAULT_CONCURRENCY;
  const sampleLimit = readPositiveIntOption(argv, '--sample-limit') ?? DEFAULT_SAMPLE_LIMIT;

  if (since.getTime() > until.getTime()) {
    throw new Error('--since must be earlier than or equal to --until');
  }

  return {
    since,
    until,
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    ...(limit ? { limit } : {}),
    concurrency,
    sampleLimit,
  };
}

function readDateOption(args: readonly string[], name: string): Date | undefined {
  const value = readOptionValue(args, name);
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be a valid ISO-8601 date`);
  }
  return parsed;
}

function readPositiveIntOption(args: readonly string[], name: string): number | undefined {
  const value = readOptionValue(args, name);
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readOptionValue(args: readonly string[], name: string): string | undefined {
  const index = args.findIndex((arg) => arg === name);
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function loadCandidates(
  prisma: PrismaService,
  options: CliOptions,
): Promise<RepairCandidateRow[]> {
  const limitSql =
    typeof options.limit === 'number' ? Prisma.sql`limit ${options.limit}` : Prisma.sql``;

  return prisma.$queryRaw<RepairCandidateRow[]>(Prisma.sql`
    with close_events as (
      select
        e.id,
        e.created_at,
        e.chat_id,
        e.user_id,
        e.message_id,
        e.bot_id,
        e.masked_excerpt,
        e.score,
        e.metadata->>'sessionKey' as session_key,
        row_number() over (
          partition by e.chat_id, e.metadata->>'sessionKey'
          order by e.created_at desc, e.id desc
        ) as newest_rank,
        first_value(e.id) over (
          partition by e.chat_id, e.metadata->>'sessionKey'
          order by e.created_at desc, e.id desc
        ) as kept_event_id,
        first_value(e.message_id) over (
          partition by e.chat_id, e.metadata->>'sessionKey'
          order by e.created_at desc, e.id desc
        ) as kept_message_id,
        count(*) over (partition by e.chat_id, e.metadata->>'sessionKey') as duplicate_events
      from moderation_events e
      where e.rule_code = 'NIGHT_MODE_CLOSE_NOTICE'
        and e.created_at >= ${options.since}
        and e.created_at <= ${options.until}
        and e.message_id is not null
        and e.metadata->>'sessionKey' is not null
    )
    select
      id,
      created_at as "createdAt",
      chat_id as "chatId",
      user_id as "userId",
      message_id as "messageId",
      bot_id as "botId",
      masked_excerpt as "maskedExcerpt",
      score,
      session_key as "sessionKey",
      kept_event_id as "keptEventId",
      kept_message_id as "keptMessageId",
      duplicate_events as "duplicateEvents"
    from close_events
    where duplicate_events > 1
      and newest_rank > 1
      and not exists (
        select 1
        from moderation_events recovery
        where recovery.chat_id = close_events.chat_id
          and recovery.rule_code = ${REPAIR_RULE_CODE}
          and (
            recovery.message_id = close_events.message_id
            or recovery.metadata->>'originalEventId' = close_events.id
          )
      )
    order by created_at asc, id asc
    ${limitSql}
  `);
}

function renderCandidate(candidate: RepairCandidateRow): Record<string, unknown> {
  return {
    id: candidate.id,
    createdAt: candidate.createdAt.toISOString(),
    chatId: candidate.chatId,
    messageId: candidate.messageId,
    botId: candidate.botId,
    sessionKey: candidate.sessionKey,
    keptEventId: candidate.keptEventId,
    keptMessageId: candidate.keptMessageId,
    duplicateEvents: Number(candidate.duplicateEvents),
  };
}

async function resolveDeleteBotIds(
  maxBotLink: MaxBotLinkService,
  candidate: RepairCandidateRow,
): Promise<string[]> {
  const botIds = new Set<string>();
  if (candidate.botId?.trim()) {
    botIds.add(candidate.botId.trim());
  }

  const resolved = await maxBotLink.resolveBotIdsForModerationAction({
    chatId: candidate.chatId,
    action: 'delete_message',
    fallbackToPrimary: false,
  });
  for (const botId of resolved) {
    if (botId.trim()) {
      botIds.add(botId.trim());
    }
  }
  return [...botIds];
}

async function recordRecoveryEvent(
  prisma: PrismaService,
  candidate: RepairCandidateRow,
  params: {
    actionBotId: string | null;
    alreadyResolved: boolean;
  },
): Promise<void> {
  await prisma.moderationEvent.create({
    data: {
      chatId: candidate.chatId,
      botId: params.actionBotId,
      userId: candidate.userId,
      messageId: candidate.messageId,
      eventType: EventType.SYSTEM,
      ruleCode: REPAIR_RULE_CODE,
      action: SanctionAction.DELETE_MESSAGE,
      maskedExcerpt: candidate.maskedExcerpt,
      score: candidate.score,
      operator: Operator.BOT,
      metadata: {
        reason: REPAIR_REASON,
        repaired: true,
        alreadyResolved: params.alreadyResolved,
        originalEventId: candidate.id,
        originalBotId: candidate.botId,
        actionBotId: params.actionBotId,
        sessionKey: candidate.sessionKey,
        keptEventId: candidate.keptEventId,
        keptMessageId: candidate.keptMessageId,
        duplicateEvents: Number(candidate.duplicateEvents),
      },
    },
  });
}

function getResponseStatus(error: unknown): number | null {
  const status = (error as { response?: { status?: unknown }; status?: unknown })?.response?.status;
  if (typeof status === 'number') {
    return status;
  }
  const directStatus = (error as { status?: unknown })?.status;
  return typeof directStatus === 'number' ? directStatus : null;
}

function printResult(result: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result);
}

async function closeApplicationContext(app: { close(): Promise<void> }): Promise<void> {
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    app.close(),
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, APP_CLOSE_TIMEOUT_MS);
      timeout.unref();
    }),
  ]);

  if (timeout) {
    clearTimeout(timeout);
  }
  if (timedOut) {
    console.error(
      `Timed out closing Nest application context after ${APP_CLOSE_TIMEOUT_MS}ms; exiting CLI process.`,
    );
  }
}

async function main() {
  const options = readCliOptions(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  try {
    const logger = app.get(Logger);
    const prisma = app.get(PrismaService);
    const maxClient = app.get(MaxClientService);
    const maxBotLink = app.get(MaxBotLinkService);
    const candidates = await loadCandidates(prisma, options);
    const stats: RepairStats = {
      totalCandidates: candidates.length,
      deleted: 0,
      alreadyResolved: 0,
      tooOld: 0,
      noPermission: 0,
      failed: 0,
    };
    const summary = {
      dryRun: options.dryRun,
      since: options.since.toISOString(),
      until: options.until.toISOString(),
      limit: options.limit ?? null,
      concurrency: options.concurrency,
      candidateCount: candidates.length,
      sample: candidates.slice(0, options.sampleLimit).map(renderCandidate),
    };

    logger.log(summary, 'Loaded duplicate night mode close notice repair candidates');
    if (options.dryRun || candidates.length === 0) {
      printResult({ ...summary, stats }, options.json);
      return;
    }

    let nextIndex = 0;
    const errors: Array<{ id: string; status: number | null; error: string }> = [];

    const processCandidate = async (candidate: RepairCandidateRow): Promise<void> => {
      const ageMs = Date.now() - candidate.createdAt.getTime();
      if (ageMs > MAX_DELETE_WINDOW_MS) {
        stats.tooOld += 1;
        return;
      }

      const botIds = await resolveDeleteBotIds(maxBotLink, candidate);
      if (botIds.length === 0) {
        stats.noPermission += 1;
        return;
      }

      let lastError: unknown = null;
      for (const botId of botIds) {
        try {
          await maxClient.deleteMessage(candidate.chatId, candidate.messageId, {
            botId,
            immediate: true,
            trafficClass: 'background',
            actionHealthLane: 'background',
            sourceTag: MAX_API_SOURCE_TAGS.NIGHT_MODE_TRANSITION,
            ignoreFailureMetricStatuses: [403, 404],
          });
          await recordRecoveryEvent(prisma, candidate, {
            actionBotId: botId,
            alreadyResolved: false,
          });
          stats.deleted += 1;
          return;
        } catch (error: unknown) {
          const status = getResponseStatus(error);
          if (status === 404) {
            await recordRecoveryEvent(prisma, candidate, {
              actionBotId: botId,
              alreadyResolved: true,
            });
            stats.alreadyResolved += 1;
            return;
          }
          lastError = error;
          if (status !== 403) {
            break;
          }
        }
      }

      const status = getResponseStatus(lastError);
      if (status === 403) {
        stats.noPermission += 1;
        return;
      }

      stats.failed += 1;
      errors.push({
        id: candidate.id,
        status,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        const candidate = candidates[index];
        if (!candidate) {
          return;
        }
        await processCandidate(candidate);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, candidates.length) }, () => worker()),
    );

    printResult(
      {
        ...summary,
        stats,
        errors: errors.slice(0, options.sampleLimit),
      },
      options.json,
    );
  } finally {
    await closeApplicationContext(app);
  }
}

void main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
