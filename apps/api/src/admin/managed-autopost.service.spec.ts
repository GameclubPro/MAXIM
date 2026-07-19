import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ManagedAutopostService } from './managed-autopost.service';
import {
  ChatEntityType,
  ManagedAutopostMaterializationStatus,
  ManagedAutopostRuleStatus,
  ManagedBroadcastStatus,
} from '../prisma/prisma-client';

const futureSlot = () => {
  const slot = new Date(Date.now() + 60 * 60_000);
  slot.setUTCSeconds(0, 0);
  slot.setUTCMinutes(slot.getUTCMinutes() < 30 ? 30 : 0);
  if (slot.getTime() - Date.now() < 2 * 60_000) {
    slot.setUTCHours(slot.getUTCHours() + 1);
  }
  return slot.toISOString();
};
const payload = (overrides: Record<string, unknown> = {}) => ({
  text: 'Новости',
  textFormat: 'markdown',
  targetMode: 'current',
  targetChatIds: ['chat-1'],
  applyToAllChats: false,
  buttons: [],
  buttonEnabled: false,
  buttonUrl: '',
  buttonText: 'Открыть',
  imageEnabled: false,
  imageBase64: '',
  imageMimeType: '',
  imageFileName: '',
  images: [],
  mediaType: null,
  mediaPayload: null,
  mediaMimeType: '',
  mediaFileName: '',
  scheduleMode: 'calendar',
  scheduleTimezone: 'Europe/Moscow',
  scheduledSlots: [futureSlot()],
  replaceConflictingSlots: false,
  sendAt: null,
  cycleEnabled: false,
  cycleEveryHours: 1,
  cycleCount: 1,
  ...overrides,
});
type AutopostPayloadInput = ReturnType<typeof payload>;

describe('ManagedAutopostService', () => {
  const user = {
    userId: 'admin-1',
    username: null,
    displayName: null,
    chatTitle: null,
  };

  function createService(
    overrides: {
      prisma?: Record<string, unknown>;
      managedEntitiesService?: Record<string, unknown>;
      managedBroadcastService?: Record<string, unknown>;
      backgroundRuntimeGovernorService?: Record<string, unknown>;
    } = {},
  ) {
    const prisma: Record<string, any> = {
      managedAutopostRule: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      managedAutopostMaterialization: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      managedBroadcast: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
      managedBroadcastDelivery: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
      managedBroadcastCalendarReservation: {
        deleteMany: jest.fn(),
      },
      managedBroadcastOccurrence: {
        deleteMany: jest.fn(),
      },
      managedBroadcastIdempotencyRecord: {
        findFirst: jest.fn(),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn((callback: (tx: Record<string, any>) => unknown) => callback(prisma)),
      ...overrides.prisma,
    };
    const managedEntitiesService = {
      assertChatAdminAccess: jest.fn().mockResolvedValue(undefined),
      assertChannelAdminAccess: jest.fn().mockResolvedValue(undefined),
      assertChatReadAccess: jest.fn().mockResolvedValue(undefined),
      assertChannelReadAccess: jest.fn().mockResolvedValue(undefined),
      listChats: jest.fn().mockResolvedValue([
        {
          id: 'chat-1',
          title: 'Садовый чат',
          createdAt: new Date().toISOString(),
          entityType: 'chat',
          link: null,
          avatarUrl: null,
        },
      ]),
      listChannels: jest.fn().mockResolvedValue([
        {
          id: 'channel-1',
          title: 'Канал',
          createdAt: new Date().toISOString(),
          entityType: 'channel',
          link: null,
          avatarUrl: null,
        },
      ]),
      ...overrides.managedEntitiesService,
    };
    const managedBroadcastService = {
      sendBroadcast: jest.fn().mockResolvedValue({ scheduleId: 'broadcast-1' }),
      sendChannelBroadcast: jest.fn().mockResolvedValue({ scheduleId: 'broadcast-1' }),
      cancelManagedBroadcast: jest.fn(),
      cancelChannelManagedBroadcast: jest.fn(),
      ...overrides.managedBroadcastService,
    };
    const service = new ManagedAutopostService(
      prisma as never,
      managedEntitiesService as never,
      managedBroadcastService as never,
      { getSnapshot: jest.fn().mockResolvedValue({ mode: 'normal', reason: '' }) } as never,
      {
        decide: jest.fn().mockResolvedValue({ action: 'run', reason: '' }),
        ...overrides.backgroundRuntimeGovernorService,
      } as never,
    );
    return { service, prisma, managedEntitiesService, managedBroadcastService };
  }

  const persistedRule = (overrides: Record<string, unknown> = {}) => ({
    id: 'rule-1',
    sourceChatId: 'chat-1',
    entityType: ChatEntityType.CHAT,
    actorUserId: 'admin-1',
    title: '',
    payload: payload(),
    status: ManagedAutopostRuleStatus.ACTIVE,
    revision: 1,
    nextMaterializeAt: new Date(),
    lastMaterializedAt: null,
    lastError: null,
    lockedAt: null,
    lockToken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    _count: { materializations: 0 },
    ...overrides,
  });

  it('lists hub rules with source and target previews', async () => {
    const chatRule = persistedRule({
      id: 'rule-chat',
      title: 'Грунты',
      payload: payload({
        targetMode: 'all',
        targetChatIds: [],
        applyToAllChats: true,
      }),
    });
    const channelRule = persistedRule({
      id: 'rule-channel',
      sourceChatId: 'channel-1',
      entityType: ChatEntityType.CHANNEL,
      title: 'Продукты',
    });
    const { service, prisma, managedEntitiesService } = createService({
      managedEntitiesService: {
        listChats: jest.fn().mockResolvedValue([
          {
            id: 'chat-1',
            title: 'Садовый чат',
            createdAt: new Date().toISOString(),
            entityType: 'chat',
            link: null,
            avatarUrl: null,
          },
          {
            id: 'chat-2',
            title: 'Клуб',
            createdAt: new Date().toISOString(),
            entityType: 'chat',
            link: null,
            avatarUrl: null,
          },
        ]),
        listChannels: jest.fn().mockResolvedValue([
          {
            id: 'channel-1',
            title: 'Витрина',
            createdAt: new Date().toISOString(),
            entityType: 'channel',
            link: null,
            avatarUrl: null,
          },
        ]),
      },
    });
    prisma.managedAutopostRule.findMany.mockResolvedValue([chatRule, channelRule]);

    const result = await service.listAutopostRules(user, { entityType: 'all' });

    expect(managedEntitiesService.listChats).toHaveBeenCalledWith(user, { fresh: false });
    expect(managedEntitiesService.listChannels).toHaveBeenCalledWith(user, { fresh: false });
    expect(prisma.managedAutopostRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            {
              entityType: ChatEntityType.CHAT,
              sourceChatId: { in: ['chat-1', 'chat-2'] },
            },
            {
              entityType: ChatEntityType.CHANNEL,
              sourceChatId: { in: ['channel-1'] },
            },
          ],
        }),
      }),
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(
      expect.objectContaining({
        id: 'rule-chat',
        sourcePreview: expect.objectContaining({ title: 'Садовый чат' }),
        targetChats: 2,
        targetPreviews: [
          expect.objectContaining({ id: 'chat-1', title: 'Садовый чат' }),
          expect.objectContaining({ id: 'chat-2', title: 'Клуб' }),
        ],
        targetOverflowCount: 0,
      }),
    );
    expect(result[1]).toEqual(
      expect.objectContaining({
        id: 'rule-channel',
        sourcePreview: expect.objectContaining({ title: 'Витрина', entityType: 'channel' }),
        targetPreviews: [expect.objectContaining({ id: 'channel-1' })],
      }),
    );
  });

  it('rolls a partial child broadcast up into the rule summary', async () => {
    const rule = persistedRule();
    const { service, prisma } = createService();
    prisma.managedAutopostRule.findMany.mockResolvedValue([rule]);
    prisma.managedAutopostMaterialization.findMany.mockResolvedValue([
      {
        ruleId: 'rule-1',
        revision: 1,
        broadcast: {
          status: 'PARTIAL',
          lastError: 'Один чат недоступен.',
          deliveries: [],
        },
      },
    ]);

    await expect(service.listChatAutopostRules('chat-1', user)).resolves.toEqual([
      expect.objectContaining({
        id: 'rule-1',
        status: ManagedAutopostRuleStatus.ERROR,
        lastError: 'Один чат недоступен.',
      }),
    ]);
  });

  it('surfaces ambiguous child delivery without overriding a paused rule', async () => {
    const rule = persistedRule({
      status: ManagedAutopostRuleStatus.PAUSED,
      lastError: 'Остановлено из-за потери доступа.',
    });
    const { service, prisma } = createService();
    prisma.managedAutopostRule.findMany.mockResolvedValue([rule]);
    prisma.managedAutopostMaterialization.findMany.mockResolvedValue([
      {
        ruleId: 'rule-1',
        revision: 1,
        broadcast: {
          status: 'ACTIVE',
          lastError: null,
          deliveries: [{ id: 'delivery-1' }],
        },
      },
    ]);

    await expect(service.listChatAutopostRules('chat-1', user)).resolves.toEqual([
      expect.objectContaining({
        id: 'rule-1',
        status: ManagedAutopostRuleStatus.PAUSED,
        lastError: 'Остановлено из-за потери доступа.',
      }),
    ]);
  });

  it('surfaces ambiguous child delivery as an actionable rule error', async () => {
    const rule = persistedRule();
    const { service, prisma } = createService();
    prisma.managedAutopostRule.findMany.mockResolvedValue([rule]);
    prisma.managedAutopostMaterialization.findMany.mockResolvedValue([
      {
        ruleId: 'rule-1',
        revision: 1,
        broadcast: {
          status: 'ACTIVE',
          lastError: null,
          deliveries: [{ id: 'delivery-1' }],
        },
      },
    ]);

    const [summary] = await service.listChatAutopostRules('chat-1', user);

    expect(summary).toEqual(
      expect.objectContaining({
        id: 'rule-1',
        status: ManagedAutopostRuleStatus.ERROR,
        lastError: expect.stringContaining('Проверьте публикацию вручную'),
      }),
    );
  });

  it('creates a hub channel rule through the channel source', async () => {
    const created = persistedRule({
      sourceChatId: 'channel-1',
      entityType: ChatEntityType.CHANNEL,
      title: 'Продукты',
      _count: { materializations: 0 },
    });
    const { service, prisma, managedEntitiesService } = createService();
    prisma.managedAutopostRule.create.mockResolvedValue(created);
    prisma.managedAutopostRule.findFirst.mockResolvedValue(created);

    const result = await service.createAutopostRule(user, {
      sourceChatId: 'channel-1',
      entityType: 'channel',
      title: 'Продукты',
      payload: payload({ targetChatIds: ['channel-1'] }),
    });

    expect(managedEntitiesService.assertChannelAdminAccess).toHaveBeenCalledWith('channel-1', user);
    expect(prisma.managedAutopostRule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceChatId: 'channel-1',
          entityType: ChatEntityType.CHANNEL,
          title: 'Продукты',
        }),
      }),
    );
    expect(result.sourcePreview).toEqual(expect.objectContaining({ id: 'channel-1' }));
  });

  it('rejects channel autoposts with non-current targets before saving', async () => {
    const { service, prisma } = createService();

    await expect(
      service.createChannelAutopostRule('channel-1', user, {
        payload: payload({
          targetMode: 'selected',
          targetChatIds: ['channel-1', 'channel-2'],
        }),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.managedAutopostRule.create).not.toHaveBeenCalled();
  });

  it('rejects hub channel rules with non-current targets before saving', async () => {
    const { service, prisma } = createService();

    await expect(
      service.createAutopostRule(user, {
        sourceChatId: 'channel-1',
        entityType: 'channel',
        payload: payload({
          targetMode: 'selected',
          targetChatIds: ['channel-1', 'channel-2'],
        }),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.managedAutopostRule.create).not.toHaveBeenCalled();
  });

  it('creates a rule without synchronous materialization', async () => {
    const created = {
      id: 'rule-1',
      sourceChatId: 'chat-1',
      entityType: ChatEntityType.CHAT,
      actorUserId: 'admin-1',
      title: '',
      payload: payload(),
      status: ManagedAutopostRuleStatus.ACTIVE,
      revision: 1,
      nextMaterializeAt: new Date(),
      lastMaterializedAt: null,
      lastError: null,
      lockedAt: null,
      lockToken: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: { materializations: 0 },
    };
    const { service, prisma, managedBroadcastService } = createService();
    prisma.managedAutopostRule.create.mockResolvedValue(created);
    prisma.managedAutopostRule.findFirst.mockResolvedValue(created);

    await service.createChatAutopostRule('chat-1', user, { payload: payload() });

    expect(managedBroadcastService.sendBroadcast).not.toHaveBeenCalled();
  });

  it('rejects create when a calendar slot is off the local 30-minute step', async () => {
    const invalidSlot = new Date(Date.now() + 60 * 60_000);
    invalidSlot.setUTCMinutes(15, 0, 0);
    const { service, prisma } = createService();

    await expect(
      service.createChatAutopostRule('chat-1', user, {
        payload: payload({ scheduledSlots: [invalidSlot.toISOString()] }),
      }),
    ).rejects.toThrow('Слоты должны быть кратны 30 минутам.');

    expect(prisma.managedAutopostRule.create).not.toHaveBeenCalled();
  });

  it('validates the calendar step in the configured timezone', async () => {
    const kathmanduSlot = new Date(Date.now() + 2 * 60 * 60_000);
    kathmanduSlot.setUTCMinutes(15, 0, 0);
    const created = persistedRule({
      payload: payload({
        scheduleTimezone: 'Asia/Kathmandu',
        scheduledSlots: [kathmanduSlot.toISOString()],
      }),
    });
    const { service, prisma } = createService();
    prisma.managedAutopostRule.create.mockResolvedValue(created);
    prisma.managedAutopostRule.findFirst.mockResolvedValue(created);

    await expect(
      service.createChatAutopostRule('chat-1', user, {
        payload: payload({
          scheduleTimezone: 'Asia/Kathmandu',
          scheduledSlots: [kathmanduSlot.toISOString()],
        }),
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'rule-1' }));
  });

  it('rejects create when any future calendar slot exceeds 31 days', async () => {
    const distantSlot = new Date(Date.now() + 32 * 24 * 60 * 60_000);
    distantSlot.setUTCMinutes(0, 0, 0);
    const { service, prisma } = createService();

    await expect(
      service.createChatAutopostRule('chat-1', user, {
        payload: payload({ scheduledSlots: [futureSlot(), distantSlot.toISOString()] }),
      }),
    ).rejects.toThrow('Планирование календаря доступно максимум на 31 день.');

    expect(prisma.managedAutopostRule.create).not.toHaveBeenCalled();
  });

  it('applies calendar slot validation when updating a rule payload', async () => {
    const invalidSlot = new Date(Date.now() + 60 * 60_000);
    invalidSlot.setUTCMinutes(15, 0, 0);
    const existing = persistedRule();
    const { service, prisma } = createService();
    prisma.managedAutopostRule.findFirst.mockResolvedValue(existing);

    await expect(
      service.updateChatAutopostRule('chat-1', 'rule-1', user, {
        payload: payload({ scheduledSlots: [invalidSlot.toISOString()] }),
      }),
    ).rejects.toThrow('Слоты должны быть кратны 30 минутам.');

    expect(prisma.managedAutopostRule.updateMany).not.toHaveBeenCalled();
  });

  it('retries failed materialization with the same request id', async () => {
    const scheduledAt = new Date(Date.now() + 5 * 60_000);
    const failedLedger = {
      id: 'ledger-1',
      requestId: 'ap_rule_1',
      attempt: 1,
      status: ManagedAutopostMaterializationStatus.FAILED,
    };
    const rule = {
      id: 'rule-1',
      sourceChatId: 'chat-1',
      entityType: ChatEntityType.CHAT,
      actorUserId: 'admin-1',
      status: ManagedAutopostRuleStatus.ACTIVE,
      revision: 1,
      lockedAt: new Date(),
      lockToken: 'lock-1',
    };
    const { service, prisma, managedBroadcastService } = createService();
    prisma.managedAutopostRule.findFirst.mockResolvedValue(rule);
    prisma.managedAutopostRule.updateMany.mockResolvedValue({ count: 1 });
    prisma.managedAutopostMaterialization.findFirst.mockResolvedValue(failedLedger);
    prisma.managedAutopostMaterialization.updateMany.mockResolvedValue({ count: 1 });
    prisma.managedAutopostMaterialization.update.mockResolvedValue({});

    const materialized = await (
      service as unknown as {
        materializeSlot: (
          ruleId: string,
          revision: number,
          lockToken: string,
          payload: AutopostPayloadInput,
          entityType: 'chat',
          scheduledAt: Date,
        ) => Promise<boolean>;
      }
    ).materializeSlot('rule-1', 1, 'lock-1', payload(), 'chat', scheduledAt);

    expect(materialized).toBe(true);
    expect(prisma.managedAutopostMaterialization.create).not.toHaveBeenCalled();
    expect(managedBroadcastService.sendBroadcast).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'admin-1' }),
      expect.objectContaining({ requestId: 'ap_rule_1' }),
      'autopost_rule',
    );
  });

  it.each([
    {
      entityType: 'chat' as const,
      sourceChatId: 'chat-1',
      sendMethod: 'sendBroadcast' as const,
      broadcastStatus: ManagedBroadcastStatus.ACTIVE,
    },
    {
      entityType: 'channel' as const,
      sourceChatId: 'channel-1',
      sendMethod: 'sendChannelBroadcast' as const,
      broadcastStatus: ManagedBroadcastStatus.CANCELED,
    },
  ])(
    'cancels a created $entityType broadcast in the database when the rule claim becomes stale',
    async ({ entityType, sourceChatId, sendMethod, broadcastStatus }) => {
      const scheduledAt = new Date(Date.now() + 5 * 60_000);
      const rule = {
        id: 'rule-1',
        sourceChatId,
        entityType: entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT,
        actorUserId: 'admin-1',
        status: ManagedAutopostRuleStatus.ACTIVE,
        revision: 1,
        lockedAt: new Date(),
        lockToken: 'lock-1',
      };
      const { service, prisma, managedBroadcastService } = createService({
        managedBroadcastService: {
          cancelManagedBroadcast: jest
            .fn()
            .mockRejectedValue(new ForbiddenException('Доступ потерян.')),
          cancelChannelManagedBroadcast: jest
            .fn()
            .mockRejectedValue(new ForbiddenException('Доступ потерян.')),
        },
      });
      prisma.managedAutopostRule.findFirst.mockResolvedValue(rule);
      prisma.managedAutopostRule.updateMany.mockResolvedValue({ count: 0 });
      prisma.managedAutopostMaterialization.findFirst.mockResolvedValue(null);
      prisma.managedAutopostMaterialization.create.mockResolvedValue({ id: 'ledger-1' });
      prisma.managedAutopostMaterialization.updateMany.mockResolvedValue({ count: 1 });
      prisma.managedAutopostMaterialization.update.mockResolvedValue({});
      prisma.managedBroadcastIdempotencyRecord.findFirst.mockResolvedValue({ id: 'request-1' });
      prisma.managedBroadcast.findFirst.mockResolvedValue({
        id: 'broadcast-1',
        status: broadcastStatus,
      });
      prisma.managedBroadcastDelivery.findFirst.mockResolvedValue(null);
      prisma.managedBroadcast.updateMany.mockResolvedValue({ count: 1 });
      prisma.managedBroadcastDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.managedBroadcastCalendarReservation.deleteMany.mockResolvedValue({ count: 1 });
      prisma.managedBroadcastOccurrence.deleteMany.mockResolvedValue({ count: 1 });

      const materialized = await (
        service as unknown as {
          materializeSlot: (
            ruleId: string,
            revision: number,
            lockToken: string,
            payload: AutopostPayloadInput,
            entityType: 'chat' | 'channel',
            scheduledAt: Date,
          ) => Promise<boolean>;
        }
      ).materializeSlot('rule-1', 1, 'lock-1', payload(), entityType, scheduledAt);

      expect(materialized).toBe(false);
      expect(managedBroadcastService[sendMethod]).toHaveBeenCalledWith(
        sourceChatId,
        expect.objectContaining({ userId: 'admin-1' }),
        expect.any(Object),
        'autopost_rule',
      );
      expect(prisma.managedAutopostRule.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'rule-1',
          revision: 1,
          lockToken: 'lock-1',
          status: {
            in: [ManagedAutopostRuleStatus.ACTIVE, ManagedAutopostRuleStatus.ERROR],
          },
        },
        data: { lockedAt: expect.any(Date) },
      });
      expect(managedBroadcastService.cancelManagedBroadcast).not.toHaveBeenCalled();
      expect(managedBroadcastService.cancelChannelManagedBroadcast).not.toHaveBeenCalled();
      expect(prisma.managedBroadcastIdempotencyRecord.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          requestId: expect.stringMatching(/^ap_rule-1_1_/u),
          sourceChatId,
          entityType: rule.entityType,
          actorUserId: 'admin-1',
          source: 'autopost_rule',
          broadcastId: 'broadcast-1',
        }),
        select: { id: true },
      });
      if (broadcastStatus === ManagedBroadcastStatus.CANCELED) {
        expect(prisma.managedBroadcast.updateMany).not.toHaveBeenCalled();
      } else {
        expect(prisma.managedBroadcast.updateMany).toHaveBeenCalledWith({
          where: expect.objectContaining({
            id: 'broadcast-1',
            sourceChatId,
            entityType: rule.entityType,
            actorUserId: 'admin-1',
            publicationOccurrenceId: null,
            lockedAt: null,
            lockToken: null,
          }),
          data: {
            status: ManagedBroadcastStatus.CANCELED,
            nextSendAt: null,
            lockedAt: null,
            lockToken: null,
            lastError: 'Правило изменилось во время создания отправки.',
          },
        });
      }
      expect(prisma.managedAutopostMaterialization.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'ledger-1',
          requestId: expect.stringMatching(/^ap_rule-1_1_/u),
          status: ManagedAutopostMaterializationStatus.PENDING,
        },
        data: {
          broadcastId: 'broadcast-1',
          status: ManagedAutopostMaterializationStatus.CANCELED,
          lastError: 'Правило изменилось во время создания отправки.',
        },
      });
      expect(prisma.managedAutopostMaterialization.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ManagedAutopostMaterializationStatus.CREATED,
          }),
        }),
      );
    },
  );

  it('cancels a pending materialization when the rule is paused before broadcast creation', async () => {
    const scheduledAt = new Date(Date.now() + 5 * 60_000);
    const rule = {
      id: 'rule-1',
      sourceChatId: 'chat-1',
      entityType: ChatEntityType.CHAT,
      actorUserId: 'admin-1',
      status: ManagedAutopostRuleStatus.ACTIVE,
      revision: 1,
      lockedAt: new Date(),
      lockToken: 'lock-1',
    };
    const { service, prisma, managedBroadcastService } = createService();
    prisma.managedAutopostRule.findFirst.mockResolvedValueOnce(rule).mockResolvedValueOnce(null);
    prisma.managedAutopostMaterialization.findFirst.mockResolvedValue(null);
    prisma.managedAutopostMaterialization.create.mockResolvedValue({ id: 'ledger-1' });
    prisma.managedAutopostMaterialization.updateMany.mockResolvedValue({ count: 1 });

    const materialized = await (
      service as unknown as {
        materializeSlot: (
          ruleId: string,
          revision: number,
          lockToken: string,
          payload: AutopostPayloadInput,
          entityType: 'chat',
          scheduledAt: Date,
        ) => Promise<boolean>;
      }
    ).materializeSlot('rule-1', 1, 'lock-1', payload(), 'chat', scheduledAt);

    expect(materialized).toBe(false);
    expect(managedBroadcastService.sendBroadcast).not.toHaveBeenCalled();
    expect(prisma.managedAutopostMaterialization.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'ledger-1',
        status: ManagedAutopostMaterializationStatus.PENDING,
      },
      data: {
        status: ManagedAutopostMaterializationStatus.CANCELED,
        lastError: 'Правило остановлено до создания отправки.',
      },
    });
  });

  it('rejects a stale concurrent rule update', async () => {
    const existing = persistedRule();
    const { service, prisma } = createService();
    prisma.managedAutopostRule.findFirst.mockResolvedValue(existing);
    prisma.managedAutopostMaterialization.findMany.mockResolvedValue([]);
    prisma.managedAutopostRule.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.updateChatAutopostRule('chat-1', 'rule-1', user, { title: 'Новое название' }),
    ).rejects.toThrow('Автопост обновляется. Повторите позже.');

    expect(prisma.managedAutopostRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'rule-1',
          revision: existing.revision,
          updatedAt: existing.updatedAt,
        }),
      }),
    );
  });

  it('guards materializer completion with the claimed revision and lock token', async () => {
    const scheduledAt = new Date(Date.now() + 5 * 60_000);
    const rule = {
      id: 'rule-1',
      sourceChatId: 'chat-1',
      entityType: ChatEntityType.CHAT,
      actorUserId: 'admin-1',
      status: ManagedAutopostRuleStatus.ACTIVE,
      revision: 7,
      payload: payload({ scheduledSlots: [scheduledAt.toISOString()] }),
    };
    const { service, prisma } = createService();
    prisma.managedAutopostRule.updateMany.mockResolvedValue({ count: 1 });
    prisma.managedAutopostRule.findUnique
      .mockResolvedValueOnce(rule)
      .mockResolvedValueOnce({ status: ManagedAutopostRuleStatus.ACTIVE });
    prisma.managedAutopostRule.findFirst.mockResolvedValue({
      ...rule,
      lockedAt: new Date(),
      lockToken: 'claimed-lock',
    });
    prisma.managedAutopostMaterialization.findFirst.mockResolvedValue(null);
    prisma.managedAutopostMaterialization.findMany.mockResolvedValue([]);
    prisma.managedAutopostMaterialization.create.mockResolvedValue({ id: 'ledger-1' });
    prisma.managedAutopostMaterialization.update.mockResolvedValue({});
    prisma.managedAutopostMaterialization.updateMany.mockResolvedValue({ count: 0 });

    await (
      service as unknown as {
        materializeRule: (
          ruleId: string,
          reason: 'scheduled',
          staleLockBefore: Date,
        ) => Promise<void>;
      }
    ).materializeRule('rule-1', 'scheduled', new Date(Date.now() - 60_000));

    expect(prisma.managedAutopostRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'rule-1',
          revision: 7,
          lockToken: expect.any(String),
        }),
        data: expect.objectContaining({
          status: ManagedAutopostRuleStatus.ACTIVE,
          lockedAt: null,
          lockToken: null,
        }),
      }),
    );
  });

  it('does not retry terminal permission failures during materialization', async () => {
    const scheduledAt = new Date(Date.now() + 5 * 60_000);
    const rule = {
      id: 'rule-1',
      sourceChatId: 'chat-1',
      entityType: ChatEntityType.CHAT,
      actorUserId: 'admin-1',
      status: ManagedAutopostRuleStatus.ACTIVE,
      revision: 7,
      payload: payload({ scheduledSlots: [scheduledAt.toISOString()] }),
    };
    const { service, prisma, managedBroadcastService } = createService({
      managedBroadcastService: {
        sendBroadcast: jest
          .fn()
          .mockRejectedValue(
            new ForbiddenException('Пользователь не является администратором чата.'),
          ),
      },
    });
    prisma.managedAutopostRule.updateMany.mockResolvedValue({ count: 1 });
    prisma.managedAutopostRule.findUnique.mockResolvedValue(rule);
    prisma.managedAutopostRule.findFirst.mockResolvedValue({
      ...rule,
      lockedAt: new Date(),
      lockToken: 'claimed-lock',
    });
    prisma.managedAutopostMaterialization.findFirst.mockResolvedValue(null);
    prisma.managedAutopostMaterialization.findMany.mockResolvedValue([]);
    prisma.managedAutopostMaterialization.create.mockResolvedValue({ id: 'ledger-1' });
    prisma.managedAutopostMaterialization.update.mockResolvedValue({});
    prisma.managedAutopostMaterialization.updateMany.mockResolvedValue({ count: 0 });

    await (
      service as unknown as {
        materializeRule: (
          ruleId: string,
          reason: 'scheduled',
          staleLockBefore: Date,
        ) => Promise<void>;
      }
    ).materializeRule('rule-1', 'scheduled', new Date(Date.now() - 60_000));

    expect(managedBroadcastService.sendBroadcast).toHaveBeenCalled();
    expect(prisma.managedAutopostRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'rule-1',
          revision: 7,
          lockToken: expect.any(String),
        }),
        data: expect.objectContaining({
          status: ManagedAutopostRuleStatus.ERROR,
          nextMaterializeAt: null,
          lastError: 'Пользователь не является администратором чата.',
          lockedAt: null,
          lockToken: null,
        }),
      }),
    );
  });

  it('does not retry a rule whose selected targets require owner reconfiguration', async () => {
    const scheduledAt = new Date(Date.now() + 5 * 60_000);
    const rule = {
      id: 'rule-target-unavailable',
      sourceChatId: 'chat-1',
      entityType: ChatEntityType.CHAT,
      actorUserId: 'admin-1',
      status: ManagedAutopostRuleStatus.ACTIVE,
      revision: 3,
      payload: payload({ scheduledSlots: [scheduledAt.toISOString()] }),
    };
    const unavailableTargetsMessage =
      'Некоторые выбранные чаты больше недоступны. Откройте список заново.';
    const { service, prisma, managedBroadcastService } = createService({
      managedBroadcastService: {
        sendBroadcast: jest
          .fn()
          .mockRejectedValue(new BadRequestException(unavailableTargetsMessage)),
      },
    });
    prisma.managedAutopostRule.updateMany.mockResolvedValue({ count: 1 });
    prisma.managedAutopostRule.findUnique.mockResolvedValue(rule);
    prisma.managedAutopostRule.findFirst.mockResolvedValue({
      ...rule,
      lockedAt: new Date(),
      lockToken: 'claimed-lock',
    });
    prisma.managedAutopostMaterialization.findFirst.mockResolvedValue(null);
    prisma.managedAutopostMaterialization.findMany.mockResolvedValue([]);
    prisma.managedAutopostMaterialization.create.mockResolvedValue({ id: 'ledger-1' });
    prisma.managedAutopostMaterialization.update.mockResolvedValue({});
    prisma.managedAutopostMaterialization.updateMany.mockResolvedValue({ count: 0 });

    await (
      service as unknown as {
        materializeRule: (
          ruleId: string,
          reason: 'scheduled',
          staleLockBefore: Date,
        ) => Promise<void>;
      }
    ).materializeRule('rule-target-unavailable', 'scheduled', new Date(Date.now() - 60_000));

    expect(managedBroadcastService.sendBroadcast).toHaveBeenCalled();
    expect(prisma.managedAutopostRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'rule-target-unavailable',
          revision: 3,
          lockToken: expect.any(String),
        }),
        data: expect.objectContaining({
          status: ManagedAutopostRuleStatus.ERROR,
          nextMaterializeAt: null,
          lastError: unavailableTargetsMessage,
          lockedAt: null,
          lockToken: null,
        }),
      }),
    );
  });

  it('does not disable a rule when future materialized broadcasts cannot be canceled', async () => {
    const existing = {
      id: 'rule-1',
      sourceChatId: 'chat-1',
      entityType: ChatEntityType.CHAT,
      actorUserId: 'admin-1',
      title: '',
      payload: payload(),
      status: ManagedAutopostRuleStatus.ACTIVE,
      revision: 1,
      nextMaterializeAt: new Date(),
      lastMaterializedAt: null,
      lastError: null,
      lockedAt: null,
      lockToken: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { service, prisma, managedBroadcastService } = createService({
      managedBroadcastService: {
        cancelManagedBroadcast: jest.fn().mockRejectedValue(new Error('MAX timeout')),
      },
    });
    prisma.managedAutopostRule.findFirst.mockResolvedValue(existing);
    prisma.managedAutopostRule.updateMany.mockResolvedValue({ count: 1 });
    prisma.managedAutopostMaterialization.findMany.mockResolvedValue([
      {
        id: 'materialization-1',
        broadcastId: 'broadcast-1',
        broadcast: { sourceChatId: 'chat-1' },
      },
    ]);

    await expect(service.deleteChatAutopostRule('chat-1', 'rule-1', user)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(managedBroadcastService.cancelManagedBroadcast).toHaveBeenCalledWith(
      'chat-1',
      'broadcast-1',
      user,
    );
    expect(prisma.managedAutopostRule.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ManagedAutopostRuleStatus.DISABLED }),
      }),
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'DELETE_AUTOPOST_RULE' }),
      }),
    );
  });

  it('cancels already materialized broadcasts even when the next slot is imminent', async () => {
    const existing = {
      id: 'rule-1',
      sourceChatId: 'chat-1',
      entityType: ChatEntityType.CHAT,
      actorUserId: 'admin-1',
      title: '',
      payload: payload(),
      status: ManagedAutopostRuleStatus.ACTIVE,
      revision: 1,
      nextMaterializeAt: new Date(),
      lastMaterializedAt: null,
      lastError: null,
      lockedAt: null,
      lockToken: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { service, prisma, managedBroadcastService } = createService();
    prisma.managedAutopostRule.findFirst.mockResolvedValue(existing);
    prisma.managedAutopostRule.updateMany.mockResolvedValue({ count: 1 });
    prisma.managedAutopostRule.findUnique.mockResolvedValue({
      ...existing,
      status: ManagedAutopostRuleStatus.DISABLED,
      _count: { materializations: 1 },
    });
    prisma.managedAutopostMaterialization.findMany.mockResolvedValue([
      {
        id: 'materialization-1',
        broadcastId: 'broadcast-1',
        scheduledAt: new Date(Date.now() + 10_000),
        broadcast: { sourceChatId: 'chat-1' },
      },
    ]);
    prisma.managedAutopostMaterialization.update.mockResolvedValue({});

    await service.deleteChatAutopostRule('chat-1', 'rule-1', user);

    expect(prisma.managedAutopostMaterialization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          broadcast: expect.objectContaining({
            nextSendAt: { not: null },
          }),
        }),
      }),
    );
    expect(managedBroadcastService.cancelManagedBroadcast).toHaveBeenCalledWith(
      'chat-1',
      'broadcast-1',
      user,
    );
    expect(prisma.managedAutopostMaterialization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'materialization-1' },
        data: { status: ManagedAutopostMaterializationStatus.CANCELED },
      }),
    );
  });

  it('cancels overdue materialized broadcasts when deleting a rule', async () => {
    const existing = {
      id: 'rule-1',
      sourceChatId: 'chat-1',
      entityType: ChatEntityType.CHAT,
      actorUserId: 'admin-1',
      title: '',
      payload: payload(),
      status: ManagedAutopostRuleStatus.ACTIVE,
      revision: 1,
      nextMaterializeAt: new Date(),
      lastMaterializedAt: null,
      lastError: null,
      lockedAt: null,
      lockToken: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { service, prisma, managedBroadcastService } = createService();
    prisma.managedAutopostRule.findFirst.mockResolvedValue(existing);
    prisma.managedAutopostRule.updateMany.mockResolvedValue({ count: 1 });
    prisma.managedAutopostRule.findUnique.mockResolvedValue({
      ...existing,
      status: ManagedAutopostRuleStatus.DISABLED,
      _count: { materializations: 1 },
    });
    prisma.managedAutopostMaterialization.findMany.mockResolvedValue([
      {
        id: 'materialization-1',
        broadcastId: 'broadcast-1',
        scheduledAt: new Date(Date.now() - 60_000),
        broadcast: {
          sourceChatId: 'chat-1',
          nextSendAt: new Date(Date.now() - 30_000),
        },
      },
    ]);
    prisma.managedAutopostMaterialization.update.mockResolvedValue({});

    await service.deleteChatAutopostRule('chat-1', 'rule-1', user);

    expect(managedBroadcastService.cancelManagedBroadcast).toHaveBeenCalledWith(
      'chat-1',
      'broadcast-1',
      user,
    );
    expect(prisma.managedAutopostMaterialization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'materialization-1' },
        data: { status: ManagedAutopostMaterializationStatus.CANCELED },
      }),
    );
  });

  it('keeps a rule in error when a failed materialization slot is already missed', async () => {
    const missedSlot = new Date(Date.now() - 60_000);
    const rule = {
      id: 'rule-1',
      sourceChatId: 'chat-1',
      entityType: ChatEntityType.CHAT,
      actorUserId: 'admin-1',
      status: ManagedAutopostRuleStatus.ERROR,
      revision: 3,
      payload: payload({ scheduledSlots: [missedSlot.toISOString()] }),
    };
    const { service, prisma, managedBroadcastService } = createService();
    prisma.managedAutopostRule.updateMany.mockResolvedValue({ count: 1 });
    prisma.managedAutopostRule.findUnique
      .mockResolvedValueOnce(rule)
      .mockResolvedValueOnce({ status: ManagedAutopostRuleStatus.ERROR });
    prisma.managedAutopostMaterialization.findMany
      .mockResolvedValueOnce([{ scheduledAt: missedSlot }])
      .mockResolvedValueOnce([]);

    await (
      service as unknown as {
        materializeRule: (
          ruleId: string,
          reason: 'scheduled',
          staleLockBefore: Date,
        ) => Promise<void>;
      }
    ).materializeRule('rule-1', 'scheduled', new Date(Date.now() - 60_000));

    expect(managedBroadcastService.sendBroadcast).not.toHaveBeenCalled();
    expect(prisma.managedAutopostRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'rule-1',
          revision: 3,
          lockToken: expect.any(String),
        }),
        data: expect.objectContaining({
          status: ManagedAutopostRuleStatus.ERROR,
          nextMaterializeAt: null,
          lastError: 'Не удалось создать отправку автопоста: время уже прошло.',
          lockedAt: null,
          lockToken: null,
        }),
      }),
    );
  });
});
