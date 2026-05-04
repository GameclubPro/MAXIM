import { ChatBotMembershipRole, ChatBotMembershipStatus } from '@prisma/client';
import { MaxBotExecutionPlannerService } from './max-bot-execution-planner.service';

type MutableChat = {
  id: string;
  botId: string | null;
  primaryBotId: string | null;
};

type MutableMembership = {
  chatId: string;
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  capabilities: unknown;
  permissionsSnapshot: unknown;
  lastSeenAt: Date | null;
  lastWebhookAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function createFixture() {
  const chat: MutableChat = {
    id: 'chat-1',
    botId: 'id613002203036_bot',
    primaryBotId: 'id613002203036_bot',
  };
  const memberships: MutableMembership[] = [
    {
      chatId: 'chat-1',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      capabilities: [],
      permissionsSnapshot: null,
      lastSeenAt: new Date('2026-03-31T00:00:00.000Z'),
      lastWebhookAt: new Date('2026-03-31T00:00:00.000Z'),
      createdAt: new Date('2026-03-31T00:00:00.000Z'),
      updatedAt: new Date('2026-03-31T00:00:00.000Z'),
    },
    {
      chatId: 'chat-1',
      botId: 'id613002203036_4_bot',
      role: ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.ACTIVE,
      capabilities: [],
      permissionsSnapshot: null,
      lastSeenAt: new Date('2026-03-31T00:00:01.000Z'),
      lastWebhookAt: new Date('2026-03-31T00:00:01.000Z'),
      createdAt: new Date('2026-03-31T00:00:01.000Z'),
      updatedAt: new Date('2026-03-31T00:00:01.000Z'),
    },
  ];

  const prisma = {
    chat: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== chat.id) {
          return null;
        }
        return {
          primaryBotId: chat.primaryBotId,
          botId: chat.botId,
          botMemberships: memberships
            .filter((membership) => membership.chatId === where.id)
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
              capabilities: membership.capabilities,
              permissionsSnapshot: membership.permissionsSnapshot,
              lastSeenAt: membership.lastSeenAt,
              lastWebhookAt: membership.lastWebhookAt,
            })),
        };
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<MutableChat> }) => {
          if (where.id !== chat.id) {
            throw new Error('Chat not found');
          }
          Object.assign(chat, data);
          return chat;
        },
      ),
    },
    chatBotMembership: {
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
            Object.assign(membership, data, { updatedAt: new Date() });
            count += 1;
          }
          return { count };
        },
      ),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { chatId_botId: { chatId: string; botId: string } };
          data: Partial<MutableMembership>;
        }) => {
          const membership = memberships.find(
            (item) =>
              item.chatId === where.chatId_botId.chatId && item.botId === where.chatId_botId.botId,
          );
          if (!membership) {
            throw new Error('Membership not found');
          }
          Object.assign(membership, data, { updatedAt: new Date() });
          return membership;
        },
      ),
    },
  };

  const maxClient = {
    getCurrentChatMemberAccess: jest.fn(async (_chatId: string, options?: { botId?: string }) => ({
      userId: options?.botId === 'id613002203036_4_bot' ? '613002203036_4' : '613002203036',
      isAdmin: true,
      isOwner: false,
      permissions: ['write', 'delete'],
    })),
  };

  const maxBotLinkService = {
    rememberChatBotBinding: jest.fn(),
    getEntryBotId: jest.fn(() => 'id613002203036_bot'),
  };

  const bots = [
    {
      id: 'id613002203036_bot',
      label: 'Майор Максимов',
      state: 'active',
      speechPersona: 'male',
      characterName: 'Майор Максимов',
    },
    {
      id: 'id613002203036_4_bot',
      label: 'Майор Максимова',
      state: 'active',
      speechPersona: 'female',
      characterName: 'Майор Максимова',
    },
  ];
  const maxBotRegistry = {
    getBotById: jest.fn((botId?: string | null) => bots.find((bot) => bot.id === botId) ?? null),
  };

  return {
    service: new MaxBotExecutionPlannerService(
      prisma as never,
      maxClient as never,
      maxBotLinkService as never,
      maxBotRegistry as never,
    ),
    chat,
    memberships,
    maxBotLinkService,
  };
}

describe('MaxBotExecutionPlannerService', () => {
  it('enables shared-assist for an active standby bot with admin access', async () => {
    const fixture = createFixture();

    const plan = await fixture.service.setPartnerAssist({
      chatId: 'chat-1',
      entityType: 'chat',
      botId: 'id613002203036_4_bot',
      enabled: true,
    });

    expect(plan.sharedMode).toBe('shared-assist');
    expect(plan.partnerBotId).toBe('id613002203036_4_bot');
    expect(
      plan.assignedBots.find((bot) => bot.botId === 'id613002203036_4_bot')?.capabilities,
    ).toEqual(['suggestion_delivery', 'membership_prewarm', 'access_prewarm']);
  });

  it('transfers owner role to another active bot and updates the cached binding', async () => {
    const fixture = createFixture();

    const plan = await fixture.service.setPrimaryBot({
      chatId: 'chat-1',
      entityType: 'chat',
      botId: 'id613002203036_4_bot',
    });

    expect(plan.primaryBotId).toBe('id613002203036_4_bot');
    expect(plan.speakerBotId).toBe('id613002203036_4_bot');
    expect(plan.linkBotId).toBe('id613002203036_4_bot');
    expect(fixture.chat.primaryBotId).toBe('id613002203036_4_bot');
    expect(fixture.maxBotLinkService.rememberChatBotBinding).toHaveBeenCalledWith(
      'chat-1',
      'id613002203036_4_bot',
    );
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_4_bot')?.role,
    ).toBe(ChatBotMembershipRole.PRIMARY);
  });
});
