import { EventType, Operator, Prisma, SanctionAction } from '../prisma/prisma-client';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_SINCE = '2026-04-06T21:58:00.000Z';
const DEFAULT_UNTIL = '2026-04-07T06:10:00.000Z';
const DEFAULT_CONCURRENCY = 3;
const PROGRESS_EVERY = 25;
const MAX_DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPAIR_REASON =
  'Repair delete for moderation messages missed during MAX permissions-gating incident';

type RepairCandidateRow = {
  id: string;
  createdAt: Date;
  chatId: string;
  userId: string;
  messageId: string;
  ruleCode: string;
  action: SanctionAction;
  botId: string | null;
  maskedExcerpt: string | null;
  score: number;
};

type RepairStats = {
  totalCandidates: number;
  deleted: number;
  alreadyResolved: number;
  tooOld: number;
  noPermission: number;
  failed: number;
};

type CliOptions = {
  since: Date;
  until: Date;
  dryRun: boolean;
  limit?: number;
  concurrency: number;
};

function readCliOptions(argv: readonly string[]): CliOptions {
  const args = [...argv];
  const dryRun = args.includes('--dry-run');
  const since = readDateOption(args, '--since', DEFAULT_SINCE);
  const until = readDateOption(args, '--until', DEFAULT_UNTIL);
  const limit = readPositiveIntOption(args, '--limit');
  const concurrency = readPositiveIntOption(args, '--concurrency') ?? DEFAULT_CONCURRENCY;

  if (since.getTime() > until.getTime()) {
    throw new Error('--since must be earlier than or equal to --until');
  }

  return {
    since,
    until,
    dryRun,
    ...(limit ? { limit } : {}),
    concurrency,
  };
}

function readDateOption(args: readonly string[], name: string, fallback: string): Date {
  const value = readOptionValue(args, name) ?? fallback;
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
    with base as (
      select distinct on (e.chat_id, e.message_id, e.rule_code)
        e.id,
        e.created_at as "createdAt",
        e.chat_id as "chatId",
        e.user_id as "userId",
        e.message_id as "messageId",
        e.rule_code as "ruleCode",
        e.action,
        e.bot_id as "botId",
        e.masked_excerpt as "maskedExcerpt",
        e.score
      from moderation_events e
      where e.created_at >= ${options.since}
        and e.created_at <= ${options.until}
        and e.rule_code in ('LINK_BLOCKED', 'COMMERCIAL_AD')
        and e.message_id is not null
      order by e.chat_id, e.message_id, e.rule_code, e.created_at asc
    )
    select *
    from base
    where not exists (
      select 1
      from moderation_events d
      where d.chat_id = base."chatId"
        and d.message_id = base."messageId"
        and d.rule_code = base."ruleCode" || '_DELETE'
        and d.action = 'DELETE_MESSAGE'
    )
    order by "createdAt" asc
    ${limitSql}
  `);
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

    logger.log(
      {
        since: options.since.toISOString(),
        until: options.until.toISOString(),
        dryRun: options.dryRun,
        limit: options.limit ?? null,
        concurrency: options.concurrency,
        candidateCount: candidates.length,
      },
      'Loaded repair candidates for missed moderation deletes',
    );

    if (options.dryRun || candidates.length === 0) {
      logger.log(
        {
          since: options.since.toISOString(),
          until: options.until.toISOString(),
          dryRun: options.dryRun,
          stats,
        },
        'Missed moderation delete repair finished',
      );
      return;
    }

    let nextIndex = 0;
    let processed = 0;

    const processCandidate = async (candidate: RepairCandidateRow): Promise<void> => {
      const ageMs = Date.now() - new Date(candidate.createdAt).getTime();
      if (ageMs > MAX_DELETE_WINDOW_MS) {
        stats.tooOld += 1;
        return;
      }

      const actionBotId = await maxBotLink.resolveBotIdForModerationAction({
        chatId: candidate.chatId,
        action: 'delete_message',
        fallbackToPrimary: false,
      });
      if (!actionBotId) {
        stats.noPermission += 1;
        return;
      }

      try {
        await maxClient.deleteMessage(candidate.chatId, candidate.messageId, {
          botId: actionBotId,
          immediate: true,
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: 'repair_missed_moderation_deletes',
          ignoreFailureMetricStatuses: [403, 404],
        });

        await prisma.moderationEvent.create({
          data: {
            chatId: candidate.chatId,
            botId: actionBotId,
            userId: candidate.userId,
            messageId: candidate.messageId,
            eventType: EventType.MESSAGE,
            ruleCode: `${candidate.ruleCode}_DELETE`,
            action: SanctionAction.DELETE_MESSAGE,
            maskedExcerpt: candidate.maskedExcerpt,
            score: candidate.score,
            operator: Operator.BOT,
            metadata: {
              reason: REPAIR_REASON,
              repaired: true,
              originalEventId: candidate.id,
              originalAction: candidate.action,
              originalBotId: candidate.botId,
              deletedWithoutBotMessage: true,
              repairWindow: {
                since: options.since.toISOString(),
                until: options.until.toISOString(),
              },
            },
          },
        });

        stats.deleted += 1;
      } catch (error: unknown) {
        const statusValue = (error as { response?: { status?: unknown } } | null)?.response?.status;
        const status = typeof statusValue === 'number' ? statusValue : null;

        if (status === 404) {
          stats.alreadyResolved += 1;
          return;
        }

        if (status === 403) {
          stats.noPermission += 1;
          return;
        }

        stats.failed += 1;
        logger.error(
          {
            chatId: candidate.chatId,
            userId: candidate.userId,
            messageId: candidate.messageId,
            ruleCode: candidate.ruleCode,
            status,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to repair missed moderation delete',
        );
      }
    };

    const worker = async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= candidates.length) {
          return;
        }

        await processCandidate(candidates[currentIndex]);
        processed += 1;

        if (processed % PROGRESS_EVERY === 0 || processed === candidates.length) {
          logger.log(
            {
              processed,
              total: candidates.length,
              stats,
            },
            'Missed moderation delete repair progress',
          );
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, candidates.length) }, () => worker()),
    );

    logger.log(
      {
        since: options.since.toISOString(),
        until: options.until.toISOString(),
        dryRun: options.dryRun,
        stats,
      },
      'Missed moderation delete repair finished',
    );
  } finally {
    await app.close();
  }
}

void main();
