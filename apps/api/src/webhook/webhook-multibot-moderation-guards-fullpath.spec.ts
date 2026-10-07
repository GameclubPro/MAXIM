import { randomUUID } from 'node:crypto';
import type { MaxActionJob } from '../max/max-client.service';
import { Prisma } from '../prisma/prisma-client';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';
import {
  bindMessageLimitEvidence,
  fingerprintModerationSettings,
} from '../moderation/message-limits-delete-guard.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeStores('native current-rule authorization across mirrored bot delivery', () => {
  let h: MultibotHarness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });
  async function fixture(bots = 4) {
    h = await createMultibotHarness({ databaseUrl, redisUrl, bots, mode: 'on' });
    return h;
  }
  function source(
    s: MultibotHarness,
    chatId: string,
    messageId: string,
    text = 'Long harmless content that exceeds twenty characters',
  ) {
    const at = Date.now();
    s.messages.set(messageId, {
      sender: { user_id: 'fixture-user', is_bot: false },
      recipient: { chat_id: chatId, chat_type: 'chat' },
      timestamp: at,
      body: { mid: messageId, text },
    });
    return new Date(at);
  }

  async function priorLengthViolations(s: MultibotHarness, chatId: string, count: number) {
    await s.prisma.violation.createMany({
      data: Array.from({ length: count }, () => ({
        chatId,
        userId: 'fixture-user',
        ruleCode: 'MESSAGE_TOO_LONG',
        score: 1,
        createdAt: new Date(Date.now() - 1_000),
      })),
    });
  }

  it('records one strike and warning when the queue worker finishes the own DELETE before its inline caller', async () => {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1, { messageLimitsWarnEnabled: true });
    await priorLengthViolations(s, chatId!, 1);
    const warnings = jest.spyOn((s.moderation as any).logger, 'warn');
    const messageId = `worker-first-${randomUUID()}`;
    const ensureIntent = s.intents.ensureIntentWithRuleFollowup.bind(s.intents);
    let workerWon = false;
    jest
      .spyOn(s.intents, 'ensureIntentWithRuleFollowup')
      .mockImplementation(async (input, sha, envelope) => {
        const ensured = await ensureIntent(input, sha, envelope);
        const registered = ensured.followupId
          ? await s.prisma.moderationRuleFollowup.findUnique({ where: { id: ensured.followupId } })
          : null;
        if (input.messageId === messageId && registered) {
          await s.intents.sweepDueIntents();
          const until = Date.now() + 5_000;
          while (Date.now() < until) {
            const current = await s.prisma.moderationDeleteIntent.findUnique({
              where: { id: registered!.intentId },
              select: { status: true },
            });
            if (current?.status === 'SUCCEEDED') {
              workerWon = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (!workerWon) throw new Error('Expected the real DELETE queue worker to win the race');
        }
        return ensured;
      });
    const at = Date.now();
    await Promise.all(
      s.bots.map((bot) =>
        s.ingest({
          chatId: chatId!,
          messageId,
          botId: bot.id,
          at,
          text: 'Valid long text remains bound to the same source after queue completion',
        }),
      ),
    );
    await s.drain();
    expect(workerWon).toBe(true);
    expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(2);
    expect(
      await s.prisma.moderationEvent.count({ where: { chatId, messageId, action: 'WARN' } }),
    ).toBe(1);
    expect(
      warnings.mock.calls.filter(
        ([, message]) => message === 'Failed to send message limits warning message',
      ),
    ).toEqual([]);
    expect(
      s.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
    ).toHaveLength(1);
  });

  it('observes the exact active sweep worker receipt before recording one strike and warning', async () => {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1, { messageLimitsWarnEnabled: true });
    await priorLengthViolations(s, chatId!, 1);
    const messageId = `sweep-first-${randomUUID()}`;
    const ensureIntent = s.intents.ensureIntentWithRuleFollowup.bind(s.intents);
    const deleteMessage = s.max.deleteMessage.bind(s.max);
    const attemptIntent = s.intents.attemptIntent.bind(s.intents);
    let sweepStarted = false;
    let inlineSawActiveLease = false;
    jest.spyOn(s.max, 'deleteMessage').mockImplementation(async (...args) => {
      sweepStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return deleteMessage(...args);
    });
    jest.spyOn(s.intents, 'attemptIntent').mockImplementation(async (...args) => {
      const result = await attemptIntent(...args);
      if (result.kind === 'pending' && result.status === 'IN_PROGRESS') inlineSawActiveLease = true;
      return result;
    });
    jest
      .spyOn(s.intents, 'ensureIntentWithRuleFollowup')
      .mockImplementation(async (input, sha, envelope) => {
        const ensured = await ensureIntent(input, sha, envelope);
        if (input.messageId === messageId) {
          expect(ensured.followupId).not.toBeNull();
          await s.intents.sweepDueIntents();
          const until = Date.now() + 5_000;
          while (!sweepStarted && Date.now() < until)
            await new Promise((resolve) => setTimeout(resolve, 5));
          if (!sweepStarted)
            throw new Error('Expected the real SQL sweeper to start the DELETE worker');
        }
        return ensured;
      });
    const at = Date.now();
    await Promise.all(
      s.bots.map((bot) =>
        s.ingest({
          chatId: chatId!,
          messageId,
          botId: bot.id,
          at,
          text: 'Valid long text authorizes only its own completed sweeping worker receipt',
        }),
      ),
    );
    await s.drain();
    expect(inlineSawActiveLease).toBe(true);
    expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(2);
    expect(
      await s.prisma.moderationEvent.count({ where: { chatId, messageId, action: 'WARN' } }),
    ).toBe(1);
    expect(
      s.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
    ).toHaveLength(1);
    expect(s.failures).toEqual([]);
  });

  it('keeps an unknown DELETE fenced without a strike or peer sanction', async () => {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1, { messageLimitsBanEnabled: true });
    await priorLengthViolations(s, chatId!, 3);
    const messageId = `unknown-delete-${randomUUID()}`;
    s.ambiguousNextDelete();
    const at = Date.now();
    await Promise.all(
      s.bots.map((bot) =>
        s.ingest({
          chatId: chatId!,
          messageId,
          botId: bot.id,
          at,
          text: 'Long unchanged content cannot borrow an unknown DELETE as sanction proof',
        }),
      ),
    );
    await s.drain();
    const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { chatId_messageId: { chatId: chatId!, messageId } },
      include: { reasons: true },
    });
    expect(intent.status).toBe('AMBIGUOUS');
    expect(intent.deleteDispatchStartedAt).not.toBeNull();
    expect(
      intent.reasons.every(
        (reason) =>
          (reason.metadata as Record<string, unknown> | null)?.moderationDeleteVerified !== true,
      ),
    ).toBe(true);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(3);
    expect(
      await s.prisma.moderationEvent.count({
        where: { chatId, messageId, action: { in: ['WARN', 'MUTE', 'BAN'] } },
      }),
    ).toBe(0);
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.path === '/messages'),
    ).toHaveLength(1);
    expect(
      s.effects.filter(
        (effect) =>
          effect.path.endsWith('/members') ||
          (effect.method === 'post' && effect.path === '/messages'),
      ),
    ).toEqual([]);
  });

  it.each([1, 4, 9, 3, 6, 12])(
    'does not strike or sanction a corrected length source across %i bots',
    async (bots) => {
      const s = await fixture(bots);
      const [chatId] = await s.seedCatalog(1, { messageLimitsBanEnabled: true });
      const messageId = `corrected-${randomUUID()}`;
      const original = s.max.deleteMessage.bind(s.max);
      jest.spyOn(s.max, 'deleteMessage').mockImplementation(async (chat, mid, options) => {
        const row = s.messages.get(mid);
        if (row) (row.body as Record<string, unknown>).text = 'fixed';
        return original(chat, mid, options);
      });
      await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            text: 'Too long at ingress but fixed before the final selected-peer check',
            botId: bot.id,
          }),
        ),
      );
      await s.drain();
      expect(s.effects.filter((e) => e.method === 'delete')).toEqual([]);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
      expect(
        await s.prisma.moderationEvent.count({
          where: { chatId, action: { in: ['WARN', 'MUTE', 'BAN'] } },
        }),
      ).toBe(0);
    },
  );

  it.each(['WARN', 'BAN'] as const)(
    'continues a valid %s through a surviving peer after the original executor loses access',
    async (action) => {
      const s = await fixture(9);
      const [chatId] = await s.seedCatalog(1, {
        messageLimitsWarnEnabled: action === 'WARN',
        messageLimitsBanEnabled: action === 'BAN',
        messageLimitsMuteEnabled: false,
      });
      const priorCount = action === 'WARN' ? 1 : 3;
      await priorLengthViolations(s, chatId!, priorCount);
      const originBotId = s.bots[0]!.id;
      let demoted = false;
      const deleteMessage = s.max.deleteMessage.bind(s.max);
      const authorAccess = s.max.getChatMemberAccess.bind(s.max);
      jest.spyOn(s.max, 'deleteMessage').mockImplementation(async (chat, mid, options) => {
        if (!demoted) {
          demoted = true;
          await s.demote(chat, originBotId);
        }
        return deleteMessage(chat, mid, options);
      });
      jest.spyOn(s.max, 'getChatMemberAccess').mockImplementation(async (chat, user, options) => {
        // The demoted token cannot be reused for post-delete author verification either.
        if (demoted && options?.botId === originBotId)
          throw Object.assign(new Error('Demoted origin cannot verify current author'), {
            response: { status: 403, data: { code: 'chat.denied' } },
          });
        return authorAccess(chat, user, options);
      });
      const checks = jest.spyOn(s.sanctionGuard, 'assertAllowed');
      const recordObservation = s.globalPolicy.recordObservation.bind(s.globalPolicy);
      let confirmedBeforeReputation = false;
      const reputation = jest
        .spyOn(s.globalPolicy, 'recordObservation')
        .mockImplementation(async (input) => {
          if (input.reason === 'SANCTION_BAN')
            confirmedBeforeReputation = s.effects.some((effect) =>
              effect.path.endsWith('/members'),
            );
          return recordObservation(input);
        });
      const messageId = `fallback-${action}-${randomUUID()}`;
      const at = Date.now();
      await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            text: 'Valid long text keeps the same rule authority after the first bot loses access',
            botId: bot.id,
            at,
          }),
        ),
      );
      await s.drain();
      expect(
        await s.prisma.moderationDeleteIntent.findUnique({
          where: { chatId_messageId: { chatId: chatId!, messageId } },
          select: { status: true, lastErrorCode: true, lastError: true },
        }),
      ).toEqual({ status: 'SUCCEEDED', lastErrorCode: null, lastError: null });
      const deletes = s.effects.filter(
        (effect) => effect.method === 'delete' && effect.path === '/messages',
      );
      expect(deletes).toHaveLength(1);
      expect(deletes[0]?.botId).not.toBe(originBotId);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(priorCount + 1);
      expect(await s.prisma.moderationEvent.count({ where: { chatId, messageId, action } })).toBe(
        1,
      );
      const memberActions = s.effects.filter((effect) => effect.path.endsWith('/members'));
      expect(memberActions).toHaveLength(action === 'BAN' ? 1 : 0);
      expect(
        reputation.mock.calls.filter(([input]) => input.reason === 'SANCTION_BAN'),
      ).toHaveLength(action === 'BAN' ? 1 : 0);
      if (action === 'BAN') expect(confirmedBeforeReputation).toBe(true);
      const notices = s.effects.filter(
        (effect) => effect.method === 'post' && effect.path === '/messages',
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]?.botId).not.toBe(originBotId);
      expect(checks.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(checks.mock.calls.every(([proof]) => proof.botId !== originBotId)).toBe(true);
    },
  );

  it('revokes a legacy word BAN after its own DELETE when the actual legacy sanction setting changes', async () => {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1, {
      maxMessageLengthEnabled: false,
      stopWordsPolicy: Prisma.DbNull,
      messageLimitsBlockedWords: ['casino'],
      messageLimitsBanEnabled: true,
      messageLimitsWarnEnabled: false,
      messageLimitsMuteEnabled: false,
    });
    await s.prisma.violation.createMany({
      data: Array.from({ length: 3 }, () => ({
        chatId: chatId!,
        userId: 'fixture-user',
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        score: 1,
        createdAt: new Date(Date.now() - 1_000),
      })),
    });
    const settings = await s.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
    expect(settings.stopWordsPolicy).toBeNull();
    const banMember = s.max.banMember.bind(s.max);
    let changed = false;
    jest.spyOn(s.max, 'banMember').mockImplementation(async (chat, user, options) => {
      changed = true;
      await s.prisma.chatSettings.update({
        where: { chatId: chat },
        data: { messageLimitsBanEnabled: false },
      });
      return banMember(chat, user, options);
    });
    const reputation = jest.spyOn(s.globalPolicy, 'recordObservation');
    const messageId = `legacy-word-ban-revoked-${randomUUID()}`;
    const at = Date.now();
    await Promise.all(
      s.bots.map((bot) =>
        s.ingest({
          chatId: chatId!,
          messageId,
          text: 'casino',
          botId: bot.id,
          at,
        }),
      ),
    );
    await s.drain();
    expect(changed).toBe(true);
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.path === '/messages'),
    ).toHaveLength(1);
    expect(
      s.effects.filter(
        (effect) =>
          effect.path.endsWith('/members') ||
          (effect.method === 'post' && effect.path === '/messages'),
      ),
    ).toEqual([]);
    expect(reputation.mock.calls.filter(([input]) => input.reason === 'SANCTION_BAN')).toEqual([]);
    expect(
      await s.prisma.spammerObservation.count({ where: { chatId, reason: 'SANCTION_BAN' } }),
    ).toBe(0);
    expect(
      await s.prisma.moderationEvent.count({ where: { chatId, messageId, action: 'BAN' } }),
    ).toBe(0);
  });

  it('revokes a warning after policy changes between its handoff and final transport guard', async () => {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1, { messageLimitsWarnEnabled: true });
    await priorLengthViolations(s, chatId!, 1);
    const sendMessage = s.max.sendMessage.bind(s.max);
    let changed = false;
    jest.spyOn(s.max, 'sendMessage').mockImplementation(async (chat, text, options, dispatch) => {
      if (!changed) {
        changed = true;
        await s.prisma.chatSettings.update({
          where: { chatId: chat },
          data: { messageLimitsWarnEnabled: false },
        });
      }
      return sendMessage(chat, text, options, dispatch);
    });
    const messageId = `warning-revoked-${randomUUID()}`;
    const at = Date.now();
    await Promise.all(
      s.bots.map((bot) =>
        s.ingest({
          chatId: chatId!,
          messageId,
          text: 'Still too long at the exact DELETE boundary',
          botId: bot.id,
          at,
        }),
      ),
    );
    await s.drain();
    expect(changed).toBe(true);
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.path === '/messages'),
    ).toHaveLength(1);
    expect(
      s.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
    ).toEqual([]);
    expect(
      await s.prisma.moderationEvent.count({ where: { chatId, messageId, action: 'WARN' } }),
    ).toBe(0);
  });

  it('keeps an unknown warning SEND fenced when a surviving peer retries the same durable action', async () => {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1, { messageLimitsWarnEnabled: true });
    await priorLengthViolations(s, chatId!, 1);
    const sendMessage = s.max.sendMessage.bind(s.max);
    let captured: Parameters<typeof s.max.sendMessage> | undefined;
    jest.spyOn(s.max, 'sendMessage').mockImplementation(async (...args) => {
      captured = args;
      return sendMessage(...args);
    });
    s.ambiguousNextSend();
    const messageId = `warning-unknown-${randomUUID()}`;
    const at = Date.now();
    await Promise.all(
      s.bots.map((bot) =>
        s.ingest({
          chatId: chatId!,
          messageId,
          text: 'Valid warning whose remote SEND response is lost',
          botId: bot.id,
          at,
        }),
      ),
    );
    await s.drain();
    const notices = s.effects.filter(
      (effect) => effect.method === 'post' && effect.path === '/messages',
    );
    expect(notices).toHaveLength(1);
    if (!captured) throw new Error('Expected guarded warning handoff');
    expect(captured[3]?.ledgerContext?.moderationRuleNotice).toMatchObject({
      version: 1,
      chatId,
      messageId,
      userId: 'fixture-user',
      ruleCode: 'MESSAGE_TOO_LONG_DELETE',
    });
    const row = await s.prisma.maxActionLedgerEntry.findFirstOrThrow({
      where: { chatId, actionType: 'SEND_MESSAGE', status: 'AMBIGUOUS' },
    });
    const firstBotId = notices[0]!.botId;
    await s.demote(chatId!, firstBotId);
    const survivingBotId = s.bots.find((bot) => bot.id !== firstBotId)!.id;
    const retry: MaxActionJob = {
      actionType: 'SEND_MESSAGE',
      chatId: chatId!,
      botId: survivingBotId,
      text: captured[1],
      options: captured[2],
      ledgerContext: captured[3]?.ledgerContext,
      trafficClass: captured[3]?.trafficClass,
      actionHealthLane: captured[3]?.actionHealthLane,
      sourceTag: captured[3]?.sourceTag,
      idempotencyKey: row.jobId,
      attempt: 2,
      createdAt: row.createdAt.toISOString(),
    };
    await expect(s.max.executeActionJob(retry)).rejects.toThrow(/no longer executable|ambiguous/iu);
    expect(
      s.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
    ).toHaveLength(1);
    expect(await s.prisma.maxActionLedgerEntry.findUnique({ where: { id: row.id } })).toMatchObject(
      {
        status: 'AMBIGUOUS',
        ambiguous: true,
        attemptCount: 1,
      },
    );
  });

  it('persists exact reason ownership: a rejected stopword cannot inherit a valid length DELETE', async () => {
    const s = await fixture();
    const [chatId] = await s.seedCatalog(1);
    const messageId = `mixed-${randomUUID()}`;
    const at = source(s, chatId!, messageId);
    const future = new Date(Date.now() + 60_000);
    const stale = await s.intents.ensureIntent({
      chatId: chatId!,
      messageId,
      subjectUserId: 'fixture-user',
      sourceMessageAt: at,
      originBotId: s.bots[0]!.id,
      routingPolicy: 'origin_first',
      executeAt: future,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      reasonKey: 'stopwords:stale',
      ruleCode: 'MESSAGE_BLOCKED_WORD_DELETE',
      event: {
        userId: 'fixture-user',
        eventType: 'MESSAGE',
        metadata: {
          stopWordsPolicyVersion: 1,
          stopWordsSourceSha256: 'removed-source',
          stopWordsRuleId: 'removed-rule',
          stopWordsRevision: 0,
        },
      },
    });
    if (!stale.intentId) throw new Error('Expected durable mixed-reason intent');
    await s.intents.ensureIntent({
      chatId: chatId!,
      messageId,
      subjectUserId: 'fixture-user',
      sourceMessageAt: at,
      originBotId: s.bots[0]!.id,
      routingPolicy: 'origin_first',
      executeAt: future,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      reasonKey: 'length:current',
      ruleCode: 'MESSAGE_TOO_LONG_DELETE',
      event: { userId: 'fixture-user', eventType: 'MESSAGE' },
    });
    await s.prisma.moderationDeleteIntent.update({
      where: { id: stale.intentId },
      data: { executeAt: new Date(0), nextAttemptAt: new Date(0) },
    });
    const result = await s.intents.attemptIntent(stale.intentId);
    expect(result).toMatchObject({ kind: 'confirmed', verifiedReasonKeys: ['length:current'] });
    const reasons = await s.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: stale.intentId },
      orderBy: { reasonKey: 'asc' },
    });
    expect(reasons.find((r) => r.reasonKey === 'length:current')?.metadata).toMatchObject({
      moderationDeleteVerified: true,
    });
    expect(reasons.find((r) => r.reasonKey === 'stopwords:stale')?.metadata).not.toMatchObject({
      moderationDeleteVerified: true,
    });
    expect(
      await s.prisma.moderationEvent.findMany({
        where: { chatId, action: 'DELETE_MESSAGE' },
        select: { ruleCode: true },
      }),
    ).toEqual([{ ruleCode: 'MESSAGE_TOO_LONG_DELETE' }]);
  });

  it('revokes a durable frequency deletion after policy change without altering counters', async () => {
    const s = await fixture(12);
    const [chatId] = await s.seedCatalog(1, { antiSpamEnabled: true });
    const messageId = `burst-${randomUUID()}`;
    const at = source(s, chatId!, messageId, 'plain message');
    const settings = await s.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
    const binding = bindMessageLimitEvidence(settings, at.getTime(), 'MESSAGE_RATE_LIMIT');
    await s.prisma.chatSettings.update({ where: { chatId }, data: { antiSpamEnabled: false } });
    const result = await s.intents.ensureAndAttempt({
      chatId: chatId!,
      messageId,
      subjectUserId: 'fixture-user',
      sourceMessageAt: at,
      originBotId: s.bots[0]!.id,
      routingPolicy: 'origin_first',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      reasonKey: 'burst',
      ruleCode: 'MESSAGE_RATE_LIMIT_DELETE',
      event: { userId: 'fixture-user', eventType: 'MESSAGE', metadata: binding },
    });
    expect(result.kind).toBe('terminal');
    expect(s.effects.filter((e) => e.method === 'delete')).toEqual([]);
    expect(await s.redis.exists(`message:anti-spam-burst:v2:${chatId}:fixture-user:5:6`)).toBe(0);
  });

  it('stores no active-mute receipt when its expiry elapses before a valid length DELETE dispatch', async () => {
    const s = await fixture(4);
    const [chatId] = await s.seedCatalog(1);
    const muteExpiresAt = new Date(Date.now() + 2_000);
    const mute = await s.prisma.moderationEvent.create({
      data: {
        chatId: chatId!,
        userId: 'fixture-user',
        eventType: 'MEMBER_ACTION',
        ruleCode: 'MANUAL_MUTE',
        action: 'MUTE',
        operator: 'ADMIN',
        score: 1,
        createdAt: new Date(Date.now() - 1_000),
        metadata: { muteExpiresAt: muteExpiresAt.toISOString(), mutePermanent: false },
      },
    });
    const messageId = `mute-expiry-${randomUUID()}`;
    const at = source(s, chatId!, messageId);
    const future = new Date(Date.now() + 60_000);
    const base = {
      chatId: chatId!,
      messageId,
      subjectUserId: 'fixture-user',
      sourceMessageAt: at,
      originBotId: s.bots[0]!.id,
      routingPolicy: 'origin_first' as const,
      executeAt: future,
      entityType: 'CHAT' as const,
      messageAuthorKind: 'user' as const,
    };
    const queued = await s.intents.ensureIntent({
      ...base,
      reasonKey: 'mute:expires',
      ruleCode: 'MUTE_ACTIVE_DELETE',
      event: { userId: 'fixture-user', eventType: 'MESSAGE', metadata: { muteEventId: mute.id } },
    });
    if (!queued.intentId) throw new Error('Expected durable expiring mixed-reason intent');
    await s.intents.ensureIntent({
      ...base,
      reasonKey: 'length:survives',
      ruleCode: 'MESSAGE_TOO_LONG_DELETE',
      event: { userId: 'fixture-user', eventType: 'MESSAGE' },
    });
    const authorizeState = s.stateGuard.authorize.bind(s.stateGuard);
    let heldStatePermit = false;
    jest.spyOn(s.stateGuard, 'authorize').mockImplementation(async (params) => {
      const permit = await authorizeState(params);
      if (typeof permit === 'object') {
        heldStatePermit = true;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, permit.deadlineAtMs - Date.now() + 5)),
        );
      }
      return permit;
    });
    await s.prisma.moderationDeleteIntent.update({
      where: { id: queued.intentId },
      data: { executeAt: new Date(0), nextAttemptAt: new Date(0) },
    });
    expect(await s.intents.attemptIntent(queued.intentId)).toMatchObject({
      kind: 'confirmed',
      verifiedReasonKeys: ['length:survives'],
    });
    expect(heldStatePermit).toBe(true);
    const reasons = await s.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: queued.intentId },
    });
    expect(
      reasons.find((reason) => reason.reasonKey === 'length:survives')?.metadata,
    ).toMatchObject({ moderationDeleteVerified: true });
    expect(
      reasons.find((reason) => reason.reasonKey === 'mute:expires')?.metadata,
    ).not.toMatchObject({ moderationDeleteVerified: true });
    expect(
      await s.prisma.moderationEvent.count({
        where: { chatId, messageId, ruleCode: 'MUTE_ACTIVE_DELETE' },
      }),
    ).toBe(0);
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.path === '/messages'),
    ).toHaveLength(1);
  });

  it('keeps positive and absent own-reason probes bounded by unique indexes with more than 10,000 retained intents', async () => {
    const s = await fixture(4);
    const [chatId] = await s.seedCatalog(1);
    const prefix = `guard-history-${randomUUID()}`;
    await s.prisma.$executeRaw(Prisma.sql`
      INSERT INTO moderation_delete_intents
        (id, chat_id, message_id, subject_user_id, source_message_at, status,
          execute_at, next_attempt_at, retry_until_at, completed_at, created_at, updated_at)
      SELECT ${prefix} || '-' || i, ${chatId}, 'history-' || i, 'fixture-user',
        CURRENT_TIMESTAMP - INTERVAL '30 days', 'SUCCEEDED'::"ModerationDeleteIntentStatus",
        CURRENT_TIMESTAMP - INTERVAL '30 days', CURRENT_TIMESTAMP - INTERVAL '30 days',
        CURRENT_TIMESTAMP - INTERVAL '30 days' + INTERVAL '5 minutes',
        CURRENT_TIMESTAMP - INTERVAL '30 days' + INTERVAL '1 minute',
        CURRENT_TIMESTAMP - INTERVAL '30 days', CURRENT_TIMESTAMP - INTERVAL '30 days'
      FROM generate_series(1, 12001) AS i
    `);
    await s.prisma.$executeRaw(Prisma.sql`
      INSERT INTO moderation_delete_intent_reasons
        (id, intent_id, reason_key, user_id, rule_code, metadata)
      SELECT ${prefix} || '-reason-' || i, ${prefix} || '-' || i,
        'length:past', 'fixture-user', 'MESSAGE_TOO_LONG_DELETE',
        '{"moderationDeleteVerified":true}'::jsonb
      FROM generate_series(1, 12001) AS i
    `);
    // A retained intent can contain several independent reasons. Populate its full
    // bounded reason set so the planner cannot pass by filtering a one-row intent index.
    await s.prisma.$executeRaw(Prisma.sql`
      INSERT INTO moderation_delete_intent_reasons
        (id, intent_id, reason_key, user_id, rule_code, metadata)
      SELECT ${prefix} || '-extra-reason-' || i, ${`${prefix}-12001`},
        'other:' || i, 'fixture-user', 'MESSAGE_TOO_LONG_DELETE',
        '{"moderationDeleteVerified":true}'::jsonb
      FROM generate_series(1, 63) AS i
    `);
    await s.prisma.$executeRaw`ANALYZE moderation_delete_intents`;
    await s.prisma.$executeRaw`ANALYZE moderation_delete_intent_reasons`;
    type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
    const assertBounded = (plans: { 'QUERY PLAN': { Plan: PlanNode }[] }[], index: string) => {
      expect(JSON.stringify(plans)).toContain(index);
      const walk = (node: PlanNode): void => {
        if (node['Relation Name']) {
          expect(node['Node Type']).not.toBe('Seq Scan');
          expect(
            Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0),
          ).toBeLessThanOrEqual(1);
        }
        for (const child of node.Plans ?? []) walk(child);
      };
      walk(plans[0]!['QUERY PLAN'][0]!.Plan);
    };
    for (const messageId of ['history-12001', 'absent-message']) {
      const plans = await s.prisma.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT id, status, subject_user_id, source_message_at FROM moderation_delete_intents
        WHERE chat_id = ${chatId} AND message_id = ${messageId}
      `);
      assertBounded(plans, 'moderation_delete_intents_chat_message_key');
    }
    for (const reasonKey of ['length:past', 'absent-reason']) {
      const plans = await s.prisma.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT rule_code, user_id, metadata FROM moderation_delete_intent_reasons
        WHERE intent_id = ${`${prefix}-12001`} AND reason_key = ${reasonKey}
      `);
      assertBounded(plans, 'moderation_delete_intent_reasons_intent_reason_key');
    }
    expect(s.effects).toEqual([]);
  });

  it.each(['authority-rejected', 'source-unavailable'] as const)(
    'completes one canonical handler and its mirrors for initial subscription %s',
    async (reason) => {
      const s = await fixture();
      const [chatId, targetId] = await s.seedCatalog(2, { maxMessageLengthEnabled: false });
      await s.prisma.chatSettings.update({
        where: { chatId: chatId! },
        data: { requiredSubscriptionEnabled: true, requiredSubscriptionChannelIds: [targetId!] },
      });
      // The initial observation says missing; the real final guard refreshes membership
      // through the local MAX fixture and sees that the participant has now joined.
      const membership = jest
        .spyOn(s.membership, 'getMembershipResolution')
        .mockResolvedValueOnce({ membership: false, fresh: true });
      if (reason === 'source-unavailable') {
        jest.spyOn(s.max, 'getExactMessageRow').mockRejectedValueOnce(
          Object.assign(new Error('Fixture source unavailable'), {
            response: { status: 404, data: {} },
          }),
        );
      }
      const authorize = jest.spyOn(s.subscriptionGuard, 'authorize');
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const activeMute = jest.spyOn(s.moderation as any, 'handleActiveMuteMessage');
      const messageId = `subscription-rejected-${randomUUID()}`;
      const at = Date.now();
      const ids = await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            botId: bot.id,
            at,
            text: 'Subscription changed',
          }),
        ),
      );
      await s.drain();
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(authorize).toHaveBeenCalledWith(
        expect.objectContaining({ initialQualification: true }),
      );
      if (reason === 'authority-rejected') {
        expect(membership).toHaveBeenCalledWith(
          targetId,
          'fixture-user',
          'moderation_required_subscription',
          { forceRefresh: true, allowStaleOnError: false },
        );
      }
      expect(handler).toHaveBeenCalledTimes(1);
      expect(activeMute).not.toHaveBeenCalled();
      expect(s.failures).toEqual([]);
      expect(s.effects).toEqual([]);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
      expect(await s.prisma.moderationEvent.count({ where: { chatId } })).toBe(0);
      expect(
        await s.prisma.moderationViolationMessageClaim.count({
          where: { chatId, messageId, ruleCode: 'REQUIRED_SUBSCRIPTION' },
        }),
      ).toBe(0);
      expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId, messageId } })).toBe(0);
      const receipts = await s.prisma.webhookEvent.findMany({ where: { id: { in: ids } } });
      expect(receipts.map((row) => row.status).sort()).toEqual([
        'DUPLICATE',
        'DUPLICATE',
        'DUPLICATE',
        'PROCESSED',
      ]);
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: { in: ids } },
      });
      expect(claim).toMatchObject({
        status: 'COMPLETED',
        enforced: true,
        businessStartedAt: expect.any(Date),
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
        leaseToken: null,
        leaseExpiresAt: null,
      });
      for (const id of ids) await s.moderation.processWebhookEvent(id);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(s.effects).toEqual([]);
    },
  );

  it('keeps a later subscription source failure fenced after feature evidence was persisted', async () => {
    const s = await fixture(1);
    const [chatId, targetId] = await s.seedCatalog(2, { maxMessageLengthEnabled: false });
    await s.prisma.chatSettings.update({
      where: { chatId: chatId! },
      data: { requiredSubscriptionEnabled: true, requiredSubscriptionChannelIds: [targetId!] },
    });
    jest
      .spyOn(s.membership, 'getMembershipResolution')
      .mockResolvedValue({ membership: false, fresh: true });
    const getSource = s.max.getExactMessageRow.bind(s.max);
    const sourceError = Object.assign(new Error('Fixture later source unavailable'), {
      response: { status: 404, data: {} },
    });
    jest
      .spyOn(s.max, 'getExactMessageRow')
      .mockImplementationOnce(getSource)
      .mockRejectedValue(sourceError);
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    const messageId = `subscription-later-unavailable-${randomUUID()}`;
    const id = await s.ingest({
      chatId: chatId!,
      messageId,
      botId: s.bots[0]!.id,
      at: Date.now(),
      text: 'Later source unavailable',
    });
    await expect(s.drain()).rejects.toBe(sourceError);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(s.failures).toHaveLength(1);
    expect(s.effects).toEqual([]);
    expect(
      await s.prisma.violation.count({ where: { chatId, ruleCode: 'REQUIRED_SUBSCRIPTION' } }),
    ).toBe(1);
    const receipt = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    expect(receipt.status).toBe('FAILED');
    const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: { kind: 'EXECUTION', webhookEventId: id },
    });
    expect(claim.status).not.toBe('COMPLETED');
    expect(claim.businessStartedAt).not.toBeNull();
    expect(claim.completedAt).toBeNull();
    expect(claim.commandResult).not.toEqual(
      expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
    );
  });

  it('requires fresh missing membership for a queued subscription deletion', async () => {
    const s = await fixture();
    const [chatId] = await s.seedCatalog(1, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['target-fixture'],
    });
    const messageId = `subscription-${randomUUID()}`;
    const at = source(s, chatId!, messageId);
    const settings = await s.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
    const result = await s.intents.ensureAndAttempt({
      chatId: chatId!,
      messageId,
      subjectUserId: 'fixture-user',
      sourceMessageAt: at,
      originBotId: s.bots[0]!.id,
      routingPolicy: 'origin_first',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      reasonKey: 'subscription',
      ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
      event: {
        userId: 'fixture-user',
        eventType: 'MESSAGE',
        metadata: {
          requiredSubscriptionGuardVersion: 1,
          requiredSubscriptionPolicySha256: fingerprintModerationSettings(
            settings,
            'REQUIRED_SUBSCRIPTION',
          ),
          requiredSubscriptionSourceAtMs: at.getTime(),
          requiredSubscriptionDeadlineAtMs: at.getTime() + 300_000,
        },
      },
    });
    // The real membership service reads the fixture HTTP member list: this participant joined.
    expect(result.kind).toBe('terminal');
    expect(s.effects.filter((e) => e.method === 'delete')).toEqual([]);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
  });

  it('revokes a queued active-mute deletion after a durable manual release', async () => {
    const s = await fixture();
    const [chatId] = await s.seedCatalog(1);
    const mute = await s.prisma.moderationEvent.create({
      data: {
        chatId: chatId!,
        userId: 'fixture-user',
        eventType: 'MEMBER_ACTION',
        ruleCode: 'MANUAL_MUTE',
        action: 'MUTE',
        operator: 'ADMIN',
        score: 1,
        createdAt: new Date(Date.now() - 1_000),
        metadata: { mutePermanent: true },
      },
    });
    const messageId = `unmuted-${randomUUID()}`;
    const at = source(s, chatId!, messageId);
    await s.prisma.moderationEvent.create({
      data: {
        chatId: chatId!,
        userId: 'fixture-user',
        eventType: 'MEMBER_ACTION',
        ruleCode: 'MANUAL_UNMUTE',
        action: 'NONE',
        operator: 'ADMIN',
        score: 1,
      },
    });
    const result = await s.intents.ensureAndAttempt({
      chatId: chatId!,
      messageId,
      subjectUserId: 'fixture-user',
      sourceMessageAt: at,
      originBotId: s.bots[0]!.id,
      routingPolicy: 'origin_first',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      reasonKey: 'mute',
      ruleCode: 'MUTE_ACTIVE_DELETE',
      event: { userId: 'fixture-user', eventType: 'MESSAGE', metadata: { muteEventId: mute.id } },
    });
    expect(result.kind).toBe('terminal');
    expect(s.effects.filter((e) => e.method === 'delete')).toEqual([]);
  });
});
