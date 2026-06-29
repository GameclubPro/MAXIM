import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ManagedAutopostService } from './managed-autopost.service';
import {
  ChatEntityType,
  ManagedAutopostMaterializationStatus,
  ManagedAutopostRuleStatus,
} from '../prisma/prisma-client';

const futureSlot = () => new Date(Date.now() + 5 * 60_000).toISOString();
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

  function createService(overrides: {
    prisma?: Record<string, unknown>;
    managedEntitiesService?: Record<string, unknown>;
    managedBroadcastService?: Record<string, unknown>;
    backgroundRuntimeGovernorService?: Record<string, unknown>;
  } = {}) {
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
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
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
      listChats: jest.fn().mockResolvedValue([{ id: 'chat-1', entityType: 'chat' }]),
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
});
