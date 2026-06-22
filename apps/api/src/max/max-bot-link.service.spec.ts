import {
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  type ChatEntityType,
} from '../prisma/prisma-client';
import { MaxBotLinkService } from './max-bot-link.service';

type MutableChat = {
  id: string;
  title: string;
  botId: string | null;
  primaryBotId: string | null;
  entityType?: ChatEntityType;
};

type MutableMembership = {
  chatId: string;
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  capabilities?: unknown;
  permissionsSnapshot?: unknown;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date | null;
  lastWebhookAt: Date | null;
};

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
          primaryBotId: chat.primaryBotId,
          botId: chat.botId,
          botMemberships: memberships
            .filter((membership) => membership.chatId === where.id)
            .map((membership) => ({
              botId: membership.botId,
              role: membership.role,
              status: membership.status,
              capabilities: membership.capabilities ?? [],
              permissionsSnapshot: membership.permissionsSnapshot ?? null,
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
        });
        return chats.get(data.id);
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<MutableChat> }) => {
          const existing = chats.get(where.id);
          if (!existing) {
            throw new Error(`Chat ${where.id} not found`);
          }
          Object.assign(existing, data);
          return existing;
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
          update: Partial<MutableChat>;
        }) => {
          const existing = chats.get(where.id);
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const created = {
            id: create.id,
            title: create.title,
            botId: create.botId ?? null,
            primaryBotId: create.primaryBotId ?? null,
            entityType: create.entityType,
          };
          chats.set(create.id, created);
          return created;
        },
      ),
    },
    chatBotMembership: {
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
            permissionsSnapshot: membership.permissionsSnapshot ?? null,
          })),
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { chatId: string; status?: ChatBotMembershipStatus; botId?: string };
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
            Object.assign(membership, data, { updatedAt: now() });
            count += 1;
          }
          return { count };
        },
      ),
    },
  };

  const bots = [
    { id: 'id613002203036_bot', token: 'token-1', state: 'active' },
    { id: 'id613002203036_4_bot', token: 'token-2', state: 'active' },
    { id: 'id613002203036_5_bot', token: 'token-3', state: 'active' },
  ];
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
      primaryBotId: 'id613002203036_bot',
      botId: 'id613002203036_4_bot',
      candidateBotIds: ['id613002203036_4_bot'],
      reason: 'alternate_confirmed',
    });
  });

  it('falls back to the active bot context for chat reads when no binding exists yet', async () => {
    const fixture = createServiceFixture();
    fixture.botContext.getActiveBotId.mockReturnValue('id613002203036_4_bot');

    await expect(fixture.service.resolveBotIdForRead({ chatId: 'missing-chat' })).resolves.toBe(
      'id613002203036_4_bot',
    );
  });

  it('prefers a bot with an explicit delete alias when the primary snapshot lacks it', async () => {
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
          permissions: ['delete_messages'],
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
          permissions: ['delete_messages'],
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
          permissions: ['delete_messages'],
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
          permissions: ['delete_messages'],
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
    expect(fixture.prisma.chatBotMembership.upsert).toHaveBeenCalledTimes(1);
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

  it('builds entry mini app links through the canonical entry bot', () => {
    const fixture = createServiceFixture();

    const url = fixture.service.buildEntryMiniappStartUrlSync('route_abc');

    expect(url).toBe('https://max.ru/id613002203036_bot?startapp=route_abc');
  });
});
