import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { ModerationDeleteIntentService } from '../moderation/moderation-delete-intent.service';
import { WebhookParser } from '../webhook/webhook.parser';
import { WebhookService } from '../webhook/webhook.service';
import { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import { MessageRetentionStore } from './message-retention-store.service';
import { MESSAGE_RETENTION_SHARD_LIMIT } from './message-retention.policy';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('retired retention intake and preserved receipts under automatic holds', () => {
  let prisma: PrismaClient;
  let holds: WebhookLegacyHoldService;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Retention hold tests require a disposable local race_test database');
    prisma = createPrismaClient(databaseUrl, { max: 4 });
    await prisma.$connect();
    holds = new WebhookLegacyHoldService(prisma as never);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  type Fixture = {
    tx: Prisma.TransactionClient;
    store: MessageRetentionStore;
    deletes: ModerationDeleteIntentService;
    chatId: string;
    independentChatId: string;
    historicalChatId: string;
    userId: string;
    messageId: string;
  };

  async function isolated(run: (f: Fixture) => Promise<void>) {
    const rollback = new Error('Rollback isolated retention hold fixture');
    try {
      await prisma.$transaction(
        async (tx) => {
          const unique = BigInt(`0x${randomUUID().replaceAll('-', '')}`).toString();
          const chatId = `-${unique}1`;
          const independentChatId = `-${unique}2`;
          const historicalChatId = `-${unique}3`;
          await tx.chat.createMany({
            data: [chatId, independentChatId, historicalChatId].map((id) => ({
              id,
              title: 'Isolated retention hold fixture',
            })),
          });
          await tx.messageRetentionPolicy.createMany({
            data: [chatId, independentChatId].map((id) => ({
              chatId: id,
              enabled: true,
              hours: 24,
              revision: 1,
              activationId: 'activation',
              captureAfter: new Date(Date.now() - 3 * 86_400_000),
              quotaShard: 31,
              lastStatus: 'running',
            })),
          });
          // FLAG: Fixture quota changes are rolled back with the whole transaction;
          // every candidate, receipt and hold is isolated from other native test state.
          await tx.messageRetentionQuota.update({
            where: { shard: 31 },
            data: { pendingCount: 0, pausedAt: null, healthySince: null },
          });
          const scopedPrisma = {
            $transaction: (work: (client: Prisma.TransactionClient) => Promise<unknown>) =>
              work(tx),
            $queryRaw: tx.$queryRaw.bind(tx),
            $executeRaw: tx.$executeRaw.bind(tx),
          };
          const store = new MessageRetentionStore(
            scopedPrisma as never,
            new ConfigService({ MESSAGE_RETENTION_MODE: 'on' }),
          );
          const deletes = Object.create(
            ModerationDeleteIntentService.prototype,
          ) as ModerationDeleteIntentService;
          Object.assign(deletes, {
            prisma: scopedPrisma,
            legacyHolds: holds,
            leaseMs: 60_000,
            logger: new Logger('RetentionHoldFixture'),
          });
          await run({
            tx,
            store,
            deletes,
            chatId,
            independentChatId,
            historicalChatId,
            userId: `retention-held-${unique}`,
            messageId: `retention-message-${unique}`,
          });
          throw rollback;
        },
        { timeout: 15_000, maxWait: 5_000 },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  async function installHold(f: Fixture, scope: 'message' | 'member' | 'global') {
    const id = `retention-reader-fixture-${randomUUID()}`;
    // FLAG: Isolated consumer rows do not attest production quiescence or activate recovery.
    await f.tx.$executeRaw(Prisma.sql`
      INSERT INTO webhook_legacy_quiescence_certificates
        (id, source_sha, image_id, attestation, attestation_digest, preview_sha256, quiesced_at, sealed_at)
      VALUES (${id}, ${'f'.repeat(40)}, ${`sha256:${'e'.repeat(64)}`}, '{}'::jsonb,
        ${'a'.repeat(64)}, ${'b'.repeat(64)}, clock_timestamp() AT TIME ZONE 'UTC', clock_timestamp() AT TIME ZONE 'UTC')
    `);
    await f.tx.$executeRaw(Prisma.sql`
      INSERT INTO webhook_legacy_recoveries
        (id, semantic_key, owner_webhook_event_id, claim_id, chat_id, message_id, user_id, source_at,
         raw_payload_digest, normalized_payload_digest, owner_snapshot, claim_snapshot, settings_snapshot, certificate_id)
      VALUES (${`${id}:hold`}, ${`${id}:semantic`}, ${`${id}:owner`}, ${`${id}:claim`},
        ${scope === 'global' ? f.historicalChatId : f.chatId},
        ${scope === 'message' ? f.messageId : `${id}:old-message`},
        ${scope === 'message' ? `${id}:other-author` : f.userId},
        clock_timestamp() AT TIME ZONE 'UTC', ${'c'.repeat(64)}, ${'d'.repeat(64)},
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ${id})
    `);
  }

  function createdUpdate(f: Fixture, chatId = f.chatId, userId = f.userId) {
    const timestamp = Date.now();
    const update = new WebhookParser().parse(
      {
        update_type: 'message_created',
        timestamp,
        message: {
          timestamp,
          sender: { user_id: userId, name: 'Retention fixture', is_bot: false },
          recipient: { chat_id: chatId, chat_type: 'chat' },
          body: { mid: f.messageId, text: 'Native held retention receipt' },
        },
      },
      { botId: 'major' },
    );
    update.updateId = randomUUID();
    return update;
  }

  async function candidate(f: Fixture, intentId: string | null = null) {
    const row = await f.tx.messageRetentionCandidate.create({
      data: {
        chatId: f.chatId,
        messageId: f.messageId,
        authorId: f.userId,
        originBotId: 'major',
        sourceAt: new Date(Date.now() - 25 * 3_600_000),
        activationId: 'activation',
        intentId,
      },
    });
    await f.tx.messageRetentionPolicy.update({
      where: { chatId: f.chatId },
      data: { pendingCount: 1 },
    });
    await f.tx.messageRetentionQuota.update({
      where: { shard: 31 },
      data: { pendingCount: 1 },
    });
    return row;
  }

  it.each(['message', 'member', 'global'] as const)(
    'preserves held and unheld raw receipts without creating obsolete history candidates under %s holds',
    async (scope) =>
      isolated(async (f) => {
        await installHold(f, scope);
        const boundary = MESSAGE_RETENTION_SHARD_LIMIT * 0.8;
        await f.tx.messageRetentionQuota.update({
          where: { shard: 31 },
          data: { pendingCount: boundary - 1 },
        });
        const ingress = Object.create(WebhookService.prototype) as any;
        Object.assign(ingress, {
          prisma: {
            $transaction: (work: (tx: Prisma.TransactionClient) => unknown) => work(f.tx),
            webhookEvent: f.tx.webhookEvent,
          },
          messageRetention: f.store,
        });
        const update = createdUpdate(f);
        const receiptId = await ingress.persistReceipt(update, null, update.raw);
        const receipt = await f.tx.webhookEvent.findUniqueOrThrow({
          where: { id: receiptId },
        });
        expect(receipt.rawPayload).toEqual(update.raw);
        expect(receipt.status).toBe('RECEIVED');
        expect(await f.tx.messageRetentionCandidate.count({ where: { chatId: f.chatId } })).toBe(0);
        expect(
          await f.tx.messageRetentionQuota.findUniqueOrThrow({ where: { shard: 31 } }),
        ).toMatchObject({ pendingCount: boundary - 1, pausedAt: null });
        expect(
          await f.tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId: f.chatId } }),
        ).toMatchObject({ pendingCount: 0, skippedCount: 0, pausedAt: null });
        // FLAG: Neither held nor unrelated sources acquire retired automatic deletion authority.
        const independent = createdUpdate(f, f.independentChatId, `${f.userId}:unheld`);
        await ingress.persistReceipt(independent, null, independent.raw);
        expect(
          await f.tx.messageRetentionCandidate.count({
            where: { chatId: f.independentChatId },
          }),
        ).toBe(0);
        expect(
          await f.tx.messageRetentionPolicy.findUniqueOrThrow({
            where: { chatId: f.independentChatId },
          }),
        ).toMatchObject({ pendingCount: 0, pausedAt: null, lastStatus: 'running' });
        expect(
          await f.tx.messageRetentionQuota.findUniqueOrThrow({ where: { shard: 31 } }),
        ).toMatchObject({ pendingCount: boundary - 1, pausedAt: null });
        expect(
          await f.tx.auditLog.count({
            where: {
              chatId: { in: [f.chatId, f.independentChatId] },
              action: 'MESSAGE_RETENTION_INTAKE_PAUSED',
            },
          }),
        ).toBe(0);
      }),
  );

  it('settles an authenticated exact removal once under a global hold', async () =>
    isolated(async (f) => {
      const intent = await f.tx.moderationDeleteIntent.create({
        data: {
          id: randomUUID(),
          chatId: f.chatId,
          messageId: f.messageId,
          subjectUserId: f.userId,
          retentionOwned: true,
          status: 'AMBIGUOUS',
          retryUntilAt: new Date('9999-01-01T00:00:00Z'),
          deleteDispatchStartedAt: new Date(),
          deleteDispatchStartedBotId: 'major',
        },
      });
      await candidate(f, intent.id);
      await installHold(f, 'global');
      const ingress = Object.create(WebhookService.prototype) as any;
      Object.assign(ingress, {
        prisma: {
          $transaction: (work: (tx: Prisma.TransactionClient) => unknown) => work(f.tx),
          webhookEvent: f.tx.webhookEvent,
        },
        messageRetention: f.store,
      });
      const update = new WebhookParser().parse(
        {
          update_type: 'message_removed',
          timestamp: Date.now(),
          chat_id: f.chatId,
          message_id: f.messageId,
          user_id: 'actor',
        },
        { botId: 'major' },
      );
      update.updateId = randomUUID();
      await ingress.persistReceipt(update, null, update.raw);
      expect(
        await f.store.settleRemovedMessage(f.tx, {
          chatId: f.chatId,
          messageId: f.messageId,
        }),
      ).toBe(false);
      expect(
        await f.tx.moderationDeleteIntent.findUniqueOrThrow({ where: { id: intent.id } }),
      ).toMatchObject({ status: 'ALREADY_ABSENT', deleteDispatchStartedBotId: 'major' });
      expect(
        await f.tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId: f.chatId } }),
      ).toMatchObject({ pendingCount: 0, deletedCount: 1 });
      expect(
        await f.tx.messageRetentionQuota.findUniqueOrThrow({ where: { shard: 31 } }),
      ).toMatchObject({ pendingCount: 0 });
    }));

  it.each(['success_at', 'success_bot'] as const)(
    'rejects an unpaired %s receipt at the database constraint',
    async (kind) => {
      await expect(
        isolated(async (f) => {
          await f.tx.moderationDeleteIntent.create({
            data: {
              id: randomUUID(),
              chatId: f.chatId,
              messageId: f.messageId,
              subjectUserId: f.userId,
              retentionOwned: true,
              status: 'AMBIGUOUS',
              retryUntilAt: new Date('9999-01-01T00:00:00Z'),
              remoteDeleteSucceededAt: kind === 'success_at' ? new Date() : null,
              remoteDeleteSucceededBotId: kind === 'success_bot' ? 'major' : null,
            },
          });
        }),
      ).rejects.toThrow('moderation_delete_intents_remote_success_pair_check');
    },
  );

  it.each(['dispatch', 'no_marker', 'independent'] as const)(
    'never claims or changes a %s receipt without paired owned success evidence',
    async (kind) =>
      isolated(async (f) => {
        const intent = await f.tx.moderationDeleteIntent.create({
          data: {
            id: randomUUID(),
            chatId: f.chatId,
            messageId: f.messageId,
            subjectUserId: f.userId,
            retentionOwned: kind !== 'independent',
            status: 'AMBIGUOUS',
            attemptCount: 3,
            retryUntilAt: new Date('9999-01-01T00:00:00Z'),
            deleteDispatchStartedAt: kind === 'dispatch' ? new Date() : null,
            deleteDispatchStartedBotId: kind === 'dispatch' ? 'major' : null,
            remoteDeleteSucceededAt: kind === 'independent' ? new Date() : null,
            remoteDeleteSucceededBotId: kind === 'independent' ? 'major' : null,
          },
        });
        await candidate(f, intent.id);
        const previousRole = process.env.APP_ROLE;
        try {
          process.env.APP_ROLE = 'message-retention';
          const result = await f.deletes.reconcileRetentionIntent(intent.id);
          if (kind === 'no_marker' || kind === 'independent') expect(result).toBeNull();
          else expect(result).toMatchObject({ status: 'AMBIGUOUS', confirmed: false });
          // FLAG: Exercise the actual atomic SQL gate, including a stale caller that
          // bypassed its positive-receipt precheck. Unknown effects must not gain a lease.
          const claim = f.deletes as unknown as {
            claimOne(
              intentId: string,
              retentionOnly: boolean,
              receiptOnly: boolean,
            ): Promise<unknown>;
          };
          expect(await claim.claimOne(intent.id, true, true)).toBeNull();
        } finally {
          if (previousRole === undefined) delete process.env.APP_ROLE;
          else process.env.APP_ROLE = previousRole;
        }
        expect(
          await f.tx.moderationDeleteIntent.findUniqueOrThrow({ where: { id: intent.id } }),
        ).toEqual(intent);
        expect(await f.tx.moderationDeleteIntent.count({ where: { chatId: f.chatId } })).toBe(1);
        expect(
          await f.tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId: f.chatId } }),
        ).toMatchObject({ pendingCount: 1, deletedCount: 0, skippedCount: 0 });
        expect(
          await f.tx.messageRetentionQuota.findUniqueOrThrow({ where: { shard: 31 } }),
        ).toMatchObject({ pendingCount: 1 });
      }),
  );

  it('keeps a paired remote-success receipt readable and settles its candidate in SQL', async () =>
    isolated(async (f) => {
      const intent = await f.tx.moderationDeleteIntent.create({
        data: {
          id: randomUUID(),
          chatId: f.chatId,
          messageId: f.messageId,
          subjectUserId: f.userId,
          retentionOwned: true,
          status: 'AMBIGUOUS',
          retryUntilAt: new Date('9999-01-01T00:00:00Z'),
          remoteDeleteSucceededAt: new Date(),
          remoteDeleteSucceededBotId: 'major',
        },
      });
      const pending = await candidate(f, intent.id);
      await installHold(f, 'global');
      expect(
        await f.tx.messageRetentionCandidate.findUniqueOrThrow({
          where: { chatId_messageId: { chatId: f.chatId, messageId: f.messageId } },
        }),
      ).toMatchObject({ intentId: intent.id, status: 'pending' });
      expect(
        await f.tx.moderationDeleteIntentReason.count({ where: { intentId: intent.id } }),
      ).toBe(0);
      // FLAG: The exact positive receipt authorizes SQL accounting only, never a new DELETE.
      const previousRole = process.env.APP_ROLE;
      try {
        process.env.APP_ROLE = 'message-retention';
        expect(await f.deletes.reconcileRetentionIntent(intent.id)).toMatchObject({
          status: 'SUCCEEDED',
          botId: 'major',
        });
      } finally {
        if (previousRole === undefined) delete process.env.APP_ROLE;
        else process.env.APP_ROLE = previousRole;
      }
      await f.tx.messageRetentionCandidate.update({
        where: { chatId_messageId: { chatId: f.chatId, messageId: f.messageId } },
        data: { outcomeCode: 'reconciliation', reconcileAfter: new Date() },
      });
      await f.store.settleReconciliation(pending, 'deleted');
      expect(
        await f.tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId: f.chatId } }),
      ).toMatchObject({ pendingCount: 0, deletedCount: 1 });
      expect(
        await f.tx.messageRetentionQuota.findUniqueOrThrow({ where: { shard: 31 } }),
      ).toMatchObject({ pendingCount: 0 });
      expect(await holds.isGlobalUserHeld(f.userId, f.tx)).toBe(true);
    }));
});
