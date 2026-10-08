import { randomUUID } from 'node:crypto';
import { WebhookExecutionOwnerUnavailableError } from '../common/webhook-execution-owner-unavailable.error';
import { MULTIBOT_EXECUTION_AUTHORITY_VERSION } from './webhook-semantic-authority';
import {
  createMultibotHarness,
  activateHarnessBotByExplicitStart,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeStores('native multibot access restoration retains the original waiting deadline', () => {
  let h: MultibotHarness | undefined;

  afterEach(async () => {
    jest.restoreAllMocks();
    await h?.dispose();
    h = undefined;
  });

  async function databaseNow(s: MultibotHarness) {
    const [row] = await s.prisma.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"
    `;
    return row!.now;
  }

  async function waitPastDeadline(s: MultibotHarness, deadline: Date) {
    // FLAG: Expiry follows the native database clock; neither the global clock nor
    // the recorded waiting deadline is rewritten after the real readiness failure.
    for (;;) {
      const now = await databaseNow(s);
      if (now.getTime() > deadline.getTime()) return;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, Math.min(100, deadline.getTime() - now.getTime() + 1))),
      );
    }
  }

  async function restoreRemoteAccess(s: MultibotHarness, chatId: string, botId: string) {
    s.allowBot(botId);
    expect(await s.links.isChatBotActivationRequired(chatId, botId)).toBe(true);
    await activateHarnessBotByExplicitStart(s, chatId, botId);
  }

  async function expectMessageEffects(
    s: MultibotHarness,
    chatId: string,
    messageId: string,
    count: number,
  ) {
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
    ).toHaveLength(count);
    expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId, messageId } })).toBe(
      count,
    );
    expect(
      await s.prisma.moderationViolationMessageClaim.count({ where: { chatId, messageId } }),
    ).toBe(count);
    if (count)
      expect(
        await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
          where: { chatId_messageId: { chatId, messageId } },
        }),
      ).toMatchObject({ status: 'SUCCEEDED' });
  }

  it.each(
    [1, 4, 9].flatMap((bots) =>
      (['before', 'after'] as const).map((restoration) => ({ bots, restoration })),
    ),
  )(
    'restores access $restoration the saved deadline with $bots bots without replaying the original message',
    async ({ bots, restoration }) => {
      const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots, mode: 'on' }));
      const [chatId] = await s.seedCatalog(1);
      const formerPrimary = s.bots[0]!.id;
      const survivor = s.bots.at(-1)!.id;
      const messageId = `access-restoration-${randomUUID()}`;
      const sourceAt = Date.now();
      const text = 'This original long message waits for a genuinely capable executor';
      await s.pause();
      const receiptId = await s.ingest({
        chatId: chatId!,
        messageId,
        text,
        botId: formerPrimary,
        at: sourceAt,
      });
      const received = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receiptId } });
      expect(received.executionDeadlineAt).toEqual(new Date(sourceAt + 5 * 60_000));
      if (restoration === 'after') {
        // FLAG: Keep the source new after the authority migration. This fixture
        // narrows its SQL deadline before preparation, then preserves it throughout.
        const narrowDeadline = new Date((await databaseNow(s)).getTime() + 10_000);
        expect(narrowDeadline.getTime()).toBeLessThan(received.executionDeadlineAt!.getTime());
        await s.prisma.webhookEvent.update({
          where: { id: receiptId },
          data: { executionDeadlineAt: narrowDeadline },
        });
      }
      await s.ingress.preparePersistedWebhookEvent(receiptId);
      const original = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: receiptId },
        include: { webhookEvent: true },
      });
      const deadline = original.webhookEvent!.executionDeadlineAt!;
      expect(original).toMatchObject({
        status: 'READY',
        executionBotId: formerPrimary,
        businessStartedAt: null,
      });
      expect(original.preparedAt).not.toBeNull();
      for (const bot of s.bots) await s.demote(chatId!, bot.id);
      for (const bot of s.bots.slice(1))
        await s.ingest({ chatId: chatId!, messageId, text, botId: bot.id, at: sourceAt });

      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      await expect(s.moderation.processWebhookEvent(receiptId)).rejects.toMatchObject({
        cause: expect.any(WebhookExecutionOwnerUnavailableError),
      });
      await s.ingest({ chatId: chatId!, messageId, text, botId: formerPrimary, at: sourceAt });
      await expect(s.moderation.processWebhookEvent(receiptId)).rejects.toMatchObject({
        cause: expect.any(WebhookExecutionOwnerUnavailableError),
      });
      const waiting = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: original.id },
        include: { webhookEvent: true },
      });
      expect(waiting).toMatchObject({
        id: original.id,
        semanticKey: original.semanticKey,
        webhookEventId: receiptId,
        status: 'READY',
        preparedAt: original.preparedAt,
        businessStartedAt: null,
        completedAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        commandResult: {
          kind: 'EXECUTION_WAITING',
          authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
          webhookEventId: receiptId,
          semanticKey: original.semanticKey,
          deadlineAt: deadline.toISOString(),
        },
      });
      expect(waiting.webhookEvent).toMatchObject({
        status: 'RECEIVED',
        executionDeadlineAt: deadline,
      });
      expect((await databaseNow(s)).getTime()).toBeLessThan(deadline.getTime());
      expect(handler).not.toHaveBeenCalled();
      expect(s.effects).toEqual([]);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
      await expectMessageEffects(s, chatId!, messageId, 0);

      if (restoration === 'after') await waitPastDeadline(s, deadline);
      const requestOffset = s.requests.length;
      await restoreRemoteAccess(s, chatId!, survivor);
      if (restoration === 'after') {
        // FLAG: A positive, freshly probed peer exists before the expired work retries.
        // Its recovered rights still cannot revive the original waiting receipt.
        expect(await s.readiness.ensureReady({ chatId: chatId! })).toMatchObject({
          botId: survivor,
        });
      }
      await s.resume();
      await s.drain();
      expect(
        s.requests
          .slice(requestOffset)
          .filter(
            (request) =>
              request.method === 'get' &&
              request.botId === survivor &&
              request.path === `/chats/${chatId}/members/me`,
          ),
      ).not.toHaveLength(0);
      expect(
        await s.prisma.chatBotMembership.findUniqueOrThrow({
          where: { chatId_botId: { chatId: chatId!, botId: survivor } },
        }),
      ).toMatchObject({
        botAccessState: 'CONFIRMED_ADMIN',
        botAccessSource: 'native-explicit-start',
      });
      const settled = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: original.id },
        include: { webhookEvent: true },
      });
      expect(settled).toMatchObject({
        semanticKey: original.semanticKey,
        webhookEventId: receiptId,
        status: 'COMPLETED',
        preparedAt: original.preparedAt,
      });
      expect(settled.webhookEvent).toMatchObject({
        status: 'PROCESSED',
        executionDeadlineAt: deadline,
      });
      expect(settled.completedAt).not.toBeNull();
      const expectedOriginalEffects = restoration === 'before' ? 1 : 0;
      if (restoration === 'before') {
        expect(settled.executionBotId).toBe(survivor);
        expect(settled.businessStartedAt).not.toBeNull();
        expect(settled.businessStartedAt!.getTime()).toBeLessThan(deadline.getTime());
        expect(s.effects.filter((effect) => effect.messageId === messageId)).toMatchObject([
          { method: 'delete', botId: survivor },
        ]);
      } else {
        expect(settled.executionBotId).toBe(original.executionBotId);
        expect(settled.businessStartedAt).toBeNull();
        expect(settled.webhookEvent!.normalizedPayload).toMatchObject({
          executionOutcome: { code: 'NO_EXECUTABLE_OWNER', deadlineAt: deadline.toISOString() },
        });
        expect(s.effects).toEqual([]);
      }
      expect(handler).toHaveBeenCalledTimes(expectedOriginalEffects);
      expect(s.effects).toHaveLength(expectedOriginalEffects);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(expectedOriginalEffects);
      await expectMessageEffects(s, chatId!, messageId, expectedOriginalEffects);

      await activateHarnessBotByExplicitStart(s, chatId!, formerPrimary);
      expect(
        await s.readiness.ensureReady({
          chatId: chatId!,
          preferredBotId: formerPrimary,
          purpose: 'delete_message',
          force: true,
        }),
      ).toMatchObject({ botId: formerPrimary });
      expect(
        await s.readiness.ensureReady({ chatId: chatId!, preferredBotId: formerPrimary }),
      ).toMatchObject({
        botId: survivor,
      });
      expect(await s.prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).toMatchObject({
        primaryBotId: survivor,
      });
      for (const bot of s.bots) {
        const mirrorId = await s.ingest({
          chatId: chatId!,
          messageId,
          text,
          botId: bot.id,
          at: sourceAt,
        });
        const mirror = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: mirrorId } });
        expect(mirror.semanticKey).toBe(original.semanticKey);
        expect(mirror.executionDeadlineAt).toEqual(received.executionDeadlineAt);
      }
      await s.drain();
      expect(
        await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: original.id } }),
      ).toEqual(
        expect.objectContaining({
          webhookEventId: receiptId,
          status: 'COMPLETED',
          preparedAt: original.preparedAt,
          businessStartedAt: settled.businessStartedAt,
          completedAt: settled.completedAt,
        }),
      );
      expect(
        await s.prisma.webhookExecutionClaim.count({
          where: { kind: 'EXECUTION', semanticKey: original.semanticKey },
        }),
      ).toBe(1);
      expect(
        await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receiptId } }),
      ).toMatchObject({
        executionDeadlineAt: deadline,
      });
      expect(handler).toHaveBeenCalledTimes(expectedOriginalEffects);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(expectedOriginalEffects);
      await expectMessageEffects(s, chatId!, messageId, expectedOriginalEffects);

      const freshMessageId = `restored-new-message-${randomUUID()}`;
      const freshAt = Date.now();
      const freshReceiptIds = await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId: freshMessageId,
            text: 'A new long message proves the restored route can execute fresh work',
            botId: bot.id,
            at: freshAt,
          }),
        ),
      );
      await s.drain();
      const freshClaims = await s.prisma.webhookExecutionClaim.findMany({
        where: { kind: 'EXECUTION', webhookEventId: { in: freshReceiptIds } },
      });
      expect(freshClaims).toHaveLength(1);
      expect(freshClaims[0]).toMatchObject({ status: 'COMPLETED', executionBotId: survivor });
      expect(freshClaims[0]!.semanticKey).not.toBe(original.semanticKey);
      expect(freshClaims[0]!.businessStartedAt).not.toBeNull();
      await expectMessageEffects(s, chatId!, freshMessageId, 1);
      await expectMessageEffects(s, chatId!, messageId, expectedOriginalEffects);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(
        expectedOriginalEffects + 1,
      );
      expect(handler).toHaveBeenCalledTimes(expectedOriginalEffects + 1);
      expect(s.effects).toHaveLength(expectedOriginalEffects + 1);
      expect(s.failures).toEqual([]);
    },
  );
});
