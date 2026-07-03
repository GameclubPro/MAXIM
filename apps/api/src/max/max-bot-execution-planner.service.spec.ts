import { ChatBotMembershipRole, ChatBotMembershipStatus } from '../prisma/prisma-client';
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
    {
      chatId: 'chat-1',
      botId: 'id613002203036_5_bot',
      role: ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.ACTIVE,
      capabilities: [],
      permissionsSnapshot: null,
      lastSeenAt: new Date('2026-03-31T00:00:02.000Z'),
      lastWebhookAt: new Date('2026-03-31T00:00:02.000Z'),
      createdAt: new Date('2026-03-31T00:00:02.000Z'),
      updatedAt: new Date('2026-03-31T00:00:02.000Z'),
    },
  ];

  const prisma = {
    $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
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
      userId:
        options?.botId === 'id613002203036_5_bot'
          ? '613002203036_5'
          : options?.botId === 'id613002203036_4_bot'
            ? '613002203036_4'
            : '613002203036',
      isAdmin: true,
      isOwner: options?.botId === 'id613002203036_5_bot',
      permissions:
        options?.botId === 'id613002203036_5_bot'
          ? ['write', 'delete', 'add_remove_members']
          : ['write', 'delete'],
    })),
  };

  const maxBotLinkService = {
    rememberChatBotBinding: jest.fn(),
    reconcileChatPrimaryByAccess: jest.fn().mockResolvedValue('id613002203036_bot'),
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
    {
      id: 'id613002203036_5_bot',
      label: 'Майор Максимов 5',
      state: 'active',
      speechPersona: 'male',
      characterName: 'Майор Максимов 5',
    },
  ];
  const maxBotRegistry = {
    getBotById: jest.fn((botId?: string | null) => bots.find((bot) => bot.id === botId) ?? null),
  };
  const chatContextCache = {
    isManagedRefreshSourceBackoffActive: jest.fn().mockResolvedValue(false),
    activateManagedRefreshSourceBackoff: jest.fn().mockResolvedValue(undefined),
  };

  return {
    service: new MaxBotExecutionPlannerService(
      prisma as never,
      maxClient as never,
      maxBotLinkService as never,
      maxBotRegistry as never,
      chatContextCache as never,
    ),
    chat,
    bots,
    memberships,
    prisma,
    maxClient,
    maxBotLinkService,
    chatContextCache,
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

  it('rejects manual primary selection when the target bot no longer has admin access', async () => {
    const fixture = createFixture();
    fixture.maxClient.getCurrentChatMemberAccess.mockImplementation(
      async (_chatId: string, options?: { botId?: string }) => ({
        userId: options?.botId ?? 'unknown-bot',
        isAdmin: options?.botId !== 'id613002203036_4_bot',
        isOwner: false,
        permissions: [] as string[],
      }),
    );

    await expect(
      fixture.service.setPrimaryBot({
        chatId: 'chat-1',
        entityType: 'chat',
        botId: 'id613002203036_4_bot',
      }),
    ).rejects.toThrow('подтверждёнными admin/owner');

    expect(fixture.chat.primaryBotId).toBe('id613002203036_bot');
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_4_bot')
        ?.role,
    ).toBe(ChatBotMembershipRole.STANDBY);
  });

  it('promotes the strongest eligible standby when no explicit target is requested', async () => {
    const fixture = createFixture();

    const plan = await fixture.service.promoteStandby({
      chatId: 'chat-1',
      entityType: 'chat',
    });

    expect(plan.primaryBotId).toBe('id613002203036_5_bot');
    expect(fixture.chat.primaryBotId).toBe('id613002203036_5_bot');
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_5_bot')?.role,
    ).toBe(ChatBotMembershipRole.PRIMARY);
  });

  it('does not fall back to another standby bot when the requested promotion target is not eligible', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.promoteStandby({
        chatId: 'chat-1',
        entityType: 'chat',
        botId: 'missing-bot',
      }),
    ).rejects.toThrow('не найден');

    await expect(
      fixture.service.promoteStandby({
        chatId: 'chat-1',
        entityType: 'chat',
        botId: 'id613002203036_bot',
      }),
    ).rejects.toThrow('standby');

    expect(fixture.chat.primaryBotId).toBe('id613002203036_bot');
    expect(fixture.maxBotLinkService.rememberChatBotBinding).not.toHaveBeenCalled();
  });

  it('keeps stale assist capabilities from non-executable standby bots out of shared mode', async () => {
    const fixture = createFixture();
    const standbyBot = fixture.bots.find((bot) => bot.id === 'id613002203036_4_bot');
    if (!standbyBot) {
      throw new Error('standby bot fixture missing');
    }
    standbyBot.state = 'dormant';
    const standbyMembership = fixture.memberships.find(
      (membership) => membership.botId === 'id613002203036_4_bot',
    );
    if (!standbyMembership) {
      throw new Error('standby membership fixture missing');
    }
    standbyMembership.capabilities = ['suggestion_delivery'];
    const extraStandbyMembership = fixture.memberships.find(
      (membership) => membership.botId === 'id613002203036_5_bot',
    );
    if (extraStandbyMembership) {
      extraStandbyMembership.status = ChatBotMembershipStatus.REMOVED;
    }

    const plan = await fixture.service.getManagedEntityExecutionPlan({
      chatId: 'chat-1',
      entityType: 'chat',
    });

    expect(plan.sharedMode).toBe('owned');
    expect(plan.partnerBotId).toBeNull();
  });

  it('refreshes stale access snapshots on the managed_refresh source lane', async () => {
    const fixture = createFixture();

    await fixture.service.refreshChatBotCapabilitySnapshots({
      chatId: 'chat-1',
      entityType: 'chat',
      botId: 'id613002203036_4_bot',
    });

    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('chat-1', {
      botId: 'id613002203036_4_bot',
      trafficClass: 'background',
      timeoutMs: 1_500,
      sourceTag: 'managed_refresh',
    });
  });

  it('uses fresh persisted access snapshots instead of repeating managed_refresh reads', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    const fixture = createFixture();
    for (const membership of fixture.memberships) {
      membership.permissionsSnapshot = {
        checkedAt: '2026-05-14T08:59:30.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['delete_messages'],
      };
    }

    try {
      await fixture.service.refreshChatBotCapabilitySnapshots({
        chatId: 'chat-1',
        entityType: 'chat',
      });
    } finally {
      jest.useRealTimers();
    }

    expect(fixture.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(fixture.prisma.chatBotMembership.update).not.toHaveBeenCalled();
  });

  it('uses stored snapshots without warning when managed_refresh source pressure defers refresh', async () => {
    const fixture = createFixture();
    const warnSpy = jest.spyOn((fixture.service as any).logger, 'warn');
    const debugSpy = jest.spyOn((fixture.service as any).logger, 'debug');
    fixture.memberships.find(
      (membership) => membership.botId === 'id613002203036_4_bot',
    )!.permissionsSnapshot = {
      checkedAt: '2026-05-14T08:00:00.000Z',
      isAdmin: true,
      isOwner: false,
      permissions: ['write', 'delete'],
    };
    fixture.maxClient.getCurrentChatMemberAccess.mockRejectedValueOnce(
      new Error('MAX API managed_refresh source limit exceeded for bot id613002203036_4_bot'),
    );

    await fixture.service.refreshChatBotCapabilitySnapshots({
      chatId: 'chat-1',
      entityType: 'chat',
      botId: 'id613002203036_4_bot',
    });
    await fixture.service.refreshChatBotCapabilitySnapshots({
      chatId: 'chat-1',
      entityType: 'chat',
      botId: 'id613002203036_5_bot',
    });

    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: 'id613002203036_4_bot',
        err: expect.stringContaining('managed_refresh source limit exceeded'),
      }),
      'Deferred execution planner access refresh under managed_refresh rate pressure',
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      'Failed to refresh bot access snapshot for execution planner',
    );
    expect(fixture.chatContextCache.activateManagedRefreshSourceBackoff).toHaveBeenCalledWith(10);
  });

  it('uses stored snapshots while a shared managed_refresh backoff is active', async () => {
    const fixture = createFixture();
    fixture.chatContextCache.isManagedRefreshSourceBackoffActive.mockResolvedValue(true);
    fixture.memberships.find(
      (membership) => membership.botId === 'id613002203036_4_bot',
    )!.permissionsSnapshot = {
      checkedAt: '2026-05-14T08:00:00.000Z',
      isAdmin: true,
      isOwner: false,
      permissions: ['write', 'delete'],
    };

    await fixture.service.refreshChatBotCapabilitySnapshots({
      chatId: 'chat-1',
      entityType: 'chat',
      botId: 'id613002203036_4_bot',
    });

    expect(fixture.chatContextCache.isManagedRefreshSourceBackoffActive).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(fixture.prisma.chatBotMembership.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_botId: {
            chatId: 'chat-1',
            botId: 'id613002203036_4_bot',
          },
        },
      }),
    );
  });

  it('does not promote a draining standby bot to primary', async () => {
    const fixture = createFixture();
    const standbyBot = fixture.bots.find((bot) => bot.id === 'id613002203036_4_bot');
    if (!standbyBot) {
      throw new Error('standby bot fixture missing');
    }
    standbyBot.state = 'draining';

    await expect(
      fixture.service.setPrimaryBot({
        chatId: 'chat-1',
        entityType: 'chat',
        botId: 'id613002203036_4_bot',
      }),
    ).rejects.toThrow('ещё не готов');

    expect(fixture.chat.primaryBotId).toBe('id613002203036_bot');
  });

  it('does not enable assist mode for a draining standby bot', async () => {
    const fixture = createFixture();
    const standbyBot = fixture.bots.find((bot) => bot.id === 'id613002203036_4_bot');
    if (!standbyBot) {
      throw new Error('standby bot fixture missing');
    }
    standbyBot.state = 'draining';

    await expect(
      fixture.service.setPartnerAssist({
        chatId: 'chat-1',
        entityType: 'chat',
        botId: 'id613002203036_4_bot',
        enabled: true,
      }),
    ).rejects.toThrow('active-бота');

    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_4_bot')
        ?.capabilities,
    ).toEqual([]);
  });
});
