import {
  ChatBotAccessState,
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatCatalogKind,
  ChatEntityType,
  ChatRoutingState,
} from '../prisma/prisma-client';
import { resolveWeightedRendezvousOwnerBotId } from './max-bot-ownership-assignment.util';
import { MaxBotOwnershipFoundationService } from './max-bot-ownership-foundation.service';

const redisStore = new Map<string, string>();
const mockRedisEval = jest.fn(
  async (_script: string, numberOfKeys: number, key: string, token: string) => {
    if (numberOfKeys !== 1 || redisStore.get(key) !== token) {
      return 0;
    }
    redisStore.delete(key);
    return 1;
  },
);

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
    eval: mockRedisEval,
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
  routingState?: ChatRoutingState;
  routingVersion?: number;
};

type ChatUpdateData = Omit<Partial<ChatRow>, 'routingVersion'> & {
  routingVersion?: number | { increment: number };
};

type MembershipRow = {
  chatId: string;
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  botAccessState?: ChatBotAccessState;
  botAccessCheckedAt?: Date | null;
  botAccessExpiresAt?: Date | null;
  botAccessSource?: string | null;
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
    __state: { chats, memberships },
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
          routingState: chat.routingState ?? ChatRoutingState.READY,
          routingVersion: chat.routingVersion ?? 0,
        })),
      ),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; routingVersion?: number };
          data: ChatUpdateData;
        }) => {
          const row = chats.find((chat) => chat.id === where.id);
          if (!row) {
            throw new Error(`Chat ${where.id} not found`);
          }
          if (
            where.routingVersion !== undefined &&
            (row.routingVersion ?? 0) !== where.routingVersion
          ) {
            const error = new Error(`Chat ${where.id} routing version changed`);
            (error as Error & { code?: string }).code = 'P2025';
            throw error;
          }
          const { routingVersion, ...nextData } = data;
          Object.assign(row, nextData);
          if (typeof routingVersion === 'number') {
            row.routingVersion = routingVersion;
          } else if (routingVersion) {
            row.routingVersion = (row.routingVersion ?? 0) + Number(routingVersion.increment ?? 0);
          }
          return row;
        },
      ),
    },
    chatBotMembership: {
      findMany: jest.fn(async () =>
        memberships.map((membership) => {
          const snapshot =
            membership.permissionsSnapshot &&
            typeof membership.permissionsSnapshot === 'object' &&
            !Array.isArray(membership.permissionsSnapshot)
              ? (membership.permissionsSnapshot as Record<string, unknown>)
              : null;
          const inferredConfirmedState =
            snapshot?.isOwner === true
              ? ChatBotAccessState.CONFIRMED_OWNER
              : snapshot?.isAdmin === true
                ? ChatBotAccessState.CONFIRMED_ADMIN
                : ChatBotAccessState.UNKNOWN;
          const snapshotCheckedAt =
            typeof snapshot?.checkedAt === 'string' &&
            Number.isFinite(Date.parse(snapshot.checkedAt))
              ? new Date(snapshot.checkedAt)
              : null;
          return {
            chatId: membership.chatId,
            botId: membership.botId,
            role: membership.role,
            status: membership.status,
            botAccessState: membership.botAccessState ?? inferredConfirmedState,
            botAccessCheckedAt:
              membership.botAccessCheckedAt === undefined
                ? snapshotCheckedAt
                : membership.botAccessCheckedAt,
            botAccessExpiresAt:
              membership.botAccessExpiresAt ??
              (inferredConfirmedState === ChatBotAccessState.UNKNOWN
                ? null
                : new Date('2026-05-10T10:05:00.000Z')),
            botAccessSource:
              membership.botAccessSource === undefined &&
              (inferredConfirmedState === ChatBotAccessState.CONFIRMED_ADMIN ||
                inferredConfirmedState === ChatBotAccessState.CONFIRMED_OWNER)
                ? 'ownership_foundation_test'
                : (membership.botAccessSource ?? null),
            permissionsSnapshot: membership.permissionsSnapshot ?? null,
          };
        }),
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
            botAccessState: create.botAccessState,
            botAccessCheckedAt: create.botAccessCheckedAt,
            botAccessExpiresAt: create.botAccessExpiresAt,
            botAccessSource: create.botAccessSource,
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

function createMaxBotLinkMock(prisma: ReturnType<typeof createPrismaMock>) {
  const rememberChatBotBinding = jest.fn();
  const forgetChatBotBinding = jest.fn();
  const selectChatPrimaryBot = jest.fn(
    async ({
      chatId,
      botId,
      title,
      entityType,
      expectedRoutingVersion,
      expectedAccessEpoch,
    }: {
      chatId: string;
      botId: string;
      title?: string | null;
      entityType?: ChatEntityType | null;
      expectedRoutingVersion?: number;
      expectedAccessEpoch?: { checkedAt: Date; source: string };
    }) => {
      const chat = prisma.__state.chats.find((candidate) => candidate.id === chatId) ?? null;
      if (!chat || (chat.routingVersion ?? 0) !== expectedRoutingVersion) {
        return false;
      }
      const membership = prisma.__state.memberships.find(
        (candidate) =>
          candidate.chatId === chatId &&
          candidate.botId === botId &&
          candidate.status === ChatBotMembershipStatus.ACTIVE,
      );
      const snapshot =
        membership?.permissionsSnapshot &&
        typeof membership.permissionsSnapshot === 'object' &&
        !Array.isArray(membership.permissionsSnapshot)
          ? (membership.permissionsSnapshot as Record<string, unknown>)
          : null;
      const confirmed =
        membership?.botAccessState === ChatBotAccessState.CONFIRMED_ADMIN ||
        membership?.botAccessState === ChatBotAccessState.CONFIRMED_OWNER ||
        snapshot?.isAdmin === true ||
        snapshot?.isOwner === true;
      const snapshotCheckedAt =
        typeof snapshot?.checkedAt === 'string' && Number.isFinite(Date.parse(snapshot.checkedAt))
          ? new Date(snapshot.checkedAt)
          : null;
      const currentCheckedAt = membership?.botAccessCheckedAt ?? snapshotCheckedAt;
      const currentSource =
        membership?.botAccessSource ?? (confirmed ? 'ownership_foundation_test' : null);
      if (
        !membership ||
        !confirmed ||
        (expectedAccessEpoch &&
          (currentCheckedAt?.getTime() !== expectedAccessEpoch.checkedAt.getTime() ||
            currentSource !== expectedAccessEpoch.source))
      ) {
        return false;
      }

      const routingChanged =
        chat.botId !== botId ||
        chat.primaryBotId !== botId ||
        chat.routingState === ChatRoutingState.NO_ELIGIBLE_BOT ||
        prisma.__state.memberships.some(
          (candidate) =>
            candidate.chatId === chatId &&
            (candidate.botId === botId
              ? candidate.role !== ChatBotMembershipRole.PRIMARY
              : candidate.role === ChatBotMembershipRole.PRIMARY),
        );
      for (const candidate of prisma.__state.memberships) {
        if (candidate.chatId === chatId) {
          candidate.role =
            candidate === membership
              ? ChatBotMembershipRole.PRIMARY
              : ChatBotMembershipRole.STANDBY;
        }
      }
      chat.botId = botId;
      chat.primaryBotId = botId;
      chat.routingState = ChatRoutingState.READY;
      if (title?.trim()) {
        chat.title = title.trim();
      }
      if (entityType) {
        chat.entityType = entityType;
      }
      if (routingChanged) {
        chat.routingVersion = (chat.routingVersion ?? 0) + 1;
      }
      rememberChatBotBinding(chatId, botId);
      return true;
    },
  );
  const reconcileChatRoutingState = jest.fn(async ({ chatId }: { chatId: string }) => {
    const chat = prisma.__state.chats.find((candidate) => candidate.id === chatId) ?? null;
    if (!chat) {
      return null;
    }
    const activeConfirmed = prisma.__state.memberships.filter((membership) => {
      if (
        membership.chatId !== chatId ||
        membership.status !== ChatBotMembershipStatus.ACTIVE ||
        membership.botAccessState === ChatBotAccessState.DENIED ||
        membership.botAccessState === ChatBotAccessState.LOST
      ) {
        return false;
      }
      const snapshot =
        membership.permissionsSnapshot &&
        typeof membership.permissionsSnapshot === 'object' &&
        !Array.isArray(membership.permissionsSnapshot)
          ? (membership.permissionsSnapshot as Record<string, unknown>)
          : null;
      return (
        membership.botAccessState === ChatBotAccessState.CONFIRMED_ADMIN ||
        membership.botAccessState === ChatBotAccessState.CONFIRMED_OWNER ||
        snapshot?.isAdmin === true ||
        snapshot?.isOwner === true
      );
    });
    const nextPrimary =
      activeConfirmed.find((membership) => membership.botId === chat.primaryBotId) ??
      activeConfirmed.find((membership) => membership.role === ChatBotMembershipRole.PRIMARY) ??
      activeConfirmed[0] ??
      null;
    const nextPrimaryBotId = nextPrimary?.botId ?? null;
    const nextRoutingState = nextPrimary
      ? ChatRoutingState.READY
      : ChatRoutingState.NO_ELIGIBLE_BOT;
    const changed =
      chat.botId !== nextPrimaryBotId ||
      chat.primaryBotId !== nextPrimaryBotId ||
      (chat.routingState ?? ChatRoutingState.READY) !== nextRoutingState ||
      prisma.__state.memberships.some(
        (membership) =>
          membership.chatId === chatId &&
          (membership === nextPrimary
            ? membership.role !== ChatBotMembershipRole.PRIMARY
            : membership.role === ChatBotMembershipRole.PRIMARY),
      );
    if (changed) {
      chat.botId = nextPrimaryBotId;
      chat.primaryBotId = nextPrimaryBotId;
      chat.routingState = nextRoutingState;
      chat.routingVersion = (chat.routingVersion ?? 0) + 1;
      for (const membership of prisma.__state.memberships) {
        if (membership.chatId === chatId) {
          membership.role =
            membership === nextPrimary
              ? ChatBotMembershipRole.PRIMARY
              : ChatBotMembershipRole.STANDBY;
        }
      }
    }
    if (nextPrimaryBotId) {
      rememberChatBotBinding(chatId, nextPrimaryBotId);
    } else {
      forgetChatBotBinding(chatId);
    }
    return { routingState: nextRoutingState, changed };
  });

  return {
    rememberChatBotBinding,
    forgetChatBotBinding,
    selectChatPrimaryBot,
    reconcileChatRoutingState,
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

function createConfigMock(overrides: Record<string, unknown> = {}) {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'REDIS_URL') {
        return 'redis://localhost:6379/0';
      }
      throw new Error(`Missing key ${key}`);
    }),
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key in overrides) {
        return overrides[key];
      }
      if (key === 'BOT_OWNERSHIP_REBALANCE_MODE') {
        return 'on';
      }
      if (key === 'BOT_OWNERSHIP_FOUNDATION_ENABLED') {
        return true;
      }
      if (key === 'BOT_OWNERSHIP_REPAIR_RUNNER_ENABLED') {
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
    mockRedisEval.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalAppRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalAppRole;
    }
  });

  it('keeps the global ownership repair runner disabled unless explicitly enabled', async () => {
    process.env.APP_ROLE = 'admin';
    const prisma = createPrismaMock({ chats: [], memberships: [] });
    const service = new MaxBotOwnershipFoundationService(
      createConfigMock({ BOT_OWNERSHIP_REPAIR_RUNNER_ENABLED: false }) as never,
      prisma as never,
      {
        getAllBots: jest.fn().mockReturnValue([]),
        getAdminVisibleBots: jest.fn().mockReturnValue([]),
      } as never,
      {} as never,
    );

    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    const snapshot = await service.getSnapshot(0);

    expect(prisma.chat.findMany).not.toHaveBeenCalled();
    expect(prisma.chatBotMembership.findMany).not.toHaveBeenCalled();
    expect(prisma.managedEntityLocalActivity.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(snapshot.repair).toMatchObject({
      enabled: false,
      activeOnThisRole: false,
    });

    await service.onModuleDestroy();
  });

  it('does not release a repair lock reacquired after the prior token expires', async () => {
    const prisma = createPrismaMock({ chats: [], memberships: [] });
    const service = new MaxBotOwnershipFoundationService(
      createConfigMock() as never,
      prisma as never,
      { getAllBots: jest.fn().mockReturnValue([]) } as never,
      {} as never,
    );
    const lockMethods = service as unknown as {
      acquireRepairLock: () => Promise<string | null>;
      releaseRepairLock: (token: string) => Promise<void>;
    };
    const lockKey = 'system:bot-ownership:foundation:repair-lock:v1';

    const expiredToken = await lockMethods.acquireRepairLock();
    expect(expiredToken).not.toBeNull();
    redisStore.delete(lockKey);
    const reacquiredToken = await lockMethods.acquireRepairLock();
    expect(reacquiredToken).not.toBeNull();
    expect(reacquiredToken).not.toBe(expiredToken);

    await lockMethods.releaseRepairLock(expiredToken!);

    expect(redisStore.get(lockKey)).toBe(reacquiredToken);
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("get", KEYS[1])'),
      1,
      lockKey,
      expiredToken,
    );

    await service.onModuleDestroy();
  });

  it('marks a cached ownership snapshot inactive without rebuilding it when repair is disabled', async () => {
    process.env.APP_ROLE = 'admin';
    const prisma = createPrismaMock({ chats: [], memberships: [] });
    const service = new MaxBotOwnershipFoundationService(
      createConfigMock({ BOT_OWNERSHIP_REPAIR_RUNNER_ENABLED: false }) as never,
      prisma as never,
      {
        getAllBots: jest.fn().mockReturnValue([]),
        getAdminVisibleBots: jest.fn().mockReturnValue([]),
      } as never,
      {} as never,
    );
    const staleSnapshot = (
      service as unknown as {
        createFallbackSnapshot: (lastError: string | null) => {
          repair: { enabled: boolean; activeOnThisRole: boolean };
        };
      }
    ).createFallbackSnapshot(null);
    staleSnapshot.repair.enabled = true;
    staleSnapshot.repair.activeOnThisRole = true;
    redisStore.set('system:bot-ownership:foundation:v1', JSON.stringify(staleSnapshot));

    const snapshot = await service.getSnapshot(0);

    expect(prisma.chat.findMany).not.toHaveBeenCalled();
    expect(prisma.chatBotMembership.findMany).not.toHaveBeenCalled();
    expect(snapshot.repair).toMatchObject({
      enabled: false,
      activeOnThisRole: false,
    });

    await service.onModuleDestroy();
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
          id: 'chat-ineligible-primary',
          entityType: ChatEntityType.CHAT,
          botId: 'id613002203036_bot',
          primaryBotId: 'id613002203036_4_bot',
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
          permissionsSnapshot: {
            checkedAt: '2026-05-09T10:04:00.000Z',
            isAdmin: true,
            isOwner: false,
            permissions: ['write'],
          },
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
          permissionsSnapshot: {
            checkedAt: '2026-05-09T10:04:00.000Z',
            isAdmin: true,
            isOwner: false,
            permissions: ['write'],
          },
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
    const maxBotLinkService = createMaxBotLinkMock(prisma);
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
    expect(webhookRepairSql).toContain('FROM unnest(ARRAY');
    expect(webhookRepairSql).toContain('JOIN LATERAL');
    expect(webhookRepairSql).toContain('selected_bot');
    expect(webhookRepairSql).toContain('webhook_events.bot_id = selected_bot.bot_id');
    expect(webhookRepairSql).toContain('created_at >= now() - interval');
    expect(webhookRepairSql).toContain("normalized_payload->'message'->>'chatId'");
    expect(webhookRepairSql).toContain("normalized_payload->>'chatId'");
    expect(webhookRepairSql).toContain('LIMIT 1');
    expect(maxBotLinkService.selectChatPrimaryBot).not.toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-legacy' }),
    );
    expect(maxBotLinkService.selectChatPrimaryBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-membership',
        botId: 'id613002203036_bot',
        expectedRoutingVersion: 0,
      }),
    );
    expect(maxBotLinkService.selectChatPrimaryBot).not.toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-local-activity' }),
    );
    expect(maxBotLinkService.selectChatPrimaryBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-unknown-primary',
        botId: 'id613002203036_bot',
        expectedRoutingVersion: 0,
      }),
    );
    expect(maxBotLinkService.reconcileChatRoutingState).toHaveBeenCalledWith({
      chatId: 'chat-ineligible-primary',
    });
    expect(
      prisma.__state.chats.find((chat) => chat.id === 'chat-ineligible-primary'),
    ).toMatchObject({
      primaryBotId: null,
      botId: null,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
    });
    expect(prisma.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'chat-webhook-signal' }),
        data: expect.objectContaining({
          title: 'Webhook Real Chat',
        }),
      }),
    );
    expect(maxBotLinkService.rememberChatBotBinding).not.toHaveBeenCalledWith(
      'chat-legacy',
      expect.any(String),
    );
    expect(prisma.chatBotMembership.upsert).not.toHaveBeenCalled();
    expect(snapshot.bots).toMatchObject({
      configured: 2,
      active: 1,
      dormant: 1,
    });
    expect(snapshot.entities.total).toMatchObject({
      total: 7,
      withPrimary: 3,
      withoutPrimary: 4,
    });
    expect(snapshot.entities.channels).toMatchObject({
      total: 1,
      withPrimary: 1,
      withoutPrimary: 0,
    });
    expect(snapshot.anomalies).toMatchObject({
      noPrimary: 4,
      recoverableLegacyOnly: 0,
      recoverableFromMemberships: 0,
      noEligibleBot: 4,
      unbound: 4,
      primaryBotUnknown: 0,
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

    const maxBotLinkService = createMaxBotLinkMock(prisma);
    const service = new MaxBotOwnershipFoundationService(
      createConfigMock() as never,
      prisma as never,
      {
        getAllBots: jest.fn().mockReturnValue([{ id: 'id613002203036_bot', state: 'active' }]),
        getAdminVisibleBots: jest
          .fn()
          .mockReturnValue([{ id: 'id613002203036_bot', state: 'active' }]),
      } as never,
      maxBotLinkService as never,
    );

    await service.onModuleInit();
    await runDeferredStartupSync();
    const snapshot = await service.getSnapshot(0);

    expect(prisma.chat.update).not.toHaveBeenCalled();
    expect(maxBotLinkService.forgetChatBotBinding).not.toHaveBeenCalled();
    expect(snapshot.anomalies).toMatchObject({
      noPrimary: 0,
      noEligibleBot: 1,
      unbound: 0,
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
      createMaxBotLinkMock(prisma) as never,
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
        where: expect.objectContaining({ id: '214007512' }),
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
    const maxBotLinkService = createMaxBotLinkMock(prisma);

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

    expect(maxBotLinkService.selectChatPrimaryBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-stronger-standby',
        botId: 'id613002203036_4_bot',
        expectedRoutingVersion: 0,
      }),
    );
    expect(prisma.__state.chats[0]).toMatchObject({
      primaryBotId: 'id613002203036_4_bot',
      botId: 'id613002203036_4_bot',
      routingVersion: 1,
    });
    expect(maxBotLinkService.rememberChatBotBinding).toHaveBeenCalledWith(
      'chat-stronger-standby',
      'id613002203036_4_bot',
    );

    await service.onModuleDestroy();
  });

  it('repairs primary assignment away from an explicit denied stored primary', async () => {
    process.env.APP_ROLE = 'admin';

    const prisma = createPrismaMock({
      chats: [
        {
          id: 'chat-denied-primary-repair',
          entityType: ChatEntityType.CHAT,
          botId: 'id613002203036_bot',
          primaryBotId: 'id613002203036_bot',
          catalogKind: ChatCatalogKind.MANAGED,
        },
      ],
      memberships: [
        {
          chatId: 'chat-denied-primary-repair',
          botId: 'id613002203036_bot',
          role: ChatBotMembershipRole.PRIMARY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            checkedAt: '2026-05-09T10:04:00.000Z',
            isAdmin: false,
            isOwner: false,
            permissions: [],
          },
        },
        {
          chatId: 'chat-denied-primary-repair',
          botId: 'id613002203036_4_bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            checkedAt: '2026-05-09T10:04:01.000Z',
            isAdmin: true,
            isOwner: false,
            permissions: ['read_all_messages', 'delete_messages', 'add_remove_members'],
          },
        },
      ],
    });
    const maxBotLinkService = createMaxBotLinkMock(prisma);

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

    expect(maxBotLinkService.selectChatPrimaryBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-denied-primary-repair',
        botId: 'id613002203036_4_bot',
        expectedRoutingVersion: 0,
      }),
    );
    expect(prisma.__state.chats[0]).toMatchObject({
      primaryBotId: 'id613002203036_4_bot',
      botId: 'id613002203036_4_bot',
      routingVersion: 1,
    });
    expect(maxBotLinkService.rememberChatBotBinding).toHaveBeenCalledWith(
      'chat-denied-primary-repair',
      'id613002203036_4_bot',
    );

    await service.onModuleDestroy();
  });

  it('never reactivates a removed membership while repairing a route gap', async () => {
    process.env.APP_ROLE = 'admin';

    const prisma = createPrismaMock({
      chats: [
        {
          id: 'chat-removed-primary',
          entityType: ChatEntityType.CHAT,
          botId: 'id613002203036_bot',
          primaryBotId: 'id613002203036_bot',
          catalogKind: ChatCatalogKind.MANAGED,
        },
      ],
      memberships: [
        {
          chatId: 'chat-removed-primary',
          botId: 'id613002203036_bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.REMOVED,
        },
      ],
    });
    const maxBotLinkService = createMaxBotLinkMock(prisma);

    const service = new MaxBotOwnershipFoundationService(
      createConfigMock() as never,
      prisma as never,
      {
        getAllBots: jest.fn().mockReturnValue([{ id: 'id613002203036_bot', state: 'active' }]),
        getAdminVisibleBots: jest
          .fn()
          .mockReturnValue([{ id: 'id613002203036_bot', state: 'active' }]),
      } as never,
      maxBotLinkService as never,
    );

    await service.onModuleInit();
    await runDeferredStartupSync();

    expect(maxBotLinkService.reconcileChatRoutingState).toHaveBeenCalledWith({
      chatId: 'chat-removed-primary',
    });
    expect(prisma.__state.chats[0]).toMatchObject({
      primaryBotId: null,
      botId: null,
      routingVersion: 1,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
    });
    expect(prisma.chatBotMembership.upsert).not.toHaveBeenCalled();
    expect(maxBotLinkService.rememberChatBotBinding).not.toHaveBeenCalled();
    expect(maxBotLinkService.forgetChatBotBinding).toHaveBeenCalledWith('chat-removed-primary');

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
    const maxBotLinkService = createMaxBotLinkMock(prisma);
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
        where: expect.objectContaining({ id: 'chat-stale-standby' }),
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

  it('reports deterministic ownership moves in shadow mode without changing primary', async () => {
    process.env.APP_ROLE = 'admin';
    const candidates = ['bot-1', 'bot-2'].map((botId) => ({
      botId,
      membershipStatus: ChatBotMembershipStatus.ACTIVE,
      lifecycleState: 'active' as const,
      capabilityEligible: true,
      ownershipWeight: 1,
      permissionsSnapshot: {
        checkedAt: '2026-05-09T10:04:00.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      },
    }));
    const chatId = Array.from({ length: 100 }, (_, index) => `shadow-chat-${index}`).find(
      (candidateChatId) =>
        resolveWeightedRendezvousOwnerBotId(candidateChatId, candidates) === 'bot-2',
    )!;
    const prisma = createPrismaMock({
      chats: [
        {
          id: chatId,
          entityType: ChatEntityType.CHAT,
          botId: 'bot-1',
          primaryBotId: 'bot-1',
          catalogKind: ChatCatalogKind.MANAGED,
        },
      ],
      memberships: candidates.map((candidate, index) => ({
        chatId,
        botId: candidate.botId,
        role: index === 0 ? ChatBotMembershipRole.PRIMARY : ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: candidate.permissionsSnapshot,
      })),
    });
    const bots = candidates.map((candidate) => ({
      id: candidate.botId,
      state: 'active',
      ownershipWeight: 1,
    }));
    const maxBotLinkService = createMaxBotLinkMock(prisma);
    const service = new MaxBotOwnershipFoundationService(
      createConfigMock({ BOT_OWNERSHIP_REBALANCE_MODE: 'shadow' }) as never,
      prisma as never,
      { getAllBots: jest.fn().mockReturnValue(bots) } as never,
      maxBotLinkService as never,
    );

    await service.onModuleInit();
    await runDeferredStartupSync();
    const snapshot = await service.getSnapshot(0);

    expect(prisma.chat.update).not.toHaveBeenCalled();
    expect(snapshot.repair).toMatchObject({
      rebalanceMode: 'shadow',
      recommendedMoves: 1,
      lastAppliedMoves: 0,
    });

    await service.onModuleDestroy();
  });

  it('does not mutate persistent routing state in shadow mode', async () => {
    process.env.APP_ROLE = 'admin';
    const prisma = createPrismaMock({
      chats: [
        {
          id: 'shadow-routing-state',
          entityType: ChatEntityType.CHAT,
          botId: 'bot-1',
          primaryBotId: 'bot-1',
          catalogKind: ChatCatalogKind.MANAGED,
          routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
        },
      ],
      memberships: [
        {
          chatId: 'shadow-routing-state',
          botId: 'bot-1',
          role: ChatBotMembershipRole.PRIMARY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            checkedAt: '2026-05-09T10:04:00.000Z',
            isAdmin: true,
            isOwner: false,
            permissions: ['write'],
          },
        },
      ],
    });
    const maxBotLinkService = createMaxBotLinkMock(prisma);
    const service = new MaxBotOwnershipFoundationService(
      createConfigMock({ BOT_OWNERSHIP_REBALANCE_MODE: 'shadow' }) as never,
      prisma as never,
      {
        getAllBots: jest
          .fn()
          .mockReturnValue([{ id: 'bot-1', state: 'active', ownershipWeight: 1 }]),
      } as never,
      maxBotLinkService as never,
    );

    await service.onModuleInit();
    await runDeferredStartupSync();
    const snapshot = await service.getSnapshot(0);

    expect(prisma.chat.update).not.toHaveBeenCalled();
    expect(maxBotLinkService.reconcileChatRoutingState).not.toHaveBeenCalled();
    expect(snapshot.routingStates).toEqual({ ready: 0, noEligibleBot: 1 });

    await service.onModuleDestroy();
  });

  it('applies bounded deterministic ownership moves when rebalance is on', async () => {
    process.env.APP_ROLE = 'admin';
    const permissionsSnapshot = {
      checkedAt: '2026-05-09T10:04:00.000Z',
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    };
    const candidates = ['bot-1', 'bot-2'].map((botId) => ({
      botId,
      membershipStatus: ChatBotMembershipStatus.ACTIVE,
      lifecycleState: 'active' as const,
      capabilityEligible: true,
      ownershipWeight: 1,
      permissionsSnapshot,
    }));
    const chatId = Array.from({ length: 100 }, (_, index) => `active-chat-${index}`).find(
      (candidateChatId) =>
        resolveWeightedRendezvousOwnerBotId(candidateChatId, candidates) === 'bot-2',
    )!;
    const prisma = createPrismaMock({
      chats: [
        {
          id: chatId,
          entityType: ChatEntityType.CHAT,
          botId: 'bot-1',
          primaryBotId: 'bot-1',
          catalogKind: ChatCatalogKind.MANAGED,
        },
      ],
      memberships: candidates.map((candidate, index) => ({
        chatId,
        botId: candidate.botId,
        role: index === 0 ? ChatBotMembershipRole.PRIMARY : ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot,
      })),
    });
    const maxBotLinkService = createMaxBotLinkMock(prisma);
    const service = new MaxBotOwnershipFoundationService(
      createConfigMock({
        BOT_OWNERSHIP_REBALANCE_MODE: 'on',
        BOT_OWNERSHIP_REBALANCE_MAX_MOVES_PER_RUN: 1,
      }) as never,
      prisma as never,
      {
        getAllBots: jest.fn().mockReturnValue(
          candidates.map((candidate) => ({
            id: candidate.botId,
            state: 'active',
            ownershipWeight: 1,
          })),
        ),
      } as never,
      maxBotLinkService as never,
    );

    await service.onModuleInit();
    await runDeferredStartupSync();
    const snapshot = await service.getSnapshot(0);

    expect(maxBotLinkService.selectChatPrimaryBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId,
        botId: 'bot-2',
        expectedRoutingVersion: 0,
      }),
    );
    expect(prisma.__state.chats[0]).toMatchObject({
      primaryBotId: 'bot-2',
      botId: 'bot-2',
      routingVersion: 1,
    });
    expect(snapshot.repair.lastAppliedMoves).toBe(1);

    await service.onModuleDestroy();
  });

  it('rejects an ownership plan after the selected access epoch changes', async () => {
    process.env.APP_ROLE = 'admin';
    const plannedCheckedAt = new Date('2026-05-09T10:04:00.000Z');
    const newerCheckedAt = new Date('2026-05-09T10:04:30.000Z');
    const chat: ChatRow = {
      id: 'access-epoch-race',
      entityType: ChatEntityType.CHAT,
      botId: 'bot-1',
      primaryBotId: 'bot-1',
      catalogKind: ChatCatalogKind.MANAGED,
      routingVersion: 7,
    };
    const memberships: MembershipRow[] = [
      {
        chatId: chat.id,
        botId: 'bot-1',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: plannedCheckedAt,
        botAccessExpiresAt: new Date('2026-05-09T10:19:00.000Z'),
        botAccessSource: 'admin_roster_sync',
        permissionsSnapshot: {
          checkedAt: plannedCheckedAt.toISOString(),
          isAdmin: true,
          isOwner: false,
          permissions: ['write', 'delete_messages'],
        },
      },
      {
        chatId: chat.id,
        botId: 'bot-2',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.CONFIRMED_OWNER,
        botAccessCheckedAt: plannedCheckedAt,
        botAccessExpiresAt: new Date('2026-05-09T10:19:00.000Z'),
        botAccessSource: 'admin_roster_sync',
        permissionsSnapshot: {
          checkedAt: plannedCheckedAt.toISOString(),
          isAdmin: true,
          isOwner: true,
          permissions: ['write', 'delete_messages'],
        },
      },
    ];
    const prisma = createPrismaMock({ chats: [chat], memberships });
    const maxBotLinkService = createMaxBotLinkMock(prisma);
    const applySelection = maxBotLinkService.selectChatPrimaryBot.getMockImplementation();
    if (!applySelection) {
      throw new Error('Missing selectChatPrimaryBot test implementation');
    }
    maxBotLinkService.selectChatPrimaryBot.mockImplementationOnce(async (params) => {
      expect(params).toEqual(
        expect.objectContaining({
          chatId: chat.id,
          botId: 'bot-2',
          expectedRoutingVersion: 7,
          expectedAccessEpoch: {
            checkedAt: plannedCheckedAt,
            source: 'admin_roster_sync',
          },
        }),
      );
      const candidate = memberships[1]!;
      candidate.botAccessState = ChatBotAccessState.CONFIRMED_ADMIN;
      candidate.botAccessCheckedAt = newerCheckedAt;
      candidate.botAccessExpiresAt = new Date('2026-05-09T10:19:30.000Z');
      candidate.botAccessSource = 'routed_action_preflight';
      candidate.permissionsSnapshot = {
        checkedAt: newerCheckedAt.toISOString(),
        isAdmin: true,
        isOwner: false,
        permissions: [],
      };
      return applySelection(params);
    });
    const service = new MaxBotOwnershipFoundationService(
      createConfigMock({ BOT_OWNERSHIP_REBALANCE_MODE: 'on' }) as never,
      prisma as never,
      {
        getAllBots: jest.fn().mockReturnValue([
          { id: 'bot-1', state: 'active', ownershipWeight: 1 },
          { id: 'bot-2', state: 'active', ownershipWeight: 1 },
        ]),
      } as never,
      maxBotLinkService as never,
    );

    await service.onModuleInit();
    await runDeferredStartupSync();
    const snapshot = await service.getSnapshot(0);

    expect(chat).toMatchObject({
      botId: 'bot-1',
      primaryBotId: 'bot-1',
      routingVersion: 7,
    });
    expect(memberships.map((membership) => membership.role)).toEqual([
      ChatBotMembershipRole.PRIMARY,
      ChatBotMembershipRole.STANDBY,
    ]);
    expect(maxBotLinkService.rememberChatBotBinding).not.toHaveBeenCalled();
    expect(snapshot.repair.lastAppliedMoves).toBe(0);

    await service.onModuleDestroy();
  });

  it('does not apply or count a stale ownership repair after routingVersion changes', async () => {
    process.env.APP_ROLE = 'admin';
    const permissionsSnapshot = {
      checkedAt: '2026-05-09T10:04:00.000Z',
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    };
    const candidates = ['bot-1', 'bot-2'].map((botId) => ({
      botId,
      membershipStatus: ChatBotMembershipStatus.ACTIVE,
      lifecycleState: 'active' as const,
      capabilityEligible: true,
      ownershipWeight: 1,
      permissionsSnapshot,
    }));
    const chatId = Array.from({ length: 100 }, (_, index) => `racing-chat-${index}`).find(
      (candidateChatId) =>
        resolveWeightedRendezvousOwnerBotId(candidateChatId, candidates) === 'bot-2',
    )!;
    const chat: ChatRow = {
      id: chatId,
      entityType: ChatEntityType.CHAT,
      botId: 'bot-1',
      primaryBotId: 'bot-1',
      catalogKind: ChatCatalogKind.MANAGED,
      routingVersion: 4,
    };
    const memberships = candidates.map((candidate, index) => ({
      chatId,
      botId: candidate.botId,
      role: index === 0 ? ChatBotMembershipRole.PRIMARY : ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot,
    }));
    const prisma = createPrismaMock({ chats: [chat], memberships });
    const maxBotLinkService = createMaxBotLinkMock(prisma);
    maxBotLinkService.selectChatPrimaryBot.mockImplementationOnce(async (params) => {
      expect(params.expectedRoutingVersion).toBe(4);
      chat.routingVersion = 5;
      return false;
    });
    const service = new MaxBotOwnershipFoundationService(
      createConfigMock({ BOT_OWNERSHIP_REBALANCE_MODE: 'on' }) as never,
      prisma as never,
      {
        getAllBots: jest.fn().mockReturnValue(
          candidates.map((candidate) => ({
            id: candidate.botId,
            state: 'active',
            ownershipWeight: 1,
          })),
        ),
      } as never,
      maxBotLinkService as never,
    );

    await service.onModuleInit();
    await runDeferredStartupSync();
    const snapshot = await service.getSnapshot(0);

    expect(maxBotLinkService.selectChatPrimaryBot).toHaveBeenCalledWith(
      expect.objectContaining({ chatId, botId: 'bot-2', expectedRoutingVersion: 4 }),
    );
    expect(chat).toEqual(
      expect.objectContaining({
        botId: 'bot-1',
        primaryBotId: 'bot-1',
        routingVersion: 5,
      }),
    );
    expect(memberships.map((membership) => membership.role)).toEqual([
      ChatBotMembershipRole.PRIMARY,
      ChatBotMembershipRole.STANDBY,
    ]);
    expect(maxBotLinkService.rememberChatBotBinding).not.toHaveBeenCalled();
    expect(snapshot.repair.lastAppliedMoves).toBe(0);

    await service.onModuleDestroy();
  });
});
