import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import {
  captureChannelPostDemand,
  claimChannelPostDemandChannels,
  claimChannelPostDemandItems,
  idleChannelPostDemand,
  persistChannelPostDemand,
  purgeExpiredChannelPostDemands,
  settleChannelPostDemand,
  type ChannelPostDemandInput,
} from './channel-post-demand';
import { WebhookParser } from '../webhook/webhook.parser';
import { WebhookService } from '../webhook/webhook.service';
import { ConfigService } from '@nestjs/config';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;
jest.setTimeout(45_000);

native('durable channel post demand in PostgreSQL', () => {
  let db: PrismaClient;
  const channels: string[] = [];
  const receipts: string[] = [];
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Only disposable local race_test PostgreSQL is permitted');
    db = createPrismaClient(databaseUrl, { max: 4 });
    const [clock] = await db.$queryRaw<
      { timezone: string }[]
    >`SELECT current_setting('TimeZone') AS timezone`;
    expect(clock?.timezone).toBe('UTC');
    expect(process.env.TZ).toBe('UTC');
  });
  afterEach(async () => {
    await db.webhookEvent.deleteMany({ where: { id: { in: receipts.splice(0) } } });
    await db.chat.deleteMany({ where: { id: { in: channels.splice(0) } } });
  });
  afterAll(async () => db?.$disconnect());
  async function channel() {
    const chatId = `-${Date.now()}${channels.length}${Math.floor(Math.random() * 1000)}`;
    channels.push(chatId);
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Disposable demand fixture',
        entityType: 'CHANNEL',
        channelSettings: {
          create: { postSignatureEnabled: true, updatedAt: new Date(Date.now() - 60_000) },
        },
      },
    });
    return chatId;
  }
  function input(chatId: string): ChannelPostDemandInput {
    return {
      chatId,
      messageId: randomUUID(),
      sourceAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    };
  }
  it('coalesces mirrors and preserves item and channel retry waits across a new client', async () => {
    const first = input(await channel());
    await Promise.all(Array.from({ length: 4 }, () => persistChannelPostDemand(db, first)));
    expect(await db.channelPostDemand.count()).toBe(1);
    await claimChannelPostDemandChannels(db, 1, 120_000);
    await claimChannelPostDemandItems(db, first.chatId, 1, 120_000);
    const before = await db.channelPostDemand.findMany();
    const channelBefore = await db.channelPostDemandChannel.findMany();
    const restarted = createPrismaClient(databaseUrl, { max: 1 });
    try {
      await persistChannelPostDemand(restarted, first);
    } finally {
      await restarted.$disconnect();
    }
    expect(await db.channelPostDemand.findMany()).toEqual(before);
    expect(await db.channelPostDemandChannel.findMany()).toEqual(channelBefore);
    expect(await claimChannelPostDemandChannels(db, 1, 30_000)).toEqual([]);
  });
  it('rotates channel and message attempts without settling an unfinished effect', async () => {
    const busy = await channel(),
      quiet = await channel();
    for (let i = 0; i < 12; i++) await persistChannelPostDemand(db, input(busy));
    await persistChannelPostDemand(db, input(quiet));
    const claimed = await Promise.all([
      claimChannelPostDemandChannels(db, 1, 30_000),
      claimChannelPostDemandChannels(db, 1, 30_000),
    ]);
    expect(new Set(claimed.flat().map((r) => r.chatId))).toEqual(new Set([busy, quiet]));
    const first = await claimChannelPostDemandItems(db, busy, 1, 30_000);
    const second = await claimChannelPostDemandItems(db, busy, 1, 30_000);
    expect(second[0]?.messageId).not.toBe(first[0]?.messageId);
    expect(await db.channelPostDemand.count({ where: { chatId: busy } })).toBe(12);
  });
  it('does not lose arrivals racing an empty-channel transition', async () => {
    const chatId = await channel();
    for (let i = 0; i < 12; i++) {
      const seed = input(chatId);
      await persistChannelPostDemand(db, seed);
      await settleChannelPostDemand(db, seed);
      const next = input(chatId);
      await Promise.all([
        db.$transaction((tx) => idleChannelPostDemand(tx, chatId)),
        persistChannelPostDemand(db, next),
      ]);
      expect(
        (await db.channelPostDemandChannel.findUniqueOrThrow({ where: { chatId } })).dueAt,
      ).not.toBeNull();
      expect(await db.channelPostDemand.count({ where: { chatId } })).toBe(1);
      await settleChannelPostDemand(db, next);
    }
  });
  it('keeps capture atomic with the receipt and excludes held creations', async () => {
    const chatId = await channel(),
      at = Date.now();
    const raw = {
      update_type: 'message_created',
      timestamp: at,
      message: {
        timestamp: at,
        recipient: { chat_id: chatId, chat_type: 'channel' },
        body: { mid: randomUUID(), text: 'Fixture' },
      },
    };
    const update = new WebhookParser().parse(raw);
    update.botId = 'fixture-moderator';
    expect(captureChannelPostDemand(update, 'publisher')).not.toBeNull();
    const ingress = new WebhookService(
      db as never,
      new ConfigService({ MAX_PUBLISHER_BOT_ID: 'publisher' }),
      {} as never,
    );
    const port = ingress as unknown as {
      persistReceipt: (u: typeof update, ip: null, r: Prisma.InputJsonValue) => Promise<string>;
    };
    try {
      Object.assign(ingress, {
        legacyHolds: { isUpdateHeld: async () => true, materializeReceipt: async () => 'HELD' },
      });
      receipts.push(await port.persistReceipt(update, null, raw));
      expect(await db.channelPostDemand.count()).toBe(0);
      update.updateId = randomUUID();
      Object.assign(ingress, {
        legacyHolds: { isUpdateHeld: async () => false },
        messageRetention: {
          captureInput: () => ({}),
          capture: async () => {
            throw new Error('fixture transaction failure');
          },
        },
      });
      await expect(port.persistReceipt(update, null, raw)).rejects.toThrow(
        'fixture transaction failure',
      );
      expect(await db.channelPostDemand.count()).toBe(0);
      expect(
        await db.webhookEvent.count({
          where: { botId: 'fixture-moderator', id: { notIn: receipts } },
        }),
      ).toBe(0);
      Object.assign(ingress, { messageRetention: undefined });
      receipts.push(await port.persistReceipt(update, null, raw));
      expect(await db.channelPostDemand.count()).toBe(1);
    } finally {
      await ingress.onModuleDestroy();
    }
  });
  it('bounds due selection and expiry against retained history and a hot channel', async () => {
    const chatId = await channel();
    await persistChannelPostDemand(db, input(chatId));
    await db.$executeRaw(Prisma.sql`INSERT INTO channel_post_demands (chat_id,message_id,source_at,expires_at,due_at)
      SELECT ${chatId}, 'history-' || n, NOW() AT TIME ZONE 'UTC',
        (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 day', (NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day'
      FROM generate_series(1,25000) n`);
    await db.$executeRawUnsafe('ANALYZE channel_post_demands');
    const captured: Prisma.Sql[] = [];
    const store = {
      $queryRaw: async (q: Prisma.Sql) => {
        captured.push(q);
        return [];
      },
      $executeRaw: async (q: Prisma.Sql) => {
        captured.push(q);
        return 0;
      },
    };
    await claimChannelPostDemandItems(store as never, chatId, 3, 30_000);
    await purgeExpiredChannelPostDemands(store as never);
    for (const [index, q] of captured.entries()) {
      const plan = await db.$queryRawUnsafe<unknown[]>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${q.text}`,
        ...q.values,
      );
      const text = JSON.stringify(plan);
      expect(text).toContain(
        index === 0 ? 'channel_post_demands_due_idx' : 'channel_post_demands_expiry_idx',
      );
      expect(text).not.toContain('Seq Scan');
    }
    expect(await db.channelPostDemand.count()).toBe(24501);
  });

  it('selects indexed due channels through idle history and skips a locked channel', async () => {
    const first = input(await channel()),
      second = input(await channel());
    await persistChannelPostDemand(db, first);
    await persistChannelPostDemand(db, second);
    const prefix = `demand-history-${randomUUID()}-`;
    const extra = Array.from({ length: 10_000 }, (_, n) => prefix + n);
    channels.push(...extra);
    await db.$executeRaw(Prisma.sql`INSERT INTO chats (id,title,entity_type,updated_at)
      SELECT ${prefix} || n, 'Disposable plan fixture', 'CHANNEL', NOW() AT TIME ZONE 'UTC' FROM generate_series(0,9999) n`);
    await db.$executeRaw(Prisma.sql`INSERT INTO channel_post_demand_channels (chat_id)
      SELECT id FROM chats WHERE id = ANY(${extra}::text[])`);
    await db.$executeRawUnsafe('ANALYZE channel_post_demand_channels');
    let query: Prisma.Sql | undefined;
    await claimChannelPostDemandChannels(
      {
        $queryRaw: async (q: Prisma.Sql) => {
          query = q;
          return [];
        },
      } as never,
      1,
      30_000,
    );
    const plan = await db.$queryRawUnsafe<unknown[]>(
      `EXPLAIN (FORMAT JSON) ${query!.text}`,
      ...query!.values,
    );
    expect(JSON.stringify(plan)).toContain('channel_post_demand_channels_due_idx');
    expect(JSON.stringify(plan)).not.toContain('Seq Scan');
    let unlock!: () => void, locked!: () => void;
    const barrier = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const owner = db.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT chat_id FROM channel_post_demand_channels WHERE chat_id = ${first.chatId} FOR UPDATE`,
        );
        locked();
        await hold;
      },
      { timeout: 5_000 },
    );
    try {
      await barrier;
      expect(await claimChannelPostDemandChannels(db, 1, 30_000)).toEqual([
        { chatId: second.chatId },
      ]);
    } finally {
      unlock();
      await owner;
    }
    expect(await claimChannelPostDemandChannels(db, 1, 30_000)).toEqual([{ chatId: first.chatId }]);
  });

  it.each(['module_off', 'before_settings', 'expired'] as const)(
    'does not persist %s demand',
    async (kind) => {
      const value = input(await channel());
      if (kind === 'module_off')
        await db.channelSettings.update({
          where: { chatId: value.chatId },
          data: {
            postSignatureEnabled: false,
            commentsEnabled: false,
            postSuggestionsEnabled: false,
            quickButtonsEnabled: false,
          },
        });
      if (kind === 'before_settings') value.sourceAt = new Date(Date.now() - 120_000);
      if (kind === 'expired') value.expiresAt = new Date(Date.now() - 1);
      await persistChannelPostDemand(db, value);
      expect(await db.channelPostDemand.count()).toBe(0);
      expect(await db.channelPostDemandChannel.count()).toBe(0);
    },
  );
});
