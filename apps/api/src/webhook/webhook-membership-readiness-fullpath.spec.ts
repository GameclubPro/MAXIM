import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { ManagedEntityHandshakeService } from '../max/managed-entity-handshake.service';
import { ManagedEntityAccessWriter } from '../max/managed-entity-access-writer.service';
import { ManagedEntityHandshakeOutcomeService } from '../max/managed-entity-handshake-outcome.service';
import { randomUUID } from 'node:crypto';
import type { MaxUpdate } from '@maxim/contracts';
import {
  DORMANT_BOT_OBSERVATION_MARKER,
  settleDormantWebhookObservation,
} from './webhook-dormant-observation';
import {
  ManagedEntityActivationRequiredError,
  type ManagedEntityExplicitActivation,
} from '../max/managed-entity-activation.util';
import { WebhookExecutionOwnerUnavailableError } from '../common/webhook-execution-owner-unavailable.error';
import { MULTIBOT_EXECUTION_AUTHORITY_VERSION } from './webhook-semantic-authority';
import { WebhookParser } from './webhook.parser';
import { WebhookCanonicalExecutionService } from '../moderation/webhook-canonical-execution.service';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

async function explicitActivation(
  s: MultibotHarness,
  chatId: string,
  botId: string,
  newerPeerVerdict?: 'BOT_DENIED' | 'USER_DENIED',
) {
  s.allowBot(botId);
  s.allowAdminUser('fixture-user');
  const sourceAt = new Date();
  const receiptId = await s.ingest({
    chatId,
    botId,
    messageId: randomUUID(),
    text: 'Старт',
    at: sourceAt.getTime(),
  });
  const receipt = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receiptId } });
  const update = receipt.normalizedPayload as MaxUpdate;
  const proof: ManagedEntityExplicitActivation = {
    kind: 'start_in_chat',
    sourceAt,
    updateId: update.updateId,
    actorUserId: 'fixture-user',
    botId,
    chatId,
  };
  const checkedAt = new Date();
  const access = await s.max.getCurrentChatMemberAccess(chatId, {
    botId,
    bypassCache: true,
    explicitActivation: proof,
  });
  const actor = await s.max.getChatMemberAccess(chatId, 'fixture-user', {
    botId,
    bypassCache: true,
  });
  if (newerPeerVerdict) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    await s.prisma.managedEntityAccessEdge.create({
      data: {
        chatId,
        botId: s.bots[1]!.id,
        userId: 'fixture-user',
        state: newerPeerVerdict,
        userRole: 'ADMIN',
        botRole: 'MEMBER',
        checkedAt: new Date(),
      },
    });
  }
  expect(
    await s.links.recordBotAccessProbe({
      chatId,
      botId,
      access,
      checkedAt,
      source: 'native-explicit-start',
      explicitActivation: proof,
      activationActorAccess: actor ?? undefined,
      allowMembershipRecovery: true,
    }),
  ).toBe(newerPeerVerdict !== 'USER_DENIED');
  await s.cache.invalidate(chatId);
  return proof;
}

describeStores('native lifecycle finite executor readiness', () => {
  let h: MultibotHarness | undefined;
  afterEach(async () => {
    jest.restoreAllMocks();
    await h?.dispose();
    h = undefined;
  });

  it.each(
    ['user_added', 'chat_title_changed'].flatMap((eventType) =>
      (['expires', 'restored'] as const).map((outcome) => ({ eventType, outcome })),
    ),
  )(
    'keeps $eventType authority when readiness $outcome and another chat progresses',
    async ({ eventType, outcome }) => {
      const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 2, mode: 'on' }));
      await s.pause();
      const [chatId, independentChatId] = await s.seedCatalog(2);
      const botId = s.bots[0]!.id;
      const independentBotId = s.bots[1]!.id;
      const sourceAt = Date.now();
      const update = new WebhookParser().parse({
        update_id: randomUUID(),
        update_type: eventType,
        chat_id: chatId!,
        title: 'Fixture title',
        user: { user_id: 'fixture-user', first_name: 'Fixture' },
        timestamp: sourceAt,
      });
      update.botId = botId;
      const receipt = await s.ingress.storeReceipt(update, null);
      const id = receipt.webhookEventId!;
      expect(id).toBeTruthy();
      s.receiptIds.push(id);
      const received = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
      expect(received.executionDeadlineAt).toEqual(new Date(sourceAt + 5 * 60_000));

      if (outcome === 'expires') {
        // FLAG: Narrow this disposable deadline before preparation and keep it unchanged
        // through the real no-executor failure, SQL clock expiry and later rights recovery.
        await s.prisma.webhookEvent.update({
          where: { id },
          data: { executionDeadlineAt: new Date(Date.now() + 10_000) },
        });
      } else {
        // FLAG: Old lifecycle receipts have NULL deadlines. Existing preparation must
        // reconstruct the original source bound, never a new five minutes from this retry.
        await s.prisma.webhookEvent.update({
          where: { id },
          data: { executionDeadlineAt: null },
        });
      }
      await s.ingress.preparePersistedWebhookEvent(id);
      const original = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: id, kind: 'EXECUTION' },
        include: { webhookEvent: true },
      });
      const deadline = original.webhookEvent!.executionDeadlineAt!;
      if (outcome === 'restored') expect(deadline).toEqual(received.executionDeadlineAt);
      expect(original).toMatchObject({ status: 'READY', businessStartedAt: null });
      expect(original.preparedAt).toBeInstanceOf(Date);
      await s.prisma.chatBotMembership.update({
        where: { chatId_botId: { chatId: chatId!, botId: independentBotId } },
        data: { status: 'REMOVED' },
      });
      await s.demote(chatId!, botId);
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      await expect(s.moderation.processWebhookEvent(id)).rejects.toMatchObject({
        cause: expect.any(WebhookExecutionOwnerUnavailableError),
      });
      expect(handler).not.toHaveBeenCalled();
      expect(s.effects).toEqual([]);
      expect(
        await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: original.id } }),
      ).toMatchObject({
        status: 'READY',
        preparedAt: original.preparedAt,
        businessStartedAt: null,
        completedAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        commandResult: {
          kind: 'EXECUTION_WAITING',
          authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
          webhookEventId: id,
          semanticKey: original.semanticKey,
          deadlineAt: deadline.toISOString(),
        },
      });

      // Another chat keeps its separate, fresh administrator route while this event waits.
      await s.prisma.chat.update({
        where: { id: independentChatId },
        data: { botId: independentBotId, primaryBotId: independentBotId },
      });
      await s.prisma.chatBotMembership.updateMany({
        where: { chatId: independentChatId },
        data: { role: 'STANDBY' },
      });
      await s.prisma.chatBotMembership.update({
        where: { chatId_botId: { chatId: independentChatId!, botId: independentBotId } },
        data: { role: 'PRIMARY' },
      });
      const freshId = await s.ingest({
        chatId: independentChatId!,
        messageId: randomUUID(),
        text: 'hello',
        botId: independentBotId,
      });
      await s.ingress.preparePersistedWebhookEvent(freshId);
      await s.moderation.processWebhookEvent(freshId);
      expect(
        await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: freshId } }),
      ).toMatchObject({ status: 'PROCESSED' });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(s.effects).toEqual([]);

      if (outcome === 'expires') {
        while (Date.now() <= deadline.getTime())
          await new Promise((resolve) => setTimeout(resolve, 50));
        await s.moderation.processWebhookEvent(id);
      }
      s.allowBot(botId);
      await s.prisma.chatBotMembership.update({
        where: { chatId_botId: { chatId: chatId!, botId } },
        data: { botAccessCheckedAt: new Date(Date.now() - 16_000) },
      });
      await s.cache.invalidate(chatId!);
      expect(await s.readiness.ensureReady({ chatId: chatId! })).toBeNull();
      await explicitActivation(s, chatId!, botId);
      if (outcome === 'expires')
        expect(await s.readiness.ensureReady({ chatId: chatId! })).toMatchObject({ botId });
      await s.moderation.processWebhookEvent(id);
      await s.moderation.processWebhookEvent(id);
      const settled = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: original.id },
        include: { webhookEvent: true },
      });
      expect(settled).toMatchObject({
        semanticKey: original.semanticKey,
        webhookEventId: id,
        status: 'COMPLETED',
        preparedAt: original.preparedAt,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      expect(settled.webhookEvent).toMatchObject({
        status: 'PROCESSED',
        executionDeadlineAt: deadline,
      });
      if (outcome === 'expires') {
        expect(settled.businessStartedAt).toBeNull();
        expect(settled.webhookEvent!.normalizedPayload).toMatchObject({
          executionOutcome: { code: 'NO_EXECUTABLE_OWNER', deadlineAt: deadline.toISOString() },
        });
      } else {
        expect(settled.businessStartedAt).toBeInstanceOf(Date);
        expect(settled.businessStartedAt!.getTime()).toBeLessThan(deadline.getTime());
      }
      expect(handler).toHaveBeenCalledTimes(outcome === 'expires' ? 1 : 2);
      expect(s.effects).toEqual([]);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
      expect(s.failures).toEqual([]);
    },
  );
});

describeStores('native legacy title readiness deadline', () => {
  let h: MultibotHarness | undefined;
  afterEach(async () => {
    jest.restoreAllMocks();
    await h?.dispose();
    h = undefined;
  });

  it('expires an unstarted title with a missing deadline from its original source time', async () => {
    const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 1, mode: 'on' }));
    await s.pause();
    const [chatId] = await s.seedCatalog(1);
    const botId = s.bots[0]!.id;
    const sourceAt = Date.now() - 6 * 60_000;
    const [migration] = await s.prisma.$queryRaw<Array<{ id: string; finishedAt: Date }>>`
      SELECT id, finished_at AS "finishedAt" FROM _prisma_migrations
      WHERE migration_name = '20261005020000_add_multibot_order_fences'
        AND rolled_back_at IS NULL AND finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1
    `;
    if (!migration) throw new Error('Expected native fixture authority migration');
    // FLAG: Model an old post-migration source in this disposable, newly migrated DB.
    // Restore its cutoff afterward; the runtime legacy authority reader remains active.
    await s.prisma.$executeRaw`
      UPDATE _prisma_migrations SET finished_at = ${new Date(sourceAt - 60_000)} WHERE id = ${migration.id}
    `;
    try {
      const update = new WebhookParser().parse({
        update_id: randomUUID(),
        update_type: 'chat_title_changed',
        chat_id: chatId!,
        title: 'Fixture title',
        actor: { user_id: 'fixture-user', first_name: 'Fixture' },
        timestamp: sourceAt,
      });
      update.botId = botId;
      const id = (await s.ingress.storeReceipt(update, null)).webhookEventId!;
      s.receiptIds.push(id);
      await s.ingress.preparePersistedWebhookEvent(id);
      // FLAG: Reproduce an already prepared receipt from before title deadlines existed.
      // Recovery must use its original timestamp and the existing no-business claim CAS.
      await s.prisma.webhookEvent.update({ where: { id }, data: { executionDeadlineAt: null } });
      await s.demote(chatId!, botId);
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      await s.moderation.processWebhookEvent(id);
      await explicitActivation(s, chatId!, botId);
      await s.moderation.processWebhookEvent(id);
      const deadline = new Date(sourceAt + 5 * 60_000);
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'PROCESSED',
        executionDeadlineAt: deadline,
        normalizedPayload: {
          executionOutcome: { code: 'NO_EXECUTABLE_OWNER', deadlineAt: deadline.toISOString() },
        },
      });
      expect(
        await s.prisma.webhookExecutionClaim.findFirstOrThrow({
          where: { webhookEventId: id, kind: 'EXECUTION' },
        }),
      ).toMatchObject({ status: 'COMPLETED', businessStartedAt: null, leaseToken: null });
      expect(handler).not.toHaveBeenCalled();
      expect(s.effects).toEqual([]);
      expect(s.failures).toEqual([]);
    } finally {
      await s.prisma.$executeRaw`
        UPDATE _prisma_migrations SET finished_at = ${migration.finishedAt} WHERE id = ${migration.id}
      `;
    }
  });
});

describeStores('native dormant receipt and explicit activation isolation', () => {
  let h: MultibotHarness | undefined;
  afterEach(async () => {
    jest.restoreAllMocks();
    await h?.dispose();
    h = undefined;
  });
  async function setup(bots = 1) {
    const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots, mode: 'on' }));
    await s.pause();
    const [chatId] = await s.seedCatalog(1);
    return { s, chatId: chatId!, botId: s.bots[0]!.id };
  }

  async function setupUnbound() {
    const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 1, mode: 'on' }));
    await s.pause();
    const chatId = `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 14)}`)}`;
    s.chatIds.push(chatId);
    const botId = s.bots[0]!.id;
    s.allowBot(botId);
    s.allowAdminUser('fixture-user');
    const handshake = new ManagedEntityHandshakeService(
      new ManagedEntityAccessWriter(s.prisma as never, s.links, s.cache),
      s.max,
      s.links,
      {
        getBotById: (id: string) => s.bots.find((bot) => bot.id === id) ?? null,
        getAllBots: () => s.bots,
        isKnownBotUserId: (id: string) => s.bots.some((bot) => bot.id === id),
      } as never,
      { processJob: async () => true, scheduleChatAdminRosterSync: async () => undefined } as never,
      new ManagedEntityHandshakeOutcomeService(s.prisma as never),
      s.groupCommands,
    );
    Object.assign(s.ingress, { managedEntityHandshakeService: handshake });
    expect(await s.prisma.chat.findUnique({ where: { id: chatId } })).toBeNull();
    expect(await s.prisma.chatBotMembership.count({ where: { chatId } })).toBe(0);
    return { s, chatId, botId };
  }

  it.each([
    'observation',
    'interleaved',
    'ordinary_completion',
    'marker_suffix',
    'missing_processed_at',
    'queued',
    'retry',
    'claim',
    'quarantine',
    'later_replay',
  ] as const)(
    'retains the independent healthy owner behind a dormant receipt: %s',
    async (proof) => {
      const { s, chatId, botId } = await setup(2);
      const peerBotId = s.bots[1]!.id;
      await s.demote(chatId, botId);
      // FLAG: Simulate temporary peer loss without changing its original activation
      // epoch. A new peer receipt may execute after recovery; the dormant receipt cannot.
      await s.prisma.chatBotMembership.update({
        where: { chatId_botId: { chatId, botId: peerBotId } },
        data: { status: 'REMOVED' },
      });
      await s.cache.invalidate(chatId);
      const messageId = randomUUID();
      const at = Date.now();
      const observedId = await s.ingest({ chatId, botId, messageId, text: 'ordinary', at });
      expect(await s.ingress.preparePersistedWebhookEvent(observedId)).toMatchObject({
        canonical: false,
        prepared: true,
      });
      const observed = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: observedId } });
      expect(observed).toMatchObject({
        status: 'PROCESSED',
        errorMessage: DORMANT_BOT_OBSERVATION_MARKER,
      });
      expect(
        await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: observedId } }),
      ).toBe(0);
      await s.prisma.chatBotMembership.update({
        where: { chatId_botId: { chatId, botId: peerBotId } },
        data: { status: 'ACTIVE' },
      });
      await s.cache.invalidate(chatId);
      let interleavedId: string | undefined;
      if (proof === 'interleaved')
        interleavedId = await s.ingest({
          chatId,
          botId: peerBotId,
          messageId: randomUUID(),
          text: 'interleaved ordinary',
        });
      const ownerId = await s.ingest({ chatId, botId: peerBotId, messageId, text: 'ordinary', at });
      expect(await s.ingress.preparePersistedWebhookEvent(ownerId)).toMatchObject({
        canonical: true,
        prepared: true,
      });
      const initialClaim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: ownerId, kind: 'EXECUTION' },
      });
      expect(initialClaim).toMatchObject({ status: 'READY', businessStartedAt: null });
      if (proof === 'ordinary_completion')
        await s.prisma.webhookEvent.update({
          where: { id: observedId },
          data: { errorMessage: null },
        });
      if (proof === 'marker_suffix')
        await s.prisma.webhookEvent.update({
          where: { id: observedId },
          data: { errorMessage: `${DORMANT_BOT_OBSERVATION_MARKER}:unverified` },
        });
      if (proof === 'missing_processed_at')
        await s.prisma.webhookEvent.update({
          where: { id: observedId },
          data: { processedAt: null },
        });
      if (proof === 'queued')
        await s.prisma.webhookEvent.update({
          where: { id: observedId },
          data: { queueName: 'moderation-default-0' },
        });
      if (proof === 'retry')
        await s.prisma.webhookEvent.update({
          where: { id: observedId },
          data: { nextEnqueueAt: new Date() },
        });
      if (proof === 'quarantine')
        await s.prisma.webhookEvent.update({
          where: { id: observedId },
          data: { timeoutQuarantineExpiresAt: new Date() },
        });
      if (proof === 'claim')
        await s.prisma.webhookExecutionClaim.create({
          data: {
            kind: 'OBSERVATION_PROOF_FIXTURE',
            semanticKey: observed.semanticKey!,
            webhookEventId: observedId,
          },
        });
      if (proof === 'later_replay') {
        const replayId = await s.ingest({ chatId, botId, messageId, text: 'ordinary', at: at + 1 });
        expect(replayId).not.toBe(observedId);
        await s.prisma.webhookEvent.update({
          where: { id: replayId },
          data: {
            status: 'FAILED',
            errorMessage:
              'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:OPERATOR_DISCARDED:fixture_scope',
            nextEnqueueAt: null,
          },
        });
      }
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      if (proof === 'observation' || proof === 'interleaved') {
        await s.moderation.processWebhookEvent(ownerId);
        await s.moderation.processWebhookEvent(ownerId);
        await s.moderation.processWebhookEvent(observedId);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(
          await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
            where: { id: initialClaim.id },
          }),
        ).toMatchObject({
          status: 'COMPLETED',
          webhookEventId: ownerId,
          executionBotId: peerBotId,
        });
        expect(
          await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: observedId } }),
        ).toEqual(observed);
        expect(
          await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: observedId } }),
        ).toBe(0);
        if (interleavedId) {
          await s.ingress.preparePersistedWebhookEvent(interleavedId);
          await s.moderation.processWebhookEvent(interleavedId);
          expect(handler).toHaveBeenCalledTimes(2);
        }
        const freshId = await s.ingest({
          chatId,
          botId: peerBotId,
          messageId: randomUUID(),
          text: 'next ordinary',
        });
        await s.ingress.preparePersistedWebhookEvent(freshId);
        await s.moderation.processWebhookEvent(freshId);
        expect(
          await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: freshId } }),
        ).toMatchObject({ status: 'PROCESSED' });
      } else {
        await expect(s.moderation.processWebhookEvent(ownerId)).rejects.toThrow();
        expect(handler).not.toHaveBeenCalled();
        expect(
          await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
            where: { id: initialClaim.id },
          }),
        ).toEqual(initialClaim);
        expect(s.effects).toEqual([]);
      }
    },
  );

  it.each(['observation_first', 'activation_first', 'future_source'] as const)(
    'never admits a first pre-activation receipt without any Chat or membership: %s',
    async (order) => {
      const { s, chatId, botId } = await setupUnbound();
      const id = await s.ingest({
        chatId,
        botId,
        messageId: randomUUID(),
        text: 'old message which must not become moderation work',
        at: Date.now() + (order === 'future_source' ? 60_000 : 0),
      });
      const received = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
      expect(await s.prisma.chat.findUnique({ where: { id: chatId } })).toBeNull();
      expect(await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: id } })).toBe(0);
      const requestsBefore = s.requests.length;
      if (order === 'observation_first') {
        expect(await s.ingress.preparePersistedWebhookEvent(id)).toMatchObject({
          canonical: false,
        });
        expect(s.requests).toHaveLength(requestsBefore);
        expect(await s.prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).toMatchObject({
          botId: null,
          primaryBotId: null,
          catalogKind: 'CONTEXT_ONLY',
          routingState: 'NO_ELIGIBLE_BOT',
        });
        expect(await s.prisma.chatBotMembership.count({ where: { chatId } })).toBe(0);
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      const activationAt = Date.now();
      expect(activationAt).toBeGreaterThan(received.createdAt.getTime());
      const startId = await s.ingest({
        chatId,
        botId,
        messageId: randomUUID(),
        text: 'Старт',
        at: activationAt,
      });
      await s.ingress.preparePersistedWebhookEvent(startId);
      const member = await s.prisma.chatBotMembership.findUniqueOrThrow({
        where: { chatId_botId: { chatId, botId } },
      });
      expect(member).toMatchObject({
        botAccessState: 'CONFIRMED_ADMIN',
        permissionsSnapshot: { explicitActivationSourceAt: new Date(activationAt).toISOString() },
      });
      const afterActivationRequests = s.requests.length;
      expect(await s.ingress.preparePersistedWebhookEvent(id)).toMatchObject({
        canonical: false,
        prepared: true,
      });
      await s.moderation.processWebhookEvent(id);
      expect(s.requests).toHaveLength(afterActivationRequests);
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'PROCESSED',
        errorMessage: DORMANT_BOT_OBSERVATION_MARKER,
      });
      expect(await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: id } })).toBe(0);
      const freshId = await s.ingest({ chatId, botId, messageId: randomUUID(), text: 'fresh' });
      expect(await s.ingress.preparePersistedWebhookEvent(freshId)).toMatchObject({
        canonical: true,
      });
      await s.moderation.processWebhookEvent(startId);
      await s.moderation.processWebhookEvent(freshId);
      expect(
        await s.prisma.webhookExecutionClaim.findFirstOrThrow({
          where: { webhookEventId: freshId, kind: 'EXECUTION' },
        }),
      ).toMatchObject({ status: 'COMPLETED' });
      expect(
        s.effects.filter(
          (effect) =>
            effect.method === 'delete' &&
            effect.messageId === (received.normalizedPayload as MaxUpdate).message?.messageId,
        ),
      ).toEqual([]);
    },
  );

  it('serializes initial Chat insertion with concurrent first Start and retains the observed receipt', async () => {
    const { s, chatId, botId } = await setupUnbound();
    const id = await s.ingest({ chatId, botId, messageId: randomUUID(), text: 'old' });
    let release!: () => void;
    let entered!: () => void;
    let bindingEntered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const binding = new Promise<void>((resolve) => {
      bindingEntered = resolve;
    });
    const original = s.links.resolveDormantReceiptPeer.bind(s.links);
    jest.spyOn(s.links, 'resolveDormantReceiptPeer').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      entered();
      await gate;
      return result;
    });
    const bind = s.links.bindDiscoveredChatBots.bind(s.links);
    jest.spyOn(s.links, 'bindDiscoveredChatBots').mockImplementationOnce(async (...args) => {
      bindingEntered();
      return bind(...args);
    });
    const observation = s.ingress.preparePersistedWebhookEvent(id);
    await locked;
    await new Promise((resolve) => setTimeout(resolve, 2));
    const startId = await s.ingest({ chatId, botId, messageId: randomUUID(), text: 'Старт' });
    const activation = s.ingress.preparePersistedWebhookEvent(startId);
    try {
      await binding;
      expect(await s.prisma.chat.findUnique({ where: { id: chatId } })).toBeNull();
      expect(await s.prisma.chatBotMembership.count({ where: { chatId } })).toBe(0);
    } finally {
      release();
    }
    expect(await observation).toMatchObject({ canonical: false, prepared: true });
    await activation;
    const observed = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    expect(observed).toMatchObject({
      status: 'PROCESSED',
      errorMessage: DORMANT_BOT_OBSERVATION_MARKER,
    });
    await s.ingress.preparePersistedWebhookEvent(id);
    await s.moderation.processWebhookEvent(id);
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toEqual(observed);
    expect(await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: id } })).toBe(0);
  });

  it('does not classify an unbound private forward as a dormant group observation', async () => {
    const { s, botId } = await setupUnbound();
    const chatId = '100500';
    const id = await s.ingest({ chatId, botId, messageId: randomUUID(), text: 'private forward' });
    const receipt = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    expect(
      await settleDormantWebhookObservation(
        s.prisma as never,
        s.links,
        id,
        receipt.normalizedPayload as MaxUpdate,
        null,
        receipt.createdAt,
      ),
    ).toBe(false);
    expect(await s.prisma.chat.findUnique({ where: { id: chatId } })).toBeNull();
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toEqual(receipt);
  });

  it('settles concurrent dormant observations without claims, MAX probes or replay after activation', async () => {
    const { s, chatId, botId } = await setup();
    await s.demote(chatId, botId);
    const id = await s.ingest({ chatId, botId, messageId: randomUUID(), text: 'ordinary' });
    const requestsBefore = s.requests.length;
    const prepared = await Promise.all([
      s.ingress.preparePersistedWebhookEvent(id),
      s.ingress.preparePersistedWebhookEvent(id),
    ]);
    expect(prepared).toEqual([
      expect.objectContaining({ canonical: false, prepared: true }),
      expect.objectContaining({ canonical: false, prepared: true }),
    ]);
    expect(await s.readiness.ensureReady({ chatId, force: true })).toBeNull();
    await expect(
      s.max.getCurrentChatMemberAccess(chatId, { botId, bypassCache: true }),
    ).rejects.toBeInstanceOf(ManagedEntityActivationRequiredError);
    expect(s.requests).toHaveLength(requestsBefore);
    const before = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    expect(before).toMatchObject({
      status: 'PROCESSED',
      errorMessage: DORMANT_BOT_OBSERVATION_MARKER,
      queueName: null,
      nextEnqueueAt: null,
    });
    expect(await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: id } })).toBe(0);
    await explicitActivation(s, chatId, botId);
    expect((await s.readiness.ensureReady({ chatId }))?.botId).toBe(botId);
    await s.ingress.preparePersistedWebhookEvent(id);
    await s.moderation.processWebhookEvent(id);
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toEqual(before);
    expect(await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: id } })).toBe(0);
    expect(s.effects).toEqual([]);
  });

  it.each(['BOT_DENIED', 'USER_DENIED'] as const)(
    'distinguishes a newer peer %s from the independently checked actor',
    async (verdict) => {
      const { s, chatId, botId } = await setup(2);
      await s.demote(chatId, botId);
      await explicitActivation(s, chatId, botId, verdict);
      expect(await s.links.isChatBotActivationRequired(chatId, botId)).toBe(
        verdict === 'USER_DENIED',
      );
      expect(s.effects).toEqual([]);
    },
  );

  it.each(['dormant', 'unbound'] as const)(
    'serves a sole %s-origin receipt through an already proven healthy peer',
    async (origin) => {
      const { s, chatId, botId } = await setup(2);
      if (origin === 'dormant') await s.demote(chatId, botId);
      else await s.prisma.chatBotMembership.delete({ where: { chatId_botId: { chatId, botId } } });
      const id = await s.ingest({ chatId, botId, messageId: randomUUID(), text: 'hello' });
      const prepared = await s.ingress.preparePersistedWebhookEvent(id);
      expect(prepared).toMatchObject({
        canonical: true,
        prepared: true,
        executionBotId: s.bots[1]!.id,
      });
      await s.moderation.processWebhookEvent(id);
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'PROCESSED',
        errorMessage: null,
      });
      expect(
        await s.prisma.webhookExecutionClaim.findFirstOrThrow({
          where: { webhookEventId: id, kind: 'EXECUTION' },
        }),
      ).toMatchObject({ status: 'COMPLETED', executionBotId: s.bots[1]!.id });
      expect(s.requests.filter((request) => request.botId === botId)).toEqual([]);
    },
  );

  it('does not admit an old dormant receipt through a peer activated only afterward', async () => {
    const { s, chatId, botId } = await setup(2);
    const peerBotId = s.bots[1]!.id;
    await s.demote(chatId, botId);
    await s.demote(chatId, peerBotId);
    const id = await s.ingest({ chatId, botId, messageId: randomUUID(), text: 'old' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await explicitActivation(s, chatId, peerBotId);
    const before = s.requests.length;
    expect(await s.ingress.preparePersistedWebhookEvent(id)).toMatchObject({
      canonical: false,
      prepared: true,
    });
    expect(s.requests).toHaveLength(before);
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'PROCESSED',
      errorMessage: DORMANT_BOT_OBSERVATION_MARKER,
    });
    expect(await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: id } })).toBe(0);
  });

  it('retains the activation source through passive positive, unknown, denied and repeated healthy Start', async () => {
    const { s, chatId, botId } = await setup();
    await s.demote(chatId, botId);
    const proof = await explicitActivation(s, chatId, botId);
    const sourceAt = proof.sourceAt.toISOString();
    const membership = () =>
      s.prisma.chatBotMembership.findUniqueOrThrow({
        where: { chatId_botId: { chatId, botId } },
      });
    const assertSource = async () =>
      expect((await membership()).permissionsSnapshot).toMatchObject({
        explicitActivationSourceAt: sourceAt,
      });
    await assertSource();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await explicitActivation(s, chatId, botId);
    await assertSource();
    for (const access of [
      {
        isAdmin: true,
        isOwner: false,
        permissionsKnown: true,
        permissions: ['read_all_messages', 'write'],
      },
      { isAdmin: true, isOwner: false, permissionsKnown: false, permissions: [] },
      null,
    ]) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      expect(
        await s.links.recordBotAccessProbe({
          chatId,
          botId,
          access,
          checkedAt: new Date(),
          source: 'native-passive-refresh',
        }),
      ).toBe(true);
      await assertSource();
    }
  });

  it('activates both exact Start receivers when the slower bot finishes after a healthy peer grant', async () => {
    const { s, chatId, botId } = await setup(2);
    const peerBotId = s.bots[1]!.id;
    await s.demote(chatId, botId);
    await s.demote(chatId, peerBotId);
    s.allowBot(botId);
    s.allowBot(peerBotId);
    s.allowAdminUser('fixture-user');
    const registry = {
      getBotById: (id: string) => s.bots.find((bot) => bot.id === id) ?? null,
      getAllBots: () => s.bots,
      isKnownBotUserId: (id: string) => s.bots.some((bot) => bot.id === id),
    };
    const handshake = new ManagedEntityHandshakeService(
      new ManagedEntityAccessWriter(s.prisma as never, s.links, s.cache),
      s.max,
      s.links,
      registry as never,
      { processJob: async () => true, scheduleChatAdminRosterSync: async () => undefined } as never,
      new ManagedEntityHandshakeOutcomeService(s.prisma as never),
      s.groupCommands,
    );
    const warnings: unknown[] = [];
    Object.assign(handshake, {
      logger: {
        log: () => undefined,
        debug: () => undefined,
        warn: (message: unknown) => warnings.push(message),
      },
    });
    Object.assign(s.ingress, { managedEntityHandshakeService: handshake });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const at = Date.now();
    const messageId = randomUUID();
    const ids = await Promise.all(
      [botId, peerBotId].map((receivingBotId) =>
        s.ingest({ chatId, botId: receivingBotId, messageId, text: 'Старт', at }),
      ),
    );
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = s.max.getCurrentChatMemberAccess.bind(s.max);
    jest.spyOn(s.max, 'getCurrentChatMemberAccess').mockImplementation(async (id, options) => {
      const access = await original(id, options);
      if (options?.botId === botId && options.explicitActivation) {
        entered();
        await gate;
      }
      return access;
    });
    const slow = s.ingress.preparePersistedWebhookEvent(ids[0]!);
    await slowEntered;
    try {
      await s.ingress.preparePersistedWebhookEvent(ids[1]!);
    } catch (error) {
      release();
      await slow.catch(() => undefined);
      throw new Error(`${String(error)} ${JSON.stringify(warnings)}`);
    }
    release();
    await slow.catch((error: unknown) => {
      throw new Error(`${String(error)} ${JSON.stringify(warnings)}`);
    });
    const memberships = await s.prisma.chatBotMembership.findMany({
      where: { chatId },
      orderBy: { botId: 'asc' },
    });
    expect(memberships).toHaveLength(2);
    for (const row of memberships)
      expect(row).toMatchObject({ status: 'ACTIVE', botAccessState: 'CONFIRMED_ADMIN' });
    expect(
      s.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
    ).toHaveLength(1);
  });

  it.each(['dormant', 'unbound'] as const)(
    'preserves an existing started claim when its exact receiver becomes %s',
    async (origin) => {
      const { s, chatId, botId } = await setup();
      const id = await s.ingest({ chatId, botId, messageId: randomUUID(), text: 'hello' });
      await s.ingress.preparePersistedWebhookEvent(id);
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: id, kind: 'EXECUTION' },
      });
      const started = await s.prisma.webhookExecutionClaim.update({
        where: { id: claim.id },
        data: { businessStartedAt: new Date() },
      });
      if (origin === 'dormant') await s.demote(chatId, botId);
      else await s.prisma.chatBotMembership.delete({ where: { chatId_botId: { chatId, botId } } });
      const event = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
      expect(
        await settleDormantWebhookObservation(
          s.prisma as never,
          s.links,
          id,
          event.normalizedPayload as MaxUpdate,
          null,
          event.createdAt,
        ),
      ).toBe(false);
      expect(
        await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      ).toEqual(started);
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toEqual(event);
      expect(s.effects).toEqual([]);
    },
  );

  it('rejects stale healthy preparation after dormant settlement wins the receipt lock', async () => {
    const { s, chatId, botId } = await setup();
    const id = await s.ingest({ chatId, botId, messageId: randomUUID(), text: 'hello' });
    const receipt = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = s.links.isChatBotActivationRequired.bind(s.links);
    jest
      .spyOn(s.links, 'isChatBotActivationRequired')
      .mockImplementationOnce(async (entityId, receivingBot) => {
        const captured = await original(entityId, receivingBot);
        entered();
        await gate;
        return captured;
      });
    const stale = s.ingress.preparePersistedWebhookEvent(id);
    await ready;
    await s.demote(chatId, botId);
    expect(
      await settleDormantWebhookObservation(
        s.prisma as never,
        s.links,
        id,
        receipt.normalizedPayload as MaxUpdate,
        null,
        receipt.createdAt,
      ),
    ).toBe(true);
    const observed = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    release();
    expect(await stale).toMatchObject({ canonical: false, prepared: true });
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toEqual(observed);
    expect(await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: id } })).toBe(0);
    expect(s.effects).toEqual([]);
  });

  it.each(['granted', 'user_denied', 'bot_denied'] as const)(
    'keeps the newer %s Redis epoch immutable during an older verified grant',
    async (state) => {
      const { s, chatId } = await setup();
      const userId = 'fixture-cache-admin';
      const at = new Date();
      expect(
        await s.cache.applyAdminAccessEpochMutation({ chatId, userId, state, eventAt: at }),
      ).toBe(true);
      const keys = [
        ChatContextCacheService.adminAccessEpochKey(chatId, userId),
        ChatContextCacheService.adminAccessKey(chatId, userId),
      ];
      const before = await s.redis.mget(...keys);
      const ttlBefore = await s.redis.pttl(keys[0]!);
      expect(
        await s.cache.applyAdminAccessEpochMutation(
          { chatId, userId, state: 'granted', eventAt: new Date(at.getTime() - 100) },
          { acceptNewerGrantedEpoch: true },
        ),
      ).toBe(state === 'granted');
      expect(await s.redis.mget(...keys)).toEqual(before);
      expect(await s.redis.pttl(keys[0]!)).toBeLessThanOrEqual(ttlBefore);
    },
  );

  it.each(['handler completion', 'finished checkpoint recovery'] as const)(
    'admits an existing owner without deadlocking concurrent %s',
    async (path) => {
      const { s, chatId, botId } = await setup();
      const id = await s.ingest({ chatId, botId, messageId: randomUUID(), text: 'hello' });
      await s.ingress.preparePersistedWebhookEvent(id);
      const context = await s.canonical.prepareExecution(id, botId);
      expect(context?.businessLeaseToken).toEqual(expect.any(String));
      await (
        s.canonical as unknown as {
          markExecutionHandlerFinished: (value: NonNullable<typeof context>) => Promise<void>;
        }
      ).markExecutionHandlerFinished(context!);
      const before = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: id, kind: 'EXECUTION' },
      });
      const receiptBefore = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
      let claimAcquired!: () => void;
      let receiptAcquired!: () => void;
      let receiptWriteStarted!: () => void;
      const claimLocked = new Promise<void>((resolve) => {
        claimAcquired = resolve;
      });
      const receiptLocked = new Promise<void>((resolve) => {
        receiptAcquired = resolve;
      });
      const receiptWriting = new Promise<void>((resolve) => {
        receiptWriteStarted = resolve;
      });
      const waitForLock = async (gate: Promise<void>, name: string) => {
        let timer!: ReturnType<typeof setTimeout>;
        try {
          await Promise.race([
            gate,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error(`Missing ${name} barrier`)), 4_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const settlingClient = s.prisma.$extends({
        query: {
          webhookExecutionClaim: {
            async updateMany({ args, query }) {
              const result = await query(args);
              if (args.where?.id === before.id && args.data.status === 'COMPLETED') {
                expect(result.count).toBe(1);
                claimAcquired();
                await waitForLock(receiptLocked, 'receipt lock');
              }
              return result;
            },
          },
          webhookEvent: {
            async updateMany({ args, query }) {
              if (args.where?.id === id && args.data.status === 'PROCESSED') receiptWriteStarted();
              return query(args);
            },
          },
        },
      });
      const admissionClient = s.prisma.$extends({
        query: {
          async $queryRaw({ args, query }) {
            const result = await query(args);
            const sql = JSON.stringify(args);
            if (sql.includes('FROM webhook_events') && sql.includes('FOR UPDATE')) {
              receiptAcquired();
              await waitForLock(receiptWriting, 'receipt write');
            }
            return result;
          },
        },
      });
      // FLAG: Keep real PostgreSQL locks in the historical inverse order: settlement
      // owns the claim, admission owns the receipt. Existing authority must be read
      // through MVCC here, never retried with an INSERT that waits on its unique row.
      Object.assign(s.ingress, { prisma: admissionClient });
      const settlingWorker = new WebhookCanonicalExecutionService(settlingClient as never);
      const settlement = (
        path === 'handler completion'
          ? settlingWorker.completeExecution(context!)
          : settlingWorker.prepareExecution(id, botId)
      ).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: undefined, error }),
      );
      let admission: ReturnType<typeof s.ingress.preparePersistedWebhookEvent> | undefined;
      try {
        expect(
          await Promise.race([
            claimLocked.then(() => 'claim-locked'),
            settlement.then(() => 'settled'),
          ]),
        ).toBe('claim-locked');
        admission = s.ingress.preparePersistedWebhookEvent(id);
        const [result, prepared] = await Promise.all([settlement, admission]);
        expect(result.error).toBeNull();
        if (path === 'finished checkpoint recovery') expect(result.value).toBeNull();
        expect(prepared).toMatchObject({ prepared: true, executionBotId: botId, enforced: true });
      } finally {
        receiptAcquired();
        receiptWriteStarted();
        await Promise.allSettled([settlement, ...(admission ? [admission] : [])]);
        Object.assign(s.ingress, { prisma: s.prisma });
      }
      const after = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(after).toMatchObject({
        webhookEventId: id,
        semanticKey: before.semanticKey,
        executionBotId: before.executionBotId,
        preparedAt: before.preparedAt,
        businessStartedAt: before.businessStartedAt,
        commandResult: before.commandResult,
        status: 'COMPLETED',
        leaseToken: null,
        leaseExpiresAt: null,
      });
      expect(await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: id } })).toBe(1);
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'PROCESSED',
        processedAt: after.completedAt,
        normalizedPayload: receiptBefore.normalizedPayload,
        executionDeadlineAt: receiptBefore.executionDeadlineAt,
        errorMessage: null,
      });
      expect(s.effects).toEqual([]);
    },
  );

  it('preserves claim admission that wins the receipt lock before dormant settlement', async () => {
    const { s, chatId, botId } = await setup();
    await s.demote(chatId, botId);
    const id = await s.ingest({ chatId, botId, messageId: randomUUID(), text: 'hello' });
    const event = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const admission = s.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM webhook_events WHERE id = ${id} FOR UPDATE`;
      const claim = await tx.webhookExecutionClaim.create({
        data: {
          kind: 'EXECUTION',
          semanticKey: event.semanticKey!,
          webhookEventId: id,
          enforced: true,
        },
      });
      acquired();
      await gate;
      return claim;
    });
    await ready;
    const observation = settleDormantWebhookObservation(
      s.prisma as never,
      s.links,
      id,
      event.normalizedPayload as MaxUpdate,
      null,
      event.createdAt,
    );
    release();
    const [claim, settled] = await Promise.all([admission, observation]);
    expect(settled).toBe(false);
    expect(
      await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
    ).toEqual(claim);
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toEqual(event);
  });
});
