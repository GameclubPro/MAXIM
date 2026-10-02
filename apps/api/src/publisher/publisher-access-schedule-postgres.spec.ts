import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import { PublisherAccessRefreshPolicy } from './publisher-access-refresh-policy';
import { PublisherBindingRefreshSchedulerService } from './publisher-binding-refresh-scheduler.service';
import { syncPublisherAdminRoster } from './publisher-admin-roster';
const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const integration = databaseUrl ? describe : describe.skip;

integration('Publisher durable access schedule on PostgreSQL', () => {
  let db: PrismaClient;
  let chatId: string;
  const botId = `schedule-${randomUUID()}`;
  const policy = new PublisherAccessRefreshPolicy(
    new ConfigService({ MAX_PUBLISHER_ACCESS_REFRESH_MODE: 'on' }),
  );
  const enqueue = jest.fn().mockResolvedValue('nomination');
  function scheduler() {
    return new PublisherBindingRefreshSchedulerService(
      db as never,
      { enqueue, compactScheduledBacklog: jest.fn() } as never,
      { getBotId: () => botId, getRequiredActionToken: jest.fn() } as never,
      { isGloballyPaused: async () => false } as never,
      { assertAttested: jest.fn() } as never,
      { dispatchEnabled: true } as never,
      { runExclusive: async (_key: string, work: () => Promise<void>) => work() } as never,
      { recoverHistoricalActorCandidates: jest.fn() } as never,
      policy,
    );
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('race_test'))
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 4, statement_timeout: 10000 }),
    });
    await db.$connect();
  });
  beforeEach(async () => {
    enqueue.mockClear();
    chatId = `schedule-${randomUUID()}`;
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Schedule fixture',
        publisherBinding: {
          create: {
            publisherBotId: botId,
            status: 'ACTIVE',
            botAccessState: 'CONFIRMED_ADMIN',
            botAccessCheckedAt: new Date(),
            botAccessExpiresAt: new Date(Date.now() + 900000),
            rosterRefreshAfter: new Date(0),
          },
        },
      },
    });
  });
  afterEach(async () => {
    await db.chat.deleteMany({ where: { publisherBinding: { is: { publisherBotId: botId } } } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  async function proof() {
    const binding = (await db.publisherEntityBinding.findUnique({ where: { chatId } }))!;
    return {
      prisma: db as never,
      maxClient: {} as never,
      chatId,
      publisherBotId: botId,
      entityType: 'CHAT' as const,
      probeStartedAt: new Date(),
      botAccessCheckedAt: binding.botAccessCheckedAt!,
      botAccessState: 'CONFIRMED_ADMIN' as const,
    };
  }
  const roster = (p: Awaited<ReturnType<typeof proof>>) => ({
    chatId,
    publisherBotId: botId,
    probeStartedAtMs: p.probeStartedAt.getTime(),
    members: [{ userId: 'admin', isBot: false, isAdmin: true, isOwner: false, permissions: [] }],
  });

  it('recovers a lost queue nomination after restart and stops scheduling after atomic success', async () => {
    await scheduler().scan('startup');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ chatId, reason: 'binding_maintenance' }),
    );
    enqueue.mockClear();
    await scheduler().scan('startup');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ chatId, reason: 'binding_maintenance' }),
    );
    const p = await proof();
    expect(await syncPublisherAdminRoster(p, roster(p))).toBe(true);
    const saved = (await db.publisherEntityBinding.findUnique({ where: { chatId } }))!;
    expect(saved.rosterCheckedAt).toEqual(p.probeStartedAt);
    expect(saved.rosterRefreshAfter!.getTime() - saved.rosterCheckedAt!.getTime()).toBe(1800000);
    enqueue.mockClear();
    await scheduler().scan('startup');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects an old roster after a lifecycle revocation and leaves all grants absent', async () => {
    const p = await proof();
    await db.publisherEntityBinding.update({
      where: { chatId },
      data: {
        status: 'REMOVED',
        lifecycleEventAt: new Date(p.probeStartedAt.getTime() + 1),
        lifecycleEventType: 'bot_removed',
      },
    });
    expect(await syncPublisherAdminRoster(p, roster(p))).toBe(false);
    expect(await db.managedEntityAccessEdge.count({ where: { chatId } })).toBe(0);
    expect(
      (await db.publisherEntityBinding.findUnique({ where: { chatId } }))!.rosterCheckedAt,
    ).toBeNull();
  });

  it('rolls back schedule metadata when an edge write fails inside the transaction', async () => {
    const p = await proof();
    const failing = {
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        db.$transaction((tx) =>
          fn({
            $queryRaw: tx.$queryRaw.bind(tx),
            publisherEntityBinding: tx.publisherEntityBinding,
            managedEntityAccessEdge: {
              updateMany: async () => {
                throw new Error('injected edge write failure');
              },
            },
          }),
        ),
    };
    await expect(
      syncPublisherAdminRoster({ ...p, prisma: failing as never }, roster(p)),
    ).rejects.toThrow('injected edge write failure');
    expect(
      (await db.publisherEntityBinding.findUnique({ where: { chatId } }))!.rosterCheckedAt,
    ).toBeNull();
    expect(await db.managedEntityAccessEdge.count({ where: { chatId } })).toBe(0);
  });

  it('loses a bot-proof race between the roster read and its SQL CAS without granting edges', async () => {
    const p = await proof();
    let signal!: () => void;
    let resume!: () => void;
    const read = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const changed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const racing = {
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        db.$transaction((tx) =>
          fn({
            $queryRaw: tx.$queryRaw.bind(tx),
            managedEntityAccessEdge: tx.managedEntityAccessEdge,
            publisherEntityBinding: {
              updateMany: tx.publisherEntityBinding.updateMany.bind(tx.publisherEntityBinding),
              findUnique: async () => {
                const original = await tx.publisherEntityBinding.findUnique({ where: { chatId } });
                signal();
                await changed;
                return original;
              },
            },
          }),
        ),
    };
    const result = syncPublisherAdminRoster({ ...p, prisma: racing as never }, roster(p));
    await read;
    try {
      await db.publisherEntityBinding.update({
        where: { chatId },
        data: {
          botAccessState: 'DENIED',
          botAccessCheckedAt: new Date(p.probeStartedAt.getTime() + 1),
        },
      });
    } finally {
      resume();
    }
    expect(await result).toBe(false);
    expect(await db.managedEntityAccessEdge.count({ where: { chatId } })).toBe(0);
    expect(
      (await db.publisherEntityBinding.findUnique({ where: { chatId } }))!.rosterCheckedAt,
    ).toBeNull();
  });

  it('orders by expiry and advances past a full page of still-pending bot checks', async () => {
    const prefix = `deadline-${randomUUID()}`;
    const due = Array.from({ length: 205 }, (_, index) => ({
      id: `${prefix}-${String(205 - index).padStart(3, '0')}`,
      title: 'Deadline fixture',
    }));
    await db.chat.createMany({ data: due });
    await db.publisherEntityBinding.createMany({
      data: due.map((chat, index) => ({
        chatId: chat.id,
        publisherBotId: botId,
        status: 'ACTIVE',
        botAccessState: 'CONFIRMED_ADMIN',
        botAccessCheckedAt: new Date(Date.now() - 1000000),
        botAccessExpiresAt: new Date(Date.now() - 500000 + index * 100),
        rosterRefreshAfter: new Date(Date.now() + 1800000),
      })),
    });
    const runner = scheduler();
    await runner.scan('startup');
    const first = enqueue.mock.calls
      .map(([job]) => job)
      .filter((job) => job.reason === 'scheduled_bot_access');
    expect(first.map((job) => job.chatId)).toEqual(due.slice(0, 200).map((chat) => chat.id));
    expect(first.every((job) => job.requiredBefore instanceof Date)).toBe(true);
    enqueue.mockClear();
    await runner.scan('scheduled');
    const next = enqueue.mock.calls
      .map(([job]) => job)
      .filter((job) => job.reason === 'scheduled_bot_access');
    expect(next.map((job) => job.chatId)).toEqual(due.slice(200).map((chat) => chat.id));
  });

  it('uses the reviewed expiry and roster index access paths', async () => {
    const plans = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      await tx.$executeRawUnsafe('SET LOCAL enable_sort = off');
      return Promise.all([
        tx.$queryRawUnsafe(
          `EXPLAIN SELECT chat_id FROM publisher_entity_bindings WHERE publisher_bot_id = $1 AND status = 'ACTIVE' AND bot_access_expires_at <= NOW() ORDER BY bot_access_expires_at, chat_id LIMIT 200`,
          botId,
        ),
        tx.$queryRawUnsafe(
          `EXPLAIN SELECT chat_id FROM publisher_entity_bindings WHERE publisher_bot_id = $1 AND status = 'ACTIVE' AND roster_refresh_after <= NOW() ORDER BY roster_refresh_after, chat_id LIMIT 25`,
          botId,
        ),
      ]);
    });
    expect(JSON.stringify(plans[0])).toContain('publisher_bindings_expiry_idx');
    expect(JSON.stringify(plans[1])).toContain('publisher_bindings_roster_due_idx');
  });
});
