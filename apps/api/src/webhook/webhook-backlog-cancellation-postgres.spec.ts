import { randomUUID } from 'node:crypto';
import { Queue, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { Prisma, createPrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  backlogReceiptPageSql,
  readBacklogPage,
  captureBacklogReceipts,
  projectBacklogReceipts,
  visitBacklogQueues,
  type BacklogCancellationRequest,
} from '../scripts/cancel-webhook-backlog';
import { materializeBacklogCancellation } from './webhook-backlog-cancellation';
import { WebhookLegacyHoldService, assertLegacyActionAllowed } from './webhook-legacy-hold.service';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { WebhookOutboxService } from './webhook-outbox.service';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

native('operator backlog cancellation with native PostgreSQL and Redis', () => {
  let db: ReturnType<typeof createPrismaClient>, redis: Redis;
  beforeAll(async () => {
    if (
      !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname) ||
      !new URL(databaseUrl).pathname.includes('race_test') ||
      !['localhost', '127.0.0.1'].includes(new URL(redisUrl).hostname)
    )
      throw new Error('Disposable stores required');
    db = createPrismaClient(databaseUrl, { max: 2 });
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.ping();
  });
  afterAll(async () => {
    await redis?.quit();
    await db?.$disconnect();
  });

  function request(): BacklogCancellationRequest {
    return {
      id: randomUUID(),
      cutoff: new Date(Date.now() - 60_000).toISOString(),
      sourceSha: 'a'.repeat(40),
      imageId: `sha256:${'b'.repeat(64)}`,
    };
  }
  async function receipt(at: Date, status: 'RECEIVED' | 'FAILED' = 'RECEIVED') {
    const update = {
      type: 'message_created',
      updateId: randomUUID(),
      timestamp: at.toISOString(),
      botId: 'fixture',
      message: {
        chatId: `-${randomUUID()}`,
        messageId: randomUUID(),
        senderId: 'same-user',
        text: 'fixture',
      },
    };
    return db.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        createdAt: at,
        status,
        errorMessage: status === 'FAILED' ? 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:uncertain' : null,
        semanticKey: buildWebhookSemanticEventKey(update),
        rawPayload: update,
        normalizedPayload: update,
      },
    });
  }
  async function seal(id: string) {
    await db.$executeRaw(Prisma.sql`UPDATE webhook_backlog_cancellations SET sealed_at = clock_timestamp() AT TIME ZONE 'UTC'
      WHERE id = ${id} AND sealed_at IS NULL`);
  }

  it('bounds each SQL page even across retained failed history and tied timestamps', async () => {
    const at = new Date(Date.now() - 3600_000);
    const prefix = randomUUID();
    await db.webhookEvent.createMany({
      data: Array.from({ length: 2000 }, (_, i) => ({
        id: `${prefix}-${String(i).padStart(4, '0')}`,
        dedupKey: `${prefix}-${i}`,
        status: 'FAILED' as const,
        createdAt: at,
        rawPayload: {},
        normalizedPayload: {},
        errorMessage: 'retained terminal failure',
      })),
    });
    try {
      await db.$executeRaw`ANALYZE webhook_events`;
      const query = backlogReceiptPageSql('FAILED', new Date(), { at, id: `${prefix}-0500` });
      const plan = await readBacklogPage<
        Array<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>
      >(db, Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`);
      const nodes: Array<Record<string, unknown>> = [];
      const walk = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) walk(child);
      };
      walk(plan[0]!['QUERY PLAN'][0]!.Plan);
      const scans = nodes.filter((node) => node['Relation Name'] === 'webhook_events');
      expect(scans.length).toBe(2);
      for (const scan of scans) {
        expect(scan['Node Type']).toMatch(/Index/);
        expect(Number(scan['Actual Rows']) * Number(scan['Actual Loops'])).toBeLessThanOrEqual(200);
        expect(Number(scan['Rows Removed by Filter'] ?? 0)).toBe(0);
      }
      const page = await readBacklogPage<Array<{ id: string; eligible: boolean }>>(db, query);
      expect(page).toHaveLength(200);
      expect(page.every((row) => !row.eligible)).toBe(true);
    } finally {
      await db.webhookEvent.deleteMany({ where: { id: { startsWith: prefix } } });
    }
  });

  it('resumes after capture and after sealing, retains uncertainty, denies replay and leaves fresh messages eligible', async () => {
    const operation = request();
    const old = await receipt(new Date(Date.now() - 120_000), 'FAILED');
    const fresh = await receipt(new Date());
    const claim = await db.webhookExecutionClaim.create({
      data: {
        semanticKey: old.semanticKey!,
        webhookEventId: old.id,
        status: 'READY',
        enforced: true,
        businessStartedAt: old.createdAt,
        preparedAt: old.createdAt,
        commandResult: { ambiguous: true },
      },
    });
    await captureBacklogReceipts(db, operation);
    await captureBacklogReceipts(db, operation);
    expect(await db.$transaction((tx) => materializeBacklogCancellation(tx, old.id))).toBe(
      'BLOCKED_UNKNOWN',
    );
    await seal(operation.id);
    await projectBacklogReceipts(db, operation.id);
    await projectBacklogReceipts(db, operation.id);
    expect(await db.webhookExecutionClaim.findUnique({ where: { id: claim.id } })).toEqual(claim);
    expect(await db.webhookEvent.findUnique({ where: { id: old.id } })).toEqual({
      ...old,
      status: 'CANCELLED',
    });
    expect(await db.webhookEvent.findUnique({ where: { id: fresh.id } })).toEqual(fresh);
    await expect(
      db.webhookEvent.update({ where: { id: old.id }, data: { status: 'RECEIVED' } }),
    ).rejects.toThrow();
    await expect(
      db.webhookExecutionClaim.update({
        where: { id: claim.id },
        data: { businessStartedAt: null },
      }),
    ).rejects.toThrow();
    const holds = new WebhookLegacyHoldService(db as unknown as PrismaService);
    const update = old.normalizedPayload as never;
    expect(await holds.isUpdateHeld(update)).toBe(true);
    expect(
      await holds.isMemberHeld(
        (old.normalizedPayload as { message: { chatId: string } }).message.chatId,
        'same-user',
      ),
    ).toBe(false);
    expect(await holds.isGlobalUserHeld('same-user')).toBe(false);
    expect(await holds.isUpdateHeld(fresh.normalizedPayload as never)).toBe(false);
    const mirror = await db.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        semanticKey: old.semanticKey,
        rawPayload: old.rawPayload as Prisma.InputJsonValue,
        normalizedPayload: old.normalizedPayload as Prisma.InputJsonValue,
      },
    });
    expect(await db.$transaction((tx) => materializeBacklogCancellation(tx, mirror.id))).toBe(
      'APPLIED_WITH_PROOF',
    );
    expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: mirror.id } })).status).toBe(
      'CANCELLED',
    );
    expect(await holds.readFreshCommandReceipt(mirror.id, update)).toBeNull();
    await expect(
      db.webhookBacklogReceipt.delete({ where: { receiptId: old.id } }),
    ).rejects.toThrow();
    await db.webhookEvent.delete({ where: { id: fresh.id } });
  });

  it('retains a completed original behind a cancelled mirror without blocking unrelated history cleanup', async () => {
    const original = await receipt(new Date(Date.now() - 120_000));
    await db.webhookEvent.update({
      where: { id: original.id },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
    const claim = await db.webhookExecutionClaim.create({
      data: {
        semanticKey: original.semanticKey!,
        webhookEventId: original.id,
        status: 'COMPLETED',
        enforced: true,
        preparedAt: original.createdAt,
        completedAt: new Date(),
      },
    });
    await db.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        semanticKey: original.semanticKey,
        createdAt: original.createdAt,
        rawPayload: original.rawPayload as Prisma.InputJsonValue,
        normalizedPayload: original.normalizedPayload as Prisma.InputJsonValue,
      },
    });
    const unrelated = await receipt(original.createdAt);
    await db.webhookEvent.update({
      where: { id: unrelated.id },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
    const operation = request();
    await captureBacklogReceipts(db, operation);
    await seal(operation.id);
    await projectBacklogReceipts(db, operation.id);
    const retention = Object.assign(Object.create(WebhookOutboxService.prototype), {
      prisma: db,
      webhookRetentionCursors: new Map(),
    }) as { deleteCompletedWebhookBatch(cutoff: Date): Promise<unknown> };
    await retention.deleteCompletedWebhookBatch(new Date());
    expect(await db.webhookEvent.findUnique({ where: { id: original.id } })).not.toBeNull();
    expect(await db.webhookExecutionClaim.findUnique({ where: { id: claim.id } })).toEqual(claim);
    expect(await db.webhookEvent.findUnique({ where: { id: unrelated.id } })).toBeNull();
  });

  it('removes cancelled webhook/action jobs, keeps future publications and rejects reintroduced action IDs', async () => {
    const operation = request();
    const old = await receipt(new Date(Date.now() - 120_000));
    const webhook = new Queue('moderation-default-0', {
      connection: redis as unknown as ConnectionOptions,
    });
    const actions = new Queue('max-actions-background', {
      connection: redis as unknown as ConnectionOptions,
    });
    const schedules = new Queue('publisher-publication-wakeup', {
      connection: redis as unknown as ConnectionOptions,
    });
    try {
      const webhookJob = await webhook.add('fixture', { webhookEventId: old.id });
      const data = {
        actionType: 'SEND_MESSAGE' as const,
        chatId: '-fixture',
        idempotencyKey: randomUUID(),
        createdAt: old.createdAt.toISOString(),
        attempt: 0,
      };
      const action = await actions.add('fixture', data, { timestamp: old.createdAt.getTime() });
      const publication = await actions.add(
        'fixture',
        { ...data, idempotencyKey: randomUUID(), sourceTag: 'managed_broadcast' },
        { timestamp: old.createdAt.getTime() },
      );
      const future = await schedules.add(
        'fixture',
        { occurrenceId: randomUUID() },
        { delay: 3600_000 },
      );
      await captureBacklogReceipts(db, operation);
      await visitBacklogQueues(db, redis, operation, false);
      await seal(operation.id);
      await projectBacklogReceipts(db, operation.id);
      await visitBacklogQueues(db, redis, operation, true);
      expect(await webhook.getJob(webhookJob.id!)).toBeUndefined();
      expect(await actions.getJob(action.id!)).toBeUndefined();
      expect(await actions.getJob(publication.id!)).toBeDefined();
      expect(await schedules.getJob(future.id!)).toBeDefined();
      const holds = new WebhookLegacyHoldService(db as unknown as PrismaService);
      await expect(assertLegacyActionAllowed(holds, data)).rejects.toThrow();
      await publication.remove();
      await future.remove();
    } finally {
      await webhook.close();
      await actions.close();
      await schedules.close();
    }
  });

  it('unblocks a fresh event in the same chat through the real outbox and moderation pipeline', async () => {
    let h: MultibotHarness | undefined;
    try {
      h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 2, mode: 'on' });
      await h.pause();
      const [chatId] = await h.seedCatalog(1, {
        maxMessageLengthEnabled: true,
        maxMessageLength: 20,
      });
      const settings = await h.prisma.chatSettings.findUniqueOrThrow({
        where: { chatId: chatId! },
      });
      const chat = await h.prisma.chat.findUniqueOrThrow({ where: { id: chatId! } });
      const oldId = await h.ingest({
        chatId: chatId!,
        messageId: randomUUID(),
        text: 'old',
        botId: h.bots[0]!.id,
      });
      await h.prisma.webhookEvent.update({
        where: { id: oldId },
        data: {
          createdAt: new Date(Date.now() - 120_000),
          status: 'FAILED',
          errorMessage: 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:uncertain',
        },
      });
      const freshId = await h.ingest({
        chatId: chatId!,
        messageId: randomUUID(),
        text: 'Fresh fixture message that exceeds the configured message length',
        botId: h.bots[0]!.id,
      });
      const operation = request();
      await captureBacklogReceipts(db, operation);
      await seal(operation.id);
      await projectBacklogReceipts(db, operation.id);
      await h.resume();
      await h.drain();
      expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: freshId } })).status).toBe(
        'PROCESSED',
      );
      expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: oldId } })).status).toBe(
        'CANCELLED',
      );
      expect(await db.chatSettings.findUnique({ where: { chatId: chatId! } })).toEqual(settings);
      expect(await db.chat.findUnique({ where: { id: chatId! } })).toMatchObject({
        id: chat.id,
        primaryBotId: chat.primaryBotId,
        botId: chat.botId,
      });
      expect(h.effects.some((effect) => effect.method === 'delete')).toBe(true);
    } finally {
      if (h) {
        // FLAG: Permanent cancellation fixtures live until the disposable database is dropped.
        const cancelled = await db.webhookBacklogReceipt.findMany({
          where: { receiptId: { in: h.receiptIds } },
          select: { receiptId: true },
        });
        for (const row of cancelled) h.receiptIds.splice(h.receiptIds.indexOf(row.receiptId), 1);
        await h.dispose();
      }
    }
  });
});
