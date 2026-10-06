import { randomBytes, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { Prisma, createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { WebhookParser } from '../webhook/webhook.parser';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import { ALL_WEBHOOK_QUEUE_NAMES } from '../webhook/webhook-queues';
import {
  legacySnapshotDigest,
  type LegacyStopAttestation,
} from '../webhook/webhook-legacy-cold-install';
import { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import { runLegacyOrderRecoveryInDisposableStores } from '../../test/fixtures/legacy-order-recovery.fixture';
import { scanLegacyRecoveryQueueCatalog } from './legacy-recovery-queue-inventory';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const originalRedisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = databaseUrl && originalRedisUrl ? describe : describe.skip;
const coldWebhookQueues = [...ALL_WEBHOOK_QUEUE_NAMES, 'moderation-default'];
jest.setTimeout(60_000);

native('real-store complete bounded legacy preview and atomic apply', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  const queues: Queue[] = [];
  const certificates: string[] = [];
  const owners: string[] = [];
  const chats: string[] = [];
  let cutoff: Date;
  const nonce = randomBytes(32).toString('hex');
  const priorEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    MAXIM_LEGACY_RECOVERY_OFFLINE: process.env.MAXIM_LEGACY_RECOVERY_OFFLINE,
  };
  beforeAll(async () => {
    const pg = new URL(databaseUrl);
    const cache = new URL(originalRedisUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(pg.hostname) ||
      !pg.pathname.includes('race_test') ||
      !['localhost', '127.0.0.1', '[::1]'].includes(cache.hostname)
    )
      throw new Error('Cold CLI acceptance requires isolated native stores');
    // Separate disposable Redis database keeps the complete namespace inventory
    // independent of other race fixtures. It has no production connection.
    cache.pathname = '/14';
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = cache.toString();
    process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = '1';
    prisma = createPrismaClient(databaseUrl, { max: 4, statement_timeout: 10_000 });
    const [proof] = await prisma.$queryRaw<
      Array<{ version: string; tz: string }>
    >`SELECT version(), current_setting('TimeZone') AS tz`;
    if (!proof?.version.startsWith('PostgreSQL ') || proof.tz !== 'UTC' || process.env.TZ !== 'UTC')
      throw new Error('Cold CLI requires native UTC stores');
    redis = new Redis(cache.toString());
    if (await redis.dbsize())
      throw new Error('Disposable Redis acceptance database is already occupied');
    for (const name of coldWebhookQueues) {
      const queue = new Queue(name, { connection: { url: process.env.REDIS_URL } });
      queues.push(queue);
      await queue.pause();
    }
    await redis.set('maxim:webhook-rollout:pause-owner:v1', `rollout:${nonce}`);
    cutoff = (
      await prisma.$queryRaw<
        Array<{ at: Date }>
      >`SELECT finished_at AS at FROM _prisma_migrations WHERE migration_name = '20261005020000_add_multibot_order_fences' AND finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1`
    )[0]!.at;
  });
  afterEach(async () => {
    await prisma.webhookLegacyChildHold.deleteMany({
      where: { certificateId: { in: certificates } },
    });
    await prisma.webhookLegacyRecovery.deleteMany({
      where: { certificateId: { in: certificates } },
    });
    await prisma.webhookLegacyQuiescenceCertificate.deleteMany({
      where: { id: { in: certificates.splice(0) } },
    });
    await prisma.webhookExecutionClaim.deleteMany({ where: { webhookEventId: { in: owners } } });
    await prisma.webhookEvent.deleteMany({ where: { id: { in: owners.splice(0) } } });
    await prisma.chat.deleteMany({ where: { id: { in: chats.splice(0) } } });
    for (const queue of queues.filter((queue) => !coldWebhookQueues.includes(queue.name as never)))
      await queue.obliterate({ force: true });
    await redis.set('maxim:webhook-rollout:pause-owner:v1', `rollout:${nonce}`);
  });
  afterAll(async () => {
    for (const queue of queues) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await redis.del('maxim:webhook-rollout:pause-owner:v1');
    redis.disconnect();
    await prisma.$disconnect();
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  async function input() {
    const chatId = `-cli-${randomUUID()}`;
    chats.push(chatId);
    await prisma.chat.create({
      data: { id: chatId, entityType: 'CHAT', title: 'Disposable CLI source' },
    });
    const timestamp = cutoff.getTime() - 5_000;
    const raw = {
      update_type: 'message_created',
      timestamp,
      message: {
        timestamp,
        sender: { user_id: `human-${randomUUID()}`, is_bot: false, name: 'Human' },
        recipient: { chat_id: chatId, chat_type: 'chat' },
        body: { mid: `source-${randomUUID()}`, text: 'Plain retained source' },
      },
    };
    const update = new WebhookParser().parse(raw, { botId: 'major-1' });
    const semanticKey = buildWebhookSemanticEventKey(update)!;
    const owner = await prisma.webhookEvent.create({
      data: {
        botId: 'major-1',
        dedupKey: randomUUID(),
        semanticKey,
        normalizedPayload: update as unknown as Prisma.InputJsonValue,
        rawPayload: {},
        status: 'FAILED',
        createdAt: new Date(timestamp + 1_000),
        errorMessage:
          'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
      },
    });
    owners.push(owner.id);
    await prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey,
        webhookEventId: owner.id,
        createdAt: new Date(timestamp + 1_000),
        enforced: false,
      },
    });
    const imageId = `sha256:${'a'.repeat(64)}`;
    const attestation: LegacyStopAttestation = {
      version: 1,
      sourceSha: 'b'.repeat(40),
      imageId,
      transitionJournalSha256: 'c'.repeat(64),
      previewSha256: '0'.repeat(64),
      queueFenceNonce: nonce,
      roleSnapshots: RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all').map(
        (serviceName) => ({
          serviceName,
          containerId: legacySnapshotDigest(serviceName),
          sourceSha: 'b'.repeat(40),
          imageId,
          stopped: true,
        }),
      ),
    };
    return {
      request: {
        version: 1 as const,
        mode: 'preview' as const,
        ownerIds: [owner.id],
        majorBotIds: ['major-1'],
        attestation,
      },
      owner,
      update,
    };
  }
  // FLAG: This verifies the real store-only CLI, not Docker/all-role stop evidence.
  // Host inventory fixtures and actual killed worker recovery cover those separate boundaries.
  it('previews without metadata writes then installs and seals one exact batch', async () => {
    const { request, owner, update } = await input();
    const before = await prisma.webhookLegacyQuiescenceCertificate.count();
    const keysBefore = (await redis.keys('*')).sort();
    const preview = (await runLegacyOrderRecoveryInDisposableStores(request)) as {
      previewSha256: string;
    };
    expect(await prisma.webhookLegacyQuiescenceCertificate.count()).toBe(before);
    expect((await redis.keys('*')).sort()).toEqual(keysBefore);
    const result = (await runLegacyOrderRecoveryInDisposableStores({
      ...request,
      mode: 'apply',
      reviewedPreviewSha256: preview.previewSha256,
    })) as { certificateId: string };
    certificates.push(result.certificateId);
    expect(
      (
        await prisma.webhookLegacyQuiescenceCertificate.findUniqueOrThrow({
          where: { id: result.certificateId },
        })
      ).sealedAt,
    ).not.toBeNull();
    expect(await new WebhookLegacyHoldService(prisma as never).isUpdateHeld(update)).toBe(true);
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: owner.id } })).errorMessage,
    ).toBe(owner.errorMessage);
    expect(
      (
        await prisma.webhookExecutionClaim.findUniqueOrThrow({
          where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: owner.semanticKey! } },
        })
      ).status,
    ).not.toBe('COMPLETED');
  });
  it('refuses changed reviewed hashes and lost ownership before any certificate write', async () => {
    const { request } = await input();
    const before = await prisma.webhookLegacyQuiescenceCertificate.count();
    await expect(
      runLegacyOrderRecoveryInDisposableStores({
        ...request,
        mode: 'apply',
        reviewedPreviewSha256: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'reviewed_preview_changed' });
    await redis.del('maxim:webhook-rollout:pause-owner:v1');
    await expect(runLegacyOrderRecoveryInDisposableStores(request)).rejects.toMatchObject({
      code: 'queue_fence_unproved',
    });
    expect(await prisma.webhookLegacyQuiescenceCertificate.count()).toBe(before);
  });
  it('refuses pending unattributed SEND and non-MAX children', async () => {
    const { request } = await input();
    for (const name of ['max-actions-interactive', 'global-spammer-denorm']) {
      const queue = new Queue(name, { connection: { url: process.env.REDIS_URL } });
      queues.push(queue);
      await queue.add('pending', {
        actionType: 'SEND_MESSAGE',
        chatId: '-unrelated',
        idempotencyKey: randomUUID(),
      });
      await expect(runLegacyOrderRecoveryInDisposableStores(request)).rejects.toMatchObject({
        code:
          name === 'max-actions-interactive' ? 'send_source_unattributed' : 'non_max_work_pending',
      });
      await queue.obliterate({ force: true });
    }
  });
  it('bounds payload bytes before reading arbitrarily large retained job data', async () => {
    const { request } = await input();
    const queue = new Queue('max-actions-interactive', {
      connection: { url: process.env.REDIS_URL },
    });
    queues.push(queue);
    const job = await queue.add('pending', {
      actionType: 'SEND_MESSAGE',
      chatId: '-unrelated',
      idempotencyKey: randomUUID(),
    });
    await redis.hset(queue.toKey(job.id!), 'data', 'x'.repeat(64 * 1024 + 1));
    await expect(runLegacyOrderRecoveryInDisposableStores(request)).rejects.toMatchObject({
      code: 'queue_inventory_unproved',
    });
  });
  it('rejects an oversized Redis catalog reply before it reaches the client or writes a certificate', async () => {
    const { request } = await input();
    const key = `bull:unreviewed:${'x'.repeat(64 * 1024)}`;
    const before = await prisma.webhookLegacyQuiescenceCertificate.count();
    await redis.set(key, 'catalog-only');
    try {
      // A small catalog fits one scan. The readonly script returns only its
      // refusal sentinel rather than transferring the oversized key to Node.
      await expect(scanLegacyRecoveryQueueCatalog(redis, '0')).rejects.toMatchObject({
        code: 'queue_catalog_budget_exceeded',
      });
      await expect(runLegacyOrderRecoveryInDisposableStores(request)).rejects.toMatchObject({
        code: 'queue_catalog_budget_exceeded',
      });
      expect(await redis.get(key)).toBe('catalog-only');
      expect(await prisma.webhookLegacyQuiescenceCertificate.count()).toBe(before);
    } finally {
      await redis.del(key);
    }
  });
  it('inventories a known MAX queue with retained jobs even if its metadata is missing', async () => {
    const { request, update } = await input();
    const queue = new Queue('max-actions-interactive', {
      connection: { url: process.env.REDIS_URL },
    });
    queues.push(queue);
    await queue.add('pending', {
      actionType: 'SEND_MESSAGE',
      chatId: update.message!.chatId,
      idempotencyKey: randomUUID(),
      ledgerContext: {
        moderationSource: {
          version: 1,
          chatId: update.message!.chatId,
          messageId: update.message!.messageId,
          userId: update.message!.senderId,
        },
      },
    });
    await redis.del(queue.toKey('meta'));
    const preview = (await runLegacyOrderRecoveryInDisposableStores(request)) as {
      children: number;
    };
    expect(preview.children).toBe(1);
    expect(await redis.exists(queue.toKey('meta'))).toBe(0);
  });
});
