import { randomUUID } from 'node:crypto';
import { WebhookExecutionOwnerUnavailableError } from '../common/webhook-execution-owner-unavailable.error';
import {
  createMultibotHarness,
  activateHarnessBotByExplicitStart,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

async function drainWithEvidence(s: MultibotHarness, receiptId: string, chatId: string) {
  try {
    await s.drain();
  } catch (error) {
    const observations = await Promise.allSettled([
      s.prisma.webhookEvent.findUnique({
        where: { id: receiptId },
        select: {
          status: true,
          enqueueAttempts: true,
          nextEnqueueAt: true,
          executionDeadlineAt: true,
        },
      }),
      s.prisma.moderationDeleteIntent.findMany({
        where: { chatId },
        take: 4,
        select: {
          status: true,
          lastErrorCode: true,
          attemptCount: true,
          nextAttemptAt: true,
          retryUntilAt: true,
          leaseExpiresAt: true,
          deleteDispatchStartedAt: true,
          remoteDeleteSucceededAt: true,
        },
      }),
      s.deleteQueue.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'failed'),
    ]);
    const [receipt, intents, queue] = observations.map((observation) =>
      observation.status === 'fulfilled' ? observation.value : 'observation_failed',
    );
    throw new Error(
      `Stale-access drain failed: ${JSON.stringify({
        observedAt: new Date().toISOString(),
        receipt,
        intents,
        queue,
        requests: s.requests.slice(-16).map((request) => ({
          botIndex: s.bots.findIndex((bot) => bot.id === request.botId),
          method: request.method,
          kind: request.path.endsWith('/members/me') ? 'own_member' : 'other',
        })),
      })}`,
      { cause: error },
    );
  }
}

describeStores('native multibot absent rights webhook and independently stale route roles', () => {
  let h: MultibotHarness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  it.each(['unavailable', 'permissions_unknown'] as const)(
    'retains the same action when the fresh own-member proof is %s',
    async (proof) => {
      h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 4 });
      const s = h;
      const [chatId] = await s.seedCatalog(1);
      await s.pause();
      const oldBot = s.bots[0]!.id;
      const messageId = `unknown-own-access-${randomUUID()}`;
      const receipt = await s.ingest({
        chatId: chatId!,
        messageId,
        botId: oldBot,
        text: 'This long message cannot lend an unknown own-member proof to a standby',
      });
      await s.ingress.preparePersistedWebhookEvent(receipt);
      const engine = jest.spyOn(s.moderation, 'handleUpdate');
      s.denyBot(oldBot);
      s.setOwnMemberProbe(oldBot, proof);
      await s.moderation.processWebhookEvent(receipt);
      expect(
        (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt } })).status,
      ).toBe('PROCESSED');
      const completed = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: receipt },
      });
      expect(completed).toMatchObject({
        status: 'COMPLETED',
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
      });
      await s.moderation.processWebhookEvent(receipt);
      expect(engine).toHaveBeenCalledTimes(1);
      const pending = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: chatId!, messageId } },
      });
      expect(pending).toMatchObject({
        status: 'RETRYABLE',
        deleteDispatchStartedAt: null,
        deleteDispatchStartedBotId: null,
      });
      expect(s.effects).toEqual([]);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
      expect(engine).toHaveBeenCalledTimes(1);
      expect(s.requests.filter((r) => r.path.endsWith('/members/me')).map((r) => r.botId)).toEqual([
        oldBot,
      ]);
      // FLAG: A committed guard retry completes the webhook without lending unknown
      // access to a peer. A later confirmed rejection continues only the saved action. The
      // original rule engine and its semantic receipt are never started again.
      s.setOwnMemberProbe(oldBot, null);
      await s.prisma.moderationDeleteIntent.update({
        where: { id: pending.id },
        data: { nextAttemptAt: new Date(Date.now() - 1) },
      });
      expect(await s.intents.attemptIntent(pending.id)).toMatchObject({ kind: 'confirmed' });
      await s.ruleFollowups.sweep();
      const deletes = s.effects.filter((e) => e.messageId === messageId);
      expect(deletes).toMatchObject([{ method: 'delete', botId: expect.any(String) }]);
      // Every standby has the same proved rights. SQL ties do not define which
      // standby wins; continuation must use one eligible reserve exactly once.
      expect(s.bots.slice(1).map((bot) => bot.id)).toContain(deletes[0]!.botId);
      expect(
        await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
          where: { id: pending.id },
        }),
      ).toMatchObject({
        status: 'SUCCEEDED',
        remoteDeleteSucceededBotId: deletes[0]!.botId,
        retryUntilAt: pending.retryUntilAt,
      });
      expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId, messageId } })).toBe(1);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
      expect(engine).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { label: 'bare 403', response: { status: 403 } },
    { label: 'bare 404', response: { status: 404 } },
    { label: 'missing user', response: { status: 404, code: 'user.not.found' } },
    { label: 'opaque gateway code', response: { status: 403, code: 'fixture.gateway.failure' } },
  ] as const)(
    'preserves the positive SQL grant and fixed assignment through $label own-member failure',
    async ({ response }) => {
      h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 2, mode: 'on' });
      const s = h;
      await s.pause();
      await s.deleteQueue.pause();
      const [chatId] = await s.seedCatalog(1);
      const botId = s.bots[0]!.id;
      await s.prisma.chat.update({
        where: { id: chatId },
        data: { fixedModeratorBotId: botId, routingVersion: { increment: 1 } },
      });
      await s.cache.invalidate(chatId!);
      const membership = () =>
        s.prisma.chatBotMembership.findUniqueOrThrow({
          where: { chatId_botId: { chatId: chatId!, botId } },
          select: {
            status: true,
            role: true,
            botAccessState: true,
            botAccessCheckedAt: true,
            botAccessExpiresAt: true,
            botAccessSource: true,
            botAccessLastErrorCode: true,
            permissionsSnapshot: true,
            permissionsHash: true,
            lifecycleEventAt: true,
            lifecycleEventType: true,
          },
        });
      const assignment = () =>
        s.prisma.chat.findUniqueOrThrow({
          where: { id: chatId },
          select: {
            botId: true,
            primaryBotId: true,
            fixedModeratorBotId: true,
            routingVersion: true,
            routingState: true,
          },
        });
      const beforeMembership = await membership();
      const beforeAssignment = await assignment();
      s.denyBot(botId);
      s.setOwnMemberProbe(botId, response);

      await expect(
        s.readiness.ensureReady({ chatId: chatId!, preferredBotId: botId, force: true }),
      ).rejects.toBeInstanceOf(WebhookExecutionOwnerUnavailableError);
      expect(await membership()).toEqual(beforeMembership);
      expect(await assignment()).toEqual(beforeAssignment);

      const messageId = `opaque-own-membership-${randomUUID()}`;
      const receipt = await s.ingest({
        chatId: chatId!,
        messageId,
        botId,
        text: 'An opaque own-member failure cannot erase this fixed moderator grant',
      });
      await s.ingress.preparePersistedWebhookEvent(receipt);
      const engine = jest.spyOn(s.moderation, 'handleUpdate');
      const requestsBeforeAction = s.requests.length;
      await s.moderation.processWebhookEvent(receipt);
      await s.moderation.processWebhookEvent(receipt);
      const pending = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: chatId!, messageId } },
      });
      expect(pending).toMatchObject({
        status: 'RETRYABLE',
        deleteDispatchStartedAt: null,
        deleteDispatchStartedBotId: null,
        remoteDeleteSucceededAt: null,
      });
      expect(await membership()).toEqual(beforeMembership);
      expect(await assignment()).toEqual(beforeAssignment);
      expect(s.effects).toEqual([]);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
      expect(engine).toHaveBeenCalledTimes(1);
      const actionRequests = s.requests.slice(requestsBeforeAction);
      expect(
        actionRequests
          .filter((request) => request.path.endsWith('/members/me'))
          .map((request) => request.botId),
      ).toEqual([botId]);
      expect(
        actionRequests
          .filter((request) => request.method === 'delete')
          .map((request) => request.botId),
      ).toEqual([]);
      expect(
        await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt } }),
      ).toMatchObject({
        status: 'PROCESSED',
      });

      // FLAG: Recovery continues only the committed DELETE; an opaque response must
      // not manufacture dormant activation or require replaying the original handler.
      s.setOwnMemberProbe(botId, null);
      s.allowBot(botId);
      await s.prisma.moderationDeleteIntent.update({
        where: { id: pending.id },
        data: { nextAttemptAt: new Date(Date.now() - 1) },
      });
      expect(await s.intents.attemptIntent(pending.id)).toMatchObject({ kind: 'confirmed' });
      await s.ruleFollowups.sweep();
      expect(
        s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
      ).toMatchObject([{ botId }]);
      expect(await assignment()).toEqual(beforeAssignment);
      expect(
        await s.prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: pending.id } }),
      ).toMatchObject({ status: 'SUCCEEDED', retryUntilAt: pending.retryUntilAt });
      expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId, messageId } })).toBe(1);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
      expect(engine).toHaveBeenCalledTimes(1);
    },
  );

  it('persists explicit own-member denial through the real writer without replacing a fixed bot', async () => {
    h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 2, mode: 'on' });
    const s = h;
    await s.pause();
    await s.deleteQueue.pause();
    const [chatId] = await s.seedCatalog(1);
    const botId = s.bots[0]!.id;
    await s.prisma.chat.update({
      where: { id: chatId },
      data: { fixedModeratorBotId: botId, routingVersion: { increment: 1 } },
    });
    await s.cache.invalidate(chatId!);
    const before = await s.prisma.chatBotMembership.findUniqueOrThrow({
      where: { chatId_botId: { chatId: chatId!, botId } },
    });
    const messageId = `explicit-own-member-denial-${randomUUID()}`;
    const receipt = await s.ingest({
      chatId: chatId!,
      botId,
      messageId,
      text: 'A confirmed own-member denial blocks only this assigned moderator',
    });
    await s.ingress.preparePersistedWebhookEvent(receipt);
    s.denyBot(botId);
    s.setOwnMemberProbe(botId, { status: 403, code: 'chat.denied' });
    await s.moderation.processWebhookEvent(receipt);

    const denied = await s.prisma.chatBotMembership.findUniqueOrThrow({
      where: { chatId_botId: { chatId: chatId!, botId } },
    });
    expect(denied).toMatchObject({
      status: 'ACTIVE',
      botAccessState: 'DENIED',
      botAccessSource: 'moderation_delete_intent_probe_denied',
    });
    expect(denied.botAccessCheckedAt!.getTime()).toBeGreaterThanOrEqual(
      before.botAccessCheckedAt!.getTime(),
    );
    expect(await s.prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).toMatchObject({
      botId: null,
      primaryBotId: null,
      fixedModeratorBotId: botId,
      routingState: 'NO_ELIGIBLE_BOT',
    });
    expect(await s.links.getFreshChatBotExecutionProof({ chatId: chatId!, botId })).toBeNull();
    expect(
      await s.prisma.chatBotMembership.findUniqueOrThrow({
        where: { chatId_botId: { chatId: chatId!, botId: s.bots[1]!.id } },
      }),
    ).toMatchObject({ botAccessState: 'CONFIRMED_ADMIN' });
    expect(s.effects).toEqual([]);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
    expect(
      await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: chatId!, messageId } },
      }),
    ).toMatchObject({ status: 'WAITING_CAPABILITY', remoteDeleteSucceededAt: null });
  });

  it('action-only recovery reaches the ninth reserve through bounded probe passes', async () => {
    h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 9 });
    const s = h;
    const [chatId] = await s.seedCatalog(1);
    await s.pause();
    await s.deleteQueue.pause();
    const originalBot = s.bots[0]!.id;
    const messageId = `bounded-action-reserves-${randomUUID()}`;
    const receipt = await s.ingest({
      chatId: chatId!,
      messageId,
      botId: originalBot,
      text: 'Only the ninth reserve may continue this already prepared long message',
    });
    await s.ingress.preparePersistedWebhookEvent(receipt);
    const engine = jest.spyOn(s.moderation, 'handleUpdate');
    for (const bot of s.bots.slice(0, -1)) s.denyBot(bot.id);
    s.setOwnMemberProbe(originalBot, 'unavailable');
    await s.moderation.processWebhookEvent(receipt);
    expect((await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt } })).status).toBe(
      'PROCESSED',
    );
    await s.moderation.processWebhookEvent(receipt);
    expect(engine).toHaveBeenCalledTimes(1);
    const pending = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { chatId_messageId: { chatId: chatId!, messageId } },
    });
    s.setOwnMemberProbe(originalBot, null);
    // FLAG: Simulate missing authority, without changing Redis/BullMQ clocks.
    // Expiry alone no longer revokes proof; genuinely unknown reserves still need bounded probes.
    await s.prisma.chatBotMembership.updateMany({
      where: { chatId },
      data: { botAccessState: 'UNKNOWN' },
    });
    let completed = false;
    for (let pass = 0; pass < 3; pass += 1) {
      await s.prisma.moderationDeleteIntent.update({
        where: { id: pending.id },
        data: { nextAttemptAt: new Date(Date.now() - 1) },
      });
      const offset = s.requests.length;
      const outcome = await s.intents.attemptIntent(pending.id);
      const probes = s.requests.slice(offset).filter((r) => r.path.endsWith('/members/me'));
      expect(probes.length).toBeLessThanOrEqual(4);
      if (outcome.kind === 'confirmed') {
        completed = true;
        break;
      }
    }
    expect(completed).toBe(true);
    expect(s.effects.filter((e) => e.messageId === messageId)).toMatchObject([
      { method: 'delete', botId: s.bots[8]!.id },
    ]);
    const settled = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(settled).toMatchObject({ status: 'SUCCEEDED', retryUntilAt: pending.retryUntilAt });
    await s.ruleFollowups.sweep();
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
    expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId, messageId } })).toBe(1);
    expect(engine).toHaveBeenCalledTimes(1);
  });

  it.each(
    [3, 4, 6, 9, 12].flatMap((bots) =>
      (['expired', 'fresh'] as const).map((access) => ({ bots, access })),
    ),
  )(
    'rejects $access rights and continues the original message with the last of $bots bots',
    async ({ bots, access }) => {
      h = await createMultibotHarness({ databaseUrl, redisUrl, bots });
      const s = h;
      const [chatId] = await s.seedCatalog(1);
      const oldBot = s.bots[0]!.id;
      const replacement = s.bots
        .map((bot) => bot.id)
        .sort()
        .at(-1)!;
      const staleRoles = [s.createRouteRole(), s.createRouteRole()];
      for (const role of [s.links, ...staleRoles]) role.rememberChatBotBinding(chatId!, oldBot);
      const initialProof = await staleRoles[0]!.getFreshChatBotExecutionProof({
        chatId: chatId!,
        botId: oldBot,
      });
      expect(initialProof).not.toBeNull();
      await s.pause();
      const at = Date.now();
      const messageId = `no-rights-webhook-${randomUUID()}`;
      const text = 'Old executor still receives this long message after losing its admin rights';
      const receipt = await s.ingest({ chatId: chatId!, messageId, text, botId: oldBot, at });
      await s.ingress.preparePersistedWebhookEvent(receipt);
      const before = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: receipt },
        include: { webhookEvent: true },
      });
      const engine = jest.spyOn(s.moderation, 'handleUpdate');

      // FLAG: Only the simulated remote changes rights. No membership webhook,
      // denial receipt, cache invalidation or epoch publication informs either role.
      for (const bot of s.bots.filter((bot) => bot.id !== replacement)) s.denyBot(bot.id);
      // Move only the legacy expiry. It must not revoke authority; the explicit
      // MAX refusal at dispatch triggers the same guarded continuation in both cases.
      if (access === 'expired')
        await s.prisma.chatBotMembership.updateMany({
          where: { chatId },
          data: { botAccessExpiresAt: new Date(Date.now() - 1) },
        });
      for (const role of staleRoles) expect(role.resolveBotIdSync(undefined, chatId)).toBe(oldBot);
      const requestsBefore = s.requests.length;
      await s.resume();
      await drainWithEvidence(s, receipt, chatId!);

      const after = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: before.id },
        include: { webhookEvent: true },
      });
      expect(after).toMatchObject({
        status: 'COMPLETED',
        // Before preparation the owner may transfer. Once its engine started,
        // keep that history and transfer only the guarded DELETE action.
        executionBotId: oldBot,
        webhookEventId: receipt,
      });
      expect(after.webhookEvent?.executionDeadlineAt).toEqual(
        before.webhookEvent?.executionDeadlineAt,
      );
      const probes = s.requests
        .slice(requestsBefore)
        .filter((request) => request.method === 'get' && request.path.endsWith('/members/me'));
      expect(probes.map((request) => request.botId)).toEqual(expect.arrayContaining([oldBot]));
      expect(s.effects.filter((effect) => effect.messageId === messageId)).toMatchObject([
        { method: 'delete', botId: replacement },
      ]);
      const promoted = await s.prisma.chat.findUniqueOrThrow({ where: { id: chatId } });
      expect(promoted.primaryBotId).not.toBe(oldBot);
      expect(promoted.routingVersion).toBeGreaterThan(initialProof!.routingVersion);
      for (const role of staleRoles) {
        // Each independent process-local hint is still stale. SQL proofs must
        // reject it rather than relying on a successful invalidation broadcast.
        expect(role.resolveBotIdSync(undefined, chatId)).toBe(oldBot);
        expect(await role.verifyChatExecutionProof({ chatId: chatId!, ...initialProof! })).toBe(
          false,
        );
        expect(
          await role.getFreshChatBotExecutionProof({ chatId: chatId!, botId: oldBot }),
        ).toBeNull();
        expect(
          await role.getFreshChatBotExecutionProof({ chatId: chatId!, botId: replacement }),
        ).toMatchObject({
          botId: replacement,
          routingVersion: promoted.routingVersion,
        });
      }

      await activateHarnessBotByExplicitStart(s, chatId!, oldBot);
      await Promise.all(
        s.bots.map((bot) => s.ingest({ chatId: chatId!, messageId, text, botId: bot.id, at })),
      );
      await s.drain();
      expect(s.effects.filter((effect) => effect.messageId === messageId)).toHaveLength(1);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
      expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId, messageId } })).toBe(1);
      expect(engine).toHaveBeenCalledTimes(1);
      expect(
        await s.prisma.webhookExecutionClaim.count({
          where: { kind: 'EXECUTION', webhookEventId: { in: s.receiptIds } },
        }),
      ).toBe(1);
    },
  );
});
