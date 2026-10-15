import { randomUUID } from 'node:crypto';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const integration = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

integration('fixed moderator through native ingress, queues and guarded MAX transport', () => {
  let h: MultibotHarness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });
  async function fixture(bots: number) {
    h = await createMultibotHarness({ databaseUrl, redisUrl, bots, mode: 'on' });
    return h;
  }
  async function fix(s: MultibotHarness, chatId: string, botId: string) {
    await s.prisma.chat.update({
      where: { id: chatId },
      data: {
        primaryBotId: botId,
        botId,
        fixedModeratorBotId: botId,
        routingVersion: { increment: 1 },
      },
    });
    await s.cache.invalidate(chatId);
    s.links.forgetChatBotBinding(chatId);
  }

  it.each([1, 2, 3, 6])(
    'executes one logical deletion with the fixed bot among %i mirrors',
    async (bots) => {
      const s = await fixture(bots);
      const [chatId] = await s.seedCatalog(1);
      const botId = s.bots.at(-1)!.id;
      await fix(s, chatId!, botId);
      const messageId = randomUUID();
      const at = Date.now();
      const receipts = await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            botId: bot.id,
            messageId,
            at,
            text: 'This message exceeds the configured twenty character maximum',
          }),
        ),
      );
      await s.drain();
      expect(
        s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
      ).toMatchObject([{ botId }]);
      expect(
        await s.prisma.webhookExecutionClaim.count({
          where: {
            kind: 'EXECUTION',
            webhookEventId: { in: receipts },
            status: 'COMPLETED',
            executionBotId: botId,
          },
        }),
      ).toBe(1);
      expect(s.failures).toEqual([]);
    },
  );

  it('uses the fixed executor when only a different connected bot receives the message', async () => {
    const s = await fixture(2);
    const [chatId] = await s.seedCatalog(1);
    await fix(s, chatId!, s.bots[1]!.id);
    const messageId = randomUUID();
    await s.ingest({
      chatId: chatId!,
      messageId,
      botId: s.bots[0]!.id,
      text: 'Only the other bot received this sufficiently long message',
    });
    await s.drain();
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
    ).toMatchObject([{ botId: s.bots[1]!.id }]);
  });

  it('keeps a revoked fixed bot assigned while another community progresses', async () => {
    const s = await fixture(2);
    await s.pause();
    const [blocked, independent] = await s.seedCatalog(2);
    await fix(s, blocked!, s.bots[0]!.id);
    await fix(s, independent!, s.bots[1]!.id);
    await s.demote(blocked!, s.bots[0]!.id);
    expect(
      await s.readiness.ensureReady({ chatId: blocked!, preferredBotId: s.bots[1]!.id }),
    ).toBeNull();
    const blockedMessage = randomUUID();
    const receipt = await s.ingest({
      chatId: blocked!,
      messageId: blockedMessage,
      botId: s.bots[1]!.id,
      text: 'A denied assigned bot must not be replaced automatically',
    });
    await expect(s.ingress.preparePersistedWebhookEvent(receipt)).rejects.toThrow(
      'No eligible moderation executor',
    );
    const independentMessage = randomUUID();
    const next = await s.ingest({
      chatId: independent!,
      messageId: independentMessage,
      botId: s.bots[1]!.id,
      text: 'An independent chat continues through its own fixed moderator',
    });
    await s.ingress.preparePersistedWebhookEvent(next);
    await s.moderation.processWebhookEvent(next);
    expect(await s.prisma.webhookEvent.findUnique({ where: { id: next } })).toMatchObject({
      status: 'PROCESSED',
    });
    expect(s.effects.filter((effect) => effect.messageId === blockedMessage)).toEqual([]);
    expect(
      s.effects.filter(
        (effect) => effect.method === 'delete' && effect.messageId === independentMessage,
      ),
    ).toMatchObject([{ botId: s.bots[1]!.id }]);
    expect(await s.prisma.chat.findUnique({ where: { id: blocked! } })).toMatchObject({
      fixedModeratorBotId: s.bots[0]!.id,
    });
  });

  it.each(['CHAT', 'CHANNEL'] as const)(
    'lets the original bot edit its old poll in a fixed %s, but refuses a forged target and revoked access',
    async (type) => {
      const s = await fixture(2);
      if (type === 'CHANNEL')
        for (const bot of s.bots)
          s.setBotPermissions(bot.id, [
            'read_all_messages',
            'write',
            'edit_message',
            'delete_message',
          ]);
      const [chatId] = await s.seedCatalog(1, {}, type);
      const originalBot = s.bots[0]!.id;
      await fix(s, chatId!, s.bots[1]!.id);
      const messageId = randomUUID();
      s.messages.set(messageId, {
        sender: { user_id: originalBot, is_bot: true },
        recipient: { chat_id: chatId, chat_type: type.toLowerCase() },
        body: { mid: messageId, text: 'Existing poll', attachments: [] },
      });
      const poll = await s.prisma.managedPoll.create({
        data: {
          chatId: chatId!,
          actorUserId: 'fixture-admin',
          question: 'Existing poll',
          identitySalt: randomUUID(),
          publicationMessageId: messageId,
          publicationBotId: originalBot,
        },
      });
      const options = { botId: originalBot, boundObject: { kind: 'poll' as const, id: poll.id } };
      await s.max.editMessageInlineKeyboard(chatId!, messageId, 'Updated poll', undefined, options);
      expect(s.effects.filter((effect) => effect.method === 'put')).toMatchObject([
        { botId: originalBot, messageId },
      ]);
      const unrelated = randomUUID();
      s.messages.set(unrelated, {
        ...s.messages.get(messageId),
        body: { mid: unrelated, text: 'Other message' },
      });
      await expect(
        s.max.editMessageInlineKeyboard(chatId!, unrelated, 'Forbidden', undefined, options),
      ).rejects.toThrow();
      await s.demote(chatId!, originalBot);
      await expect(
        s.max.editMessageInlineKeyboard(chatId!, messageId, 'Forbidden', undefined, options),
      ).rejects.toThrow();
      expect(s.effects.filter((effect) => effect.method === 'put')).toHaveLength(1);
    },
  );
});
