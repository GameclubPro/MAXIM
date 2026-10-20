import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Prisma, createPrismaClient } from '../prisma/prisma-client';
import type { MaxActionJob } from '../max/max-client.service';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import {
  applyTargetedBacklogCancellation,
  previewTargetedBacklogCancellation,
} from './cancel-webhook-backlog-v2';
import {
  backlogCancellationDigestV2,
  type BacklogCancellationNominationV2,
} from './cancel-webhook-backlog-v2.contract';

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Filter?: string;
  Plans?: PlanNode[];
};
type ExplainRow = { 'QUERY PLAN': Array<{ Plan: PlanNode }> };
const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;
const bindings = { runtimeDigest: 'c'.repeat(64), clientSha256: 'd'.repeat(64) };
jest.setTimeout(120_000);

native('exact cancellation v2 operation plans after capture statistics change', () => {
  let db: ReturnType<typeof createPrismaClient>, redis: Redis;
  const queue = 'max-actions-critical';
  const ids: string[] = [];
  beforeAll(async () => {
    if (
      !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname) ||
      !new URL(databaseUrl).pathname.includes('race_test') ||
      !['localhost', '127.0.0.1'].includes(new URL(redisUrl).hostname)
    )
      throw new Error('Disposable stores required');
    db = createPrismaClient(databaseUrl, {
      max: 2,
      options: '-c timezone=UTC -c statement_timeout=5000',
    });
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.ping();
  });
  afterAll(async () => {
    // FLAG: Only exact fixture Redis keys are removed; SQL evidence stays immutable.
    for (const id of ids) {
      await redis.lrem(`bull:${queue}:wait`, 0, id);
      await redis.del(`bull:${queue}:${id}`);
    }
    await redis?.quit();
    await db?.$disconnect();
  });

  it('applies all 4096 children after ANALYZE while both reads seek the operation index', async () => {
    const id = randomUUID();
    const at = new Date(Date.now() - 600_000);
    const chatId = `-${id}`;
    const messageId = id;
    const update = {
      type: 'message_created' as const,
      updateId: id,
      timestamp: at.toISOString(),
      botId: 'fixture',
      message: { chatId, messageId, senderId: 'fixture-user', text: 'fixture' },
    };
    const semanticKey = buildWebhookSemanticEventKey(update)!;
    await db.webhookEvent.create({
      data: {
        id,
        dedupKey: id,
        createdAt: at,
        status: 'FAILED',
        errorMessage: 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:uncertain',
        semanticKey,
        rawPayload: update,
        normalizedPayload: update,
      },
    });
    await db.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey,
        webhookEventId: id,
        status: 'READY',
        enforced: true,
        preparedAt: at,
        businessStartedAt: at,
      },
    });
    const nomination: BacklogCancellationNominationV2 = {
      version: 2,
      id: randomUUID(),
      cutoff: new Date(Date.now() - 60_000).toISOString(),
      sourceSha: 'a'.repeat(40),
      imageId: `sha256:${'b'.repeat(64)}`,
      rootIds: [id],
    };
    const batch = redis.pipeline();
    for (let i = 0; i < 4096; i++) {
      const jobId = `forced-analyze-${id}-${i}`;
      const action: MaxActionJob = {
        actionType: 'SEND_MESSAGE',
        chatId,
        text: 'fixture',
        attempt: 0,
        idempotencyKey: jobId,
        createdAt: at.toISOString(),
        ledgerContext: {
          moderationSource: { version: 1, chatId, messageId, userId: 'fixture-user' },
        },
      };
      ids.push(jobId);
      batch.hset(
        `bull:${queue}:${jobId}`,
        'name',
        'fixture',
        'data',
        JSON.stringify(action),
        'opts',
        '{}',
        'timestamp',
        String(at.getTime()),
        'delay',
        '0',
        'priority',
        '0',
      );
    }
    batch.rpush(`bull:${queue}:wait`, ...ids);
    expect((await batch.exec())?.some(([error]) => error)).toBe(false);
    const preview = await previewTargetedBacklogCancellation(db, redis, nomination, bindings);
    expect(preview.issues).toEqual([]);
    expect(preview.children).toHaveLength(4096);

    let captured = 0;
    let analyzed = false;
    const reads = new Map<'size' | 'snapshot', Prisma.Sql>();
    const extension = db.$extends({
      query: {
        async $executeRaw({ args, query }) {
          const result = await query(args);
          const statement = 'sql' in args ? args.sql : args[0];
          if (
            typeof statement === 'string' &&
            statement.includes('INSERT INTO webhook_backlog_children(')
          ) {
            captured++;
            if (captured === 4096) {
              await db.$executeRaw`ANALYZE webhook_backlog_children`;
              analyzed = true;
            }
          }
          return result;
        },
        async $queryRaw({ args, query }) {
          if (
            captured === 4096 &&
            'sql' in args &&
            args.sql.includes('FROM webhook_backlog_children') &&
            !args.sql.includes('EXPLAIN') &&
            args.sql.includes('AS "childKey"')
          )
            reads.set(args.sql.includes('octet_length') ? 'size' : 'snapshot', args);
          return query(args);
        },
      },
    });
    // FLAG: Query-only instrumentation retains the real database contract and transactions.
    const observedDb: Parameters<typeof applyTargetedBacklogCancellation>[0] = new Proxy(db, {
      get(target, key) {
        return key === '$on' ? target.$on.bind(target) : Reflect.get(extension, key);
      },
    });
    const progress: Array<{ phase: string; count?: number }> = [];
    const result = await applyTargetedBacklogCancellation(
      observedDb,
      redis,
      nomination,
      {
        version: 2,
        id: nomination.id,
        cutoff: nomination.cutoff,
        sourceSha: nomination.sourceSha,
        imageId: nomination.imageId,
        previewSha256: backlogCancellationDigestV2(preview),
      },
      preview,
      bindings,
      (value) => progress.push(value),
    );
    expect(captured).toBe(4096);
    expect(analyzed).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.outcome).toBe('APPLIED');
    expect(result.sealed).toBe(true);
    expect(result.counts).toEqual({
      receipts: 1,
      projected: 1,
      children: 4096,
      removed: 4096,
      retainedLocked: 0,
      missingJobs: 0,
    });
    expect(progress).toContainEqual({ phase: 'CHILDREN_CAPTURED', count: 4096 });
    expect(await db.webhookBacklogChild.count({ where: { cancellationId: nomination.id } })).toBe(
      4096,
    );
    const retirement = redis.pipeline();
    for (const jobId of ids) {
      retirement.exists(`bull:${queue}:${jobId}`);
      retirement.lpos(`bull:${queue}:wait`, jobId);
    }
    const retired = await retirement.exec();
    expect(retired).toHaveLength(ids.length * 2);
    expect(
      retired?.every(
        ([error, value], index) => error === null && (index % 2 ? value === null : value === 0),
      ),
    ).toBe(true);
    expect(reads.size).toBe(2);
    for (const projection of ['size', 'snapshot'] as const) {
      const sql = reads.get(projection);
      if (!sql) throw new Error(`Missing actual ${projection} query`);
      // FLAG: Foreign retained history can hide the cost regression; require the bounded
      // query contract as well as the actual plan for both production reads.
      expect(sql.values).toEqual([nomination.id, nomination.id, 4097]);
      expect(sql.sql).toMatch(/WHERE cancellation_id>=\? AND cancellation_id<=\?/u);
      expect(sql.sql).toMatch(/ORDER BY cancellation_id,kind,child_key LIMIT \?\s*$/u);
      const plan = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`SET LOCAL enable_seqscan=off`;
        await tx.$executeRaw`SET LOCAL enable_bitmapscan=off`;
        await tx.$executeRaw`SET LOCAL enable_sort=off`;
        await tx.$executeRaw`SET LOCAL enable_incremental_sort=off`;
        await tx.$executeRaw`SET LOCAL jit=off`;
        return tx.$queryRaw<ExplainRow[]>(Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`);
      });
      const scans: PlanNode[] = [];
      const walk = (node: PlanNode, depth = 0): void => {
        if (depth > 16) throw new Error('Operation plan exceeded finite depth');
        if (node['Relation Name']) scans.push(node);
        for (const child of node.Plans ?? []) walk(child, depth + 1);
      };
      walk(plan[0]!['QUERY PLAN'][0]!.Plan);
      expect(scans).toHaveLength(1);
      expect(scans[0]).toMatchObject({
        'Node Type': 'Index Scan',
        'Relation Name': 'webhook_backlog_children',
        'Index Name': 'webhook_backlog_children_operation_idx',
      });
      expect(scans[0]!['Index Cond']).toBeTruthy();
      expect(scans[0]!.Filter).toBeUndefined();
    }
  });
});
