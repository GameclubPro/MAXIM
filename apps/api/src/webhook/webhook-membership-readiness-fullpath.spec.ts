import { randomUUID } from 'node:crypto';
import { WebhookExecutionOwnerUnavailableError } from '../common/webhook-execution-owner-unavailable.error';
import { MULTIBOT_EXECUTION_AUTHORITY_VERSION } from './webhook-semantic-authority';
import { WebhookParser } from './webhook.parser';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeStores('native user_added finite executor readiness', () => {
  let h: MultibotHarness | undefined;
  afterEach(async () => {
    jest.restoreAllMocks();
    await h?.dispose();
    h = undefined;
  });

  it.each(['expires', 'restored'] as const)(
    'keeps the original join authority when readiness %s and another chat progresses',
    async (outcome) => {
      const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 2, mode: 'on' }));
      await s.pause();
      const [chatId, independentChatId] = await s.seedCatalog(2);
      const botId = s.bots[0]!.id;
      const independentBotId = s.bots[1]!.id;
      const sourceAt = Date.now();
      const update = new WebhookParser().parse({
        update_id: randomUUID(),
        update_type: 'user_added',
        chat_id: chatId!,
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
        // FLAG: Old user_added receipts have NULL deadlines. Existing preparation must
        // reconstruct the original source bound, never a new five minutes from this retry.
        await s.prisma.webhookEvent.update({ where: { id }, data: { executionDeadlineAt: null } });
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

      // Another chat keeps its separate, fresh administrator route while this join waits.
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
