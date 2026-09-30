import { randomUUID } from 'node:crypto';
import {
  PrismaClient,
  createPrismaAdapter,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import {
  PublisherDeliveryDeferredError,
  PublisherManagedBroadcastDispatch,
} from '../admin/publisher-managed-broadcast-dispatch';
import { PublisherReadinessService } from './publisher-readiness.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const integration = databaseUrl ? describe : describe.skip;

integration('Publisher publication authority on PostgreSQL', () => {
  let db: PrismaClient;
  let chatId: string;
  let actorId: string;
  let readiness: PublisherReadinessService;
  let dispatch: PublisherManagedBroadcastDispatch;
  const botId = `publisher-authority-${randomUUID()}`;
  const enqueue = jest.fn().mockResolvedValue('local-probe-nomination');

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    ) {
      throw new Error('Disposable local race_test database required');
    }
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 10_000 }),
    });
    await db.$connect();
    readiness = new PublisherReadinessService(
      db as never,
      {} as never,
      {
        get: (name: string) =>
          name === 'MAX_PUBLISHER_BOT_ID' ? botId : name === 'MAX_PUBLISHER_DISPATCH_ENABLED',
      } as never,
      { enqueue } as never,
    );
    dispatch = new PublisherManagedBroadcastDispatch(
      { prisma: db, publisherReadinessService: readiness } as never,
      { warn: jest.fn() } as never,
    );
  });

  beforeEach(async () => {
    enqueue.mockClear();
    chatId = `authority-${randomUUID()}`;
    actorId = `author-${randomUUID()}`;
    const now = new Date();
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Publication authority integration fixture',
        publisherBinding: {
          create: {
            publisherBotId: botId,
            status: 'ACTIVE',
            botAccessState: 'CONFIRMED_ADMIN',
            botAccessCheckedAt: now,
            botAccessExpiresAt: new Date(now.getTime() + 15 * 60_000),
          },
        },
      },
    });
  });

  afterEach(async () => {
    await db.chat.delete({ where: { id: chatId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  async function edge(options: {
    ageMinutes: number;
    state?: ManagedEntityAccessState;
    expiresAt?: Date | null;
    edgeBotId?: string;
  }) {
    return db.managedEntityAccessEdge.create({
      data: {
        chatId,
        userId: actorId,
        botId: options.edgeBotId ?? botId,
        state: options.state ?? ManagedEntityAccessState.GRANTED,
        userRole: options.state === ManagedEntityAccessState.USER_DENIED ? 'UNKNOWN' : 'ADMIN',
        botRole: 'ADMIN',
        checkedAt: new Date(Date.now() - options.ageMinutes * 60_000),
        expiresAt:
          options.expiresAt === undefined
            ? new Date(Date.now() + 3 * 24 * 60 * 60_000)
            : options.expiresAt,
        source: 'publisher_targeted_user_access',
        sourceVersion: `authority-proof-${randomUUID()}`,
      },
    });
  }

  const nominate = (maxAgeMs?: number) =>
    readiness.requestActorAccessRefresh(
      [{ chatId, entityType: 'chat' }],
      actorId,
      botId,
      maxAgeMs === undefined ? {} : { maxAgeMs },
    );
  const authorize = () =>
    dispatch.assertActorAdminAccess({
      targetChatIds: [chatId],
      actorUserId: actorId,
      entityType: 'chat',
      requiredBotId: botId,
    });

  it('requires an urgent targeted check for an old positive three-day grant without rewriting it', async () => {
    const original = await edge({ ageMinutes: 20 });
    await expect(authorize()).rejects.toBeInstanceOf(PublisherDeliveryDeferredError);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId,
        publisherBotId: botId,
        candidateUserId: actorId,
        candidateVersion: original.sourceVersion,
        reason: 'publication_actor_due',
      }),
    );
    expect(
      await db.managedEntityAccessEdge.findUniqueOrThrow({
        where: { chatId_userId_botId: { chatId, userId: actorId, botId } },
      }),
    ).toMatchObject({
      state: original.state,
      checkedAt: original.checkedAt,
      expiresAt: original.expiresAt,
      sourceVersion: original.sourceVersion,
    });
  });

  it('accepts a fresh exact Publisher grant without nominating another check', async () => {
    await edge({ ageMinutes: 1 });
    await expect(authorize()).resolves.toBeUndefined();
    await nominate();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'preserves fresh denial with legacy null expiry=%s',
    async (legacyNull) => {
      const original = await edge({
        ageMinutes: 10,
        state: ManagedEntityAccessState.USER_DENIED,
        expiresAt: legacyNull ? null : new Date(Date.now() + 15 * 60_000),
      });
      await expect(authorize()).rejects.toBeInstanceOf(PublisherDeliveryDeferredError);
      await nominate(9 * 60_000);
      expect(enqueue).not.toHaveBeenCalled();
      expect(
        await db.managedEntityAccessEdge.findUniqueOrThrow({
          where: { chatId_userId_botId: { chatId, userId: actorId, botId } },
        }),
      ).toMatchObject({
        state: 'USER_DENIED',
        checkedAt: original.checkedAt,
        expiresAt: original.expiresAt,
      });
    },
  );

  it('preflights a ten-minute-old null-expiry grant using the requested nine-minute age', async () => {
    await edge({ ageMinutes: 10, expiresAt: null });
    await nominate(9 * 60_000);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'publication_actor_due' }),
    );
  });

  it('never copies a foreign bot grant into Publisher authority', async () => {
    await edge({ ageMinutes: 1, edgeBotId: `foreign-${randomUUID()}` });
    await expect(authorize()).rejects.toBeInstanceOf(PublisherDeliveryDeferredError);
    expect(
      await db.managedEntityAccessEdge.findUniqueOrThrow({
        where: { chatId_userId_botId: { chatId, userId: actorId, botId } },
      }),
    ).toMatchObject({ state: 'BOT_DENIED', userRole: 'UNKNOWN', botRole: 'UNKNOWN' });
  });

  it.each(['removed', 'disabled'] as const)(
    'never authorizes a fresh grant after %s',
    async (change) => {
      const original = await edge({ ageMinutes: 1 });
      if (change === 'removed')
        await db.publisherEntityBinding.update({ where: { chatId }, data: { status: 'REMOVED' } });
      else
        await db.managedEntityPublicationPolicy.create({ data: { chatId, publikEnabled: false } });
      await expect(authorize()).rejects.toBeInstanceOf(PublisherDeliveryDeferredError);
      expect(enqueue).not.toHaveBeenCalled();
      expect(
        await db.managedEntityAccessEdge.findUniqueOrThrow({
          where: { chatId_userId_botId: { chatId, userId: actorId, botId } },
        }),
      ).toMatchObject({ state: original.state, checkedAt: original.checkedAt });
    },
  );
});
