import { randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  Prisma,
  type PrismaClient,
  type ChatReportCase,
} from '../../prisma/prisma-client';
import { ReportStateService } from './report-state.service';
import { ReportSubmissionService } from './report-submission.service';
import { ReportRetentionService } from './report-retention.service';
import { ReportTelemetryService } from './report-telemetry.service';
import { ReportViewService } from './report-view.service';
import { REPORT_DAY_MS } from './report.util';
import { WebhookParser } from '../../webhook/webhook.parser';
import { reportJournalPageQuery } from './report-journal-query.util';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('PostgreSQL report journal and bounded detail archive', () => {
  let prisma: PrismaClient;
  let state: ReportStateService;
  let views: ReportViewService;
  let archive: ReportRetentionService;
  const chatId = `-report-journal-${randomUUID()}`;
  const now = new Date();
  const old = new Date(now.getTime() - 100 * REPORT_DAY_MS);
  let enabled = true;
  const caseInput = (id: string) => ({
    id,
    chatId,
    messageId: `target-${id}`,
    authorId: 'author',
    originBotId: 'bot',
    contentHash: 'hash',
    policyRevision: 0,
    messageCreatedAt: old,
    expiresAt: new Date(old.getTime() + REPORT_DAY_MS),
    threshold: 3,
    deleteMode: 'MESSAGE',
    status: 'COMPLETED',
    decidedAt: old,
    createdAt: old,
    updatedAt: old,
    dueAt: new Date('9999-01-01T00:00:00Z'),
  });

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Report journal tests require a disposable local race_test database');
    prisma = createPrismaClient(databaseUrl, { max: 8 });
    await prisma.$connect();
    await prisma.chat.create({
      data: {
        id: chatId,
        title: 'Report journal test',
        settings: { create: { reportsEnabled: true } },
      },
    });
    state = new ReportStateService(
      prisma as never,
      {} as never,
      { isKnownBotUserId: () => false } as never,
      { get: (key: string) => (key === 'PARTICIPANT_REPORTS_MODE' ? 'on' : '') } as never,
    );
    views = new ReportViewService(prisma as never, state);
    archive = new ReportRetentionService(
      prisma as never,
      state,
      views,
      { get: (key: string) => (key.endsWith('ENABLED') ? enabled : 90) } as never,
      new ReportTelemetryService(),
    );
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.chat.deleteMany({ where: { id: chatId } });
    await prisma.$disconnect();
  });

  it('filters all pages on the server and rejects a cursor from another filter', async () => {
    await prisma.chatReportCase.createMany({
      data: Array.from({ length: 45 }, (_, n) => ({
        ...caseInput(`journal-${n}`),
        createdAt: new Date(now.getTime() - n * 1000),
        expiresAt: new Date(now.getTime() + REPORT_DAY_MS),
        authorId: n % 2 ? 'different-author' : 'author',
        status: n % 2 ? 'COMPLETED' : 'COLLECTING',
        decidedAt: null,
      })),
    });
    const first = await views.list(chatId, undefined, { status: 'ACTIVE', authorId: 'author' });
    expect(first.items).toHaveLength(20);
    expect(
      first.items.every((item) => item.status === 'COLLECTING' && item.authorId === 'author'),
    ).toBe(true);
    expect(first.observedAt).toMatch(/Z$/);
    const second = await views.list(chatId, first.nextCursor, {
      status: 'ACTIVE',
      authorId: 'author',
    });
    expect(second.items).toHaveLength(3);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(23);
    await expect(views.list(chatId, first.nextCursor, { status: 'COMPLETED' })).rejects.toThrow(
      'фильтр',
    );
    const period = await views.list(chatId, undefined, {
      from: new Date(now.getTime() - 10_000).toISOString(),
      to: now.toISOString(),
    });
    expect(period.items).toHaveLength(11);
  });

  it('keeps case and receipt in one repeatable snapshot during a concurrent receipt commit', async () => {
    const report = await prisma.chatReportCase.create({
      data: { ...caseInput('snapshot'), status: 'RUNNING', createdAt: now },
    });
    await prisma.moderationDeleteIntent.create({
      data: {
        id: 'journal-snapshot-intent',
        chatId,
        messageId: report.messageId,
        status: 'PENDING',
        retryUntilAt: new Date(now.getTime() + REPORT_DAY_MS),
      },
    });
    await prisma.chatReportAction.create({
      data: { caseId: report.id, messageId: report.messageId, intentId: 'journal-snapshot-intent' },
    });
    const target = views as unknown as {
      summaries: (
        reports: readonly ChatReportCase[],
        db: Prisma.TransactionClient,
      ) => Promise<unknown>;
    };
    const original = target.summaries.bind(views);
    const spy = jest.spyOn(target, 'summaries').mockImplementationOnce(async (reports, db) => {
      await prisma.moderationDeleteIntent.update({
        where: { id: 'journal-snapshot-intent' },
        data: {
          status: 'SUCCEEDED',
          remoteDeleteSucceededAt: new Date(),
          remoteDeleteSucceededBotId: 'bot',
        },
      });
      return original(reports, db);
    });
    try {
      const before = await views.detail(chatId, report.id);
      expect(before.pending).toBe(1);
      const after = await views.detail(chatId, report.id);
      expect(after.deleted).toBe(1);
      expect(after.updatedAt! >= before.updatedAt!).toBe(true);
      expect(after.snapshotVersion).not.toBe(before.snapshotVersion);
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves final totals through multiple bounded batches without reopening the tombstone', async () => {
    const report = await prisma.chatReportCase.create({ data: caseInput('bounded-archive') });
    await prisma.chatReportVote.createMany({
      data: Array.from({ length: 3 }, (_, n) => ({
        caseId: report.id,
        chatId,
        contentVersion: 1,
        reporterId: `reporter-${n}`,
        commandMessageId: `command-${n}`,
        createdAt: old,
      })),
    });
    await prisma.chatReportAction.createMany({
      data: Array.from({ length: 450 }, (_, n) => ({
        caseId: report.id,
        messageId: `archive-message-${n}`,
        receiptStatus: n % 2 ? 'ALREADY_ABSENT' : 'SUCCEEDED',
      })),
    });
    const before = await views.detail(chatId, report.id);
    enabled = false;
    expect(await archive.archivePage()).toBe(0);
    expect(await archive.previewPage()).toBe(200);
    expect((await views.detail(chatId, report.id)).detailsArchived).toBe(false);
    enabled = true;
    for (let page = 0; page < 8; page++)
      expect(await archive.archivePage()).toBeLessThanOrEqual(200);
    const after = await views.detail(chatId, report.id);
    expect(after).toMatchObject({
      detailsArchived: true,
      votes: before.votes,
      candidates: before.candidates,
      deleted: before.deleted,
      absent: before.absent,
      failed: before.failed,
      pending: 0,
      reporters: [],
    });
    expect(await prisma.chatReportAction.count({ where: { caseId: report.id } })).toBe(0);
    expect(await prisma.chatReportVote.count({ where: { caseId: report.id } })).toBe(0);
    expect(await prisma.chatReportCase.findUnique({ where: { id: report.id } })).not.toBeNull();
    await prisma.chatReportCase.update({
      where: { id: report.id },
      data: { status: 'CANCELLED', expiresAt: new Date(now.getTime() + REPORT_DAY_MS) },
    });
    const timestamp = Date.now() - 60_000;
    const max = {
      getExactMessageRow: async () => ({
        timestamp,
        sender: { user_id: 'author', is_bot: false },
        recipient: { chat_id: chatId, chat_type: 'chat' },
        body: { mid: report.messageId, text: 'text' },
      }),
      getChatMemberAccess: async (_chat: string, userId: string) => ({
        userId,
        isBot: false,
        isAdmin: false,
        isOwner: false,
        joinedAtMs: Date.now() - 2 * REPORT_DAY_MS,
      }),
      sendMessage: jest.fn(),
    };
    const submissionState = new ReportStateService(
      prisma as never,
      max as never,
      { isKnownBotUserId: () => false } as never,
      { get: (key: string) => (key === 'PARTICIPANT_REPORTS_MODE' ? 'on' : '') } as never,
    );
    const submissions = new ReportSubmissionService(
      submissionState,
      prisma as never,
      max as never,
      {} as never,
      { setStringIfAbsentWithTtl: async () => false } as never,
    );
    const update = new WebhookParser().parse(
      {
        update_type: 'message_created',
        timestamp,
        message: {
          timestamp,
          sender: { user_id: 'new-reporter', is_bot: false },
          recipient: { chat_id: chatId, chat_type: 'chat' },
          body: { mid: 'new-command', text: 'жалоба' },
          link: { type: 'reply', chat_id: chatId, message: { mid: report.messageId } },
        },
      },
      { botId: 'bot' },
    );
    await prisma.chatSettings.update({ where: { chatId }, data: { reportsThreshold: 6 } });
    await submissions.handle(update, { reportsEnabled: true, reportsAliases: [] });
    expect(
      (await prisma.chatReportCase.findUniqueOrThrow({ where: { id: report.id } })).status,
    ).toBe('CANCELLED');
    expect(await prisma.chatReportVote.count({ where: { caseId: report.id } })).toBe(0);
  });

  it('does not archive a live cleanup binding or a concurrently reopened collection', async () => {
    const report = await prisma.chatReportCase.create({ data: caseInput('live-archive') });
    await prisma.moderationDeleteIntent.create({
      data: {
        id: 'journal-live-cleanup',
        chatId,
        messageId: 'cleanup-command',
        status: 'PENDING',
        retryUntilAt: new Date(now.getTime() + REPORT_DAY_MS),
      },
    });
    await prisma.moderationDeleteIntentReason.create({
      data: {
        id: randomUUID(),
        intentId: 'journal-live-cleanup',
        reasonKey: 'command-cleanup',
        ruleCode: 'PARTICIPANT_REPORT_COMMAND_CLEANUP',
        metadata: { reportCaseId: report.id },
      },
    });
    await archive.archivePage();
    expect(
      (await prisma.chatReportCase.findUniqueOrThrow({ where: { id: report.id } }))
        .detailsArchivedAt,
    ).toBeNull();
    const original = state.transaction.bind(state);
    const transaction = jest.spyOn(state, 'transaction');
    transaction.mockImplementationOnce(async (id, operation) => {
      await prisma.chatReportCase.update({
        where: { id: report.id },
        data: { status: 'COLLECTING' },
      });
      return original(id, operation);
    });
    try {
      await archive.archivePage();
      expect(
        (await prisma.chatReportCase.findUniqueOrThrow({ where: { id: report.id } }))
          .detailsArchivedAt,
      ).toBeNull();
    } finally {
      transaction.mockRestore();
    }
  });

  it('uses the counter, author journal and archive page indexes on representative data', async () => {
    await prisma.chatReportCase.createMany({
      data: Array.from({ length: 1500 }, (_, n) => ({
        ...caseInput(`indexed-${n}`),
        authorId: n % 10 ? `author-${n}` : 'author-shared',
        counterMessageId: `counter-${n}`,
        expiresAt: new Date(now.getTime() + REPORT_DAY_MS),
        status: ['COLLECTING', 'PENDING', 'RUNNING', 'FAILED', 'PARTIAL', 'COMPLETED'][n % 6],
      })),
    });
    await prisma.$executeRawUnsafe('ANALYZE chat_report_cases');
    const counter = JSON.stringify(
      await prisma.$queryRaw(Prisma.sql`EXPLAIN (FORMAT JSON)
      SELECT id FROM chat_report_cases WHERE chat_id = ${chatId} AND counter_message_id = 'counter-1499' LIMIT 1`),
    );
    const author = JSON.stringify(
      await prisma.$queryRaw(Prisma.sql`EXPLAIN (FORMAT JSON)
      SELECT id FROM chat_report_cases WHERE chat_id = ${chatId} AND author_id = 'author-1499'
      ORDER BY created_at DESC, id DESC LIMIT 21`),
    );
    expect(counter).toContain('chat_report_cases_chat_counter_idx');
    expect(author).toContain('chat_report_cases_chat_author_created_idx');
    for (const filter of [
      { status: 'ALL' as const },
      { status: 'ACTIVE' as const },
      { status: 'FAILED' as const },
      { status: 'ACTIVE' as const, authorId: 'author-shared' },
    ]) {
      const query = reportJournalPageQuery(chatId, filter);
      const plan = JSON.stringify(
        await prisma.$queryRaw(Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`),
      );
      expect(plan).toContain('Index');
      expect(query.sql.match(/LIMIT 21/g)!.length).toBeLessThanOrEqual(5);
      if (filter.status !== 'ALL')
        expect(plan).toContain(
          filter.authorId
            ? 'chat_report_cases_chat_author_status_created_idx'
            : 'chat_report_cases_chat_status_created_idx',
        );
    }
    const archivePlan = JSON.stringify(
      await prisma.$queryRaw(Prisma.sql`EXPLAIN (FORMAT JSON)
      SELECT id FROM chat_report_cases WHERE details_archive_completed_at IS NULL AND expires_at < ${old}
      ORDER BY expires_at, id LIMIT 5`),
    );
    expect(archivePlan).toContain('chat_report_cases_archive_expiry_idx');
    await prisma.moderationDeleteIntentReason.createMany({
      data: Array.from({ length: 1500 }, (_, n) => ({
        id: randomUUID(),
        intentId: 'journal-live-cleanup',
        reasonKey: `indexed-reason-${n}`,
        ruleCode: 'PARTICIPANT_REPORT_COMMAND_CLEANUP',
        metadata: { reportCaseId: `unrelated-case-${n}` },
      })),
    });
    await prisma.$executeRawUnsafe('ANALYZE moderation_delete_intent_reasons');
    const bindingPlan = JSON.stringify(
      await prisma.$queryRaw(Prisma.sql`EXPLAIN (FORMAT JSON)
      SELECT 1 FROM moderation_delete_intent_reasons reason JOIN moderation_delete_intents intent ON intent.id = reason.intent_id
      WHERE reason.rule_code IN ('PARTICIPANT_REPORT_DELETE', 'PARTICIPANT_REPORT_COMMAND_CLEANUP', 'PARTICIPANT_REPORT_COUNTER_CLEANUP')
        AND reason.metadata->>'reportCaseId' = 'unrelated-case-1499' AND intent.status::text NOT IN ('SUCCEEDED','ALREADY_ABSENT','EXPIRED','FAILED_TERMINAL')
      LIMIT 1`),
    );
    expect(bindingPlan).toContain('moderation_delete_reasons_report_case_idx');
  });
});
