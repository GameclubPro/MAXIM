import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MaxActionDispatchOptions, MaxClientService } from '../max/max-client.service';
import type { ManagedEntitiesService } from './managed-entities.service';
import { AdvertisingPlacementService } from './advertising-placement.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('Advertising placement PostgreSQL fences', () => {
  let prisma: PrismaClient;
  const chatId = `-${Date.now()}`;
  const listingId = randomUUID();
  const pilot = { userId: '323459159', username: null, displayName: null };
  const entities = { assertChatAdminAccess: jest.fn().mockResolvedValue(undefined) };
  const config = { get: () => 'a'.repeat(64) };
  let remoteCalls = 0;
  let beforeGuard: (() => Promise<void>) | null = null;
  const max = {
    sendMessage: async (
      _chat: string,
      _text: string,
      _body: unknown,
      options: MaxActionDispatchOptions,
    ) => {
      await beforeGuard?.();
      await options.beforeImmediateSendMutation?.();
      remoteCalls++;
      return { messageId: 'synthetic-receipt' };
    },
  };
  const service = () =>
    new AdvertisingPlacementService(
      prisma as unknown as PrismaService,
      entities as unknown as ManagedEntitiesService,
      max as unknown as MaxClientService,
      config as unknown as ConfigService,
    );

  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      !parsed.pathname.includes('race_test')
    )
      throw new Error('Advertising tests require a disposable local race_test database');
    prisma = createPrismaClient(databaseUrl, { max: 4 });
    await prisma.$connect();
  });
  beforeEach(async () => {
    remoteCalls = 0;
    beforeGuard = null;
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            listing: {
              id: listingId,
              chatId,
              title: 'Synthetic',
              url: `https://max.ru/id613000037577_3_bot?startapp=listing_${listingId}`,
            },
            connectUrl: `https://max.ru/id613000037577_3_bot?startapp=connect_chat_${chatId}`,
          }),
        ),
    );
    await prisma.advertisingPlacement.create({
      data: { chatId, enabled: true, listingId, revision: 1 },
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.advertisingPlacementSend.deleteMany({ where: { chatId } });
    await prisma.advertisingPlacement.deleteMany({ where: { chatId } });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('allows one sender across two instances sharing the same request ID', async () => {
    const input = { requestId: randomUUID(), revision: 1, previousSendId: null };
    await Promise.all([service().send(chatId, pilot, input), service().send(chatId, pilot, input)]);
    expect(remoteCalls).toBe(1);
    const row = await prisma.advertisingPlacementSend.findUniqueOrThrow({
      where: { id: input.requestId },
    });
    expect(row.status).toBe('SENT');
    expect(row.remoteMessageId).toBe('synthetic-receipt');
  });

  it('lets only one competing new request advance the last-send CAS', async () => {
    const results = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((requestId) =>
        service().send(chatId, pilot, { requestId, revision: 1, previousSendId: null }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(remoteCalls).toBe(1);
  });

  it('an explicit disable after claim stops the pending mutation', async () => {
    beforeGuard = async () => {
      await prisma.advertisingPlacement.update({
        where: { chatId },
        data: { enabled: false, revision: { increment: 1 } },
      });
    };
    expect(
      (
        await service().send(chatId, pilot, {
          requestId: randomUUID(),
          revision: 1,
          previousSendId: null,
        })
      ).status,
    ).toBe('FAILED');
    expect(remoteCalls).toBe(0);
  });

  it('SQL refuses enabled unbound settings and success without a receipt', async () => {
    await expect(
      prisma.advertisingPlacement.update({ where: { chatId }, data: { listingId: null } }),
    ).rejects.toThrow();
    await expect(
      prisma.advertisingPlacementSend.create({
        data: { id: randomUUID(), chatId, listingId, settingsRevision: 1, status: 'SENT' },
      }),
    ).rejects.toThrow();
  });
});
