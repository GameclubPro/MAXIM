import {
  ChatBotAccessState,
  ChatCatalogKind,
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatEntityType,
  ChatRoutingState,
  Prisma,
} from '../prisma/prisma-client';
import { MaxBotLinkService } from './max-bot-link.service';

type MutableChat = {
  id: string;
  title: string;
  botId: string | null;
  primaryBotId: string | null;
  entityType?: ChatEntityType;
  catalogKind?: ChatCatalogKind;
  routingState?: ChatRoutingState;
  routingVersion?: number;
};

type MutableChatUpdate = Omit<Partial<MutableChat>, 'routingVersion'> & {
  routingVersion?: number | { increment: number };
};

type MutableMembership = {
  chatId: string;
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  capabilities?: unknown;
  permissionsSnapshot?: unknown;
  botAccessState?: string;
  botAccessCheckedAt?: Date | null;
  botAccessExpiresAt?: Date | null;
  botAccessSource?: string | null;
  botAccessLastErrorCode?: string | null;
  permissionsHash?: string | null;
  lifecycleEventAt?: Date | null;
  lifecycleEventType?: string | null;
  lifecycleSource?: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date | null;
  lastWebhookAt: Date | null;
};

const ROUTE_MATRIX_BOT_IDS = [
  'id613002203036_bot',
  'id613002203036_4_bot',
  'id613002203036_5_bot',
  'id613070470872_5_bot',
  'id613070470872_6_bot',
  'id613070470872_9_bot',
] as const;

function createActiveMembership(
  chatId: string,
  botId: string,
  index: number,
  overrides: Partial<MutableMembership> = {},
): MutableMembership {
  const timestamp = new Date(Date.UTC(2026, 2, 31, 0, 0, index));
  return {
    chatId,
    botId,
    role: index === 0 ? ChatBotMembershipRole.PRIMARY : ChatBotMembershipRole.STANDBY,
    status: ChatBotMembershipStatus.ACTIVE,
    botAccessState: 'UNKNOWN',
    botAccessCheckedAt: null,
    permissionsSnapshot: {
      checkedAt: timestamp.toISOString(),
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'write', 'delete_messages', 'add_remove_members'],
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    lastWebhookAt: timestamp,
    ...overrides,
  };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }

  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((tail) => [
      item,
      ...tail,
    ]),
  );
}

function createServiceFixture() {
  const chats = new Map<string, MutableChat>();
  const memberships: MutableMembership[] = [];
  const now = () => new Date();

  const prisma = {
    chat: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const chat = chats.get(where.id) ?? null;
        if (!chat) {
          return null;
        }
        return {
          entityType: chat.entityType ?? null,
          catalogKind: chat.catalogKind ?? null,
          routingState: chat.routingState ?? ChatRoutingState.READY,
          routingVersion: chat.routingVersion ?? 0,
          primaryBotId: chat.primaryBotId,
          botId: chat.botId,
          botMemberships: memberships
            .filter((membership) => membership.chatId === where.id)
            .map((membership) => ({
              botId: membership.botId,
              role: membership.role,
              status: membership.status,
              botAccessState: membership.botAccessState ?? 'UNKNOWN',
              botAccessCheckedAt: membership.botAccessCheckedAt ?? null,
              botAccessExpiresAt: membership.botAccessExpiresAt ?? null,
              capabilities: membership.capabilities ?? [],
              permissionsSnapshot:
                membership.permissionsSnapshot === Prisma.JsonNull
                  ? null
                  : (membership.permissionsSnapshot ?? null),
            })),
        };
      }),
      create: jest.fn(async ({ data }: { data: MutableChat }) => {
        if (chats.has(data.id)) {
          const error = new Error('Unique constraint failed');
          (error as Error & { code?: string }).code = 'P2002';
          throw error;
        }
        chats.set(data.id, {
          id: data.id,
          title: data.title,
          botId: data.botId ?? null,
          primaryBotId: data.primaryBotId ?? null,
          entityType: data.entityType,
          catalogKind: data.catalogKind,
          routingState: data.routingState ?? ChatRoutingState.READY,
          routingVersion: data.routingVersion ?? 0,
        });
        return chats.get(data.id);
      }),
      createMany: jest.fn(
        async ({
          data,
          skipDuplicates,
        }: {
          data: MutableChat | MutableChat[];
          skipDuplicates?: boolean;
        }) => {
          const rows = Array.isArray(data) ? data : [data];
          let count = 0;
          for (const row of rows) {
            if (chats.has(row.id)) {
              if (skipDuplicates) {
                continue;
              }
              const error = new Error('Unique constraint failed');
              (error as Error & { code?: string }).code = 'P2002';
              throw error;
            }
            chats.set(row.id, {
              id: row.id,
              title: row.title,
              botId: row.botId ?? null,
              primaryBotId: row.primaryBotId ?? null,
              entityType: row.entityType,
              catalogKind: row.catalogKind,
              routingState: row.routingState ?? ChatRoutingState.READY,
              routingVersion: row.routingVersion ?? 0,
            });
            count += 1;
          }
          return { count };
        },
      ),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: MutableChatUpdate }) => {
          const existing = chats.get(where.id);
          if (!existing) {
            throw new Error(`Chat ${where.id} not found`);
          }
          const { routingVersion, ...nextData } = data;
          Object.assign(existing, nextData);
          if (typeof routingVersion === 'number') {
            existing.routingVersion = routingVersion;
          } else if (routingVersion) {
            existing.routingVersion =
              (existing.routingVersion ?? 0) + Number(routingVersion.increment ?? 0);
          }
          return existing;
        },
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: {
            id: string;
            routingState?: ChatRoutingState | { not: ChatRoutingState };
            routingVersion?: number;
            botMemberships?: {
              some: {
                botId: string;
                status: ChatBotMembershipStatus;
                lifecycleEventAt: Date;
                lifecycleEventType: string;
              };
            };
          };
          data: MutableChatUpdate;
        }) => {
          const existing = chats.get(where.id);
          if (
            !existing ||
            (typeof where.routingState === 'string' &&
              (existing.routingState ?? ChatRoutingState.READY) !== where.routingState) ||
            (where.routingState !== undefined &&
              typeof where.routingState === 'object' &&
              (existing.routingState ?? ChatRoutingState.READY) === where.routingState.not) ||
            (where.routingVersion !== undefined &&
              (existing.routingVersion ?? 0) !== where.routingVersion) ||
            (where.botMemberships &&
              !memberships.some(
                (membership) =>
                  membership.chatId === where.id &&
                  membership.botId === where.botMemberships?.some.botId &&
                  membership.status === where.botMemberships.some.status &&
                  membership.lifecycleEventType === where.botMemberships.some.lifecycleEventType &&
                  membership.lifecycleEventAt?.getTime() ===
                    where.botMemberships.some.lifecycleEventAt.getTime(),
              ))
          ) {
            return { count: 0 };
          }
          const { routingVersion, ...nextData } = data;
          Object.assign(existing, nextData);
          if (typeof routingVersion === 'number') {
            existing.routingVersion = routingVersion;
          } else if (routingVersion) {
            existing.routingVersion =
              (existing.routingVersion ?? 0) + Number(routingVersion.increment ?? 0);
          }
          return { count: 1 };
        },
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { id: string };
          create: MutableChat;
          update: MutableChatUpdate;
        }) => {
          const existing = chats.get(where.id);
          if (existing) {
            const { routingVersion, ...nextData } = update;
            Object.assign(existing, nextData);
            if (typeof routingVersion === 'number') {
              existing.routingVersion = routingVersion;
            } else if (routingVersion) {
              existing.routingVersion =
                (existing.routingVersion ?? 0) + Number(routingVersion.increment ?? 0);
            }
            return existing;
          }
          const created = {
            id: create.id,
            title: create.title,
            botId: create.botId ?? null,
            primaryBotId: create.primaryBotId ?? null,
            entityType: create.entityType,
            catalogKind: create.catalogKind,
            routingState: create.routingState ?? ChatRoutingState.READY,
            routingVersion: create.routingVersion ?? 0,
          };
          chats.set(create.id, created);
          return created;
        },
      ),
    },
    chatBotMembership: {
      findUnique: jest.fn(
        async ({ where }: { where: { chatId_botId: { chatId: string; botId: string } } }) =>
          memberships.find(
            (membership) =>
              membership.chatId === where.chatId_botId.chatId &&
              membership.botId === where.chatId_botId.botId,
          ) ?? null,
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { chatId_botId: { chatId: string; botId: string } };
          create: Omit<MutableMembership, 'createdAt' | 'updatedAt'>;
          update: Partial<MutableMembership>;
        }) => {
          const existing = memberships.find(
            (membership) =>
              membership.chatId === where.chatId_botId.chatId &&
              membership.botId === where.chatId_botId.botId,
          );
          if (existing) {
            Object.assign(existing, update, { updatedAt: now() });
            return existing;
          }
          const created: MutableMembership = {
            ...create,
            chatId: create.chatId,
            botId: create.botId,
            role: create.role,
            status: create.status,
            capabilities: (create as MutableMembership).capabilities ?? [],
            permissionsSnapshot: (create as MutableMembership).permissionsSnapshot ?? null,
            createdAt: now(),
            updatedAt: now(),
            lastSeenAt: create.lastSeenAt ?? null,
            lastWebhookAt: create.lastWebhookAt ?? null,
          };
          memberships.push(created);
          return created;
        },
      ),
      findMany: jest.fn(async ({ where }: { where: { chatId: string } }) =>
        memberships
          .filter((membership) => membership.chatId === where.chatId)
          .slice()
          .sort((left, right) => {
            const updatedDiff = right.updatedAt.getTime() - left.updatedAt.getTime();
            if (updatedDiff !== 0) {
              return updatedDiff;
            }
            return left.createdAt.getTime() - right.createdAt.getTime();
          })
          .map((membership) => ({
            botId: membership.botId,
            role: membership.role,
            status: membership.status,
            botAccessState: membership.botAccessState ?? ChatBotAccessState.UNKNOWN,
            botAccessCheckedAt: membership.botAccessCheckedAt ?? null,
            permissionsSnapshot:
              membership.permissionsSnapshot === Prisma.JsonNull
                ? null
                : (membership.permissionsSnapshot ?? null),
          })),
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: {
            chatId: string;
            status?: ChatBotMembershipStatus;
            botId?: string;
            OR?: Array<Record<string, unknown>>;
          };
          data: Partial<MutableMembership>;
        }) => {
          let count = 0;
          for (const membership of memberships) {
            if (membership.chatId !== where.chatId) {
              continue;
            }
            if (where.status && membership.status !== where.status) {
              continue;
            }
            if (where.botId && membership.botId !== where.botId) {
              continue;
            }
            if (
              where.OR &&
              !where.OR.some((condition) => {
                if (condition.status && membership.status !== condition.status) {
                  return false;
                }
                if (condition.lifecycleEventAt === null) {
                  return membership.lifecycleEventAt == null;
                }
                const lifecycleEventAt = condition.lifecycleEventAt;
                if (lifecycleEventAt instanceof Date) {
                  if (membership.lifecycleEventAt?.getTime() !== lifecycleEventAt.getTime()) {
                    return false;
                  }
                } else if (
                  lifecycleEventAt &&
                  typeof lifecycleEventAt === 'object' &&
                  (lifecycleEventAt as { lt?: unknown }).lt instanceof Date
                ) {
                  const existingAtMs = membership.lifecycleEventAt?.getTime();
                  if (
                    existingAtMs == null ||
                    existingAtMs >= (lifecycleEventAt as { lt: Date }).lt.getTime()
                  ) {
                    return false;
                  }
                }
                const lifecycleType = condition.lifecycleEventType;
                if (
                  lifecycleType &&
                  typeof lifecycleType === 'object' &&
                  'not' in lifecycleType &&
                  membership.lifecycleEventType === (lifecycleType as { not?: string }).not
                ) {
                  return false;
                }
                return true;
              })
            ) {
              continue;
            }
            Object.assign(membership, data, { updatedAt: now() });
            count += 1;
          }
          return { count };
        },
      ),
    },
  };

  const bots = ROUTE_MATRIX_BOT_IDS.map((id, index) => ({
    id,
    token: `token-${index + 1}`,
    state: 'active',
  }));
  const botRegistry = {
    getBotById: jest.fn((botId?: string | null) => bots.find((bot) => bot.id === botId) ?? null),
    getDefaultBot: jest.fn(() => bots[0]),
    getEntryBot: jest.fn(() => bots[0]),
  };
  const botContext = {
    getActiveBotId: jest.fn((): string | null => null),
  };

  return {
    service: new MaxBotLinkService(prisma as never, botRegistry as never, botContext as never),
    prisma,
    botContext,
    bots,
    chats,
    memberships,
  };
}

describe('MaxBotLinkService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-09T10:05:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('treats routed send access as stale at the configured age boundary', async () => {
    const fixture = createServiceFixture();
    fixture.memberships.push(
      createActiveMembership('chat-access-age', fixture.bots[0]!.id, 0, {
        botAccessCheckedAt: new Date('2026-05-09T09:35:00.000Z'),
      }),
    );

    await expect(
      fixture.service.isBotAccessSnapshotStale({
        chatId: 'chat-access-age',
        botId: fixture.bots[0]!.id,
        maxAgeMs: 30 * 60_000,
      }),
    ).resolves.toBe(true);
    await expect(
      fixture.service.isBotAccessSnapshotStale({
        chatId: 'chat-access-age',
        botId: fixture.bots[0]!.id,
        maxAgeMs: 31 * 60_000,
      }),
    ).resolves.toBe(false);
  });

  it('persists a live routed access probe only onto an ACTIVE membership', async () => {
    const fixture = createServiceFixture();
    const membership = createActiveMembership('chat-access-probe', fixture.bots[0]!.id, 0);
    fixture.memberships.push(membership);

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId: 'chat-access-probe',
        botId: fixture.bots[0]!.id,
        access: {
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        },
        source: 'routed_action_preflight',
      }),
    ).resolves.toBe(true);

    expect(membership).toEqual(
      expect.objectContaining({
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessSource: 'routed_action_preflight',
        botAccessCheckedAt: new Date('2026-05-09T10:05:00.000Z'),
        permissionsSnapshot: expect.objectContaining({
          isAdmin: true,
          permissions: ['write'],
        }),
      }),
    );
  });

  it('reactivates a removed origin membership only for an explicitly authorized live probe', async () => {
    const fixture = createServiceFixture();
    const membership = createActiveMembership('chat-access-recovery', fixture.bots[0]!.id, 0, {
      status: ChatBotMembershipStatus.REMOVED,
      role: ChatBotMembershipRole.STANDBY,
      lifecycleEventAt: new Date('2026-05-09T09:55:00.000Z'),
      lifecycleEventType: 'bot_removed',
      lifecycleSource: 'webhook',
    });
    fixture.memberships.push(membership);

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId: 'chat-access-recovery',
        botId: fixture.bots[0]!.id,
        access: {
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        },
        source: 'moderation_delete_intent_probe',
        allowMembershipRecovery: true,
      }),
    ).resolves.toBe(true);

    expect(membership).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.ACTIVE,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessSource: 'moderation_delete_intent_probe',
      }),
    );
  });

  it('binds a new chat through a duplicate-safe insert instead of a noisy create', async () => {
    const fixture = createServiceFixture();

    await expect(
      fixture.service.bindChatToBot({
        chatId: 'chat-bind-1',
        title: 'Bound chat',
        entityType: ChatEntityType.CHAT,
        botId: 'id613002203036_4_bot',
      }),
    ).resolves.toBe('id613002203036_4_bot');

    expect(fixture.prisma.chat.create).not.toHaveBeenCalled();
    expect(fixture.prisma.chat.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'chat-bind-1',
        title: 'Bound chat',
        botId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_4_bot',
        entityType: ChatEntityType.CHAT,
        catalogKind: ChatCatalogKind.MANAGED,
      }),
      skipDuplicates: true,
    });
    expect(fixture.prisma.chat.update).not.toHaveBeenCalled();
    expect(fixture.chats.get('chat-bind-1')).toEqual(
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_4_bot',
      }),
    );
    expect(fixture.memberships).toContainEqual(
      expect.objectContaining({
        chatId: 'chat-bind-1',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastWebhookAt: expect.any(Date),
      }),
    );
  });

  it('keeps the stored primary bot when a duplicate-safe bind observes another bot', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-bind-2', {
      id: 'chat-bind-2',
      title: 'Stored chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: ChatEntityType.CHAT,
      catalogKind: ChatCatalogKind.MANAGED,
    });

    await expect(
      fixture.service.bindChatToBot({
        chatId: 'chat-bind-2',
        title: 'Updated stored chat',
        entityType: ChatEntityType.CHAT,
        botId: 'id613002203036_4_bot',
      }),
    ).resolves.toBe('id613002203036_bot');

    expect(fixture.prisma.chat.create).not.toHaveBeenCalled();
    expect(fixture.prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-bind-2' },
      data: expect.objectContaining({
        title: 'Updated stored chat',
        botId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_bot',
        entityType: ChatEntityType.CHAT,
        catalogKind: ChatCatalogKind.MANAGED,
      }),
    });
    expect(fixture.memberships).toContainEqual(
      expect.objectContaining({
        chatId: 'chat-bind-2',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
      }),
    );
    expect(fixture.memberships).toContainEqual(
      expect.objectContaining({
        chatId: 'chat-bind-2',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
      }),
    );
  });

  it.each([1, 2, 3, 6])(
    'keeps deterministic send and moderation routes when %i bot(s) are active in one chat',
    async (botCount) => {
      const fixture = createServiceFixture();
      const chatId = `chat-route-matrix-${botCount}`;
      const botIds = ROUTE_MATRIX_BOT_IDS.slice(0, botCount);
      const primaryBotId = botIds[0];
      if (!primaryBotId) {
        throw new Error('Route matrix needs at least one bot');
      }
      fixture.chats.set(chatId, {
        id: chatId,
        title: `Matrix chat ${botCount}`,
        botId: primaryBotId,
        primaryBotId,
        entityType: ChatEntityType.CHAT,
      });
      fixture.memberships.push(
        ...botIds.map((botId, index) => createActiveMembership(chatId, botId, index)),
      );

      const sendRoute = await fixture.service.resolveBotRoute({
        purpose: 'send_message',
        chatId,
      });
      const moderationRoute = await fixture.service.resolveBotRoute({
        purpose: 'moderation_action',
        chatId,
        action: 'delete_message',
      });

      expect(sendRoute.botId).toBe(primaryBotId);
      expect(sendRoute.primaryBotId).toBe(primaryBotId);
      expect(sendRoute.candidateBotIds).toEqual(botIds);
      expect(moderationRoute.botId).toBe(primaryBotId);
      expect(moderationRoute.primaryBotId).toBe(primaryBotId);
      expect(moderationRoute.candidateBotIds).toEqual(botIds);
    },
  );

  it('fails closed for every routed purpose when the chat is NO_ELIGIBLE_BOT', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-no-eligible';
    const botId = fixture.bots[0]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Closed route',
      botId,
      primaryBotId: botId,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      routingVersion: 7,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
      }),
    );

    const routes = await Promise.all([
      fixture.service.resolveBotRoute({ purpose: 'default', chatId }),
      fixture.service.resolveBotRoute({ purpose: 'read', chatId }),
      fixture.service.resolveBotRoute({ purpose: 'send_message', chatId }),
      fixture.service.resolveBotRouteForChannelPoll({ chatId }),
      fixture.service.resolveBotRoute({
        purpose: 'moderation_action',
        chatId,
        action: 'delete_message',
      }),
      fixture.service.resolveBotRoute({
        purpose: 'capability',
        chatId,
        capability: 'background_scans',
      }),
    ]);

    for (const route of routes) {
      expect(route).toEqual(
        expect.objectContaining({
          botId: null,
          candidateBotIds: [],
          routingVersion: 7,
        }),
      );
    }
    await expect(fixture.service.getStoredChatPrimaryBotId(chatId)).resolves.toBeNull();
    await expect(
      fixture.service.getChatExecutionBinding({ chatId, activeBotId: botId }),
    ).resolves.toEqual(expect.objectContaining({ shouldHandleGroupUpdate: false }));
  });

  it('does not let a stale local binding override the primary stored by another process', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-cross-process-primary';
    const oldBotId = fixture.bots[0]!.id;
    const newBotId = fixture.bots[1]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Cross-process route',
      botId: newBotId,
      primaryBotId: newBotId,
      routingState: ChatRoutingState.READY,
      routingVersion: 9,
    });
    fixture.service.rememberChatBotBinding(chatId, oldBotId);

    await expect(fixture.service.getStoredChatPrimaryBotId(chatId)).resolves.toBe(newBotId);
    expect(fixture.service.resolveBotIdSync(null, chatId)).toBe(newBotId);
  });

  it('keeps a newly discovered chat closed until a fresh self-access snapshot is confirmed', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-discovery-needs-access';
    const botId = fixture.bots[0]!.id;

    await expect(
      fixture.service.bindDiscoveredChatBots({
        chatId,
        primaryBotId: botId,
        botIds: [botId],
        title: 'Discovered chat',
        entityType: ChatEntityType.CHAT,
      }),
    ).resolves.toBeNull();
    expect(fixture.chats.get(chatId)).toEqual(
      expect.objectContaining({
        routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      }),
    );
    await expect(fixture.service.getStoredChatPrimaryBotId(chatId)).resolves.toBeNull();

    const accessCheckedAt = new Date();
    Object.assign(fixture.memberships[0]!, {
      botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
      botAccessCheckedAt: accessCheckedAt,
      botAccessExpiresAt: new Date(accessCheckedAt.getTime() + 15 * 60_000),
      permissionsSnapshot: {
        checkedAt: accessCheckedAt.toISOString(),
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      },
    });

    await expect(fixture.service.reconcileChatPrimaryByAccess({ chatId })).resolves.toBe(botId);
    expect(fixture.chats.get(chatId)).toEqual(
      expect.objectContaining({
        routingState: ChatRoutingState.READY,
      }),
    );
  });

  it('clears a stale primary when no runtime-actionable membership survives', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-zero-actionable';
    const botId = fixture.bots[0]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'No actionable bot',
      botId,
      primaryBotId: botId,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
      routingVersion: 3,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        botAccessState: ChatBotAccessState.DENIED,
      }),
    );

    await expect(fixture.service.reconcileChatPrimaryByAccess({ chatId })).resolves.toBeNull();
    expect(fixture.chats.get(chatId)).toEqual(
      expect.objectContaining({
        botId: null,
        primaryBotId: null,
        routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
        routingVersion: 4,
      }),
    );
  });

  it('reopens a persisted route only after runtime eligibility is confirmed', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-route-recovered';
    const botId = fixture.bots[0]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Recovered route',
      botId,
      primaryBotId: botId,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      routingVersion: 5,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
      }),
    );

    await expect(fixture.service.reconcileChatPrimaryByAccess({ chatId })).resolves.toBe(botId);
    expect(fixture.chats.get(chatId)).toEqual(
      expect.objectContaining({
        routingState: ChatRoutingState.READY,
      }),
    );
    await expect(
      fixture.service.resolveBotRoute({ purpose: 'send_message', chatId }),
    ).resolves.toEqual(expect.objectContaining({ botId, candidateBotIds: [botId] }));
  });

  it('retries a routing-state write when a membership fence changes routingVersion', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-routing-cas';
    const botId = fixture.bots[0]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'CAS route',
      botId,
      primaryBotId: botId,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      routingVersion: 2,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
      }),
    );
    fixture.prisma.chat.updateMany.mockImplementationOnce(async () => {
      fixture.chats.get(chatId)!.routingVersion = 3;
      return { count: 0 };
    });

    await expect(fixture.service.reconcileChatRoutingState({ chatId })).resolves.toEqual({
      routingState: ChatRoutingState.READY,
      changed: true,
    });
    expect(fixture.prisma.chat.updateMany).toHaveBeenCalledTimes(2);
    expect(fixture.chats.get(chatId)).toEqual(
      expect.objectContaining({ routingState: ChatRoutingState.READY, routingVersion: 4 }),
    );
  });

  it('force-bumps routingVersion for a dirty epoch even when the effective state stays READY', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-routing-dirty-epoch';
    const botId = fixture.bots[0]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Dirty route',
      botId,
      primaryBotId: botId,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
      routingVersion: 7,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
      }),
    );

    await expect(
      fixture.service.reconcileChatRoutingState({ chatId, forceVersionBump: true }),
    ).resolves.toEqual({
      routingState: ChatRoutingState.READY,
      changed: true,
    });
    expect(fixture.chats.get(chatId)?.routingVersion).toBe(8);
  });

  it('fails retryably when a forced dirty-epoch CAS is exhausted', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-routing-dirty-cas-exhausted';
    const botId = fixture.bots[0]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Contended dirty route',
      botId,
      primaryBotId: botId,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
      routingVersion: 11,
    });
    fixture.memberships.push(createActiveMembership(chatId, botId, 0));
    fixture.prisma.chat.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      fixture.service.reconcileChatRoutingState({ chatId, forceVersionBump: true }),
    ).rejects.toThrow('routing state changed during forced reconciliation');
    expect(fixture.prisma.chat.updateMany).toHaveBeenCalledTimes(2);
  });

  it('promotes an active standby bot to primary when the current primary bot is removed', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-1', {
      id: 'chat-1',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-1',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-30T10:00:00.000Z'),
        updatedAt: new Date('2026-03-30T10:00:00.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:00.000Z'),
      },
      {
        chatId: 'chat-1',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-30T10:00:01.000Z'),
        updatedAt: new Date('2026-03-30T10:00:01.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:01.000Z'),
      },
    );

    await fixture.service.markChatBotRemoved({
      chatId: 'chat-1',
      botId: 'id613002203036_bot',
      title: 'Shared chat',
    });

    expect(fixture.chats.get('chat-1')).toEqual(
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_4_bot',
      }),
    );
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_bot'),
    ).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.REMOVED,
      }),
    );
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_4_bot'),
    ).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
      }),
    );
  });

  it('promotes a fresh standby over a stale stronger standby when primary access is lost', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-3bot-lost-primary', {
      id: 'chat-3bot-lost-primary',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-3bot-lost-primary',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-05-09T10:00:00.000Z'),
        updatedAt: new Date('2026-05-09T10:00:00.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:00.000Z'),
      },
      {
        chatId: 'chat-3bot-lost-primary',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-07T10:00:00.000Z',
          isAdmin: true,
          isOwner: true,
          permissions: ['delete_messages', 'add_remove_members'],
        },
        createdAt: new Date('2026-05-09T10:00:01.000Z'),
        updatedAt: new Date('2026-05-09T10:00:01.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:01.000Z'),
      },
      {
        chatId: 'chat-3bot-lost-primary',
        botId: 'id613002203036_5_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:30.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-05-09T10:00:02.000Z'),
        updatedAt: new Date('2026-05-09T10:00:02.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:02.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:02.000Z'),
      },
    );

    await expect(
      fixture.service.markChatBotRemoved({
        chatId: 'chat-3bot-lost-primary',
        botId: 'id613002203036_bot',
        title: 'Shared chat',
      }),
    ).resolves.toBe('id613002203036_5_bot');

    expect(fixture.chats.get('chat-3bot-lost-primary')).toEqual(
      expect.objectContaining({
        botId: 'id613002203036_5_bot',
        primaryBotId: 'id613002203036_5_bot',
      }),
    );
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_4_bot'),
    ).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
      }),
    );
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_5_bot'),
    ).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
      }),
    );
  });

  it('does not promote a standby with fresh explicit denied access when primary is removed', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-3bot-denied-standby', {
      id: 'chat-3bot-denied-standby',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      createActiveMembership('chat-3bot-denied-standby', 'id613002203036_bot', 0),
      createActiveMembership('chat-3bot-denied-standby', 'id613002203036_4_bot', 1, {
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:30.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
      }),
      createActiveMembership('chat-3bot-denied-standby', 'id613002203036_5_bot', 2, {
        permissionsSnapshot: {
          checkedAt: '2026-05-07T10:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
      }),
    );

    await expect(
      fixture.service.markChatBotRemoved({
        chatId: 'chat-3bot-denied-standby',
        botId: 'id613002203036_bot',
        title: 'Shared chat',
      }),
    ).resolves.toBe('id613002203036_5_bot');

    expect(fixture.chats.get('chat-3bot-denied-standby')).toEqual(
      expect.objectContaining({
        botId: 'id613002203036_5_bot',
        primaryBotId: 'id613002203036_5_bot',
      }),
    );
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_4_bot'),
    ).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
      }),
    );
  });

  it('resolves an assist-capable standby bot for shared background lanes', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-2', {
      id: 'chat-2',
      title: 'Assist chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-2',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-31T00:00:00.000Z'),
        updatedAt: new Date('2026-03-31T00:00:00.000Z'),
        lastSeenAt: new Date('2026-03-31T00:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-31T00:00:00.000Z'),
      },
      {
        chatId: 'chat-2',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-31T00:00:01.000Z'),
        updatedAt: new Date('2026-03-31T00:00:01.000Z'),
        lastSeenAt: new Date('2026-03-31T00:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-31T00:00:01.000Z'),
        capabilities: ['suggestion_delivery', 'channel_stats'],
      },
    );

    const resolved = await fixture.service.resolveBotIdForCapability({
      chatId: 'chat-2',
      capability: 'suggestion_delivery',
    });

    expect(resolved).toBe('id613002203036_4_bot');
  });

  it('returns every assist-capable standby before the primary capability fallback', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-2-multi-assist', {
      id: 'chat-2-multi-assist',
      title: 'Assist chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-2-multi-assist',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-31T00:00:00.000Z'),
        updatedAt: new Date('2026-03-31T00:00:00.000Z'),
        lastSeenAt: new Date('2026-03-31T00:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-31T00:00:00.000Z'),
      },
      {
        chatId: 'chat-2-multi-assist',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        capabilities: ['suggestion_delivery', 'channel_stats'],
        createdAt: new Date('2026-03-31T00:00:01.000Z'),
        updatedAt: new Date('2026-03-31T00:00:01.000Z'),
        lastSeenAt: new Date('2026-03-31T00:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-31T00:00:01.000Z'),
      },
      {
        chatId: 'chat-2-multi-assist',
        botId: 'id613002203036_5_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        capabilities: ['suggestion_delivery'],
        createdAt: new Date('2026-03-31T00:00:02.000Z'),
        updatedAt: new Date('2026-03-31T00:00:02.000Z'),
        lastSeenAt: new Date('2026-03-31T00:00:02.000Z'),
        lastWebhookAt: new Date('2026-03-31T00:00:02.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdsForCapability({
        chatId: 'chat-2-multi-assist',
        capability: 'suggestion_delivery',
      }),
    ).resolves.toEqual(['id613002203036_4_bot', 'id613002203036_5_bot', 'id613002203036_bot']);

    const route = await fixture.service.resolveBotRoute({
      purpose: 'capability',
      chatId: 'chat-2-multi-assist',
      capability: 'suggestion_delivery',
    });
    expect(route.botId).toBe('id613002203036_4_bot');
    expect(route.candidateBotIds).toEqual([
      'id613002203036_4_bot',
      'id613002203036_5_bot',
      'id613002203036_bot',
    ]);
  });

  it('does not route assist capabilities to a bot with explicit denied access', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-denied-capability', {
      id: 'chat-denied-capability',
      title: 'Denied assist chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      createActiveMembership('chat-denied-capability', 'id613002203036_bot', 0),
      createActiveMembership('chat-denied-capability', 'id613002203036_4_bot', 1, {
        capabilities: ['suggestion_delivery'],
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:30.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
      }),
    );

    await expect(
      fixture.service.resolveBotIdsForCapability({
        chatId: 'chat-denied-capability',
        capability: 'suggestion_delivery',
        fallbackToPrimary: false,
      }),
    ).resolves.toEqual([]);

    await expect(
      fixture.service.resolveBotIdsForCapability({
        chatId: 'chat-denied-capability',
        capability: 'suggestion_delivery',
      }),
    ).resolves.toEqual(['id613002203036_bot']);
  });

  it('stores access-loss diagnostics on removed bot memberships', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-access-lost', {
      id: 'chat-access-lost',
      title: 'Lost chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });

    await fixture.service.markChatBotRemoved({
      chatId: 'chat-access-lost',
      botId: 'id613002203036_bot',
      title: 'Lost chat',
      accessLostReason: 'bot_denied',
      accessLostSource: 'night_mode_transition:close',
      lastMaxErrorCode: 'chat.denied',
      lastMaxErrorMessage: 'Forbidden',
      lastMaxStatusCode: 403,
    });

    expect(
      fixture.memberships.find((membership) => membership.chatId === 'chat-access-lost'),
    ).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.REMOVED,
        permissionsSnapshot: expect.objectContaining({
          accessLostReason: 'bot_denied',
          accessLostSource: 'night_mode_transition:close',
          lastMaxErrorCode: 'chat.denied',
          lastMaxErrorMessage: 'Forbidden',
          lastMaxStatusCode: 403,
          accessLostAt: expect.any(String),
        }),
      }),
    );
  });

  it('does not downgrade a managed group chat to context-only when marking a bot removed', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('managed-chat', {
      id: 'managed-chat',
      title: 'Managed group',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: ChatEntityType.CHAT,
      catalogKind: ChatCatalogKind.MANAGED,
    });
    fixture.memberships.push({
      chatId: 'managed-chat',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      createdAt: new Date('2026-05-09T10:00:00.000Z'),
      updatedAt: new Date('2026-05-09T10:00:00.000Z'),
      lastSeenAt: new Date('2026-05-09T10:00:00.000Z'),
      lastWebhookAt: new Date('2026-05-09T10:00:00.000Z'),
    });

    await expect(
      fixture.service.markChatBotRemoved({
        chatId: 'managed-chat',
        botId: 'id613002203036_bot',
        title: 'Managed group',
        entityType: ChatEntityType.CHAT,
      }),
    ).resolves.toBeNull();

    expect(fixture.chats.get('managed-chat')).toEqual(
      expect.objectContaining({
        catalogKind: ChatCatalogKind.MANAGED,
        botId: null,
        primaryBotId: null,
      }),
    );
  });

  it('reports non-primary shared chat bindings as non-executable for group updates', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-1', {
      id: 'chat-1',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-1',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-30T10:00:00.000Z'),
        updatedAt: new Date('2026-03-30T10:00:00.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:00.000Z'),
      },
      {
        chatId: 'chat-1',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-30T10:00:01.000Z'),
        updatedAt: new Date('2026-03-30T10:00:01.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:01.000Z'),
      },
    );

    const binding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-1',
      activeBotId: 'id613002203036_4_bot',
    });

    expect(binding).toEqual(
      expect.objectContaining({
        activeBotId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_bot',
        activeMembershipStatus: ChatBotMembershipStatus.ACTIVE,
        shouldHandleGroupUpdate: false,
      }),
    );
  });

  it('uses an active executable standby instead of a draining stored primary for execution binding', async () => {
    const fixture = createServiceFixture();
    const drainingPrimaryBot = fixture.bots.find((bot) => bot.id === 'id613002203036_bot');
    if (!drainingPrimaryBot) {
      throw new Error('primary bot fixture missing');
    }
    drainingPrimaryBot.state = 'draining';
    fixture.chats.set('chat-draining-execution-owner', {
      id: 'chat-draining-execution-owner',
      title: 'Shared chat with draining owner',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      createActiveMembership('chat-draining-execution-owner', 'id613002203036_bot', 0, {
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write', 'delete_messages', 'add_remove_members'],
        },
      }),
      createActiveMembership('chat-draining-execution-owner', 'id613002203036_4_bot', 1, {
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write', 'delete_messages', 'add_remove_members'],
        },
      }),
    );

    const standbyBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-draining-execution-owner',
      activeBotId: 'id613002203036_4_bot',
    });
    const drainingBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-draining-execution-owner',
      activeBotId: 'id613002203036_bot',
    });

    expect(standbyBinding).toEqual(
      expect.objectContaining({
        activeBotId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_4_bot',
        activeMembershipStatus: ChatBotMembershipStatus.ACTIVE,
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        shouldHandleGroupUpdate: true,
      }),
    );
    expect(drainingBinding).toEqual(
      expect.objectContaining({
        activeBotId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_4_bot',
        activeMembershipStatus: ChatBotMembershipStatus.ACTIVE,
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        shouldHandleGroupUpdate: false,
      }),
    );
  });

  it('keeps the operational fallback for execution binding when no executable candidate exists', async () => {
    const fixture = createServiceFixture();
    const drainingPrimaryBot = fixture.bots.find((bot) => bot.id === 'id613002203036_bot');
    if (!drainingPrimaryBot) {
      throw new Error('primary bot fixture missing');
    }
    drainingPrimaryBot.state = 'draining';
    fixture.chats.set('chat-draining-execution-fallback', {
      id: 'chat-draining-execution-fallback',
      title: 'Shared chat with no executable owner',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      createActiveMembership('chat-draining-execution-fallback', 'id613002203036_bot', 0, {
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
      }),
    );

    await expect(
      fixture.service.getChatExecutionBinding({
        chatId: 'chat-draining-execution-fallback',
        activeBotId: 'id613002203036_bot',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        activeBotId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_bot',
        activeMembershipStatus: ChatBotMembershipStatus.ACTIVE,
        assignedBotIds: ['id613002203036_bot'],
        shouldHandleGroupUpdate: true,
      }),
    );
  });

  it('derives a deterministic owner from active memberships when chat primary is missing', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-2', {
      id: 'chat-2',
      title: 'Shared chat without primary',
      botId: null,
      primaryBotId: null,
    });
    fixture.memberships.push(
      {
        chatId: 'chat-2',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-30T11:00:00.000Z'),
        updatedAt: new Date('2026-03-30T11:00:00.000Z'),
        lastSeenAt: new Date('2026-03-30T11:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-30T11:00:00.000Z'),
      },
      {
        chatId: 'chat-2',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-30T11:00:01.000Z'),
        updatedAt: new Date('2026-03-30T11:00:01.000Z'),
        lastSeenAt: new Date('2026-03-30T11:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-30T11:00:01.000Z'),
      },
    );

    const ownerBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-2',
      activeBotId: 'id613002203036_bot',
    });
    const standbyBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-2',
      activeBotId: 'id613002203036_4_bot',
    });

    expect(ownerBinding).toEqual(
      expect.objectContaining({
        primaryBotId: 'id613002203036_bot',
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        shouldHandleGroupUpdate: true,
      }),
    );
    expect(standbyBinding).toEqual(
      expect.objectContaining({
        primaryBotId: 'id613002203036_bot',
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        shouldHandleGroupUpdate: false,
      }),
    );
  });

  it('treats the active bot with stronger permissions as primary in shared chats', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-rights', {
      id: 'chat-rights',
      title: 'Shared rights chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-rights',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-05-09T10:00:00.000Z'),
        updatedAt: new Date('2026-05-09T10:00:00.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:00.000Z'),
      },
      {
        chatId: 'chat-rights',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'delete_messages', 'add_remove_members'],
        },
        createdAt: new Date('2026-05-09T10:00:01.000Z'),
        updatedAt: new Date('2026-05-09T10:00:01.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:01.000Z'),
      },
    );

    const strongerBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-rights',
      activeBotId: 'id613002203036_4_bot',
    });
    const weakerBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-rights',
      activeBotId: 'id613002203036_bot',
    });

    expect(strongerBinding).toEqual(
      expect.objectContaining({
        primaryBotId: 'id613002203036_4_bot',
        shouldHandleGroupUpdate: true,
      }),
    );
    expect(weakerBinding).toEqual(
      expect.objectContaining({
        primaryBotId: 'id613002203036_4_bot',
        shouldHandleGroupUpdate: false,
      }),
    );
  });

  it('does not use a stale stronger standby as the shared chat execution owner', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-stale-execution-owner', {
      id: 'chat-stale-execution-owner',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-stale-execution-owner',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-05-09T10:00:00.000Z'),
        updatedAt: new Date('2026-05-09T10:00:00.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:00.000Z'),
      },
      {
        chatId: 'chat-stale-execution-owner',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-07T10:00:00.000Z',
          isAdmin: true,
          isOwner: true,
          permissions: ['delete_messages', 'add_remove_members'],
        },
        createdAt: new Date('2026-05-09T10:00:01.000Z'),
        updatedAt: new Date('2026-05-09T10:00:01.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:01.000Z'),
      },
    );

    const ownerBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-stale-execution-owner',
      activeBotId: 'id613002203036_bot',
    });
    const staleStandbyBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-stale-execution-owner',
      activeBotId: 'id613002203036_4_bot',
    });

    expect(ownerBinding).toEqual(
      expect.objectContaining({
        primaryBotId: 'id613002203036_bot',
        shouldHandleGroupUpdate: true,
      }),
    );
    expect(staleStandbyBinding).toEqual(
      expect.objectContaining({
        primaryBotId: 'id613002203036_bot',
        shouldHandleGroupUpdate: false,
      }),
    );
  });

  it('persists stronger bot permissions as the chat primary during reconciliation', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-reconcile-rights', {
      id: 'chat-reconcile-rights',
      title: 'Shared rights chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-reconcile-rights',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-05-09T10:00:00.000Z'),
        updatedAt: new Date('2026-05-09T10:00:00.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:00.000Z'),
      },
      {
        chatId: 'chat-reconcile-rights',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'delete_messages', 'add_remove_members'],
        },
        createdAt: new Date('2026-05-09T10:00:01.000Z'),
        updatedAt: new Date('2026-05-09T10:00:01.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:01.000Z'),
      },
    );

    await expect(
      fixture.service.reconcileChatPrimaryByAccess({ chatId: 'chat-reconcile-rights' }),
    ).resolves.toBe('id613002203036_4_bot');

    expect(fixture.chats.get('chat-reconcile-rights')).toEqual(
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_4_bot',
      }),
    );
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_4_bot'),
    ).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.PRIMARY,
      }),
    );
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_bot'),
    ).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.STANDBY,
      }),
    );
  });

  it('repairs an ineligible stored primary by falling back to an executable legacy bot', async () => {
    const fixture = createServiceFixture();
    const dormantPrimaryBot = fixture.bots.find((bot) => bot.id === 'id613002203036_4_bot');
    if (!dormantPrimaryBot) {
      throw new Error('standby bot fixture missing');
    }
    dormantPrimaryBot.state = 'dormant';
    fixture.chats.set('chat-ineligible-primary', {
      id: 'chat-ineligible-primary',
      title: 'Shared transition chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_4_bot',
    });
    fixture.memberships.push({
      chatId: 'chat-ineligible-primary',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-05-09T10:00:00.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      },
      createdAt: new Date('2026-05-09T10:00:00.000Z'),
      updatedAt: new Date('2026-05-09T10:00:00.000Z'),
      lastSeenAt: new Date('2026-05-09T10:00:00.000Z'),
      lastWebhookAt: new Date('2026-05-09T10:00:00.000Z'),
    });

    await expect(
      fixture.service.reconcileChatPrimaryByAccess({ chatId: 'chat-ineligible-primary' }),
    ).resolves.toBe('id613002203036_bot');

    expect(fixture.chats.get('chat-ineligible-primary')).toEqual(
      expect.objectContaining({
        botId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_bot',
      }),
    );
  });

  it('prefers a standby bot with confirmed admin access for member-access lookups', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-1', {
      id: 'channel-1',
      title: 'Shared channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'channel-1',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:00.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
        createdAt: new Date('2026-03-30T10:00:00.000Z'),
        updatedAt: new Date('2026-03-30T10:00:00.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:00.000Z'),
      },
      {
        chatId: 'channel-1',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-03-30T10:00:01.000Z'),
        updatedAt: new Date('2026-03-30T10:00:01.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForMemberAccess({ chatId: 'channel-1' }),
    ).resolves.toBe('id613002203036_4_bot');
  });

  it('uses an operational draining bot for member-access reads instead of a dormant primary', async () => {
    const fixture = createServiceFixture();
    const primaryBot = fixture.bots.find((bot) => bot.id === 'id613002203036_bot');
    const standbyBot = fixture.bots.find((bot) => bot.id === 'id613002203036_4_bot');
    if (!primaryBot || !standbyBot) {
      throw new Error('bot fixture missing');
    }
    primaryBot.state = 'dormant';
    standbyBot.state = 'draining';
    fixture.chats.set('channel-operational-read', {
      id: 'channel-operational-read',
      title: 'Shared channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'channel-operational-read',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-26T08:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-05-26T08:00:00.000Z'),
        updatedAt: new Date('2026-05-26T08:00:00.000Z'),
        lastSeenAt: new Date('2026-05-26T08:00:00.000Z'),
        lastWebhookAt: new Date('2026-05-26T08:00:00.000Z'),
      },
      {
        chatId: 'channel-operational-read',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-26T08:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-05-26T08:00:01.000Z'),
        updatedAt: new Date('2026-05-26T08:00:01.000Z'),
        lastSeenAt: new Date('2026-05-26T08:00:01.000Z'),
        lastWebhookAt: new Date('2026-05-26T08:00:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForMemberAccess({ chatId: 'channel-operational-read' }),
    ).resolves.toBe('id613002203036_4_bot');
  });

  it('reuses the member-access route for generic chat reads when the primary bot lost access', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-read-1', {
      id: 'channel-read-1',
      title: 'Readable channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'channel-read-1',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:00.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
        createdAt: new Date('2026-03-30T10:00:00.000Z'),
        updatedAt: new Date('2026-03-30T10:00:00.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:00.000Z'),
      },
      {
        chatId: 'channel-read-1',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-03-30T10:00:01.000Z'),
        updatedAt: new Date('2026-03-30T10:00:01.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:01.000Z'),
      },
    );

    await expect(fixture.service.resolveBotIdForRead({ chatId: 'channel-read-1' })).resolves.toBe(
      'id613002203036_4_bot',
    );
  });

  it('returns a structured read route with provenance for generic chat reads', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-read-route-1', {
      id: 'channel-read-route-1',
      title: 'Readable channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'channel-read-route-1',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:00.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
        createdAt: new Date('2026-03-30T10:00:00.000Z'),
        updatedAt: new Date('2026-03-30T10:00:00.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:00.000Z'),
      },
      {
        chatId: 'channel-read-route-1',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-03-30T10:00:01.000Z'),
        updatedAt: new Date('2026-03-30T10:00:01.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotRoute({
        purpose: 'read',
        chatId: 'channel-read-route-1',
      }),
    ).resolves.toMatchObject({
      purpose: 'read',
      chatId: 'channel-read-route-1',
      primaryBotId: 'id613002203036_4_bot',
      botId: 'id613002203036_4_bot',
      candidateBotIds: ['id613002203036_4_bot'],
      reason: 'primary_confirmed',
    });
  });

  it('uses the send-message route for write delivery instead of generic read fallback', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-send-route-1', {
      id: 'channel-send-route-1',
      title: 'Writable channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'channel-send-route-1',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:00.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
        createdAt: new Date('2026-03-30T10:00:00.000Z'),
        updatedAt: new Date('2026-03-30T10:00:00.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:00.000Z'),
      },
      {
        chatId: 'channel-send-route-1',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        },
        createdAt: new Date('2026-03-30T10:00:01.000Z'),
        updatedAt: new Date('2026-03-30T10:00:01.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotRoute({
        purpose: 'send_message',
        chatId: 'channel-send-route-1',
      }),
    ).resolves.toMatchObject({
      purpose: 'send_message',
      chatId: 'channel-send-route-1',
      primaryBotId: 'id613002203036_4_bot',
      botId: 'id613002203036_4_bot',
      candidateBotIds: ['id613002203036_4_bot'],
      reason: 'primary_confirmed',
    });
  });

  it('does not treat channel admin status without write permission as send access', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-send-no-write', {
      id: 'channel-send-no-write',
      title: 'Read-only channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHANNEL',
    });
    fixture.memberships.push({
      chatId: 'channel-send-no-write',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-03-30T10:00:00.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['edit'],
      },
      createdAt: new Date('2026-03-30T10:00:00.000Z'),
      updatedAt: new Date('2026-03-30T10:00:00.000Z'),
      lastSeenAt: new Date('2026-03-30T10:00:00.000Z'),
      lastWebhookAt: new Date('2026-03-30T10:00:00.000Z'),
    });

    await expect(
      fixture.service.resolveBotRoute({
        purpose: 'send_message',
        chatId: 'channel-send-no-write',
        fallbackToPrimary: false,
      }),
    ).resolves.toMatchObject({ botId: null, candidateBotIds: [] });
  });

  it('selects a channel poll bot only with confirmed write and edit permissions', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-poll-route', {
      id: 'channel-poll-route',
      title: 'Poll channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHANNEL',
    });
    fixture.memberships.push(
      createActiveMembership('channel-poll-route', 'id613002203036_bot', 0, {
        role: ChatBotMembershipRole.PRIMARY,
        permissionsSnapshot: {
          checkedAt: '2026-07-10T10:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        },
      }),
      createActiveMembership('channel-poll-route', 'id613002203036_4_bot', 1, {
        permissionsSnapshot: {
          checkedAt: '2026-07-10T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['write', 'edit'],
        },
      }),
      createActiveMembership('channel-poll-route', 'id613002203036_5_bot', 2, {
        permissionsSnapshot: {
          checkedAt: '2026-07-10T10:00:02.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['write', 'edit'],
        },
      }),
    );

    await expect(
      fixture.service.resolveBotIdForChannelPoll({ chatId: 'channel-poll-route' }),
    ).resolves.toBe('id613002203036_4_bot');
    await expect(
      fixture.service.resolveBotRouteForChannelPoll({ chatId: 'channel-poll-route' }),
    ).resolves.toMatchObject({
      botId: 'id613002203036_4_bot',
      candidateBotIds: ['id613002203036_4_bot', 'id613002203036_5_bot'],
    });
  });

  it('rejects split or unknown channel poll permissions', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-poll-split', {
      id: 'channel-poll-split',
      title: 'Split poll channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHANNEL',
    });
    fixture.memberships.push(
      createActiveMembership('channel-poll-split', 'id613002203036_bot', 0, {
        role: ChatBotMembershipRole.PRIMARY,
        permissionsSnapshot: {
          checkedAt: '2026-07-10T10:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        },
      }),
      createActiveMembership('channel-poll-split', 'id613002203036_4_bot', 1, {
        permissionsSnapshot: {
          checkedAt: '2026-07-10T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['edit'],
        },
      }),
    );

    await expect(
      fixture.service.resolveBotIdForChannelPoll({ chatId: 'channel-poll-split' }),
    ).resolves.toBeNull();
  });

  it('keeps an explicit denied stored primary out of route fallbacks', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-denied-primary-fallbacks', {
      id: 'chat-denied-primary-fallbacks',
      title: 'Denied primary fallbacks',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      createActiveMembership('chat-denied-primary-fallbacks', 'id613002203036_bot', 0, {
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:30.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
      }),
      createActiveMembership('chat-denied-primary-fallbacks', 'id613002203036_4_bot', 1, {
        capabilities: ['suggestion_delivery'],
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:31.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['write', 'read_all_messages'],
        },
      }),
    );

    await expect(
      fixture.service.resolveBotRoute({
        purpose: 'send_message',
        chatId: 'chat-denied-primary-fallbacks',
      }),
    ).resolves.toMatchObject({
      primaryBotId: 'id613002203036_4_bot',
      botId: 'id613002203036_4_bot',
      candidateBotIds: ['id613002203036_4_bot'],
    });
    await expect(
      fixture.service.resolveBotIdsForCapability({
        chatId: 'chat-denied-primary-fallbacks',
        capability: 'suggestion_delivery',
      }),
    ).resolves.toEqual(['id613002203036_4_bot']);
  });

  it('does not fall back to a draining primary bot for send-message routes', async () => {
    const fixture = createServiceFixture();
    const primaryBot = fixture.bots.find((bot) => bot.id === 'id613002203036_bot');
    if (!primaryBot) {
      throw new Error('primary bot fixture missing');
    }
    primaryBot.state = 'draining';
    fixture.chats.set('channel-draining-send-route', {
      id: 'channel-draining-send-route',
      title: 'Writable channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push({
      chatId: 'channel-draining-send-route',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-05-26T10:00:00.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      },
      createdAt: new Date('2026-05-26T10:00:00.000Z'),
      updatedAt: new Date('2026-05-26T10:00:00.000Z'),
      lastSeenAt: new Date('2026-05-26T10:00:00.000Z'),
      lastWebhookAt: new Date('2026-05-26T10:00:00.000Z'),
    });

    await expect(
      fixture.service.resolveBotRoute({
        purpose: 'send_message',
        chatId: 'channel-draining-send-route',
      }),
    ).resolves.toMatchObject({
      purpose: 'send_message',
      chatId: 'channel-draining-send-route',
      primaryBotId: null,
      botId: null,
      candidateBotIds: [],
      reason: null,
    });
  });

  it('falls back to the active bot context for chat reads when no binding exists yet', async () => {
    const fixture = createServiceFixture();
    fixture.botContext.getActiveBotId.mockReturnValue('id613002203036_4_bot');

    await expect(fixture.service.resolveBotIdForRead({ chatId: 'missing-chat' })).resolves.toBe(
      'id613002203036_4_bot',
    );
  });

  it('prefers a bot with complete chat delete access when the primary snapshot lacks it', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-3', {
      id: 'chat-3',
      title: 'Moderated chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-3',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-06T21:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'change_chat_info'],
        },
        createdAt: new Date('2026-04-06T21:00:00.000Z'),
        updatedAt: new Date('2026-04-06T21:00:00.000Z'),
        lastSeenAt: new Date('2026-04-06T21:00:00.000Z'),
        lastWebhookAt: new Date('2026-04-06T21:00:00.000Z'),
      },
      {
        chatId: 'chat-3',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-06T21:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'post_edit_delete_message'],
        },
        createdAt: new Date('2026-04-06T21:00:01.000Z'),
        updatedAt: new Date('2026-04-06T21:00:01.000Z'),
        lastSeenAt: new Date('2026-04-06T21:00:01.000Z'),
        lastWebhookAt: new Date('2026-04-06T21:00:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId: 'chat-3',
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toBe('id613002203036_4_bot');
  });

  it.each([
    {
      label: 'accepts chat admin write access',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'write'],
      expected: true,
    },
    {
      label: 'accepts the legacy chat post-edit-delete permission for an owner',
      entityType: ChatEntityType.CHAT,
      isAdmin: false,
      isOwner: true,
      permissions: ['read_all_messages', 'post_edit_delete_message'],
      expected: true,
    },
    {
      label: 'rejects delete-only access in a chat',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'delete'],
      expected: false,
    },
    {
      label: 'accepts chat write access without read-all',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      expected: true,
    },
    {
      label: 'rejects a non-admin chat member with both action permissions',
      entityType: ChatEntityType.CHAT,
      isAdmin: false,
      isOwner: false,
      permissions: ['read_all_messages', 'write'],
      expected: false,
    },
    {
      label: 'accepts channel admin delete access',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'delete'],
      expected: true,
    },
    {
      label: 'accepts the legacy channel delete-message permission for an owner',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: false,
      isOwner: true,
      permissions: ['read_all_messages', 'delete_message'],
      expected: true,
    },
    {
      label: 'rejects channel write access',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'write'],
      expected: false,
    },
    {
      label: 'rejects the chat legacy permission in a channel',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'post_edit_delete_message'],
      expected: false,
    },
    {
      label: 'accepts channel delete access without read-all',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['delete'],
      expected: true,
    },
  ])('$label', async ({ entityType, isAdmin, isOwner, permissions, expected }) => {
    const fixture = createServiceFixture();
    const chatId = `delete-matrix-${entityType}-${permissions.join('-')}-${String(isOwner)}`;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Delete capability matrix',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType,
    });
    fixture.memberships.push({
      chatId,
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-05-09T10:04:00.000Z',
        isAdmin,
        isOwner,
        permissions,
      },
      createdAt: new Date('2026-05-09T10:04:00.000Z'),
      updatedAt: new Date('2026-05-09T10:04:00.000Z'),
      lastSeenAt: new Date('2026-05-09T10:04:00.000Z'),
      lastWebhookAt: new Date('2026-05-09T10:04:00.000Z'),
    });

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId,
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toBe(expected ? 'id613002203036_bot' : null);
  });

  it('routes through a fresh confirmed capability even while stored routing is not ready', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-fresh-delete-capability';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Fresh delete capability',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      routingVersion: 9,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, 'id613002203036_bot', 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:19:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
      }),
    );

    await expect(
      fixture.service.resolveDeleteMessageBotRoute({ chatId, requireFreshSnapshot: true }),
    ).resolves.toMatchObject({
      botId: 'id613002203036_bot',
      candidateBotIds: ['id613002203036_bot'],
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      routingVersion: 9,
      capabilityState: 'confirmed_capable',
      capabilityReason: 'confirmed',
      checkedAt: '2026-05-09T10:04:00.000Z',
      expiresAt: '2026-05-09T10:19:00.000Z',
      candidateCapabilities: [
        expect.objectContaining({
          botId: 'id613002203036_bot',
          state: 'confirmed_capable',
          reason: 'confirmed',
          routeEligible: true,
        }),
      ],
    });
  });

  it('distinguishes a stale capability and only exposes it through an explicit soft fallback', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-stale-delete-capability';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Stale delete capability',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, 'id613002203036_bot', 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T09:00:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T09:15:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T09:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
      }),
    );

    const strictRoute = await fixture.service.resolveDeleteMessageBotRoute({
      chatId,
      requireFreshSnapshot: true,
    });
    const softRoute = await fixture.service.resolveDeleteMessageBotRoute({
      chatId,
      requireFreshSnapshot: false,
    });

    expect(strictRoute).toMatchObject({
      botId: null,
      candidateBotIds: [],
      capabilityState: 'stale_or_unknown',
      capabilityReason: 'snapshot_stale',
    });
    expect(softRoute).toMatchObject({
      botId: 'id613002203036_bot',
      candidateBotIds: ['id613002203036_bot'],
      reason: 'primary_soft',
      capabilityState: 'stale_or_unknown',
      capabilityReason: 'snapshot_stale',
    });
  });

  it('prefers a fresh confirmed alternate over a stale primary in soft-fallback mode', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-mixed-delete-capabilities';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Mixed delete capabilities',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, 'id613002203036_bot', 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T09:00:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T09:15:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T09:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
      }),
      createActiveMembership(chatId, 'id613002203036_4_bot', 1, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:19:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
      }),
    );

    await expect(
      fixture.service.resolveDeleteMessageBotRoute({
        chatId,
        requireFreshSnapshot: false,
      }),
    ).resolves.toMatchObject({
      botId: 'id613002203036_4_bot',
      candidateBotIds: ['id613002203036_4_bot', 'id613002203036_bot'],
      reason: 'alternate_confirmed',
      capabilityState: 'confirmed_capable',
      capabilityReason: 'confirmed',
    });
  });

  it('keeps a fresh explicit channel permission failure out of strict and soft routes', async () => {
    const fixture = createServiceFixture();
    const chatId = 'channel-explicit-delete-incapable';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Write-only channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: ChatEntityType.CHANNEL,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, 'id613002203036_bot', 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:19:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
      }),
    );

    await expect(
      fixture.service.resolveDeleteMessageBotRoute({
        chatId,
        requireFreshSnapshot: false,
      }),
    ).resolves.toMatchObject({
      botId: null,
      candidateBotIds: [],
      capabilityState: 'explicitly_incapable',
      capabilityReason: 'missing_channel_delete_permission',
      candidateCapabilities: [
        expect.objectContaining({
          routeEligible: false,
          state: 'explicitly_incapable',
          reason: 'missing_channel_delete_permission',
        }),
      ],
    });
  });

  it('requires an explicit MAX edit permission for channel post edits', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-edit', {
      id: 'channel-edit',
      title: 'Editable channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHANNEL',
    });
    fixture.memberships.push({
      chatId: 'channel-edit',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-04-06T21:00:00.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['write', 'edit'],
      },
      createdAt: new Date('2026-04-06T21:00:00.000Z'),
      updatedAt: new Date('2026-04-06T21:00:00.000Z'),
      lastSeenAt: new Date('2026-04-06T21:00:00.000Z'),
      lastWebhookAt: new Date('2026-04-06T21:00:00.000Z'),
    });

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId: 'channel-edit',
        action: 'edit_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toBe('id613002203036_bot');
  });

  it('does not use channel write permission as edit permission', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-no-edit', {
      id: 'channel-no-edit',
      title: 'Write-only channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHANNEL',
    });
    fixture.memberships.push({
      chatId: 'channel-no-edit',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-04-06T21:00:00.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      },
      createdAt: new Date('2026-04-06T21:00:00.000Z'),
      updatedAt: new Date('2026-04-06T21:00:00.000Z'),
      lastSeenAt: new Date('2026-04-06T21:00:00.000Z'),
      lastWebhookAt: new Date('2026-04-06T21:00:00.000Z'),
    });

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId: 'channel-no-edit',
        action: 'edit_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toBeNull();
  });

  it('does not treat non-empty admin permissions as delete-capable without a delete alias', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-4', {
      id: 'chat-4',
      title: 'Restricted chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-4',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-06T21:10:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-04-06T21:10:00.000Z'),
        updatedAt: new Date('2026-04-06T21:10:00.000Z'),
        lastSeenAt: new Date('2026-04-06T21:10:00.000Z'),
        lastWebhookAt: new Date('2026-04-06T21:10:00.000Z'),
      },
      {
        chatId: 'chat-4',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-06T21:10:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['change_chat_info'],
        },
        createdAt: new Date('2026-04-06T21:10:01.000Z'),
        updatedAt: new Date('2026-04-06T21:10:01.000Z'),
        lastSeenAt: new Date('2026-04-06T21:10:01.000Z'),
        lastWebhookAt: new Date('2026-04-06T21:10:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId: 'chat-4',
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toBeNull();
  });

  it('does not use fallback candidates whose explicit snapshot lacks delete permission', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-fallback-delete-limited', {
      id: 'chat-fallback-delete-limited',
      title: 'Restricted chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHAT',
    });
    fixture.memberships.push({
      chatId: 'chat-fallback-delete-limited',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-07-06T09:40:01.508Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members', 'read_all_messages', 'pin_message', 'can_call'],
        health: 'ok',
      },
      createdAt: new Date('2026-07-06T09:40:01.508Z'),
      updatedAt: new Date('2026-07-06T09:40:01.508Z'),
      lastSeenAt: new Date('2026-07-06T09:40:01.508Z'),
      lastWebhookAt: new Date('2026-07-06T09:40:01.508Z'),
    });

    await expect(
      fixture.service.resolveBotIdsForModerationAction({
        chatId: 'chat-fallback-delete-limited',
        action: 'delete_message',
      }),
    ).resolves.toEqual([]);
  });

  it('does not fall back to a bot whose refreshed snapshot marks delete as action-limited', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-action-limited', {
      id: 'chat-action-limited',
      title: 'Restricted chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push({
      chatId: 'chat-action-limited',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-05-15T00:23:29.333Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members', 'read_all_messages'],
        health: 'action_limited',
        missingActions: ['delete_message'],
      },
      createdAt: new Date('2026-05-15T00:23:29.333Z'),
      updatedAt: new Date('2026-05-15T00:23:29.333Z'),
      lastSeenAt: new Date('2026-05-15T00:23:29.333Z'),
      lastWebhookAt: new Date('2026-05-15T00:23:28.984Z'),
    });

    await expect(
      fixture.service.resolveBotIdsForModerationAction({
        chatId: 'chat-action-limited',
        action: 'delete_message',
      }),
    ).resolves.toEqual([]);
  });

  it('returns null for member moderation when every active bot explicitly lacks the permission', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-4', {
      id: 'chat-4',
      title: 'Restricted chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-4',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-06T21:10:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-04-06T21:10:00.000Z'),
        updatedAt: new Date('2026-04-06T21:10:00.000Z'),
        lastSeenAt: new Date('2026-04-06T21:10:00.000Z'),
        lastWebhookAt: new Date('2026-04-06T21:10:00.000Z'),
      },
      {
        chatId: 'chat-4',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-06T21:10:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['change_chat_info'],
        },
        createdAt: new Date('2026-04-06T21:10:01.000Z'),
        updatedAt: new Date('2026-04-06T21:10:01.000Z'),
        lastSeenAt: new Date('2026-04-06T21:10:01.000Z'),
        lastWebhookAt: new Date('2026-04-06T21:10:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId: 'chat-4',
        action: 'moderate_member',
        fallbackToPrimary: false,
      }),
    ).resolves.toBeNull();
  });

  it('falls back to a standby bot with unknown permissions when the active primary is not an admin', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-5', {
      id: 'chat-5',
      title: 'Shared restricted chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-5',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-07T00:20:00.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
        createdAt: new Date('2026-04-07T00:20:00.000Z'),
        updatedAt: new Date('2026-04-07T00:20:00.000Z'),
        lastSeenAt: new Date('2026-04-07T00:20:00.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:20:00.000Z'),
      },
      {
        chatId: 'chat-5',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: null,
        createdAt: new Date('2026-04-07T00:20:01.000Z'),
        updatedAt: new Date('2026-04-07T00:20:01.000Z'),
        lastSeenAt: new Date('2026-04-07T00:20:01.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:20:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId: 'chat-5',
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toBe('id613002203036_4_bot');
  });

  it('still falls back to a standby bot with unknown permissions when there is no active primary membership', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-6', {
      id: 'chat-6',
      title: 'Standby-only chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-6',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.REMOVED,
        permissionsSnapshot: {
          checkedAt: '2026-04-07T00:30:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-04-07T00:30:00.000Z'),
        updatedAt: new Date('2026-04-07T00:30:00.000Z'),
        lastSeenAt: new Date('2026-04-07T00:30:00.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:30:00.000Z'),
      },
      {
        chatId: 'chat-6',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: null,
        createdAt: new Date('2026-04-07T00:30:01.000Z'),
        updatedAt: new Date('2026-04-07T00:30:01.000Z'),
        lastSeenAt: new Date('2026-04-07T00:30:01.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:30:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId: 'chat-6',
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toBe('id613002203036_4_bot');
  });

  it('excludes primary moderation action candidates that explicitly lack delete permission', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-7', {
      id: 'chat-7',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-7',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-07T00:40:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-04-07T00:40:00.000Z'),
        updatedAt: new Date('2026-04-07T00:40:00.000Z'),
        lastSeenAt: new Date('2026-04-07T00:40:00.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:40:00.000Z'),
      },
      {
        chatId: 'chat-7',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-07T00:40:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
        createdAt: new Date('2026-04-07T00:40:01.000Z'),
        updatedAt: new Date('2026-04-07T00:40:01.000Z'),
        lastSeenAt: new Date('2026-04-07T00:40:01.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:40:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdsForModerationAction({
        chatId: 'chat-7',
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toEqual(['id613002203036_4_bot']);
  });

  it('does not route moderation actions to a draining standby bot', async () => {
    const fixture = createServiceFixture();
    const standbyBot = fixture.bots.find((bot) => bot.id === 'id613002203036_4_bot');
    if (!standbyBot) {
      throw new Error('standby bot fixture missing');
    }
    standbyBot.state = 'draining';
    fixture.chats.set('chat-draining-action', {
      id: 'chat-draining-action',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-draining-action',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-26T09:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-05-26T09:00:00.000Z'),
        updatedAt: new Date('2026-05-26T09:00:00.000Z'),
        lastSeenAt: new Date('2026-05-26T09:00:00.000Z'),
        lastWebhookAt: new Date('2026-05-26T09:00:00.000Z'),
      },
      {
        chatId: 'chat-draining-action',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-26T09:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
        createdAt: new Date('2026-05-26T09:00:01.000Z'),
        updatedAt: new Date('2026-05-26T09:00:01.000Z'),
        lastSeenAt: new Date('2026-05-26T09:00:01.000Z'),
        lastWebhookAt: new Date('2026-05-26T09:00:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdsForModerationAction({
        chatId: 'chat-draining-action',
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toEqual([]);
  });

  it('does not route assist capabilities to a draining standby bot', async () => {
    const fixture = createServiceFixture();
    const standbyBot = fixture.bots.find((bot) => bot.id === 'id613002203036_4_bot');
    if (!standbyBot) {
      throw new Error('standby bot fixture missing');
    }
    standbyBot.state = 'draining';
    fixture.chats.set('chat-draining-capability', {
      id: 'chat-draining-capability',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-draining-capability',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-05-26T09:10:00.000Z'),
        updatedAt: new Date('2026-05-26T09:10:00.000Z'),
        lastSeenAt: new Date('2026-05-26T09:10:00.000Z'),
        lastWebhookAt: new Date('2026-05-26T09:10:00.000Z'),
      },
      {
        chatId: 'chat-draining-capability',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        capabilities: ['suggestion_delivery'],
        createdAt: new Date('2026-05-26T09:10:01.000Z'),
        updatedAt: new Date('2026-05-26T09:10:01.000Z'),
        lastSeenAt: new Date('2026-05-26T09:10:01.000Z'),
        lastWebhookAt: new Date('2026-05-26T09:10:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForCapability({
        chatId: 'chat-draining-capability',
        capability: 'suggestion_delivery',
        fallbackToPrimary: false,
      }),
    ).resolves.toBeNull();
  });

  it('returns a structured moderation route for the confirmed delete-capable bot', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-route-7', {
      id: 'chat-route-7',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-route-7',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-07T00:40:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-04-07T00:40:00.000Z'),
        updatedAt: new Date('2026-04-07T00:40:00.000Z'),
        lastSeenAt: new Date('2026-04-07T00:40:00.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:40:00.000Z'),
      },
      {
        chatId: 'chat-route-7',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-07T00:40:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
        createdAt: new Date('2026-04-07T00:40:01.000Z'),
        updatedAt: new Date('2026-04-07T00:40:01.000Z'),
        lastSeenAt: new Date('2026-04-07T00:40:01.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:40:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotRoutes({
        purpose: 'moderation_action',
        chatId: 'chat-route-7',
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toMatchObject({
      purpose: 'moderation_action',
      chatId: 'chat-route-7',
      primaryBotId: 'id613002203036_bot',
      botId: 'id613002203036_4_bot',
      candidateBotIds: ['id613002203036_4_bot'],
      reason: 'alternate_confirmed',
      action: 'delete_message',
    });
  });

  it('touches observed shared-bot membership without rewriting the chat row on every webhook', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-8', {
      id: 'chat-8',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push({
      chatId: 'chat-8',
      botId: 'id613002203036_4_bot',
      role: ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: null,
      createdAt: new Date('2026-05-09T09:00:00.000Z'),
      updatedAt: new Date('2026-05-09T09:00:00.000Z'),
      lastSeenAt: null,
      lastWebhookAt: null,
    });

    await fixture.service.observeStoredChatBotWebhook({
      chatId: 'chat-8',
      primaryBotId: 'id613002203036_bot',
      botId: 'id613002203036_4_bot',
    });
    await fixture.service.observeStoredChatBotWebhook({
      chatId: 'chat-8',
      primaryBotId: 'id613002203036_bot',
      botId: 'id613002203036_4_bot',
    });

    expect(fixture.prisma.chat.update).not.toHaveBeenCalled();
    expect(fixture.prisma.chatBotMembership.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.chatBotMembership.updateMany).toHaveBeenCalledTimes(1);
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_4_bot'),
    ).toEqual(
      expect.objectContaining({
        chatId: 'chat-8',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastWebhookAt: expect.any(Date),
      }),
    );
  });

  it('touches an active mirrored membership without promoting it when the chat has no primary', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-route-gap-touch', {
      id: 'chat-route-gap-touch',
      title: 'Route gap chat',
      botId: null,
      primaryBotId: null,
    });
    fixture.memberships.push({
      chatId: 'chat-route-gap-touch',
      botId: 'id613002203036_4_bot',
      role: ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: null,
      createdAt: new Date('2026-05-09T09:00:00.000Z'),
      updatedAt: new Date('2026-05-09T09:00:00.000Z'),
      lastSeenAt: null,
      lastWebhookAt: null,
    });

    await fixture.service.observeStoredChatBotWebhook({
      chatId: 'chat-route-gap-touch',
      primaryBotId: null,
      botId: 'id613002203036_4_bot',
      observedAt: new Date('2026-05-09T09:05:00.000Z'),
    });

    expect(fixture.memberships[0]).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastSeenAt: new Date('2026-05-09T09:05:00.000Z'),
        lastWebhookAt: new Date('2026-05-09T09:05:00.000Z'),
      }),
    );
  });

  it('does not reactivate or clear access loss on an ordinary webhook after bot removal', async () => {
    const fixture = createServiceFixture();
    const removedAt = new Date('2026-05-09T09:00:00.123Z');
    const accessLossSnapshot = {
      accessLostAt: removedAt.toISOString(),
      accessLostReason: 'bot_removed',
    };
    fixture.chats.set('chat-lifecycle-observe', {
      id: 'chat-lifecycle-observe',
      title: 'Lifecycle chat',
      botId: null,
      primaryBotId: null,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
    });
    fixture.memberships.push({
      chatId: 'chat-lifecycle-observe',
      botId: 'id613002203036_4_bot',
      role: ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.REMOVED,
      permissionsSnapshot: accessLossSnapshot,
      botAccessState: ChatBotAccessState.DENIED,
      lifecycleEventAt: removedAt,
      lifecycleEventType: 'bot_removed',
      lifecycleSource: 'webhook',
      createdAt: removedAt,
      updatedAt: removedAt,
      lastSeenAt: removedAt,
      lastWebhookAt: removedAt,
    });

    await fixture.service.observeStoredChatBotWebhook({
      chatId: 'chat-lifecycle-observe',
      primaryBotId: null,
      botId: 'id613002203036_4_bot',
      observedAt: new Date('2026-05-09T09:05:00.456Z'),
    });

    expect(fixture.memberships[0]).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.REMOVED,
        permissionsSnapshot: accessLossSnapshot,
        botAccessState: ChatBotAccessState.DENIED,
        lifecycleEventAt: removedAt,
        lifecycleEventType: 'bot_removed',
        lastWebhookAt: removedAt,
      }),
    );
  });

  it('keeps removal precedence for old or equal bot_added and permits only a newer re-add', async () => {
    const fixture = createServiceFixture();
    const botId = 'id613002203036_4_bot';
    const removedAt = new Date('2026-05-09T09:00:00.456Z');
    fixture.chats.set('chat-lifecycle-readd', {
      id: 'chat-lifecycle-readd',
      title: 'Lifecycle chat',
      botId: null,
      primaryBotId: null,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
    });
    fixture.memberships.push({
      chatId: 'chat-lifecycle-readd',
      botId,
      role: ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.REMOVED,
      permissionsSnapshot: { accessLostAt: removedAt.toISOString() },
      botAccessState: ChatBotAccessState.LOST,
      lifecycleEventAt: removedAt,
      lifecycleEventType: 'bot_removed',
      lifecycleSource: 'webhook',
      createdAt: removedAt,
      updatedAt: removedAt,
      lastSeenAt: removedAt,
      lastWebhookAt: removedAt,
    });

    for (const lifecycleEventAt of [new Date('2026-05-09T08:59:59.999Z'), new Date(removedAt)]) {
      await expect(
        fixture.service.bindChatToBot({
          chatId: 'chat-lifecycle-readd',
          title: 'Lifecycle chat',
          entityType: ChatEntityType.CHAT,
          botId,
          lifecycleEventAt,
          lifecycleEventType: 'bot_added',
          lifecycleSource: 'webhook',
        }),
      ).resolves.toBeNull();
      expect(fixture.memberships[0]).toEqual(
        expect.objectContaining({
          status: ChatBotMembershipStatus.REMOVED,
          lifecycleEventAt: removedAt,
          lifecycleEventType: 'bot_removed',
          botAccessState: ChatBotAccessState.LOST,
        }),
      );
      expect(fixture.chats.get('chat-lifecycle-readd')?.routingState).toBe(
        ChatRoutingState.NO_ELIGIBLE_BOT,
      );
    }

    const readdedAt = new Date('2026-05-09T09:00:00.457Z');
    await expect(
      fixture.service.bindChatToBot({
        chatId: 'chat-lifecycle-readd',
        title: 'Lifecycle chat',
        entityType: ChatEntityType.CHAT,
        botId,
        lifecycleEventAt: readdedAt,
        lifecycleEventType: 'bot_added',
        lifecycleSource: 'webhook',
      }),
    ).resolves.toBe(botId);

    expect(fixture.memberships[0]).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.ACTIVE,
        lifecycleEventAt: readdedAt,
        lifecycleEventType: 'bot_added',
        botAccessState: ChatBotAccessState.UNKNOWN,
        permissionsSnapshot: Prisma.JsonNull,
      }),
    );
    expect(fixture.chats.get('chat-lifecycle-readd')?.routingState).toBe(ChatRoutingState.READY);

    Object.assign(fixture.memberships[0]!, {
      botAccessState: ChatBotAccessState.DENIED,
      permissionsSnapshot: {
        checkedAt: '2026-05-09T09:01:00.000Z',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      },
    });
    fixture.chats.get('chat-lifecycle-readd')!.routingState = ChatRoutingState.NO_ELIGIBLE_BOT;
    await fixture.service.bindChatToBot({
      chatId: 'chat-lifecycle-readd',
      title: 'Lifecycle chat',
      entityType: ChatEntityType.CHAT,
      botId,
      lifecycleEventAt: readdedAt,
      lifecycleEventType: 'bot_added',
      lifecycleSource: 'webhook',
    });
    expect(fixture.chats.get('chat-lifecycle-readd')?.routingState).toBe(
      ChatRoutingState.NO_ELIGIBLE_BOT,
    );
  });

  it('preserves lifecycle fencing across every delivery order of add, message, removal, duplicate, and re-add', async () => {
    const eventKinds = ['add', 'message', 'remove', 'remove-duplicate', 'readd'] as const;
    const addedAt = new Date('2026-05-09T09:00:00.123Z');
    const messageAt = new Date('2026-05-09T09:00:00.234Z');
    const removedAt = new Date('2026-05-09T09:00:00.456Z');
    const readdedAt = new Date('2026-05-09T09:00:00.789Z');

    for (const deliveryOrder of permutations(eventKinds)) {
      const fixture = createServiceFixture();
      const chatId = `chat-lifecycle-permutation-${deliveryOrder.join('-')}`;
      const botId = fixture.bots[0]!.id;

      for (const eventKind of deliveryOrder) {
        if (eventKind === 'message') {
          await fixture.service.observeStoredChatBotWebhook({
            chatId,
            primaryBotId: null,
            botId,
            observedAt: messageAt,
          });
          continue;
        }
        if (eventKind === 'remove' || eventKind === 'remove-duplicate') {
          await fixture.service.markChatBotRemoved({
            chatId,
            botId,
            title: 'Lifecycle permutation',
            entityType: ChatEntityType.CHAT,
            lifecycleEventAt: removedAt,
            lifecycleEventType: 'bot_removed',
            lifecycleSource: 'webhook',
          });
          continue;
        }

        const lifecycleEventAt = eventKind === 'readd' ? readdedAt : addedAt;
        await fixture.service.bindChatToBot({
          chatId,
          botId,
          title: 'Lifecycle permutation',
          entityType: ChatEntityType.CHAT,
          lifecycleEventAt,
          lifecycleEventType: 'bot_added',
          lifecycleSource: 'webhook',
        });
      }

      const membership = fixture.memberships.find(
        (candidate) => candidate.chatId === chatId && candidate.botId === botId,
      );
      expect(membership).toEqual(
        expect.objectContaining({
          status: ChatBotMembershipStatus.ACTIVE,
          lifecycleEventAt: readdedAt,
          lifecycleEventType: 'bot_added',
        }),
      );
    }
  });

  it('preserves confirmed access and reopens after a successful live probe', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-live-probe-readd';
    const botId = fixture.bots[0]!.id;
    const probeAt = new Date('2026-05-09T10:04:30.000Z');
    const expiresAt = new Date('2026-05-09T10:20:00.000Z');
    const confirmedSnapshot = {
      checkedAt: probeAt.toISOString(),
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    };
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Probe recovery',
      botId: null,
      primaryBotId: null,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      routingVersion: 2,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        status: ChatBotMembershipStatus.REMOVED,
        role: ChatBotMembershipRole.STANDBY,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: probeAt,
        botAccessExpiresAt: expiresAt,
        permissionsSnapshot: confirmedSnapshot,
        lifecycleEventAt: new Date('2026-05-09T09:00:00.000Z'),
        lifecycleEventType: 'bot_removed',
      }),
    );

    await expect(
      fixture.service.bindChatToBot({
        chatId,
        title: 'Probe recovery',
        entityType: ChatEntityType.CHAT,
        botId,
        allowReassign: true,
        lifecycleEventAt: probeAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      }),
    ).resolves.toBe(botId);

    expect(fixture.memberships[0]).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessExpiresAt: expiresAt,
        permissionsSnapshot: confirmedSnapshot,
      }),
    );
    expect(fixture.chats.get(chatId)?.routingState).toBe(ChatRoutingState.READY);
  });

  it('builds entry mini app links through the canonical entry bot', () => {
    const fixture = createServiceFixture();

    const url = fixture.service.buildEntryMiniappStartUrlSync('route_abc');

    expect(url).toBe('https://max.ru/id613002203036_bot?startapp=route_abc');
  });
});
