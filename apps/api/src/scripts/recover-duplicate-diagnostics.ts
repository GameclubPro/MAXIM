import { config as loadEnv } from 'dotenv';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';

const statusNames = [
  'OBSERVED',
  'PENDING',
  'IN_PROGRESS',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
  'SUCCEEDED',
  'ALREADY_ABSENT',
  'EXPIRED',
  'FAILED_TERMINAL',
] as const;
const cursorSchema = z
  .object({
    chatId: z.string().min(1).max(512),
    until: z.iso.datetime(),
    at: z.iso.datetime(),
    id: z.string().min(1).max(512),
  })
  .strict();
type Candidate = {
  id: string;
  createdAt: Date;
  cursorAt: string;
  duplicate: boolean;
  projected: boolean;
};

export function parseDuplicateDiagnosticsRecoveryOptions(argv: string[], now = Date.now()) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      'chat-id': { type: 'string' },
      until: { type: 'string' },
      cursor: { type: 'string' },
      limit: { type: 'string' },
      apply: { type: 'boolean' },
      'expected-preview-sha': { type: 'string' },
    },
  });
  const chatId = z.string().min(1).max(512).parse(values['chat-id']);
  const until = z.iso.datetime().parse(values.until);
  if (Date.parse(until) > now || now - Date.parse(until) > 24 * 3600_000)
    throw new Error('Recovery requires an explicit recent UTC snapshot, no older than 24 hours');
  const limit = values.limit === undefined ? 100 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1..100');
  if (values.cursor && values.cursor.length > 1024) throw new Error('Recovery cursor is too long');
  const cursor = values.cursor
    ? cursorSchema.parse(JSON.parse(Buffer.from(values.cursor, 'base64url').toString('utf8')))
    : undefined;
  const since = new Date(Date.parse(until) - 86400_000).toISOString();
  if (
    cursor &&
    (cursor.chatId !== chatId ||
      cursor.until !== until ||
      Date.parse(cursor.at) > Date.parse(until) ||
      Date.parse(cursor.at) < Date.parse(since))
  )
    throw new Error('Recovery cursor scope changed');
  if (values.apply && !/^[a-f0-9]{64}$/u.test(values['expected-preview-sha'] ?? ''))
    throw new Error('Apply requires the exact previously reviewed preview SHA');
  return {
    chatId,
    until,
    since,
    limit,
    cursor,
    apply: values.apply === true,
    expectedPreviewSha: values['expected-preview-sha'],
  };
}

export function duplicateDiagnosticsRecoveryQuery(
  options: ReturnType<typeof parseDuplicateDiagnosticsRecoveryOptions>,
) {
  const before = options.cursor
    ? Prisma.sql`AND (created_at, id) < (CAST(${options.cursor.at} AS timestamp), ${options.cursor.id})`
    : Prisma.empty;
  // FLAG: Walk bounded indexed recent slices of one chat/status. Inspect only exact-intent
  // reasons after that bound; unrelated/retention rows advance the cursor without writes.
  return Prisma.sql`
    WITH statuses(status) AS (VALUES ${Prisma.join(statusNames.map((status) => Prisma.sql`(CAST(${status} AS "ModerationDeleteIntentStatus"))`))}),
    candidates AS MATERIALIZED (
      SELECT recent.* FROM statuses CROSS JOIN LATERAL (
        SELECT id, created_at AS "createdAt",
          to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
        FROM moderation_delete_intents
        WHERE chat_id = ${options.chatId} AND status = statuses.status
          AND created_at >= CAST(${options.since} AS timestamp) AND created_at <= CAST(${options.until} AS timestamp)
          ${before}
        ORDER BY created_at DESC, id DESC LIMIT ${options.limit + 1}
      ) recent ORDER BY recent."createdAt" DESC, recent.id DESC LIMIT ${options.limit + 1}
    )
    SELECT candidates.*,
      EXISTS (SELECT 1 FROM moderation_delete_intent_reasons WHERE intent_id = candidates.id AND rule_code = 'DUPLICATE_DELETE') AS duplicate,
      EXISTS (SELECT 1 FROM duplicate_diagnostics_history WHERE intent_id = candidates.id) AS projected
    FROM candidates ORDER BY "createdAt" DESC, id DESC
  `;
}

export async function runDuplicateDiagnosticsRecovery(
  prisma: PrismaClient,
  argv: string[],
  now = Date.now(),
) {
  const options = parseDuplicateDiagnosticsRecoveryOptions(argv, now);
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
      await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
      const rows = await tx.$queryRaw<Candidate[]>(duplicateDiagnosticsRecoveryQuery(options));
      const sample = rows.slice(0, options.limit);
      const digest = createHash('sha256')
        .update(
          JSON.stringify({
            schemaVersion: 1,
            options: {
              chatId: options.chatId,
              until: options.until,
              limit: options.limit,
              cursor: options.cursor,
            },
            sample: sample.map((row) => [row.id, row.cursorAt, row.duplicate, row.projected]),
          }),
        )
        .digest('hex');
      if (options.apply && digest !== options.expectedPreviewSha)
        throw new Error('Preview changed; inspect a fresh preview before applying');
      const recoverable = sample.filter((row) => row.duplicate && !row.projected);
      let inserted = 0;
      if (options.apply && recoverable.length) {
        // FLAG: Projection-only recovery rechecks exact rows/reasons and never calls MAX,
        // queues, claims, counters, or moderation intent updates. Replays preserve registered_at.
        inserted = await tx.$executeRaw(Prisma.sql`
        INSERT INTO duplicate_diagnostics_history (intent_id, chat_id, intent_created_at)
        SELECT intent.id, intent.chat_id, intent.created_at FROM moderation_delete_intents intent
        WHERE intent.chat_id = ${options.chatId} AND intent.id IN (${Prisma.join(recoverable.map((row) => row.id))})
          AND EXISTS (SELECT 1 FROM moderation_delete_intent_reasons WHERE intent_id = intent.id AND rule_code = 'DUPLICATE_DELETE')
        ON CONFLICT (intent_id) DO NOTHING
      `);
      }
      const last = sample.at(-1);
      const nextCursor =
        rows.length > options.limit && last
          ? Buffer.from(
              JSON.stringify({
                chatId: options.chatId,
                until: options.until,
                at: last.cursorAt,
                id: last.id,
              }),
            ).toString('base64url')
          : null;
      return {
        schemaVersion: 1,
        preview: !options.apply,
        scannedIntents: sample.length,
        recoverableIntents: recoverable.length,
        inserted,
        previewSha256: digest,
        nextCursor,
        since: options.since,
        until: options.until,
      };
    },
    { timeout: 3000, maxWait: 1000 },
  );
}

async function main() {
  for (const path of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')])
    loadEnv({ path, override: false, quiet: true });
  const prisma = createPrismaClient();
  try {
    console.log(
      JSON.stringify(await runDuplicateDiagnosticsRecovery(prisma, process.argv.slice(2))),
    );
  } finally {
    await prisma.$disconnect();
  }
}
if (require.main === module)
  void main().catch(() => {
    console.error(
      'Duplicate diagnostics recovery failed; no moderation actions were requested. Inspect arguments, schema and database availability.',
    );
    process.exitCode = 1;
  });
