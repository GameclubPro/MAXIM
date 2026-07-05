import {
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatCatalogKind,
  ChatEntityType,
} from '../prisma/prisma-client';
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
  title?: string;
  botId: string | null;
  primaryBotId: string | null;
  catalogKind?: ChatCatalogKind;
};

type MembershipRow = {
  chatId: string;
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  permissionsSnapshot?: unknown | null;
};

type LocalActivityRow = {
  chatId: string;
  botId: string | null;
  chatTitle?: string | null;
  lastEventAt: Date;
};

type WebhookSignalRow = {
  chatId: string;
  botId: string | null;
  chatTitle?: string | null;
  createdAt: Date;
};

function createPrismaMock(params: {
  chats: ChatRow[];
  memberships: MembershipRow[];
  localActivities?: LocalActivityRow[];
  webhookSignals?: WebhookSignalRow[];
}) {
  const chats = params.chats;
  const memberships = params.memberships;
  const localActivities = params.localActivities ?? [];
  const webhookSignals = params.webhookSignals ?? [];

  return {
    chat: {
      findMany: jest.fn(async () =>
        chats.map((chat) => ({
          id: chat.id,
          entityType: chat.entityType,
          title:
            chat.title ??
            (chat.entityType === ChatEntityType.CHANNEL ? `Channel ${chat.id}` : `Chat ${chat.id}`),
          botId: chat.botId,
          primaryBotId: chat.primaryBotId,
          catalogKind: chat.catalogKind ?? ChatCatalogKind.MANAGED,
        })),
      ),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<ChatRow> }) => {
          const row = chats.find((chat) => chat.id === where.id);
          if (!row) {
            throw new Error(`Chat ${where.id} not found`);
          }
          Object.assign(row, data);
          return row;
        },
      ),
    },
    chatBotMembership: {
      findMany: jest.fn(async () =>
        memberships.map((membership) => ({
          chatId: membership.chatId,
          botId: membership.botId,
          role: membership.role,
          status: membership.status,
          permissionsSnapshot: membership.permissionsSnapshot ?? null,
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
            permissionsSnapshot: create.permissionsSnapshot ?? null,
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
    managedEntityLocalActivity: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: {
            chatId: { in: string[] };
            botId?: { in: string[] };
            OR?: Array<{ botId?: { in: string[] }; chatTitle?: { not: null } }>;
          };
        }) => {
          const knownBotIds = new Set(
            where.botId?.in ?? where.OR?.flatMap((entry) => entry.botId?.in ?? []) ?? [],
          );
          return localActivities
            .filter((activity) => {
              if (!where.chatId.in.includes(activity.chatId)) {
                return false;
              }
              return (
                (activity.botId !== null && knownBotIds.has(activity.botId)) ||
                Boolean(activity.chatTitle?.trim())
              );
            })
            .slice()
            .sort((left, right) => {
              if (left.chatId !== right.chatId) {
                return left.chatId.localeCompare(right.chatId);
              }
              return right.lastEventAt.getTime() - left.lastEventAt.getTime();
            })
            .map((activity) => ({
              chatId: activity.chatId,
              botId: activity.botId,
              chatTitle: activity.chatTitle ?? null,
              lastEventAt: activity.lastEventAt,
            }));
        },
      ),
    },
    $queryRaw: jest.fn(async () =>
      webhookSignals.map((signal) => ({
        chat_id: signal.chatId,
        bot_id: signal.botId,
        chat_title: signal.chatTitle ?? null,
        created_at: signal.createdAt,
      })),
    ),
    $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
  };
}

function extractSqlText(arg: unknown): string {
  if (Array.isArray(arg)) {
    return arg.map((part) => extractSqlText(part)).join(' ');
  }

  if (arg && typeof arg === 'object' && 'strings' in arg) {
    const sqlArg = arg as { strings?: unknown; values?: unknown };
    const strings = sqlArg.strings;
    const values = sqlArg.values;
    const parts: string[] = [];
    if (Array.isArray(strings)) {
      parts.push(strings.map((part) => String(part)).join(' '));
    }
    if (Array.isArray(values)) {
      parts.push(values.map((part) => extractSqlText(part)).join(' '));
    }
    if (parts.length > 0) {
      return parts.filter(Boolean).join(' ');
    }
  }

  return String(arg);
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

async function runDeferredStartupSync() {
  await jest.advanceTimersByTimeAsync(1_000);
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

describe('MaxBotOwnershipFoundationService', () => {
  const originalAppRole = process.env.APP_ROLE;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-09T10:05:00.000Z'));
    redisStore.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
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
          catalogKind: ChatCatalogKind.MANAGED,
        },
        {
          id: 'channel-membership',
          entityType: ChatEntityType.CHANNEL,
          botId: null,
          primaryBotId: null,
          catalogKind: ChatCatalogKind.MANAGED,
        },
        {
          id: 'chat-ok',
          entityType: ChatEntityType.CHAT,
          botId: 'id613002203036_bot',
          primaryBotId: 'id613002203036_bot',
          catalogKind: ChatCatalogKind.MANAGED,
        },
        {
          id: 'chat-unknown-primary',
          entityType: ChatEntityType.CHAT,
          botId: null,
          primaryBotId: 'unknown_bot',
          catalogKind: ChatCatalogKind.MANAGED,
        },
        {
          id: 'chat-local-activity',
          entityType: ChatEntityType.CHAT,
          botId: null,
          primaryBotId: null,
          catalogKind: ChatCatalogKind.MANAGED,
        },
        {
          id: 'chat-webhook-signal',
          entityType: ChatEntityType.CHAT,
          title: 'Chat chat-webhook-signal',
          botId: null,
          primaryBotId: null,
          catalogKind: ChatCatalogKind.MANAGED,
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
      localActivities: [
        {
          chatId: 'chat-local-activity',
          botId: 'id613002203036_bot',
          lastEventAt: new Date('2026-03-31T10:00:00.000Z'),
        },
      ],
      webhookSignals: [
        {
          chatId: 'chat-webhook-signal',
          botId: 'id613002203036_4_bot',
          chatTitle: 'Webhook Real Chat',
          createdAt: new Date('2026-04-01T10:00:00.000Z'),
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
    expect(prisma.chat.update).not.toHaveBeenCalled();

    await runDeferredStartupSync();
    const snapshot = await service.getSnapshot(0);

    const webhookRepairSql = extractSqlText(prisma.$queryRaw.mock.calls[0]);
    expect(webhookRepairSql).toContain('WITH candidate_events AS');
    expect(webhookRepairSql).toContain('bot_id IN');
    expect(webhookRepairSql).toContain('created_at >= now() - interval');
    expect(webhookRepairSql).toContain("normalized_payload->'message'->>'chatId'");
    expect(webhookRepairSql).toContain("normalized_payload->>'chatId'");
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
    expect(prisma.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'chat-local-activity' },
        data: {
          primaryBotId: 'id613002203036_bot',
          botId: 'id613002203036_bot',
        },
      }),
    );
    expect(prisma.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'chat-webhook-signal' },
        data: {
          primaryBotId: 'id613002203036_4_bot',
          botId: 'id613002203036_4_bot',
          title: 'Webhook Real Chat',
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
      total: 6,
      withPrimary: 5,
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

  it('flags primary bots whose latest permissions snapshot no longer has admin access', async () => {
    process.env.APP_ROLE = 'admin';

    const prisma = createPrismaMock({
      chats: [
        {
          id: 'chat-no-access',
          entityType: ChatEntityType.CHAT,
          botId: 'id613002203036_bot',
          primaryBotId: 'id613002203036_bot',
          catalogKind: ChatCatalogKind.MANAGED,
        },
      ],
      memberships: [
        {
          chatId: 'chat-no-access',
          botId: 'id613002203036_bot',
          role: ChatBotMembershipRole.PRIMARY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            checkedAt: '2026-03-31T00:00:00.000Z',
            isAdmin: false,
            isOwner: false,
            permissions: [],
          },
        },
      ],
    });

    const service = new MaxBotOwnershipFoundationService(
      createConfigMock() as never,
      prisma as never,
      {
        getAllBots: jest.fn().mockReturnValue([{ id: 'id613002203036_bot', state: 'active' }]),
        getAdminVisibleBots: jest
          .fn()
          .mockReturnValue([{ id: 'id613002203036_bot', state: 'active' }]),
      } as never,
      {
        rememberChatBotBinding: jest.fn(),
      } as never,
    );

    await service.onModuleInit();
    await runDeferredStartupSync();
    const snapshot = await service.getSnapshot(0);

    expect(snapshot.anomalies).toMatchObject({
      primaryWithoutAdminAccess: 1,
      primaryWithoutActiveMembership: 0,
    });

    await service.onModuleDestroy();
  });

  it('excludes private and context-only chats from ownership coverage and unknown membership anomalies', async () => {
    process.env.APP_ROLE = 'admin';

    const prisma = createPrismaMock({
      chats: [
        {
          id: '-100-managed',
          entityType: ChatEntityType.CHAT,
          botId: 'id613002203036_bot',
          primaryBotId: 'id613002203036_bot',
          catalogKind: ChatCatalogKind.MANAGED,
        },
        {
          id: '214007512',
          entityType: ChatEntityType.CHAT,
          botId: null,
          primaryBotId: null,
          catalogKind: ChatCatalogKind.PRIVATE_DIRECT,
        },
        {
          id: '-100-context',
          entityType: ChatEntityType.CHAT,
          botId: null,
          primaryBotId: null,
          catalogKind: ChatCatalogKind.CONTEXT_ONLY,
        },
      ],
      memberships: [
        {
          chatId: '-100-managed',
          botId: 'id613002203036_bot',
          role: ChatBotMembershipRole.PRIMARY,
          status: ChatBotMembershipStatus.ACTIVE,
        },
        {
          chatId: '214007512',
          botId: 'unknown_bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
        },
        {
          chatId: '-100-context',
          botId: 'unknown_bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
        },
      ],
    });

    const service = new MaxBotOwnershipFoundationService(
      createConfigMock() as never,
      prisma as never,
      {
        getAllBots: jest.fn().mockReturnValue([{ id: 'id613002203036_bot', state: 'active' }]),
        getAdminVisibleBots: jest
          .fn()
          .mockReturnValue([{ id: 'id613002203036_bot', state: 'active' }]),
      } as never,
      {
        rememberChatBotBinding: jest.fn(),
      } as never,
    );

    await service.onModuleInit();
    await runDeferredStartupSync();
    const snapshot = await service.getSnapshot(0);

    expect(snapshot.entities.total).toMatchObject({
      total: 1,
      withPrimary: 1,
      withoutPrimary: 0,
    });
    expect(snapshot.anomalies).toMatchObject({
      activeMembershipBotUnknown: 0,
      noPrimary: 0,
      unbound: 0,
    });
    expect(prisma.chat.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '214007512' },
      }),
    );

    await service.onModuleDestroy();
  });

  it('repairs primary assignment to the active bot with stronger permissions', async () => {
    process.env.APP_ROLE = 'admin';

    const prisma = createPrismaMock({
      chats: [
        {
          id: 'chat-stronger-standby',
          entityType: ChatEntityType.CHAT,
          botId: 'id613002203036_bot',
          primaryBotId: 'id613002203036_bot',
          catalogKind: ChatCatalogKind.MANAGED,
        },
      ],
      memberships: [
        {
          chatId: 'chat-stronger-standby',
          botId: 'id613002203036_bot',
          role: ChatBotMembershipRole.PRIMARY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            checkedAt: '2026-05-09T10:00:00.000Z',
            isAdmin: true,
            isOwner: false,
            permissions: ['read_all_messages'],
          },
        },
        {
          chatId: 'chat-stronger-standby',
          botId: 'id613002203036_4_bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            checkedAt: '2026-05-09T10:00:01.000Z',
            isAdmin: true,
            isOwner: false,
            permissions: ['read_all_messages', 'delete_messages', 'add_remove_members'],
          },
        },
      ],
    });
    const maxBotLinkService = {
      rememberChatBotBinding: jest.fn(),
    };

    const service = new MaxBotOwnershipFoundationService(
      createConfigMock() as never,
      prisma as never,
      {
        getAllBots: jest.fn().mockReturnValue([
          { id: 'id613002203036_bot', state: 'active' },
          { id: 'id613002203036_4_bot', state: 'active' },
        ]),
        getAdminVisibleBots: jest.fn().mockReturnValue([
          { id: 'id613002203036_bot', state: 'active' },
          { id: 'id613002203036_4_bot', state: 'active' },
        ]),
      } as never,
      maxBotLinkService as never,
    );

    await service.onModuleInit();
    await runDeferredStartupSync();

    expect(prisma.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'chat-stronger-standby' },
        data: {
          primaryBotId: 'id613002203036_4_bot',
          botId: 'id613002203036_4_bot',
        },
      }),
    );
    expect(maxBotLinkService.rememberChatBotBinding).toHaveBeenCalledWith(
      'chat-stronger-standby',
      'id613002203036_4_bot',
    );

    await service.onModuleDestroy();
  });

  it('does not move primary to a stronger standby with a stale permissions snapshot', async () => {
    process.env.APP_ROLE = 'admin';

    const prisma = createPrismaMock({
      chats: [
        {
          id: 'chat-stale-standby',
          entityType: ChatEntityType.CHAT,
          botId: 'bot-primary',
          primaryBotId: 'bot-primary',
          catalogKind: ChatCatalogKind.MANAGED,
        },
      ],
      memberships: [
        {
          chatId: 'chat-stale-standby',
          botId: 'bot-primary',
          role: ChatBotMembershipRole.PRIMARY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            checkedAt: '2026-05-09T10:04:00.000Z',
            isAdmin: true,
            isOwner: false,
            permissions: ['read_all_messages'],
          },
        },
        {
          chatId: 'chat-stale-standby',
          botId: 'bot-stale-owner',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            checkedAt: '2026-05-07T10:00:00.000Z',
            isAdmin: true,
            isOwner: true,
            permissions: ['delete_messages', 'add_remove_members'],
          },
        },
        {
          chatId: 'chat-stale-standby',
          botId: 'bot-fresh-standby',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            checkedAt: '2026-05-09T10:04:30.000Z',
            isAdmin: true,
            isOwner: false,
            permissions: [],
          },
        },
      ],
    });
    const maxBotLinkService = {
      rememberChatBotBinding: jest.fn(),
    };

    const service = new MaxBotOwnershipFoundationService(
      createConfigMock() as never,
      prisma as never,
      {
        getAllBots: jest.fn().mockReturnValue([
          { id: 'bot-primary', state: 'active' },
          { id: 'bot-stale-owner', state: 'active' },
          { id: 'bot-fresh-standby', state: 'active' },
        ]),
        getAdminVisibleBots: jest.fn().mockReturnValue([
          { id: 'bot-primary', state: 'active' },
          { id: 'bot-stale-owner', state: 'active' },
          { id: 'bot-fresh-standby', state: 'active' },
        ]),
      } as never,
      maxBotLinkService as never,
    );

    await service.onModuleInit();
    await runDeferredStartupSync();

    expect(prisma.chat.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'chat-stale-standby' },
        data: expect.objectContaining({
          primaryBotId: 'bot-stale-owner',
        }),
      }),
    );
    expect(maxBotLinkService.rememberChatBotBinding).not.toHaveBeenCalledWith(
      'chat-stale-standby',
      'bot-stale-owner',
    );

    await service.onModuleDestroy();
  });
});
