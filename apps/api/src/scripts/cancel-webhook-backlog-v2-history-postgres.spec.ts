import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Prisma, createPrismaClient } from '../prisma/prisma-client';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import {
  previewTargetedBacklogCancellation,
  applyTargetedBacklogCancellation,
} from './cancel-webhook-backlog-v2';
import {
  backlogCancellationDigestV2,
  type BacklogCancellationNominationV2,
} from './cancel-webhook-backlog-v2.contract';

function recordNativeEvidence(value: unknown): void {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(240000);
type Plan = Record<string, unknown> & { Plans?: Plan[] };

native('exact cancellation v2 retained-history PostgreSQL plans', () => {
  let db: ReturnType<typeof createPrismaClient>, redis: Redis;
  const ownedHistoryBatches: Array<{
    rows: Array<{ id: string; semanticKey: string }>;
    at: Date;
    update: Prisma.InputJsonValue;
  }> = [];
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
    try {
      await cleanupOwnedHistory();
    } finally {
      await redis?.quit();
      await db?.$disconnect();
    }
  });

  async function cleanupOwnedHistory(): Promise<void> {
    for (const batch of ownedHistoryBatches) {
      await db.$transaction(async (tx) => {
        const before = await tx.webhookEvent.findMany({
          where: { id: { in: batch.rows.map((row) => row.id) } },
          select: { id: true },
        });
        // FLAG: Remove only unchanged ordinary owned bodies. Any claim, captured receipt
        // (sealed or unsealed), disposition or recovery keeps its evidence and fails cleanup.
        const removed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          DELETE FROM webhook_events event
          USING (VALUES ${Prisma.join(batch.rows.map((row) => Prisma.sql`(${row.id}, ${row.semanticKey})`))}) owned(id, semantic_key)
          WHERE event.id = owned.id AND event.dedup_key = owned.id
            AND event.semantic_key = owned.semantic_key
            AND event.status = 'FAILED'::"WebhookStatus"
            AND event.created_at = ${batch.at} AND event.processed_at = ${batch.at}
            AND event.error_message = 'terminal fixture'
            AND event.raw_payload = '{}'::jsonb
            AND event.normalized_payload = ${JSON.stringify(batch.update)}::jsonb
            AND event.source_disposition_id IS NULL AND event.source_disposition_receipt_id IS NULL
            AND event.legacy_disposition_id IS NULL AND event.legacy_disposition_receipt_id IS NULL
            AND event.bot_id IS NULL AND event.queue_name IS NULL AND event.source_ip IS NULL
            AND event.queued_at IS NULL AND event.enqueue_attempts = 0
            AND event.next_enqueue_at IS NULL AND event.timeout_quarantine_expires_at IS NULL
            AND event.execution_deadline_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM webhook_execution_claims claim
              WHERE claim.webhook_event_id = event.id OR claim.semantic_key = event.semantic_key)
            AND NOT EXISTS (SELECT 1 FROM webhook_backlog_receipts proof
              WHERE proof.receipt_id = event.id OR proof.semantic_key = event.semantic_key)
            AND NOT EXISTS (SELECT 1 FROM webhook_source_receipt_dispositions proof
              WHERE proof.receipt_id = event.id)
            AND NOT EXISTS (SELECT 1 FROM webhook_legacy_receipt_dispositions proof
              WHERE proof.receipt_id = event.id)
            AND NOT EXISTS (SELECT 1 FROM webhook_source_abandonments proof
              WHERE proof.owner_webhook_event_id = event.id OR proof.semantic_key = event.semantic_key)
            AND NOT EXISTS (SELECT 1 FROM webhook_legacy_recoveries proof
              WHERE proof.owner_webhook_event_id = event.id OR proof.semantic_key = event.semantic_key)
            AND NOT EXISTS (SELECT 1 FROM webhook_dependency_quarantines proof
              WHERE proof.receipt_id = event.id OR proof.blocker_id = event.id OR proof.anchor_id = event.id)
          RETURNING event.id
        `);
        expect(removed.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
        expect(
          await tx.webhookEvent.count({ where: { id: { in: batch.rows.map((row) => row.id) } } }),
        ).toBe(0);
      });
    }
    ownedHistoryBatches.length = 0;
  }

  it('seeks exact family/operation pages through 50000 terminal webhooks and 50000 foreign children', async () => {
    const prefix = randomUUID(),
      id = `history-root-${prefix}`,
      at = new Date(Date.now() - 600000),
      chatId = `-${prefix}`,
      messageId = prefix;
    const update = {
      type: 'message_created',
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
    const n: BacklogCancellationNominationV2 = {
      version: 2,
      id: randomUUID(),
      cutoff: new Date(Date.now() - 60000).toISOString(),
      sourceSha: 'a'.repeat(40),
      imageId: `sha256:${'b'.repeat(64)}`,
      rootIds: [id],
    };
    const foreign = randomUUID();
    await db.webhookBacklogCancellation.create({
      data: { id: foreign, cutoff: new Date(n.cutoff), sourceSha: n.sourceSha, imageId: n.imageId },
    });
    for (let offset = 0; offset < 50000; offset += 1000) {
      const rows = Array.from({ length: 1000 }, (_, i) => ({
        id: `${prefix}-history-${offset + i}`,
        semanticKey: `history:${prefix}:${offset + i}`,
      }));
      // FLAG: Register exact ordinary IDs before the insert, including a lost insert acknowledgement.
      ownedHistoryBatches.push({ rows, at, update });
      await db.webhookEvent.createMany({
        data: rows.map((row) => ({
          ...row,
          dedupKey: row.id,
          createdAt: at,
          status: 'FAILED' as const,
          processedAt: at,
          errorMessage: 'terminal fixture',
          rawPayload: {},
          normalizedPayload: update,
        })),
      });
      await db.webhookBacklogChild.createMany({
        data: Array.from({ length: 1000 }, (_, i) => ({
          kind: 'MAX_ACTION',
          childKey: `${prefix}-foreign-${offset + i}`,
          cancellationId: foreign,
          originalSnapshot: { fixture: true },
        })),
      });
    }
    await db.$executeRaw`ANALYZE webhook_events`;
    await db.$executeRaw`ANALYZE webhook_backlog_children`;
    const bindings = { runtimeDigest: 'c'.repeat(64), clientSha256: 'd'.repeat(64) };
    const p = await previewTargetedBacklogCancellation(db, redis, n, bindings);
    expect(p.issues).toEqual([]);
    expect(p.decision).toBe('READY');
    expect(p.receipts.map((row) => row.receiptId)).toEqual([id]);
    const result = await applyTargetedBacklogCancellation(
      db,
      redis,
      n,
      {
        version: 2,
        id: n.id,
        cutoff: n.cutoff,
        sourceSha: n.sourceSha,
        imageId: n.imageId,
        previewSha256: backlogCancellationDigestV2(p),
      },
      p,
      bindings,
    );
    expect(result.issues).toEqual([]);
    expect(result.outcome).toBe('APPLIED');
    const sqls = [
      {
        index: 'webhook_events_semantic_order_idx',
        relation: 'webhook_events',
        rows: 1,
        sql: Prisma.sql`SELECT id,created_at AS at FROM webhook_events WHERE semantic_key=${semanticKey} AND semantic_key IS NOT NULL ORDER BY created_at,id LIMIT 200`,
      },
      {
        index: 'webhook_events_source_family_pending_idx',
        relation: 'webhook_events',
        rows: 0,
        sql: Prisma.sql`SELECT id,created_at AS at FROM webhook_events WHERE normalized_payload->'message'->>'chatId'=${chatId} AND normalized_payload->'message'->>'messageId'=${messageId} AND status IN ('RECEIVED','QUEUED','FAILED') AND processed_at IS NULL AND source_disposition_id IS NULL AND normalized_payload->'message'->>'chatId' IS NOT NULL AND normalized_payload->'message'->>'messageId' IS NOT NULL ORDER BY created_at,id LIMIT 200`,
      },
      {
        index: 'webhook_backlog_children_operation_idx',
        relation: 'webhook_backlog_children',
        rows: 0,
        sql: Prisma.sql`SELECT kind,child_key AS "childKey",octet_length(original_snapshot::text) AS size FROM webhook_backlog_children WHERE cancellation_id=${n.id} ORDER BY kind,child_key LIMIT 4097`,
      },
    ];
    const evidence: Array<Record<string, unknown>> = [];
    for (const item of sqls) {
      const explain = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_seqscan=off`;
        await tx.$executeRaw`SET LOCAL enable_bitmapscan=off`;
        await tx.$executeRaw`SET LOCAL enable_sort=off`;
        return tx.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>>(
          Prisma.sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${item.sql}`,
        );
      });
      const scans: Plan[] = [];
      const walk = (node: Plan) => {
        if (node['Relation Name']) scans.push(node);
        for (const child of node.Plans ?? []) walk(child);
      };
      walk(explain[0]!['QUERY PLAN'][0]!.Plan);
      expect(scans).toHaveLength(1);
      const scan = scans[0]!;
      expect(scan['Relation Name']).toBe(item.relation);
      expect(scan['Index Name']).toBe(item.index);
      expect(Number(scan['Actual Rows']) * Number(scan['Actual Loops'])).toBeLessThanOrEqual(
        item.rows,
      );
      expect(Number(scan['Rows Removed by Filter'] ?? 0)).toBe(0);
      expect(
        Number(scan['Shared Hit Blocks'] ?? 0) + Number(scan['Shared Read Blocks'] ?? 0),
      ).toBeLessThan(64);
      evidence.push({
        index: item.index,
        rows: scan['Actual Rows'],
        loops: scan['Actual Loops'],
        filtered: scan['Rows Removed by Filter'] ?? 0,
        sharedHits: scan['Shared Hit Blocks'] ?? 0,
        sharedReads: scan['Shared Read Blocks'] ?? 0,
      });
    }
    expect(await db.webhookBacklogChild.count({ where: { cancellationId: foreign } })).toBe(50000);
    expect(
      await db.webhookEvent.count({
        where: { id: { startsWith: `${prefix}-history-` }, status: 'FAILED', processedAt: at },
      }),
    ).toBe(50000);
    recordNativeEvidence(
      JSON.stringify({
        kind: 'V2_NATIVE_RETAINED_PLANS',
        terminalWebhooks: 50000,
        foreignChildren: 50000,
        cost: p.cost,
        plans: evidence,
      }),
    );
    const retainedProofs = async () => ({
      root: await db.webhookEvent.findUniqueOrThrow({ where: { id } }),
      claims: await db.webhookExecutionClaim.findMany({
        where: { webhookEventId: id },
        orderBy: { id: 'asc' },
      }),
      operations: await db.webhookBacklogCancellation.findMany({
        where: { id: { in: [n.id, foreign] } },
        orderBy: { id: 'asc' },
      }),
      receipts: await db.webhookBacklogReceipt.findMany({
        where: { cancellationId: { in: [n.id, foreign] } },
        orderBy: { receiptId: 'asc' },
      }),
      foreignChildren: await db.webhookBacklogChild.count({ where: { cancellationId: foreign } }),
      matchingForeignChildren: await db.webhookBacklogChild.count({
        where: {
          cancellationId: foreign,
          kind: 'MAX_ACTION',
          childKey: { startsWith: `${prefix}-foreign-` },
          originalSnapshot: { equals: { fixture: true } },
        },
      }),
      ownChildren: await db.webhookBacklogChild.count({ where: { cancellationId: n.id } }),
    });
    const retained = await retainedProofs();
    expect(retained.root.status).toBe('CANCELLED');
    expect(retained.operations).toHaveLength(2);
    expect(retained.operations.find((row) => row.id === foreign)?.sealedAt).toBeNull();
    expect(retained.receipts.map((row) => row.receiptId)).toEqual([id]);
    expect(retained.foreignChildren).toBe(50000);
    expect(retained.matchingForeignChildren).toBe(50000);
    expect(retained.ownChildren).toBe(0);
    await cleanupOwnedHistory();
    expect(await retainedProofs()).toEqual(retained);
    recordNativeEvidence({
      kind: 'V2_NATIVE_HISTORY_CLEANUP',
      removedOrdinary: 50000,
      retainedChildren: 50000,
    });
  });
});
