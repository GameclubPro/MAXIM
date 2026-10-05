import { randomUUID } from 'node:crypto';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

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
      await expect(s.moderation.processWebhookEvent(receipt)).rejects.toThrow(
        'Simulated MAX chat access denied',
      );
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
      // A later confirmed rejection can continue only the saved action. The
      // original rule engine and its semantic receipt are never started again.
      s.setOwnMemberProbe(oldBot, null);
      await s.prisma.moderationDeleteIntent.update({
        where: { id: pending.id },
        data: { nextAttemptAt: new Date(Date.now() - 1) },
      });
      expect(await s.intents.attemptIntent(pending.id)).toMatchObject({ kind: 'confirmed' });
      await s.ruleFollowups.sweep();
      expect(s.effects.filter((e) => e.messageId === messageId)).toMatchObject([
        { method: 'delete', botId: s.bots[1]!.id },
      ]);
      expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId, messageId } })).toBe(1);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
      expect(engine).toHaveBeenCalledTimes(1);
    },
  );

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
    await expect(s.moderation.processWebhookEvent(receipt)).rejects.toThrow(
      'Simulated MAX chat access denied',
    );
    const pending = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { chatId_messageId: { chatId: chatId!, messageId } },
    });
    s.setOwnMemberProbe(originalBot, null);
    // FLAG: Simulate the elapsed proof lifetime in SQL without changing Redis,
    // BullMQ or database clocks. Recovery must now probe the whole reserve fairly.
    await s.prisma.chatBotMembership.updateMany({
      where: { chatId },
      data: { botAccessExpiresAt: new Date(Date.now() - 1) },
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
      // Move the saved proof past its expiry instead of changing the process clock
      // driving real Redis leases and BullMQ workers. Its original epoch stays intact.
      if (access === 'expired')
        await s.prisma.chatBotMembership.updateMany({
          where: { chatId },
          data: { botAccessExpiresAt: new Date(Date.now() - 1) },
        });
      for (const role of staleRoles) expect(role.resolveBotIdSync(undefined, chatId)).toBe(oldBot);
      const requestsBefore = s.requests.length;
      await s.resume();
      await s.drain();

      const after = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: before.id },
        include: { webhookEvent: true },
      });
      expect(after).toMatchObject({
        status: 'COMPLETED',
        // Before preparation the owner may transfer. Once its engine started,
        // keep that history and transfer only the guarded DELETE action.
        executionBotId: access === 'expired' ? replacement : oldBot,
        webhookEventId: receipt,
      });
      expect(after.webhookEvent?.executionDeadlineAt).toEqual(
        before.webhookEvent?.executionDeadlineAt,
      );
      const probes = s.requests
        .slice(requestsBefore)
        .filter((request) => request.method === 'get' && request.path.endsWith('/members/me'));
      expect(probes.map((request) => request.botId)).toEqual(
        expect.arrayContaining(access === 'expired' ? s.bots.map((b) => b.id) : [oldBot]),
      );
      expect(s.effects.filter((effect) => effect.messageId === messageId)).toMatchObject([
        { method: 'delete', botId: replacement },
      ]);
      const promoted = await s.prisma.chat.findUniqueOrThrow({ where: { id: chatId } });
      if (access === 'expired') expect(promoted.primaryBotId).toBe(replacement);
      else expect(promoted.primaryBotId).not.toBe(oldBot);
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

      s.allowBot(oldBot);
      await s.links.recordBotAccessProbe({
        chatId: chatId!,
        botId: oldBot,
        access: {
          isAdmin: true,
          isOwner: false,
          permissionsKnown: true,
          permissions: ['read_all_messages', 'write', 'add_remove_members'],
        },
        checkedAt: new Date(),
        source: 'restored-remote-rights',
        allowMembershipRecovery: false,
      });
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
