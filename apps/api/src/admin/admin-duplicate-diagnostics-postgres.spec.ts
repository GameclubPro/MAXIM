import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { AdminDuplicateDiagnosticsService } from './admin-duplicate-diagnostics.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
(databaseUrl ? describe : describe.skip)('duplicate diagnostics PostgreSQL boundaries', () => {
  let prisma: PrismaClient;
  const chatId = `duplicate-diagnostics-${randomUUID()}`;
  const otherChatId = `${chatId}-other`;
  const now = Date.now();
  let query: Prisma.Sql | undefined;
  let service: AdminDuplicateDiagnosticsService;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Duplicate diagnostics tests require a disposable local race_test database');
    prisma = createPrismaClient(databaseUrl, { max: 2 });
    await prisma.$connect();
    await prisma.chat.createMany({
      data: [
        { id: chatId, title: 'Test' },
        { id: otherChatId, title: 'Other' },
      ],
    });
    await prisma.chatSettings.create({ data: { chatId, antiDuplicateEnabled: true } });
    await prisma.moderationDeleteIntent.createMany({
      data: Array.from({ length: 25 }, (_, index) => ({
        id: `${chatId}-${index}`,
        chatId,
        messageId: `message-${index}`,
        status: 'PENDING',
        retryUntilAt: new Date(now + 3600000),
        createdAt: new Date(now - index * 1000),
      })),
    });
    await prisma.moderationDeleteIntentReason.createMany({
      data: Array.from({ length: 25 }, (_, index) => ({
        id: `${chatId}-reason-${index}`,
        intentId: `${chatId}-${index}`,
        reasonKey: 'rule',
        ruleCode: index === 0 ? 'OTHER_DELETE' : 'DUPLICATE_DELETE',
      })),
    });
    await prisma.moderationDeleteIntent.createMany({
      data: Array.from({ length: 2000 }, (_, index) => ({
        id: `${otherChatId}-${index}`,
        chatId: otherChatId,
        messageId: `message-${index}`,
        status: 'PENDING',
        retryUntilAt: new Date(now + 3600000),
      })),
    });
    const database = {
      chatSettings: prisma.chatSettings,
      $transaction: (
        callback: (tx: unknown) => Promise<unknown>,
        options: { timeout: number; maxWait: number },
      ) =>
        prisma.$transaction(
          (tx) =>
            callback({
              $executeRaw: tx.$executeRaw.bind(tx),
              $queryRaw: (value: Prisma.Sql) => {
                query = value;
                return tx.$queryRaw(value);
              },
            }),
          options,
        ),
    };
    service = new AdminDuplicateDiagnosticsService(
      database as never,
      {
        resolveStrictWriteModerationBotRoute: async () => ({
          botId: null,
          capabilityState: 'stale_or_unknown',
          checkedAt: null,
        }),
      } as never,
      {} as never,
      { resolve: async () => ({ mode: 'full' }) } as never,
    );
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.chat.deleteMany({ where: { id: { in: [chatId, otherChatId] } } });
    await prisma.$disconnect();
  });

  it('executes the actual capped query and isolates the authenticated chat', async () => {
    const result = await service.read(chatId);
    expect(result.history).toMatchObject({ available: true, sampledIntents: 20, limited: true });
    expect(result.history.attempts.map((attempt) => attempt.id)).toEqual(
      [1, 2, 3, 4, 5].map((id) => `${chatId}-${id}`),
    );
    expect(result.history.attempts.every((attempt) => attempt.outcome === 'PENDING')).toBe(true);
    expect(await prisma.moderationDeleteIntent.count({ where: { chatId } })).toBe(25);
  });

  it('keeps the per-chat/status and exact-intent reason indexes usable', async () => {
    await service.read(chatId);
    expect(query).toBeDefined();
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw(Prisma.sql`EXPLAIN (FORMAT JSON) ${query!}`);
    });
    const serialized = JSON.stringify(plan);
    expect(serialized).toContain('moderation_delete_intents_chat_status_created_idx');
    expect(serialized).toContain('moderation_delete_intent_reasons_intent_reason_key');
    expect(serialized).toContain('Limit');
  });
});
