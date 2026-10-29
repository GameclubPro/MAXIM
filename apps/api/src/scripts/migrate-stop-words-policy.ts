import { parseArgs } from 'node:util';
import Redis from 'ioredis';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { invalidateSharedChatContext } from '../chat-context/chat-context-cache.service';
import { stopWordsPolicyStorage } from '../moderation/stop-words/stop-words.policy';
import { readStopWordsStorageStatus } from '../moderation/stop-words/stop-words-storage-status';
import { readEditableStopWordsPolicy } from '../admin/stop-words-editable-policy';

export async function migrateStopWordsPolicies(params: {
  prisma: PrismaClient;
  apply: boolean;
  limit: number;
  after?: string;
  invalidate: (chatId: string) => Promise<void>;
}) {
  if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 10_000)
    throw new Error('Limit must be 1..10000');
  if (params.after && !/^[a-zA-Z0-9_-]{1,128}$/u.test(params.after))
    throw new Error('Invalid cursor');
  const deadline = Date.now() + 60_000;
  const result = {
    apply: params.apply,
    after: params.after ?? null,
    limit: params.limit,
    scanned: 0,
    valid: 0,
    legacy: 0,
    eligible: 0,
    migrated: 0,
    conflicts: 0,
    invalid: 0,
    exhausted: false,
    stoppedBy: 'limit' as 'limit' | 'deadline' | 'exhausted',
    nextCursor: params.after ?? (null as string | null),
  };
  while (result.scanned < params.limit && Date.now() < deadline) {
    const rows = await params.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        return tx.chatSettings.findMany({
          where: result.nextCursor ? { id: { gt: result.nextCursor } } : {},
          orderBy: { id: 'asc' },
          take: 1,
        });
      },
      { timeout: 7_000 },
    );
    if (!rows.length) {
      result.exhausted = true;
      result.stoppedBy = 'exhausted';
      break;
    }
    for (const row of rows) {
      result.scanned += 1;
      result.nextCursor = row.id;
      const storageStatus = readStopWordsStorageStatus(row);
      if (storageStatus === 'invalid') {
        result.invalid += 1;
        continue;
      }
      if (storageStatus === 'valid') {
        result.valid += 1;
        if (params.apply) await params.invalidate(row.chatId);
        continue;
      }
      let policy;
      try {
        policy = readEditableStopWordsPolicy(row);
      } catch {
        result.invalid += 1;
        continue;
      }
      result.legacy += 1;
      result.eligible += 1;
      if (!params.apply) continue;
      const migrated = await params.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
          const changed = await tx.chatSettings.updateMany({
            where: {
              id: row.id,
              updatedAt: row.updatedAt,
              stopWordsRevision: row.stopWordsRevision,
            },
            data: { ...stopWordsPolicyStorage(policy), stopWordsRevision: { increment: 1 } },
          });
          if (changed.count !== 1) return false;
          await tx.auditLog.create({
            data: {
              chatId: row.chatId,
              actorUserId: 'system:stop-words-migration',
              action: 'MIGRATE_STOP_WORDS',
              payload: {
                revision: row.stopWordsRevision + 1,
                ruleCount: policy.rules.length,
                domainCount: policy.domains.length,
              },
            },
          });
          return true;
        },
        { timeout: 7_000 },
      );
      if (!migrated) {
        result.conflicts += 1;
        continue;
      }
      await params.invalidate(row.chatId);
      result.migrated += 1;
    }
  }
  if (!result.exhausted && result.scanned < params.limit) result.stoppedBy = 'deadline';
  return result;
}

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      limit: { type: 'string', default: '1000' },
      after: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  if (
    values.apply &&
    process.env.NODE_ENV === 'production' &&
    process.env.APP_SERVICE_NAME !== 'api-admin'
  )
    throw new Error('Run migration only inside api-admin');
  if (values.apply && !process.env.REDIS_URL)
    throw new Error('REDIS_URL is required for cache invalidation');
  const prisma = createPrismaClient();
  const redis = values.apply
    ? new Redis(process.env.REDIS_URL!, {
        maxRetriesPerRequest: 1,
        connectTimeout: 3_000,
        commandTimeout: 3_000,
      })
    : null;
  try {
    const result = await migrateStopWordsPolicies({
      prisma,
      apply: values.apply,
      limit: Number(values.limit),
      after: values.after,
      invalidate: async (chatId) => {
        if (redis) await invalidateSharedChatContext(redis, chatId);
      },
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.invalid || result.conflicts) process.exitCode = 2;
  } finally {
    redis?.disconnect();
    await prisma.$disconnect();
  }
}

if (require.main === module)
  void main().catch(() => {
    process.stderr.write(
      'Stop-word migration failed. No source text or credentials were logged.\n',
    );
    process.exitCode = 1;
  });
