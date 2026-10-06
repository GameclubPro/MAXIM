import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { MaxUpdate } from '@maxim/contracts';
import { WebhookCanonicalExecutionService } from '../moderation/webhook-canonical-execution.service';
import {
  createPrismaClient,
  type PrismaClient,
  Prisma,
  type WebhookEvent,
} from '../prisma/prisma-client';
import { WebhookParser } from './webhook.parser';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { buildWebhookReceiptSemanticKey } from './webhook-receipt-semantic-key';
import { WebhookService } from './webhook.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;
const publisherBotId = 'fixture-publisher';
type ReceiptInternals = {
  persistReceipt(
    update: MaxUpdate,
    sourceIp: null,
    rawPayload: Prisma.InputJsonValue,
  ): Promise<string>;
};
type OrderedGuard = {
  assertNoOutstandingOrderedPredecessor(event: WebhookEvent, update: MaxUpdate): Promise<void>;
};

// FLAG: Synthetic loopback receipts exercise the real SQL ordering guard. These fixtures
// never invoke MAX transport or turn an old production receipt into execution authority.
native('Publisher receipt semantic isolation in PostgreSQL', () => {
  jest.setTimeout(30_000);
  let prisma: PrismaClient;
  let ingress: WebhookService;
  let canonical: WebhookCanonicalExecutionService;
  const ids: string[] = [];
  const lifecycle = { observeWebhook: jest.fn().mockResolvedValue(undefined) };
  const retention = {
    captureInput: jest.fn((update: MaxUpdate) => ({ fixtureUpdateId: update.updateId })),
    capture: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Only disposable loopback PostgreSQL is permitted');
    prisma = createPrismaClient(databaseUrl, { max: 8, statement_timeout: 10_000 });
    const [identity] = await prisma.$queryRaw<Array<{ version: string; timezone: string }>>`
      SELECT version(), current_setting('TimeZone') AS timezone`;
    expect(identity?.version).toMatch(/^PostgreSQL 16\./u);
    expect(identity?.timezone).toBe('UTC');
    expect(process.env.TZ).toBe('UTC');
  });

  beforeEach(() => {
    ingress = new WebhookService(
      prisma as never,
      new ConfigService({
        MAX_PUBLISHER_BOT_ID: publisherBotId,
        WEBHOOK_CANONICAL_EXECUTION_MODE: 'on',
      }),
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lifecycle as never,
    );
    Object.assign(ingress, { messageRetention: retention });
    canonical = new WebhookCanonicalExecutionService(prisma as never);
  });

  afterEach(async () => {
    await ingress?.onModuleDestroy();
    const owned = ids.splice(0);
    await prisma.webhookExecutionClaim.deleteMany({ where: { webhookEventId: { in: owned } } });
    await prisma.webhookEvent.deleteMany({ where: { id: { in: owned } } });
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function persist(update: MaxUpdate, createdAt: Date) {
    const id = await (ingress as unknown as ReceiptInternals).persistReceipt(
      update,
      null,
      update.raw!,
    );
    ids.push(id);
    return prisma.webhookEvent.update({ where: { id }, data: { createdAt } });
  }

  async function fixture(type: 'message_created' | 'message_edited' = 'message_created') {
    const now = Date.now();
    const update = new WebhookParser().parse(
      {
        update_type: type,
        update_id: randomUUID(),
        timestamp: now,
        message: {
          sender: { user_id: 'fixture-author', name: 'Fixture', is_bot: false },
          recipient: { chat_id: `-${randomUUID()}`, chat_type: 'chat' },
          timestamp: now,
          body: { mid: randomUUID(), text: 'fixture content' },
        },
      },
      { botId: publisherBotId },
    );
    const publisher = await persist(update, new Date(now - 100));
    await expect(ingress.preparePersistedWebhookEvent(publisher.id, update)).resolves.toMatchObject(
      {
        canonical: false,
        prepared: true,
      },
    );
    const regularUpdate = { ...update, botId: 'fixture-moderator' };
    const storedOwner = await persist(regularUpdate, new Date(now));
    const owner = await prisma.webhookEvent.update({
      where: { id: storedOwner.id },
      data: { status: 'QUEUED' },
    });
    const semanticKey = buildWebhookSemanticEventKey(regularUpdate)!;
    const claim = await prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey,
        webhookEventId: owner.id,
        executionBotId: regularUpdate.botId,
        enforced: true,
        status: 'READY',
        preparedAt: new Date(now),
      },
    });
    return { publisher, update, owner, regularUpdate, semanticKey, claim };
  }

  async function guard(f: Awaited<ReturnType<typeof fixture>>) {
    return (canonical as unknown as OrderedGuard).assertNoOutstandingOrderedPredecessor(
      f.owner,
      f.regularUpdate,
    );
  }

  it.each(['message_created', 'message_edited'] as const)(
    'removes the Publisher %s collision while retaining canonical claims and retention capture',
    async (type) => {
      const f = await fixture(type);
      const observation = await prisma.webhookEvent.findUniqueOrThrow({
        where: { id: f.publisher.id },
      });
      expect(observation).toMatchObject({
        status: 'PROCESSED',
        semanticKey: buildWebhookReceiptSemanticKey(f.update, publisherBotId),
      });
      expect(f.owner.semanticKey).toBe(f.semanticKey);
      expect(lifecycle.observeWebhook).toHaveBeenCalledTimes(1);
      expect(retention.captureInput).toHaveBeenCalledWith(f.update);
      expect(retention.captureInput).toHaveBeenCalledWith(f.regularUpdate);
      expect(retention.capture).toHaveBeenCalledTimes(2);
      expect(
        await prisma.webhookExecutionClaim.findMany({ where: { webhookEventId: { in: ids } } }),
      ).toEqual([f.claim]);

      // Reproduce the previous persisted shape without changing the production guard.
      await prisma.webhookEvent.update({
        where: { id: f.publisher.id },
        data: { semanticKey: f.semanticKey },
      });
      await expect(guard(f)).rejects.toThrow('Legacy mirror retains business execution proof');
      await prisma.webhookEvent.update({
        where: { id: f.publisher.id },
        data: { semanticKey: observation.semanticKey },
      });
      await expect(guard(f)).resolves.toBeUndefined();
      expect(
        await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: f.claim.id } }),
      ).toEqual(f.claim);
      expect(
        await prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.publisher.id } }),
      ).toEqual(observation);
    },
  );

  it.each([
    'processed',
    'ambiguous',
    'quarantine',
    'terminal_quarantine',
    'quarantine_expiry',
  ] as const)('preserves a genuine moderation %s mirror fence', async (proof) => {
    const f = await fixture();
    const mirror = await prisma.webhookEvent.create({
      data: {
        botId: 'fixture-second-moderator',
        dedupKey: randomUUID(),
        semanticKey: f.semanticKey,
        normalizedPayload: {
          ...f.regularUpdate,
          botId: 'fixture-second-moderator',
        } as unknown as Prisma.InputJsonValue,
        rawPayload: {},
        createdAt: new Date(f.owner.createdAt.getTime() + 100),
        status: proof === 'processed' ? 'PROCESSED' : 'FAILED',
        processedAt: proof === 'processed' ? new Date() : null,
        errorMessage:
          proof === 'ambiguous'
            ? 'fixture AMBIGUOUS effect'
            : proof === 'quarantine'
              ? 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:fixture'
              : proof === 'terminal_quarantine'
                ? 'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:fixture'
                : null,
        timeoutQuarantineExpiresAt:
          proof === 'quarantine_expiry' ? new Date(Date.now() + 60_000) : null,
      },
    });
    ids.push(mirror.id);
    await expect(guard(f)).rejects.toThrow('Legacy mirror retains business execution proof');
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: mirror.id } })).toEqual(
      mirror,
    );
    expect(
      await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: f.claim.id } }),
    ).toEqual(f.claim);
  });

  it('still waits for an earlier independent moderation message in the same chat', async () => {
    const f = await fixture();
    const priorUpdate = {
      ...f.regularUpdate,
      updateId: randomUUID(),
      message: { ...f.regularUpdate.message!, messageId: randomUUID() },
    };
    const prior = await persist(priorUpdate, new Date(f.publisher.createdAt.getTime() - 100));
    await expect(guard(f)).rejects.toMatchObject({ name: 'WebhookOrderedPredecessorPendingError' });
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: prior.id } })).toEqual(prior);
  });

  it('does not retag or observe a historical shared-key Publisher receipt automatically', async () => {
    const f = await fixture();
    const legacy = await prisma.webhookEvent.update({
      where: { id: f.publisher.id },
      data: {
        semanticKey: f.semanticKey,
        status: 'RECEIVED',
        processedAt: null,
      },
    });
    lifecycle.observeWebhook.mockClear();
    await expect(ingress.preparePersistedWebhookEvent(legacy.id)).rejects.toThrow(
      'Publisher receipt semantic namespace requires reviewed recovery',
    );
    expect(lifecycle.observeWebhook).not.toHaveBeenCalled();
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: legacy.id } })).toEqual(
      legacy,
    );
    expect(
      await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: f.claim.id } }),
    ).toEqual(f.claim);
  });
});
