import {
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '@prisma/client';
import { MaxBotOwnershipFoundationService } from './max-bot-ownership-foundation.service';

const redisStore = new Map<string, string>();

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
      const wantsNx = args.includes('NX');
      if (wantsNx && redisStore.has(key)) {
        return null;
      }
      redisStore.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => {
      redisStore.delete(key);
      return 1;
    }),
    quit: jest.fn().mockResolvedValue(undefined),
  })),
}));

type ChatRow = {
  id: string;
  entityType: ChatEntityType;
  botId: string | null;
  primaryBotId: string | null;
};

type MembershipRow = {
  chatId: string;
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
};

function createPrismaMock(params: {
  chats: ChatRow[];
  memberships: MembershipRow[];
}) {
  const chats = params.chats;
  const memberships = params.memberships;

  return {
    chat: {
      findMany: jest.fn(async () =>
        chats.map((chat) => ({
          id: chat.id,
          entityType: chat.entityType,
          botId: chat.botId,
          primaryBotId: chat.primaryBotId,
        })),
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<ChatRow> }) => {
        const row = chats.find((chat) => chat.id === where.id);
        if (!row) {
          throw new Error(`Chat ${where.id} not found`);
        }
        Object.assign(row, data);
        return row;
      }),
    },
    chatBotMembership: {
      findMany: jest.fn(async () =>
        memberships.map((membership) => ({
          chatId: membership.chatId,
          botId: membership.botId,
          role: membership.role,
          status: membership.status,
        })),
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { chatId_botId: { chatId: string; botId: string } };
          create: MembershipRow;
          update: Partial<MembershipRow>;
        }) => {
          const existing = memberships.find(
            (membership) =>
              membership.chatId === where.chatId_botId.chatId &&
              membership.botId === where.chatId_botId.botId,
          );
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          memberships.push({
            chatId: create.chatId,
            botId: create.botId,
            role: create.role,
            status: create.status,
          });
          return memberships[memberships.length - 1]!;
        },
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { chatId: string; botId?: { in: string[] }; status: ChatBotMembershipStatus };
          data: Partial<MembershipRow>;
        }) => {
          let count = 0;
          for (const membership of memberships) {
            if (membership.chatId !== where.chatId) {
              continue;
            }
            if (membership.status !== where.status) {
              continue;
            }
            if (where.botId?.in && !where.botId.in.includes(membership.botId)) {
              continue;
            }
            Object.assign(membership, data);
            count += 1;
          }
          return { count };
        },
      ),
    },
    $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
  };
}

function createConfigMock() {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'REDIS_URL') {
        return 'redis://localhost:6379/0';
      }
      throw new Error(`Missing key ${key}`);
    }),
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'BOT_OWNERSHIP_FOUNDATION_ENABLED') {
        return true;
      }
      if (key === 'BOT_OWNERSHIP_REPAIR_INTERVAL_MS') {
        return 300_000;
      }
      if (key === 'BOT_OWNERSHIP_REPAIR_LOCK_TTL_MS') {
        return 60_000;
      }
      if (key === 'BOT_OWNERSHIP_REPAIR_BATCH_SIZE') {
        return 250;
      }
      return fallback;
    }),
  };
}

describe('MaxBotOwnershipFoundationService', () => {
  const originalAppRole = process.env.APP_ROLE;

  beforeEach(() => {
    redisStore.clear();
  });

  afterEach(() => {
    if (originalAppRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalAppRole;
    }
  });

  it('repairs recoverable ownership gaps and exposes rollout blockers in the snapshot', async () => {
    process.env.APP_ROLE = 'admin';

    const prisma = createPrismaMock({
      chats: [
        {
          id: 'chat-legacy',
          entityType: ChatEntityType.CHAT,
          botId: 'id613002203036_bot',
          primaryBotId: null,
        },
        {
          id: 'channel-membership',
          entityType: ChatEntityType.CHANNEL,
          botId: null,
          primaryBotId: null,
        },
        {
          id: 'chat-ok',
          entityType: ChatEntityType.CHAT,
          botId: 'id613002203036_bot',
          primaryBotId: 'id613002203036_bot',
        },
        {
          id: 'chat-unknown-primary',
          entityType: ChatEntityType.CHAT,
          botId: null,
          primaryBotId: 'unknown_bot',
        },
      ],
      memberships: [
        {
          chatId: 'channel-membership',
          botId: 'id613002203036_bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
        },
        {
          chatId: 'chat-ok',
          botId: 'id613002203036_bot',
          role: ChatBotMembershipRole.PRIMARY,
          status: ChatBotMembershipStatus.ACTIVE,
        },
        {
          chatId: 'chat-unknown-primary',
          botId: 'id613002203036_bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
        },
      ],
    });
    const maxBotLinkService = {
      rememberChatBotBinding: jest.fn(),
    };
    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        { id: 'id613002203036_bot', state: 'active' },
        { id: 'id613002203036_4_bot', state: 'dormant' },
      ]),
      getAdminVisibleBots: jest.fn().mockReturnValue([
        { id: 'id613002203036_bot', state: 'active' },
        { id: 'id613002203036_4_bot', state: 'dormant' },
      ]),
    };

    const service = new MaxBotOwnershipFoundationService(
      createConfigMock() as never,
      prisma as never,
      botRegistry as never,
      maxBotLinkService as never,
    );

    await service.onModuleInit();
    const snapshot = await service.getSnapshot(0);

    expect(prisma.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'chat-legacy' },
        data: {
          primaryBotId: 'id613002203036_bot',
          botId: 'id613002203036_bot',
        },
      }),
    );
    expect(prisma.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'channel-membership' },
        data: {
          primaryBotId: 'id613002203036_bot',
          botId: 'id613002203036_bot',
        },
      }),
    );
    expect(maxBotLinkService.rememberChatBotBinding).toHaveBeenCalledWith(
      'chat-legacy',
      'id613002203036_bot',
    );
    expect(snapshot.bots).toMatchObject({
      configured: 2,
      active: 1,
      dormant: 1,
    });
    expect(snapshot.entities.total).toMatchObject({
      total: 4,
      withPrimary: 3,
      withoutPrimary: 1,
    });
    expect(snapshot.entities.channels).toMatchObject({
      total: 1,
      withPrimary: 1,
      withoutPrimary: 0,
    });
    expect(snapshot.anomalies).toMatchObject({
      noPrimary: 0,
      recoverableLegacyOnly: 0,
      recoverableFromMemberships: 0,
      unbound: 0,
      primaryBotUnknown: 1,
      primaryWithoutActiveMembership: 0,
    });
    expect(snapshot.repair.lastAppliedChanges).toBeGreaterThan(0);
    expect(snapshot.repair.lastSuccessAt).not.toBeNull();

    await service.onModuleDestroy();
  });
});
