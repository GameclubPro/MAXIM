import { randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { PublisherAutoReplyDeliveryService } from './publisher-auto-reply-delivery.service';
import { PublisherAutoReplyRecoveryService } from './publisher-auto-reply-recovery.service';
import { PublisherAutoReplySourceFenceService } from './publisher-auto-reply-source-fence.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import type { PublisherAutoReplyJob } from './publisher-auto-reply.queue';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const integration = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

integration('Publisher auto-reply exact receipt settlement on PostgreSQL', () => {
  let db: PrismaClient;
  let service: PublisherAutoReplyDeliveryService;
  let recovery: PublisherAutoReplyRecoveryService;
  let sourceFence: PublisherAutoReplySourceFenceService;
  let chatId: string;
  let ruleId: string;
  let contentRevisionId: string;
  let deliveryId: string;
  let webhookEventId: string;
  let tableSchema: string;
  let afterFence: (() => Promise<void>) | undefined;
  const botId = `auto-reply-receipt-${randomUUID()}`;
  const faultSchema = `auto_reply_receipt_${randomUUID().replaceAll('-', '')}`;
  const triggerName = `${faultSchema}_fault`;
  const attempt = { final: false, attemptsMade: 1, maxAttempts: 7 };
  const remoteMessageId = 'synthetic-confirmed-auto-reply';
  const queue = { ensureDeliveryJob: jest.fn().mockResolvedValue(undefined) };
  const health = {
    assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
    recordSendSuccess: jest.fn().mockResolvedValue(undefined),
    recordSendFailure: jest.fn().mockResolvedValue('transient'),
  };
  const maxClient = {
    sendMessageImmediateWithId: jest.fn(
      async (_chatId: string, _text: string, options: { beforeSend: () => Promise<void> }) => {
        await options.beforeSend();
        await afterFence?.();
        return { messageId: remoteMessageId };
      },
    ),
    uploadImage: jest.fn(),
  };
  const source = () => ({
    publisherBotId: botId,
    chatId,
    sourceMessageId: 'synthetic-source-message',
    sourceWebhookEventId: webhookEventId,
  });
  const job = (): PublisherAutoReplyJob => ({
    version: 1,
    kind: 'deliver',
    retryPolicyName: 'publisher-auto-reply',
    deliveryId,
  });
  const row = () => db.publisherAutoReplyDelivery.findUniqueOrThrow({ where: { id: deliveryId } });

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    tableSchema = url.searchParams.get('schema')?.trim() || 'public';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tableSchema))
      throw new Error('Test schema must be a plain PostgreSQL identifier');
    db = createPrismaClient(databaseUrl, { max: 5, statement_timeout: 10_000 });
    await db.$connect();
    expect(await db.$queryRawUnsafe<Array<{ TimeZone: string }>>('SHOW TimeZone')).toEqual([
      { TimeZone: 'UTC' },
    ]);
    await db.$executeRawUnsafe(`CREATE SCHEMA "${faultSchema}"`);
    await db.$executeRawUnsafe(`CREATE SEQUENCE "${faultSchema}"."receipt_write_attempts"`);
    // FLAG: Inject actual PostgreSQL failures only for the exact disposable delivery's SENT
    // write. Sequence increments survive rollback so the production SQL retry is measurable.
    await db.$executeRawUnsafe(`
      CREATE FUNCTION "${faultSchema}"."fail_receipt_write"() RETURNS trigger
      LANGUAGE plpgsql AS $body$
      BEGIN
        IF nextval('"${faultSchema}"."receipt_write_attempts"') <= TG_ARGV[0]::integer THEN
          RAISE EXCEPTION 'Synthetic receipt write conflict' USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END
      $body$
    `);
  });

  function createService() {
    return new PublisherAutoReplyDeliveryService(
      db as never,
      maxClient as never,
      {
        assertEntityReady: async () => ({ chatId, entityType: 'chat', requiredBotId: botId }),
      } as never,
      health as never,
      sourceFence,
      { get: (_key: string, fallback: unknown) => fallback } as never,
      {
        getBotId: () => botId,
        getRequiredActionToken: () => 'synthetic-never-transmitted-token',
      } as never,
    );
  }

  beforeEach(async () => {
    afterFence = undefined;
    jest.clearAllMocks();
    chatId = `auto-reply-receipt-chat-${randomUUID()}`;
    deliveryId = `auto-reply-receipt-delivery-${randomUUID()}`;
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Synthetic receipt settlement fixture',
        publisherSettings: {
          create: { autoRepliesEnabled: true, autoReplyConfigRevision: 7, revision: 4 },
        },
        publicationPolicy: { create: { publikEnabled: true, revision: 2 } },
      },
    });
    const rule = await db.publisherAutoReplyRule.create({
      data: {
        chatId,
        phrase: 'прайс',
        normalizedPhrase: 'прайс',
        version: 3,
        cooldownSeconds: 30,
        createdByUserId: 'synthetic-admin',
        updatedByUserId: 'synthetic-admin',
        contentRevisions: {
          create: {
            revision: 1,
            text: 'Synthetic auto-reply',
            createdByUserId: 'synthetic-admin',
          },
        },
      },
      include: { contentRevisions: true },
    });
    ruleId = rule.id;
    contentRevisionId = rule.contentRevisions[0]!.id;
    await db.publisherAutoReplyRule.update({
      where: { id: ruleId },
      data: { currentContentRevisionId: contentRevisionId },
    });
    const event = await db.webhookEvent.create({
      data: {
        dedupKey: `auto-reply-receipt-${randomUUID()}`,
        botId,
        rawPayload: { synthetic: true },
        normalizedPayload: { synthetic: true },
      },
    });
    webhookEventId = event.id;
    sourceFence = new PublisherAutoReplySourceFenceService(db as never);
    expect(await sourceFence.admit(source())).toBe('admitted');
    await db.publisherAutoReplyDelivery.create({
      data: {
        id: deliveryId,
        chatId,
        ruleId,
        contentRevisionId,
        publisherBotId: botId,
        sourceMessageId: source().sourceMessageId,
        sourceUserId: 'synthetic-member',
        sourceWebhookEventId: webhookEventId,
        matchedRuleVersion: 3,
        matchedNormalizedPhrase: 'прайс',
        autoReplyConfigRevision: 7,
        publisherSettingsRevision: 4,
        publicationPolicyRevision: 2,
        dueAt: new Date(Date.now() - 1_000),
      },
    });
    service = createService();
    recovery = new PublisherAutoReplyRecoveryService(
      db as never,
      queue as never,
      { dispatchEnabled: true } as never,
      {} as never,
      {} as never,
      new PublisherBackgroundWorkCoordinatorService(),
    );
  });

  afterEach(async () => {
    await db.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "${triggerName}" ON "${tableSchema}"."publisher_auto_reply_deliveries"`,
    );
    await db.publisherAutoReplyDelivery.deleteMany({ where: { chatId } });
    await db.publisherAutoReplyRule.updateMany({
      where: { chatId },
      data: { currentContentRevisionId: null },
    });
    await db.publisherAutoReplyRule.deleteMany({ where: { chatId } });
    await db.chat.deleteMany({ where: { id: chatId } });
    await db.webhookExecutionClaim.deleteMany({ where: { webhookEventId } });
    await db.webhookEvent.deleteMany({ where: { id: webhookEventId } });
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${faultSchema}" CASCADE`);
    } finally {
      await db.$disconnect();
    }
  });

  async function failReceiptWrites(count: number) {
    await db.$executeRawUnsafe(
      `ALTER SEQUENCE "${faultSchema}"."receipt_write_attempts" RESTART WITH 1`,
    );
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE UPDATE ON "${tableSchema}"."publisher_auto_reply_deliveries"
      FOR EACH ROW WHEN (NEW.id = '${deliveryId}' AND NEW.status::text = 'SENT')
      EXECUTE FUNCTION "${faultSchema}"."fail_receipt_write"('${count}')
    `);
  }

  async function receiptWriteAttempts() {
    const result = await db.$queryRawUnsafe<Array<{ attempts: number }>>(
      `SELECT last_value::integer AS attempts FROM "${faultSchema}"."receipt_write_attempts"`,
    );
    return result[0]!.attempts;
  }

  it('retries a real failed SQL receipt write without another MAX send', async () => {
    await failReceiptWrites(1);
    await service.process(job(), attempt);
    expect(await receiptWriteAttempts()).toBe(2);
    expect(await row()).toMatchObject({
      status: 'SENT',
      remoteMessageId,
      dispatchStartedAt: expect.any(Date),
      attemptCount: 1,
      lockToken: null,
      failureCode: null,
    });
    await createService().process(job(), attempt);
    await recovery.recoverOnce(new Date(Date.now() + 3 * 60_000));
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(health.recordSendSuccess).toHaveBeenCalledTimes(1);
    expect(health.recordSendFailure).not.toHaveBeenCalled();
    expect(queue.ensureDeliveryJob).not.toHaveBeenCalled();
    expect(await db.publisherAutoReplyCooldown.count({ where: { ruleId } })).toBe(1);
  });

  it('settles a late exact receipt after stale-lease recovery and policy revocation', async () => {
    const crossed = gate();
    const release = gate();
    afterFence = async () => {
      crossed.resolve();
      await release.promise;
    };
    const sending = service.process(job(), attempt);
    const settled = expect(sending).resolves.toBeUndefined();
    try {
      await crossed.promise;
      const fenced = await row();
      expect(fenced.status).toBe('SENDING');
      expect(fenced.dispatchStartedAt).toEqual(expect.any(Date));
      await sourceFence.cancel(source());
      await db.publisherEntitySettings.update({
        where: { chatId },
        data: { autoRepliesEnabled: false, revision: { increment: 1 } },
      });
      await db.publisherAutoReplyRule.update({ where: { id: ruleId }, data: { enabled: false } });
      await expect(
        recovery.recoverOnce(new Date(fenced.lockedAt!.getTime() + 2 * 60_000 + 1)),
      ).resolves.toMatchObject({ ambiguous: 1, enqueued: 0, reset: 0 });
      expect(await row()).toMatchObject({
        status: 'AMBIGUOUS',
        dispatchStartedAt: fenced.dispatchStartedAt,
        remoteMessageId: null,
        failureCode: 'STALE_SEND_FENCE',
      });
      await createService().process(job(), attempt);
      expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    await settled;
    expect(await row()).toMatchObject({
      status: 'SENT',
      remoteMessageId,
      attemptCount: 1,
      failureCode: null,
      lockToken: null,
    });
    await recovery.recoverOnce(new Date(Date.now() + 3 * 60_000));
    await createService().process(job(), attempt);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(queue.ensureDeliveryJob).not.toHaveBeenCalled();
    expect(health.recordSendFailure).not.toHaveBeenCalled();
  });

  it('keeps the committed send fence when all three SQL receipt writes fail, without resending', async () => {
    await failReceiptWrites(3);
    await expect(service.process(job(), attempt)).rejects.toThrow();
    expect(await receiptWriteAttempts()).toBe(3);
    const fenced = await row();
    expect(fenced).toMatchObject({
      status: 'SENDING',
      dispatchStartedAt: expect.any(Date),
      remoteMessageId: null,
      attemptCount: 1,
      failureCode: null,
    });
    await createService().process(job(), attempt);
    await recovery.recoverOnce(new Date(Date.now() + 3 * 60_000));
    expect(await row()).toMatchObject({
      status: 'AMBIGUOUS',
      dispatchStartedAt: fenced.dispatchStartedAt,
      remoteMessageId: null,
      attemptCount: 1,
    });
    expect(await receiptWriteAttempts()).toBe(3);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(health.recordSendSuccess).not.toHaveBeenCalled();
    expect(health.recordSendFailure).not.toHaveBeenCalled();
    expect(queue.ensureDeliveryJob).not.toHaveBeenCalled();
  });

  it('cannot attach an old receipt to a different durable dispatch timestamp', async () => {
    const crossed = gate();
    const release = gate();
    afterFence = async () => {
      crossed.resolve();
      await release.promise;
    };
    const sending = service.process(job(), attempt);
    const rejected = expect(sending).rejects.toThrow('could not be persisted');
    let replacementFence: Date;
    try {
      await crossed.promise;
      const fenced = await row();
      replacementFence = new Date(fenced.dispatchStartedAt!.getTime() + 1);
      await db.publisherAutoReplyDelivery.update({
        where: { id: deliveryId },
        data: { dispatchStartedAt: replacementFence, lockToken: 'synthetic-replacement-worker' },
      });
    } finally {
      release.resolve();
    }
    await rejected;
    expect(await row()).toMatchObject({
      status: 'SENDING',
      dispatchStartedAt: replacementFence!,
      lockToken: 'synthetic-replacement-worker',
      remoteMessageId: null,
      attemptCount: 1,
      failureCode: null,
    });
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(health.recordSendFailure).not.toHaveBeenCalled();
  });
});
