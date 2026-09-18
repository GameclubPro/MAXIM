import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, type PrismaClient } from '../../prisma/prisma-client';
import { WebhookParser } from '../../webhook/webhook.parser';
import { ReportStateService } from './report-state.service';
import { ReportSubmissionService } from './report-submission.service';
import { ReportExecutionService } from './report-execution.service';
import { ReportViewService } from './report-view.service';
import { ReportDeleteGuardService } from './report-delete-guard.service';
import { ModerationSanctionStateLockService } from '../moderation-sanction-state-lock.service';
import { ModerationSanctionStateFenceService } from '../moderation-sanction-state-fence.service';
import { REPORT_DAY_MS } from './report.util';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('PostgreSQL participant reports', () => {
  let prisma: PrismaClient;
  let state: ReportStateService;
  let submissions: ReportSubmissionService;
  let views: ReportViewService;
  let executor: ReportExecutionService;
  let guard: ReportDeleteGuardService;
  const chatId = `-${Date.now()}`;
  const prefix = randomUUID();
  const rows = new Map<string, Record<string, unknown>>();
  const memberOverrides = new Map<string, Record<string, unknown>>();
  const member = (userId: string) => ({
    userId,
    isBot: false,
    isAdmin: false,
    isOwner: false,
    joinedAtMs: Date.now() - 2 * REPORT_DAY_MS,
    permissions: [],
    ...memberOverrides.get(userId),
  });
  const max = {
    getExactMessageRow: jest.fn(async (_chatId: string, id: string) => rows.get(id) ?? null),
    getChatMemberAccess: jest.fn(async (_chatId: string, userId: string) => member(userId)),
    getChatMembersAccess: jest.fn(
      async (_chatId: string, ids: string[]) => new Map(ids.map((id) => [id, member(id)])),
    ),
    sendMessage: jest.fn(),
    replaceOwnMessage: jest.fn(),
    sendMessageImmediateWithId: jest.fn(async (_chatId, _text, options) => {
      await options.beforeSend();
      return { messageId: `counter-${randomUUID()}` };
    }),
  };
  const redis = {
    setStringIfAbsentWithTtl: jest.fn().mockResolvedValue(false),
    deleteKey: jest.fn(),
  };
  const deletes = {
    enqueueCurrentIntentWakeupStrict: jest.fn(),
    ensureIntent: jest.fn(async (input) => {
      const id = `intent:${input.chatId}:${input.messageId}`;
      await prisma.moderationDeleteIntent.upsert({
        where: { id },
        update: {},
        create: {
          id,
          chatId: input.chatId,
          messageId: input.messageId,
          subjectUserId: input.subjectUserId,
          retryUntilAt: input.retryUntilAt ?? new Date(Date.now() + REPORT_DAY_MS),
        },
      });
      await prisma.moderationDeleteIntentReason.upsert({
        where: { intentId_reasonKey: { intentId: id, reasonKey: input.reasonKey } },
        update: {},
        create: {
          id: randomUUID(),
          intentId: id,
          reasonKey: input.reasonKey,
          ruleCode: input.ruleCode,
          userId: input.subjectUserId,
          metadata: input.event?.metadata ?? {},
        },
      });
      return { intentId: id, rollout: 'execute' as const, status: 'PENDING' as const };
    }),
  };

  function target(id: string, authorId = 'author', createdAt = new Date(Date.now() - 60_000)) {
    rows.set(id, {
      sender: { user_id: authorId, is_bot: false },
      recipient: { chat_id: chatId, chat_type: 'chat' },
      timestamp: createdAt.getTime(),
      body: { mid: id, text: 'reported text' },
    });
    return id;
  }
  async function vote(
    targetId: string,
    reporterId: string,
    commandId: string = randomUUID(),
    botId = 'bot-a',
  ) {
    const update = new WebhookParser().parse({
      update_type: 'message_created',
      timestamp: Date.now(),
      message: {
        sender: { user_id: reporterId, is_bot: false },
        recipient: { chat_id: chatId, chat_type: 'chat' },
        timestamp: Date.now(),
        body: { mid: commandId, text: 'жалоба' },
        link: { type: 'reply', chat_id: chatId, message: { mid: targetId } },
      },
    });
    update.botId = botId;
    const settings = await prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
    await submissions.handle(update, settings);
    return prisma.chatReportCase.findUnique({
      where: { chatId_messageId: { chatId, messageId: targetId } },
    });
  }
  async function pending(
    id: string,
    options: { mute?: boolean; history?: boolean; author?: string } = {},
  ) {
    await prisma.chatSettings.update({
      where: { chatId },
      data: {
        reportsEnabled: true,
        reportsThreshold: 2,
        reportsMuteEnabled: options.mute ?? false,
        reportsDeleteMode: options.history ? 'HISTORY_24H' : 'MESSAGE',
      },
    });
    target(id, options.author);
    await vote(id, `r1-${id}`);
    return (await vote(id, `r2-${id}`))!;
  }
  async function process(id: string) {
    await prisma.chatReportCase.update({
      where: { id },
      data: { leaseToken: 'test-lease', leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    await executor.process(id, 'test-lease');
  }

  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      !parsed.pathname.includes('race_test')
    )
      throw new Error('Reports tests require a disposable local race_test database');
    prisma = createPrismaClient(databaseUrl, { max: 8 });
    await prisma.$connect();
    await prisma.chat.create({
      data: {
        id: chatId,
        title: 'Reports integration test',
        settings: { create: { reportsEnabled: true } },
      },
    });
    state = new ReportStateService(
      prisma as never,
      max as never,
      { isKnownBotUserId: () => false } as never,
      { get: (key: string) => (key === 'PARTICIPANT_REPORTS_MODE' ? 'on' : '') } as never,
    );
    submissions = new ReportSubmissionService(
      state,
      prisma as never,
      max as never,
      deletes as never,
      redis as never,
    );
    views = new ReportViewService(prisma as never, state);
    executor = new ReportExecutionService(
      prisma as never,
      state,
      deletes as never,
      max as never,
      views,
      new ModerationSanctionStateLockService(),
      new ModerationSanctionStateFenceService(prisma as never),
      redis as never,
    );
    guard = new ReportDeleteGuardService(state, prisma as never, max as never);
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.webhookEvent.deleteMany({ where: { dedupKey: { startsWith: prefix } } });
    await prisma.chatModerationFeedItem.deleteMany({ where: { chatId } });
    await prisma.chat.deleteMany({ where: { id: chatId } });
    await prisma.$disconnect();
  });
  beforeEach(() => memberOverrides.clear());

  it.each([2, 6])(
    'atomically crosses threshold %i once under mirrored/concurrent votes',
    async (threshold) => {
      await prisma.chatSettings.update({
        where: { chatId },
        data: { reportsThreshold: threshold },
      });
      const id = target(`concurrent-${threshold}`);
      await Promise.all(
        Array.from({ length: threshold }, (_, n) => vote(id, `concurrent-${threshold}-${n}`)),
      );
      const report = await prisma.chatReportCase.findUniqueOrThrow({
        where: { chatId_messageId: { chatId, messageId: id } },
      });
      expect(report.status).toBe('PENDING');
      expect(await prisma.chatReportVote.count({ where: { caseId: report.id } })).toBe(threshold);
      await vote(id, `concurrent-${threshold}-0`, 'duplicate', 'bot-b');
      expect(await prisma.chatReportVote.count({ where: { caseId: report.id } })).toBe(threshold);
    },
  );
  it('deduplicates before the threshold across bots and commands', async () => {
    const id = target('mirror');
    const [report] = await Promise.all([
      vote(id, 'mirror-user', 'same-mid'),
      vote(id, 'mirror-user', 'same-mid', 'bot-b'),
    ]);
    await vote(id, 'mirror-user');
    expect(await prisma.chatReportVote.count({ where: { caseId: report!.id } })).toBe(1);
  });
  it('does not merge votes between messages and resets votes for edited content', async () => {
    const one = target('one'),
      two = target('two');
    const report = (await vote(one, 'edit-user'))!;
    await vote(two, 'edit-user-2');
    rows.get(one)!.body = { mid: one, text: 'changed' };
    const updated = (await vote(one, 'edit-user-3'))!;
    expect(updated.contentVersion).toBe(report.contentVersion + 1);
    expect((await views.summary(updated)).votes).toBe(1);
  });
  it('rejects self reports, expired messages, new members, bots and protected authors', async () => {
    expect(await vote(target('self', 'self-user'), 'self-user')).toBeNull();
    expect(
      await vote(
        target('expired', 'author', new Date(Date.now() - REPORT_DAY_MS - 10)),
        'old-user',
      ),
    ).toBeNull();
    memberOverrides.set('new-user', { joinedAtMs: Date.now() - 1000 });
    expect(await vote(target('new'), 'new-user')).toBeNull();
    memberOverrides.set('bot-user', { isBot: true });
    expect(await vote(target('bot'), 'bot-user')).toBeNull();
    memberOverrides.set('admin-author', { isAdmin: true });
    expect(await vote(target('protected', 'admin-author'), 'normal-user')).toBeNull();
    await prisma.chatParticipantModerationImmunity.create({
      data: { chatId, userId: 'immune', createdByUserId: 'admin' },
    });
    expect(await vote(target('immune-target', 'immune'), 'normal-user')).toBeNull();
  });
  it('serializes the sliding hourly limit across different messages', async () => {
    await Promise.all(
      Array.from({ length: 11 }, (_, n) => vote(target(`limited-${n}`), 'limited')),
    );
    expect(await prisma.chatReportVote.count({ where: { chatId, reporterId: 'limited' } })).toBe(
      10,
    );
  });
  it('database revision changes only for report settings and invalidates old cases', async () => {
    const report = (await vote(target('policy'), 'policy-user'))!;
    const before = await prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
    await prisma.chatSettings.update({
      where: { chatId },
      data: { reportsThreshold: before.reportsThreshold, warnThreshold: 5 },
    });
    expect(
      (await prisma.chatSettings.findUniqueOrThrow({ where: { chatId } })).reportsRevision,
    ).toBe(before.reportsRevision);
    await prisma.chatSettings.update({
      where: { chatId },
      data: { reportsMuteEnabled: !before.reportsMuteEnabled },
    });
    await expect(state.assertPolicy(report)).rejects.toThrow('настройки');
  });
  it('dismiss is chat scoped, persistent, and prevents later votes', async () => {
    const report = (await vote(target('dismiss'), 'dismiss-user'))!;
    await expect(views.dismiss('other-chat', report.id, 'admin')).rejects.toThrow();
    await views.dismiss(chatId, report.id, 'admin');
    await vote('dismiss', 'another-user');
    expect((await views.detail(chatId, report.id)).status).toBe('DISMISSED');
    expect((await views.detail(chatId, report.id)).votes).toBe(1);
  });
  it('recovers an execution without extending or duplicating a mute', async () => {
    const report = await pending('muting', { mute: true, author: 'mute-author' });
    await process(report.id);
    const applied = await prisma.chatReportCase.findUniqueOrThrow({ where: { id: report.id } });
    expect(applied.muteEventId).not.toBeNull();
    await process(report.id);
    expect(
      await prisma.moderationEvent.count({
        where: { chatId, ruleCode: 'PARTICIPANT_REPORT', userId: 'mute-author' },
      }),
    ).toBe(1);
    expect(await state.hasActiveSanction(chatId, 'mute-author')).toBe(true);
    const second = await pending('already-muted', { mute: true, author: 'mute-author' });
    await process(second.id);
    expect(
      (await prisma.chatReportCase.findUniqueOrThrow({ where: { id: second.id } })).muteEventId,
    ).toBeNull();
  });

  it('retries an unavailable MAX membership lookup without recording an optimistic vote', async () => {
    const id = target('membership-retry');
    max.getChatMemberAccess.mockRejectedValueOnce(new Error('temporary MAX failure'));
    await expect(vote(id, 'retry-user', 'retry-command')).rejects.toThrow('temporary MAX failure');
    expect(await prisma.chatReportVote.count({ where: { chatId, reporterId: 'retry-user' } })).toBe(
      0,
    );
    const report = (await vote(id, 'retry-user', 'retry-command'))!;
    expect((await views.summary(report)).votes).toBe(1);
  });

  it('never repeats an ambiguous counter send when execution is recovered', async () => {
    const report = await pending('counter-timeout');
    const calls = max.sendMessageImmediateWithId.mock.calls.length;
    max.sendMessageImmediateWithId.mockImplementationOnce(async (_chat, _text, options) => {
      await options.beforeSend();
      throw new Error('ambiguous send timeout');
    });
    await expect(process(report.id)).rejects.toThrow('ambiguous send timeout');
    await process(report.id);
    expect(max.sendMessageImmediateWithId.mock.calls.length).toBe(calls + 1);
    const current = await prisma.chatReportCase.findUniqueOrThrow({ where: { id: report.id } });
    expect(current.counterSendStartedAt).not.toBeNull();
    expect(current.counterMessageId).toBeNull();
    expect(current.status).toBe('RUNNING');
  });

  it('does not create sanctions after the reported message disappears', async () => {
    const report = await pending('removed-before-execution', { mute: true });
    rows.delete(report.messageId);
    await expect(process(report.id)).rejects.toThrow('удалено');
    expect(await prisma.chatReportAction.count({ where: { caseId: report.id } })).toBe(0);
    expect(
      (await prisma.chatReportCase.findUniqueOrThrow({ where: { id: report.id } })).muteEventId,
    ).toBeNull();
  });
  it('revalidates edited content, disabled settings and promoted authors at delete dispatch', async () => {
    const report = await pending('guarded');
    await process(report.id);
    const action = await prisma.chatReportAction.findUniqueOrThrow({
      where: { caseId_messageId: { caseId: report.id, messageId: report.messageId } },
    });
    const params = {
      intentId: action.intentId!,
      chatId,
      messageId: report.messageId,
      subjectUserId: report.authorId,
      botId: 'bot-a',
    };
    expect(await guard.assertIntentStillActionable(params)).toBe('allowed');
    memberOverrides.set(report.authorId, { isAdmin: true });
    await expect(guard.assertIntentStillActionable(params)).rejects.toThrow();
    memberOverrides.clear();
    rows.get(report.messageId)!.body = { mid: report.messageId, text: 'edited' };
    await expect(guard.assertIntentStillActionable(params)).rejects.toThrow('content changed');
    await prisma.chatSettings.update({ where: { chatId }, data: { reportsEnabled: false } });
    await expect(guard.assertIntentStillActionable(params)).rejects.toThrow('выключен');
  });
  it('paginates more than 1000 known messages within fixed history bounds and survives replay', async () => {
    const report = await pending('history', { history: true, author: 'history-author' });
    await process(report.id);
    const targetAction = await prisma.chatReportAction.findUniqueOrThrow({
      where: { caseId_messageId: { caseId: report.id, messageId: report.messageId } },
    });
    expect(await prisma.chatReportAction.count({ where: { caseId: report.id } })).toBe(1);
    await prisma.moderationDeleteIntent.update({
      where: { id: targetAction.intentId! },
      data: {
        status: 'SUCCEEDED',
        remoteDeleteSucceededAt: new Date(),
        remoteDeleteSucceededBotId: 'bot-a',
      },
    });
    const at = new Date(report.decidedAt!.getTime() - 1000);
    await prisma.webhookEvent.createMany({
      data: Array.from({ length: 1005 }, (_, n) => ({
        dedupKey: `${prefix}-${n}`,
        rawPayload: {},
        createdAt: at,
        normalizedPayload: {
          type: 'message_created',
          message: {
            chatId,
            senderId: report.authorId,
            messageId: `history-${n}`,
            createdAt: at.toISOString(),
          },
        },
      })),
    });
    await prisma.webhookEvent.createMany({
      data: [
        {
          dedupKey: `${prefix}-too-old`,
          rawPayload: {},
          createdAt: at,
          normalizedPayload: {
            type: 'message_created',
            message: {
              chatId,
              senderId: report.authorId,
              messageId: 'too-old',
              createdAt: new Date(at.getTime() - REPORT_DAY_MS).toISOString(),
            },
          },
        },
        {
          dedupKey: `${prefix}-future`,
          rawPayload: {},
          createdAt: new Date(report.decidedAt!.getTime() + 1),
          normalizedPayload: {
            type: 'message_created',
            message: {
              chatId,
              senderId: report.authorId,
              messageId: 'future',
              createdAt: at.toISOString(),
            },
          },
        },
      ],
    });
    await process(report.id);
    expect((await views.detail(chatId, report.id)).pending).toBeLessThanOrEqual(200);
    const firstPageCount = await prisma.chatReportAction.count({ where: { caseId: report.id } });
    await process(report.id);
    expect(await prisma.chatReportAction.count({ where: { caseId: report.id } })).toBe(
      firstPageCount,
    );
    for (let page = 0; page < 7; page++) {
      const actions = await prisma.chatReportAction.findMany({
        where: { caseId: report.id },
        select: { intentId: true },
      });
      await prisma.moderationDeleteIntent.updateMany({
        where: { id: { in: actions.map((a) => a.intentId!) } },
        data: {
          status: 'SUCCEEDED',
          remoteDeleteSucceededAt: new Date(),
          remoteDeleteSucceededBotId: 'bot-a',
        },
      });
      await process(report.id);
    }
    expect(await prisma.chatReportAction.count({ where: { caseId: report.id } })).toBe(1006);
    await process(report.id);
    expect(await prisma.chatReportAction.count({ where: { caseId: report.id } })).toBe(1006);
    expect((await views.detail(chatId, report.id)).status).toBe('COMPLETED');
    const sql = Prisma.sql`SELECT id, created_at, normalized_payload FROM webhook_events
      WHERE normalized_payload->>'type' = 'message_created'
      AND normalized_payload->'message'->>'chatId' = ${chatId}
      AND normalized_payload->'message'->>'senderId' = ${report.authorId}
      AND created_at >= ${new Date(at.getTime() - REPORT_DAY_MS)} AND created_at <= ${report.decidedAt}
      ORDER BY created_at, id LIMIT 200`;
    await prisma.$executeRawUnsafe('ANALYZE webhook_events');
    expect(
      JSON.stringify(await prisma.$queryRaw(Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`)),
    ).toContain('webhook_events_report_history_idx');
  }, 60_000);
});
