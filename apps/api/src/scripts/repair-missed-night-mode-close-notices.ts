import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../app.module';
import { ModerationExecutionService } from '../moderation/moderation-execution.service';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MIN_REMAINING_MINUTES = 15;
const DEFAULT_SAMPLE_LIMIT = 30;
const APP_CLOSE_TIMEOUT_MS = 5_000;

type CliOptions = {
  dryRun: boolean;
  json: boolean;
  limit?: number;
  concurrency: number;
  minRemainingMinutes: number;
  sampleLimit: number;
};

type RepairCandidateRow = {
  chatId: string;
  title: string;
  scheduledFor: Date;
  sessionEndsAt: Date;
  sessionKey: string;
  startMinutes: number;
  endMinutes: number;
  timezone: string;
  activeBotCount: number | bigint;
  recentAccessLossReasons: string | null;
  recentAccessLossSources: string | null;
};

type RepairStats = {
  totalCandidates: number;
  sent: number;
  alreadyHadNotice: number;
  stopped: number;
  skipped: number;
  failed: number;
};

function readCliOptions(argv: readonly string[]): CliOptions {
  return {
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    limit: readPositiveIntOption(argv, '--limit'),
    concurrency: readPositiveIntOption(argv, '--concurrency') ?? DEFAULT_CONCURRENCY,
    minRemainingMinutes:
      readNonNegativeIntOption(argv, '--min-remaining-minutes') ??
      DEFAULT_MIN_REMAINING_MINUTES,
    sampleLimit: readPositiveIntOption(argv, '--sample-limit') ?? DEFAULT_SAMPLE_LIMIT,
  };
}

function readPositiveIntOption(args: readonly string[], name: string): number | undefined {
  const value = readStringOption(args, name);
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readNonNegativeIntOption(args: readonly string[], name: string): number | undefined {
  const value = readStringOption(args, name);
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function readStringOption(args: readonly string[], name: string): string | undefined {
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
    with settings as (
      select
        cs.chat_id,
        c.title,
        cs.night_mode_start_time_minutes as start_min,
        cs.night_mode_end_time_minutes as end_min,
        cs.night_mode_timezone as timezone,
        ((extract(hour from now() at time zone cs.night_mode_timezone)::int * 60) +
          extract(minute from now() at time zone cs.night_mode_timezone)::int) as current_min,
        (now() at time zone cs.night_mode_timezone)::date as local_date
      from chat_settings cs
      join chats c on c.id = cs.chat_id
      where cs.night_mode_enabled = true
        and cs.night_mode_bot_message_enabled = true
        and cs.night_mode_start_time_minutes <> cs.night_mode_end_time_minutes
        and (
          exists (
            select 1
            from chat_bot_memberships active_membership
            where active_membership.chat_id = cs.chat_id
              and active_membership.status = 'ACTIVE'
          )
          or not exists (
            select 1
            from chat_bot_memberships any_membership
            where any_membership.chat_id = cs.chat_id
          )
        )
    ),
    active_settings as (
      select *
      from settings
      where
        (start_min < end_min and current_min >= start_min and current_min < end_min)
        or (start_min > end_min and (current_min >= start_min or current_min < end_min))
    ),
    sessions as (
      select
        *,
        case
          when start_min < end_min then local_date
          when current_min < end_min then local_date - 1
          else local_date
        end as session_date,
        case
          when start_min < end_min then local_date
          when current_min < end_min then local_date
          else local_date + 1
        end as session_end_date
      from active_settings
    ),
    expected as (
      select
        chat_id as "chatId",
        title,
        start_min as "startMinutes",
        end_min as "endMinutes",
        timezone,
        (
          session_date::text || ' ' ||
          lpad((start_min / 60)::text, 2, '0') || ':' ||
          lpad((start_min % 60)::text, 2, '0')
        )::timestamp at time zone timezone as "scheduledFor",
        (
          session_end_date::text || ' ' ||
          lpad((end_min / 60)::text, 2, '0') || ':' ||
          lpad((end_min % 60)::text, 2, '0')
        )::timestamp at time zone timezone as "sessionEndsAt",
        (
          'v1:' || timezone || ':' ||
          lpad((start_min / 60)::text, 2, '0') || ':' ||
          lpad((start_min % 60)::text, 2, '0') || ':' ||
          lpad((end_min / 60)::text, 2, '0') || ':' ||
          lpad((end_min % 60)::text, 2, '0') || ':' ||
          session_date::text
        ) as "sessionKey"
      from sessions
    )
    select
      expected.*,
      (
        select count(*)
        from chat_bot_memberships active_membership
        where active_membership.chat_id = expected."chatId"
          and active_membership.status = 'ACTIVE'
      ) as "activeBotCount",
      access_loss.reasons as "recentAccessLossReasons",
      access_loss.sources as "recentAccessLossSources"
    from expected
    left join lateral (
      select
        string_agg(distinct denied_reason, ', ') filter (where denied_reason is not null) as reasons,
        string_agg(distinct source, ', ') filter (where source is not null) as sources
      from managed_entity_access_edges access_edge
      where access_edge.chat_id = expected."chatId"
        and access_edge.state = 'BOT_DENIED'
        and access_edge.updated_at >= expected."scheduledFor" - interval '5 minutes'
    ) access_loss on true
    where expected."scheduledFor" <= now()
      and expected."sessionEndsAt" > now() + make_interval(mins => ${options.minRemainingMinutes})
      and not exists (
        select 1
        from moderation_events close_notice
        where close_notice.chat_id = expected."chatId"
          and close_notice.rule_code = 'NIGHT_MODE_CLOSE_NOTICE'
          and close_notice.created_at >= expected."scheduledFor" - interval '2 minutes'
          and close_notice.created_at < expected."sessionEndsAt"
      )
    order by expected."scheduledFor" desc, expected.title asc
    ${limitSql}
  `);
}

async function hasCloseNoticeEvent(
  prisma: PrismaService,
  candidate: RepairCandidateRow,
): Promise<boolean> {
  const closeNotice = await prisma.moderationEvent.findFirst({
    where: {
      chatId: candidate.chatId,
      ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
      createdAt: {
        gte: new Date(candidate.scheduledFor.getTime() - 2 * 60 * 1000),
        lt: candidate.sessionEndsAt,
      },
    },
    select: { id: true },
  });
  return Boolean(closeNotice);
}

function renderCandidate(candidate: RepairCandidateRow): Record<string, unknown> {
  return {
    chatId: candidate.chatId,
    title: candidate.title,
    scheduledFor: candidate.scheduledFor.toISOString(),
    sessionEndsAt: candidate.sessionEndsAt.toISOString(),
    sessionKey: candidate.sessionKey,
    activeBotCount: Number(candidate.activeBotCount),
    recentAccessLossReasons: candidate.recentAccessLossReasons,
    recentAccessLossSources: candidate.recentAccessLossSources,
  };
}

function printResult(result: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result);
}

async function closeApplicationContext(app: INestApplicationContext): Promise<void> {
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
    const prisma = app.get(PrismaService);
    const moderationExecution = app.get(ModerationExecutionService);
    const candidates = await loadCandidates(prisma, options);
    const stats: RepairStats = {
      totalCandidates: candidates.length,
      sent: 0,
      alreadyHadNotice: 0,
      stopped: 0,
      skipped: 0,
      failed: 0,
    };

    const summary = {
      dryRun: options.dryRun,
      limit: options.limit ?? null,
      concurrency: options.concurrency,
      minRemainingMinutes: options.minRemainingMinutes,
      candidateCount: candidates.length,
      sample: candidates.slice(0, options.sampleLimit).map(renderCandidate),
    };

    if (options.dryRun || candidates.length === 0) {
      printResult(summary, options.json);
      return;
    }

    let nextIndex = 0;
    const errors: Array<{ chatId: string; error: string }> = [];

    const processCandidate = async (candidate: RepairCandidateRow): Promise<void> => {
      if (await hasCloseNoticeEvent(prisma, candidate)) {
        stats.alreadyHadNotice += 1;
        return;
      }

      try {
        const result = await moderationExecution.processNightModeTransitionJob({
          chatId: candidate.chatId,
          transition: 'close',
          scheduledFor: candidate.scheduledFor.toISOString(),
          sessionKey: candidate.sessionKey,
          retryPolicyName: 'night-mode-transition',
          createdAt: new Date().toISOString(),
        });
        const hasNoticeAfterRepair = await hasCloseNoticeEvent(prisma, candidate);
        if (hasNoticeAfterRepair) {
          stats.sent += 1;
        } else if (!result.shouldEnqueueNext) {
          stats.stopped += 1;
        } else {
          stats.skipped += 1;
        }
      } catch (error: unknown) {
        stats.failed += 1;
        errors.push({
          chatId: candidate.chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
