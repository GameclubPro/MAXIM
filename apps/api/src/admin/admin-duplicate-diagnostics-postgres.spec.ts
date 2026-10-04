import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { AdminDuplicateDiagnosticsService } from './admin-duplicate-diagnostics.service';
import { runDuplicateDiagnosticsRecovery } from '../scripts/recover-duplicate-diagnostics';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
(databaseUrl ? describe : describe.skip)('duplicate diagnostics PostgreSQL boundaries', () => {
  let prisma: PrismaClient;
  const chatId = `duplicate-diagnostics-${randomUUID()}`;
  const otherChatId = `${chatId}-other`;
  const now = Date.now();
  let query: Prisma.Sql | undefined;
  let service: AdminDuplicateDiagnosticsService;

  // The large skew fixture and ANALYZE need a bounded setup budget under full-suite load.
  // Individual production reads retain their separate two-second statement deadline.
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
      // Exercise ordered exact-intent reason selection with representative metadata skew.
      // One reason per intent lets PostgreSQL legitimately prefer another exact-intent index.
      data: Array.from({ length: 25 }, (_, index) =>
        Array.from({ length: 32 }, (_, reasonIndex) => ({
          id: `${chatId}-reason-${index}-${reasonIndex}`,
          intentId: `${chatId}-${index}`,
          reasonKey: `rule-${String(reasonIndex).padStart(2, '0')}`,
          ruleCode: index === 0 ? 'OTHER_DELETE' : 'DUPLICATE_DELETE',
          ...(index === 1 && reasonIndex === 0
            ? {
                metadata: {
                  messageDuplicate: {
                    original: {
                      member: 'a'.repeat(64),
                      author: 'b'.repeat(64),
                      messageId: 'original-id',
                      senderId: 'private-author',
                      publishedAtMs: now - 3600000,
                      observedAtMs: now - 3600000,
                      expiresAtMs: now + 23 * 3600000,
                      sourceDigest: 'c'.repeat(64),
                      contentDigest: 'd'.repeat(64),
                      mediaHashes: [],
                      epoch: 0,
                    },
                  },
                },
              }
            : {}),
        })),
      ).flat(),
    });
    await prisma.moderationDeleteIntent.createMany({
      data: Array.from({ length: 5000 }, (_, index) => ({
        id: `${otherChatId}-${index}`,
        chatId: otherChatId,
        messageId: `message-${index}`,
        status: 'PENDING',
        retryUntilAt: new Date(now + 3600000),
      })),
    });
    await prisma.moderationDeleteIntentReason.createMany({
      data: Array.from({ length: 5000 }, (_, index) => ({
        id: `${otherChatId}-reason-${index}`,
        intentId: `${otherChatId}-${index}`,
        reasonKey: 'duplicate',
        ruleCode: 'DUPLICATE_DELETE',
      })),
    });
    // Thousands of newer retained/unrelated reasons in the SAME chat must not evict
    // older duplicate entries. The trigger does not project any of these intents.
    await prisma.moderationDeleteIntent.createMany({
      data: Array.from({ length: 5000 }, (_, index) => ({
        id: `${chatId}-retention-${index}`,
        chatId,
        messageId: `retained-${index}`,
        retentionOwned: true,
        status: 'SUCCEEDED',
        retryUntilAt: new Date(now + 3600000),
        createdAt: new Date(now - 10),
      })),
    });
    await prisma.moderationDeleteIntentReason.createMany({
      data: Array.from({ length: 5000 }, (_, index) => ({
        id: `${chatId}-retention-reason-${index}`,
        intentId: `${chatId}-retention-${index}`,
        reasonKey: 'retention',
        ruleCode: 'MESSAGE_RETENTION',
      })),
    });
    await prisma.moderationDeleteIntent.createMany({
      data: [
        {
          id: `${chatId}-legacy`,
          chatId,
          messageId: 'legacy',
          retryUntilAt: new Date(now + 3600000),
          createdAt: new Date(now - 7200000),
        },
        {
          id: `${chatId}-outside`,
          chatId,
          messageId: 'outside',
          retryUntilAt: new Date(now + 3600000),
          createdAt: new Date(now - 90000000),
        },
      ],
    });
    await prisma.moderationDeleteIntentReason.createMany({
      data: ['legacy', 'outside'].map((suffix) => ({
        id: `${chatId}-${suffix}-reason`,
        intentId: `${chatId}-${suffix}`,
        reasonKey: 'duplicate',
        ruleCode: 'DUPLICATE_DELETE',
      })),
    });
    await prisma.duplicateDiagnosticsHistory.delete({ where: { intentId: `${chatId}-legacy` } });
    await prisma.moderationEvent.createMany({
      data: [
        ...Array.from({ length: 10000 }, (_, index) => ({
          chatId: index % 2 ? otherChatId : chatId,
          userId: 'test-author',
          messageId: `unrelated-${index}`,
          eventType: 'MESSAGE' as const,
          ruleCode: 'DUPLICATE_WARN',
          action: 'WARN' as const,
        })),
        ...Array.from({ length: 32 }, (_, index) => ({
          chatId,
          userId: 'test-author',
          messageId: 'message-1',
          eventType: 'MESSAGE' as const,
          ruleCode: index % 2 ? 'OTHER_RULE' : 'DUPLICATE_WARN',
          action: 'WARN' as const,
        })),
      ],
    });
    await prisma.$executeRaw`ANALYZE duplicate_diagnostics_history, moderation_delete_intents, moderation_delete_intent_reasons, moderation_events`;
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
  }, 30_000);
  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.chat.deleteMany({ where: { id: { in: [chatId, otherChatId] } } });
    } finally {
      await prisma.$disconnect();
    }
  }, 30_000);

  it('executes the actual capped query and isolates the authenticated chat', async () => {
    const result = await service.read(chatId);
    expect(result.history).toMatchObject({
      available: true,
      sampledIntents: 5,
      limited: true,
      coverage: 'PROJECTED_ONLY',
    });
    expect(result.history.attempts.map((attempt) => attempt.id)).toEqual(
      [1, 2, 3, 4, 5].map((id) => `${chatId}-${id}`),
    );
    expect(result.history.attempts.every((attempt) => attempt.outcome === 'PENDING')).toBe(true);
    expect(result.history.attempts[0]?.target?.messageId).toBe('message-1');
    expect(JSON.stringify(result)).not.toContain('private-author');
    expect(await prisma.moderationDeleteIntent.count({ where: { chatId } })).toBe(5027);
    expect(result.history.nextCursor).toBeTruthy();
    const second = await service.read(chatId, false, { cursor: result.history.nextCursor });
    expect(second.history.attempts.map((attempt) => attempt.id)).toEqual(
      [6, 7, 8, 9, 10].map((id) => `${chatId}-${id}`),
    );
    await expect(
      service.read(otherChatId, false, { cursor: result.history.nextCursor }),
    ).rejects.toThrow();
  });

  it('uses the dedicated ordered projection and bounded exact-intent metadata lookups under skew', async () => {
    await service.read(chatId);
    expect(query).toBeDefined();
    const plan = await prisma.$queryRaw(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query!}`,
    );
    const serialized = JSON.stringify(plan);
    expect(serialized).toContain('duplicate_diagnostics_history_chat_created_id_idx');
    expect(serialized).toMatch(/moderation_delete_intent_reasons_(intent_reason_key|event_idx)/u);
    expect(serialized).toContain('moderation_events_chat_message_idx');
    expect(serialized).toContain('Limit');
    const nodes: Record<string, unknown>[] = [];
    const walk = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      const row = value as Record<string, unknown>;
      if (row['Node Type']) nodes.push(row);
      Object.values(row).forEach(walk);
    };
    walk(plan);
    const events = nodes.filter((node) => node['Relation Name'] === 'moderation_events');
    expect(events).toHaveLength(1);
    expect(Number(events[0]!['Actual Loops'])).toBeLessThanOrEqual(6);
    expect(
      Number(events[0]!['Actual Rows']) + Number(events[0]!['Rows Removed by Filter'] ?? 0),
    ).toBeLessThanOrEqual(32);
    expect(serialized).not.toContain('Seq Scan');
  });

  it('recovers legacy projection rows only after exact preview review and leaves all authority unchanged', async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        chatId,
        until: new Date(now).toISOString(),
        at: new Date(now - 1000).toISOString(),
        id: 'zz',
      }),
    ).toString('base64url');
    const args = [
      '--chat-id',
      chatId,
      '--until',
      new Date(now).toISOString(),
      '--limit',
      '100',
      '--cursor',
      cursor,
    ];
    const before = await prisma.moderationDeleteIntent.findMany({
      where: { chatId },
      select: { id: true, status: true, attemptCount: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });
    const preview = await runDuplicateDiagnosticsRecovery(prisma, args);
    expect(preview).toMatchObject({ preview: true, recoverableIntents: 1, inserted: 0 });
    expect(preview.scannedIntents).toBeLessThanOrEqual(100);
    await expect(
      runDuplicateDiagnosticsRecovery(prisma, [
        ...args,
        '--apply',
        '--expected-preview-sha',
        '0'.repeat(64),
      ]),
    ).rejects.toThrow('Preview changed');
    const applied = await runDuplicateDiagnosticsRecovery(prisma, [
      ...args,
      '--apply',
      '--expected-preview-sha',
      preview.previewSha256,
    ]);
    expect(applied.inserted).toBe(1);
    const registered = await prisma.duplicateDiagnosticsHistory.findUniqueOrThrow({
      where: { intentId: `${chatId}-legacy` },
    });
    const replay = await runDuplicateDiagnosticsRecovery(prisma, args);
    expect(replay.recoverableIntents).toBe(0);
    expect(
      (
        await prisma.duplicateDiagnosticsHistory.findUniqueOrThrow({
          where: { intentId: `${chatId}-legacy` },
        })
      ).registeredAt,
    ).toEqual(registered.registeredAt);
    expect(
      await prisma.moderationDeleteIntent.findMany({
        where: { chatId },
        select: { id: true, status: true, attemptCount: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before);
  });

  it('commits the canonical reason during a blocked observer write and restores the caller lock timeout', async () => {
    const intentId = `${chatId}-observer-lock`;
    await prisma.moderationDeleteIntent.create({
      data: {
        id: intentId,
        chatId,
        messageId: 'observer-lock',
        retryUntilAt: new Date(now + 3600000),
      },
    });
    let releaseLock!: () => void;
    let notifyLocked!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      notifyLocked = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`LOCK TABLE duplicate_diagnostics_history IN ACCESS EXCLUSIVE MODE`;
        notifyLocked();
        await released;
      },
      { timeout: 5000, maxWait: 1000 },
    );
    await locked;
    try {
      const restored = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '750ms'`;
          const before = await tx.$queryRaw`SHOW lock_timeout`;
          await tx.moderationDeleteIntentReason.create({
            data: {
              id: `${intentId}-reason`,
              intentId,
              reasonKey: 'duplicate',
              ruleCode: 'DUPLICATE_DELETE',
            },
          });
          const after = await tx.$queryRaw`SHOW lock_timeout`;
          return { before, after };
        },
        { timeout: 2500, maxWait: 1000 },
      );
      expect(restored.after).toEqual(restored.before);
    } finally {
      releaseLock();
      await blocker;
    }
    expect(await prisma.moderationDeleteIntentReason.count({ where: { intentId } })).toBe(1);
    expect(await prisma.duplicateDiagnosticsHistory.count({ where: { intentId } })).toBe(0);
  });
});
