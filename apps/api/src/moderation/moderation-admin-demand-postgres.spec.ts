import { randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { ModerationAccessService } from './moderation-access.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
(databaseUrl ? describe : describe.skip)('demand admin proof PostgreSQL fence', () => {
  let prisma: PrismaClient;
  const chatId = `admin-demand-${randomUUID()}`;
  const userId = 'former-admin';
  const old = new Date(Date.now() - 60_000);
  const sharedStates = new Map<string, 'granted' | 'user_denied'>();
  const shared = {
    getAdminAccessBatch: jest.fn(
      async (_chat: string, ids: string[]) =>
        new Map(ids.map((id) => [id, sharedStates.get(id) ?? null])),
    ),
    applyAdminAccessEpochMutation: jest.fn(
      async (input: { userId: string; state: 'granted' | 'user_denied' }) => {
        sharedStates.set(input.userId, input.state);
        return true;
      },
    ),
  };
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw Error('Disposable local PostgreSQL required');
    prisma = createPrismaClient(databaseUrl, { max: 4 });
    await prisma.chat.create({ data: { id: chatId, title: 'Admin demand fixture' } });
  });
  beforeEach(async () => {
    sharedStates.clear();
    jest.clearAllMocks();
    await prisma.managedEntityAccessEdge.deleteMany({ where: { chatId } });
    await prisma.managedEntityAdminMember.deleteMany({ where: { chatId } });
    await prisma.chatAdminAllowlist.upsert({
      where: { chatId_userId: { chatId, userId } },
      create: { chatId, userId, createdAt: old },
      update: { createdAt: old },
    });
  });
  afterAll(async () => {
    if (prisma) {
      await prisma.chat.deleteMany({ where: { id: chatId } });
      await prisma.$disconnect();
    }
  });
  function service(getChatMembersAccess: () => Promise<Map<string, unknown>>) {
    return new ModerationAccessService(
      prisma as never,
      { getChatMembersAccess } as never,
      shared as never,
    );
  }
  const check = (instance: ModerationAccessService) =>
    instance.resolveSenderChatAdminCheck(chatId, [userId], userId, {
      allowRemoteLookup: true,
      skipRemoteLookupWhenLocalAdminsKnown: true,
    });
  const roster = () => prisma.chatAdminAllowlist.count({ where: { chatId, userId } });
  it('removes confirmed former-admin immunity and informs another replica without erasing navigation', async () => {
    await prisma.managedEntityAccessEdge.create({
      data: {
        chatId,
        userId,
        botId: 'moderator',
        state: 'GRANTED',
        userRole: 'ADMIN',
        botRole: 'ADMIN',
        checkedAt: old,
      },
    });
    const lookup = jest.fn(async () => new Map());
    expect(await check(service(lookup))).toEqual({ isAdmin: false, source: 'remote' });
    expect(await roster()).toBe(0);
    const secondLookup = jest.fn(async () => new Map());
    expect(await check(service(secondLookup))).toEqual({ isAdmin: false, source: 'remote' });
    expect(secondLookup).not.toHaveBeenCalled();
    expect(await prisma.managedEntityAccessEdge.count({ where: { chatId, userId } })).toBe(1);
  });
  it.each(['edge', 'member', 'roster'] as const)(
    'protects a newer %s proof from an in-flight negative lookup',
    async (kind) => {
      const lookup = jest.fn(async () => {
        // The explicit timestamps deterministically model a newer proof committed during GET.
        const newer = new Date(Date.now() + 1000);
        if (kind === 'edge')
          await prisma.managedEntityAccessEdge.create({
            data: {
              chatId,
              userId,
              botId: 'moderator',
              state: 'GRANTED',
              userRole: 'ADMIN',
              botRole: 'ADMIN',
              checkedAt: newer,
            },
          });
        if (kind === 'member')
          await prisma.managedEntityAdminMember.create({
            data: {
              chatId,
              userId,
              observedByBotId: 'moderator',
              role: 'ADMIN',
              checkedAt: newer,
            },
          });
        if (kind === 'roster')
          await prisma.chatAdminAllowlist.update({
            where: { chatId_userId: { chatId, userId } },
            data: { createdAt: newer },
          });
        return new Map();
      });
      expect(await check(service(lookup))).toEqual({ isAdmin: true, source: 'local_fallback' });
      expect(await roster()).toBe(1);
      expect(shared.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    },
  );
  it('retains protection and the roster during MAX outage', async () => {
    const lookup = jest.fn(async () => {
      throw Object.assign(new Error('unavailable'), { response: { status: 503 } });
    });
    expect(await check(service(lookup))).toEqual({ isAdmin: true, source: 'local_fallback' });
    expect(await roster()).toBe(1);
    expect(shared.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });
});
