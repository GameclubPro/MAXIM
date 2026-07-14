import { Prisma, createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import {
  buildChatUserDisplayNameUpsert,
  type ChatUserDisplayNameObservation,
} from '../common/chat-user-display-name-read-model.util';

const DEFAULT_BATCH_SIZE = 250;
const MAX_BATCH_SIZE = 1_000;
const DEFAULT_CHAT_LIMIT = 10;
const MAX_CHAT_LIMIT = 100;
const DEFAULT_SINCE_DAYS = 180;
const MAX_SINCE_DAYS = 3_650;

type BackfillSource = 'membership' | 'moderation';
type BackfillSourceSelection = BackfillSource | 'all';

type CliOptions = {
  source: BackfillSourceSelection;
  chatId: string | null;
  chatLimit: number;
  batchSize: number;
  sinceDays: number;
  dryRun: boolean;
  json: boolean;
  help: boolean;
};

type BackfillWorkItem = {
  chatId: string;
  cursorEventAt: Date | null;
  cursorEventId: string | null;
};

type BackfillNameRow = {
  userId: string | null;
  displayName: string | null;
  eventAt: Date;
  sourceEventId: string;
};

type BackfillSummary = {
  source: BackfillSource;
  selectedChats: number;
  scannedRows: number;
  observations: number;
  completedChats: number;
  dryRun: boolean;
};

export function parseChatUserDisplayNameBackfillOptions(argv: readonly string[]): CliOptions {
  assertKnownArguments(argv);
  const source = readOptionValue(argv, '--source') ?? 'all';
  if (source !== 'all' && source !== 'membership' && source !== 'moderation') {
    throw new Error('--source must be all, membership, or moderation');
  }

  const chatId = readOptionValue(argv, '--chat-id')?.trim() || null;
  const chatLimit = readPositiveIntOption(argv, '--chat-limit') ?? DEFAULT_CHAT_LIMIT;
  const batchSize = readPositiveIntOption(argv, '--batch-size') ?? DEFAULT_BATCH_SIZE;
  const sinceDays = readPositiveIntOption(argv, '--since-days') ?? DEFAULT_SINCE_DAYS;
  if (chatLimit > MAX_CHAT_LIMIT) {
    throw new Error(`--chat-limit must be at most ${MAX_CHAT_LIMIT}`);
  }
  if (batchSize > MAX_BATCH_SIZE) {
    throw new Error(`--batch-size must be at most ${MAX_BATCH_SIZE}`);
  }
  if (sinceDays > MAX_SINCE_DAYS) {
    throw new Error(`--since-days must be at most ${MAX_SINCE_DAYS}`);
  }

  return {
    source,
    chatId,
    chatLimit: chatId ? 1 : chatLimit,
    batchSize,
    sinceDays,
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    help: argv.includes('--help'),
  };
}

function assertKnownArguments(argv: readonly string[]): void {
  const valueOptions = new Set([
    '--source',
    '--chat-id',
    '--chat-limit',
    '--batch-size',
    '--since-days',
  ]);
  const flags = new Set(['--dry-run', '--json', '--help']);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (flags.has(value)) {
      continue;
    }
    if (!valueOptions.has(value)) {
      throw new Error(`Unknown argument: ${value}`);
    }
    if (!argv[index + 1] || argv[index + 1]?.startsWith('--')) {
      throw new Error(`${value} requires a value`);
    }
    index += 1;
  }
}

function readOptionValue(args: readonly string[], name: string): string | undefined {
  const index = args.findIndex((arg) => arg === name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readPositiveIntOption(args: readonly string[], name: string): number | undefined {
  const value = readOptionValue(args, name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function stateSourceKind(source: BackfillSource): string {
  return `chat_user_display_name:${source}:v1`;
}

async function loadWorkItems(
  prisma: PrismaClient,
  source: BackfillSource,
  options: CliOptions,
): Promise<BackfillWorkItem[]> {
  const sourceKind = stateSourceKind(source);
  const chatFilter = options.chatId ? Prisma.sql`AND chat.id = ${options.chatId}` : Prisma.empty;
  return prisma.$queryRaw<BackfillWorkItem[]>`
    SELECT
      chat.id AS "chatId",
      state.cursor_event_at AS "cursorEventAt",
      state.cursor_event_id AS "cursorEventId"
    FROM chats AS chat
    LEFT JOIN chat_user_display_name_backfill_states AS state
      ON state.chat_id = chat.id
      AND state.source_kind = ${sourceKind}
    WHERE chat.id LIKE '-%'
      AND state.completed_at IS NULL
      ${chatFilter}
    ORDER BY chat.id ASC
    LIMIT ${options.chatLimit}
  `;
}

async function loadSourceRows(
  prisma: PrismaClient,
  source: BackfillSource,
  item: BackfillWorkItem,
  cutoff: Date,
  batchSize: number,
): Promise<BackfillNameRow[]> {
  const cursor =
    item.cursorEventAt && item.cursorEventId
      ? Prisma.sql`
          AND (
            event_at < ${item.cursorEventAt}
            OR (event_at = ${item.cursorEventAt} AND source_event_id < ${item.cursorEventId})
          )
        `
      : Prisma.empty;

  if (source === 'membership') {
    return prisma.$queryRaw<BackfillNameRow[]>`
      SELECT
        user_id AS "userId",
        sender_name AS "displayName",
        event_at AS "eventAt",
        source_event_id AS "sourceEventId"
      FROM chat_membership_activity_feed_items
      WHERE chat_id = ${item.chatId}
        AND event_at >= ${cutoff}
        ${cursor}
      ORDER BY event_at DESC, source_event_id DESC
      LIMIT ${batchSize}
    `;
  }

  return prisma.$queryRaw<BackfillNameRow[]>`
    SELECT
      user_id AS "userId",
      user_display_name AS "displayName",
      created_at AS "eventAt",
      id AS "sourceEventId"
    FROM chat_moderation_feed_items
    WHERE chat_id = ${item.chatId}
      AND created_at >= ${cutoff}
      ${buildModerationCursorSql(item)}
    ORDER BY created_at DESC, id DESC
    LIMIT ${batchSize}
  `;
}

function buildModerationCursorSql(item: BackfillWorkItem): Prisma.Sql {
  if (!item.cursorEventAt || !item.cursorEventId) {
    return Prisma.empty;
  }

  return Prisma.sql`
    AND (
      created_at < ${item.cursorEventAt}
      OR (created_at = ${item.cursorEventAt} AND id < ${item.cursorEventId})
    )
  `;
}

async function persistProgress(
  prisma: PrismaClient,
  source: BackfillSource,
  item: BackfillWorkItem,
  rows: readonly BackfillNameRow[],
  batchSize: number,
): Promise<boolean> {
  const lastRow = rows.at(-1);
  const completed = rows.length < batchSize;
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO chat_user_display_name_backfill_states (
      chat_id,
      source_kind,
      cursor_event_at,
      cursor_event_id,
      completed_at,
      updated_at
    )
    VALUES (
      ${item.chatId},
      ${stateSourceKind(source)},
      ${lastRow?.eventAt ?? item.cursorEventAt},
      ${lastRow?.sourceEventId ?? item.cursorEventId},
      ${completed ? new Date() : null},
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (chat_id, source_kind) DO UPDATE SET
      cursor_event_at = EXCLUDED.cursor_event_at,
      cursor_event_id = EXCLUDED.cursor_event_id,
      completed_at = EXCLUDED.completed_at,
      updated_at = CURRENT_TIMESTAMP
  `);
  return completed;
}

async function backfillSource(
  prisma: PrismaClient,
  source: BackfillSource,
  options: CliOptions,
): Promise<BackfillSummary> {
  const cutoff = new Date(Date.now() - options.sinceDays * 24 * 60 * 60 * 1_000);
  const workItems = await loadWorkItems(prisma, source, options);
  const summary: BackfillSummary = {
    source,
    selectedChats: workItems.length,
    scannedRows: 0,
    observations: 0,
    completedChats: 0,
    dryRun: options.dryRun,
  };

  for (const item of workItems) {
    const rows = await loadSourceRows(prisma, source, item, cutoff, options.batchSize);
    const observations: ChatUserDisplayNameObservation[] = rows.flatMap((row) => {
      const userId = row.userId?.trim() ?? '';
      const displayName = row.displayName?.trim() ?? '';
      if (!userId || !displayName || !row.sourceEventId || !row.eventAt) {
        return [];
      }

      return [
        {
          chatId: item.chatId,
          userId,
          displayName,
          observedAt: row.eventAt,
          sourceEventId: row.sourceEventId,
          sourceKind: `backfill:${source}`,
        },
      ];
    });
    summary.scannedRows += rows.length;
    summary.observations += observations.length;

    if (options.dryRun) {
      if (rows.length < options.batchSize) {
        summary.completedChats += 1;
      }
      continue;
    }

    const upsert = buildChatUserDisplayNameUpsert(observations);
    if (upsert) {
      await prisma.$executeRaw(upsert);
    }
    if (await persistProgress(prisma, source, item, rows, options.batchSize)) {
      summary.completedChats += 1;
    }
  }

  return summary;
}

function printHelp(): void {
  process.stdout.write(`Usage: npm run stats:backfill-display-names -- [options]\n\n`);
  process.stdout.write(`  --source all|membership|moderation  Source read model (default: all)\n`);
  process.stdout.write(`  --chat-id <id>                     Process one managed chat\n`);
  process.stdout.write(
    `  --chat-limit <n>                   Chats per source run (default: ${DEFAULT_CHAT_LIMIT})\n`,
  );
  process.stdout.write(
    `  --batch-size <n>                   Rows per chat page (default: ${DEFAULT_BATCH_SIZE})\n`,
  );
  process.stdout.write(
    `  --since-days <n>                   Ignore older source rows (default: ${DEFAULT_SINCE_DAYS})\n`,
  );
  process.stdout.write(`  --dry-run                          Read only; do not persist progress\n`);
  process.stdout.write(`  --json                             Emit JSON summary\n`);
}

async function main(): Promise<void> {
  const options = parseChatUserDisplayNameBackfillOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const prisma = createPrismaClient();
  try {
    const sources: readonly BackfillSource[] =
      options.source === 'all' ? ['membership', 'moderation'] : [options.source];
    const summaries: BackfillSummary[] = [];
    for (const source of sources) {
      summaries.push(await backfillSource(prisma, source, options));
    }

    const output = { cutoffDays: options.sinceDays, summaries };
    process.stdout.write(`${JSON.stringify(output, null, options.json ? 2 : 0)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
