import type { MaxUpdate } from '@maxim/contracts';
import { ChatEntityType } from '../prisma/prisma-client';
import { WebhookParser } from './webhook.parser';
import { WebhookService } from './webhook.service';

describe('WebhookService', () => {
  const flushDeferredWebhookWork = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const extractSqlText = (query: unknown): string => {
    const strings = (query as { strings?: unknown[] } | null)?.strings;
    return Array.isArray(strings) ? strings.map(String).join(' ') : String(query);
  };
  const extractSqlValues = (query: unknown): unknown[] => {
    const values = (query as { values?: unknown[] } | null)?.values;
    return Array.isArray(values) ? values : [];
  };
  const buildMembershipUpdate = (params: {
    updateId: string;
    type: 'user_added' | 'user_removed';
    createdAt: string;
    userIds?: string[];
  }): MaxUpdate => {
    const userIds = params.userIds ?? ['user-1'];
    return {
      updateId: params.updateId,
      type: params.type,
      botId: 'id613002203036_bot',
      message: {
        messageId: `${params.type}:${params.updateId}`,
        chatId: '-100-membership',
        chatTitle: 'Membership chat',
        entityType: 'chat',
        senderId: userIds[0],
        text: '',
        createdAt: params.createdAt,
      },
      membership: {
        action: params.type === 'user_removed' ? 'removed' : 'added',
        memberUserIds: userIds,
      },
    };
  };
  const createAtomicMembershipFixture = (options?: {
    newerGrantedUserIds?: string[];
    newerAdminUserIds?: string[];
  }) => {
    const operations: string[] = [];
    const tx = {
      chat: {
        createMany: jest.fn(async () => {
          operations.push('chat:create');
          return { count: 0 };
        }),
      },
      $queryRaw: jest.fn(async () => {
        operations.push('chat:lock');
        return [{ id: '-100-membership' }];
      }),
      $executeRaw: jest.fn(async (_query: unknown) => {
        operations.push('activity:upsert');
        return 1;
      }),
      managedEntityAccessEdge: {
        updateMany: jest.fn(async () => {
          operations.push('edge:deny');
          return { count: 1 };
        }),
        findMany: jest.fn(async () => {
          operations.push('edge:newer');
          return (options?.newerGrantedUserIds ?? []).map((userId) => ({ userId }));
        }),
      },
      managedEntityAdminMember: {
        deleteMany: jest.fn(async () => {
          operations.push('admin:delete');
          return { count: 1 };
        }),
        findMany: jest.fn(async () => {
          operations.push('admin:newer');
          return (options?.newerAdminUserIds ?? []).map((userId) => ({ userId }));
        }),
      },
      chatAdminAllowlist: {
        deleteMany: jest.fn(async () => {
          operations.push('allowlist:delete');
          return { count: 1 };
        }),
      },
    };
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-atomic-membership' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
        operations.push('transaction:start');
        const result = await callback(tx);
        operations.push('transaction:commit');
        return result;
      }),
    };
    return { operations, prisma, tx };
  };

  const maxBotLinkService = {
    bindChatToBot: jest.fn().mockResolvedValue(undefined),
    bindDiscoveredChatBots: jest.fn().mockResolvedValue(null),
    getStoredChatPrimaryBotId: jest.fn().mockResolvedValue(null),
    observeStoredChatBotWebhook: jest.fn().mockResolvedValue(undefined),
    markChatBotRemoved: jest.fn().mockResolvedValue(undefined),
    recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    reconcileChatPrimaryByAccess: jest.fn().mockResolvedValue(null),
  };
  const maxChatAdminRosterSyncService = {
    scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    maxBotLinkService.bindChatToBot.mockReset();
    maxBotLinkService.bindChatToBot.mockResolvedValue(undefined);
    maxBotLinkService.bindDiscoveredChatBots.mockReset();
    maxBotLinkService.bindDiscoveredChatBots.mockResolvedValue(null);
    maxBotLinkService.getStoredChatPrimaryBotId.mockReset();
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValue(null);
    maxBotLinkService.observeStoredChatBotWebhook.mockReset();
    maxBotLinkService.observeStoredChatBotWebhook.mockResolvedValue(undefined);
    maxBotLinkService.markChatBotRemoved.mockReset();
    maxBotLinkService.markChatBotRemoved.mockResolvedValue(undefined);
    maxBotLinkService.recordBotAccessProbe.mockReset();
    maxBotLinkService.recordBotAccessProbe.mockResolvedValue(true);
    maxBotLinkService.reconcileChatPrimaryByAccess.mockReset();
    maxBotLinkService.reconcileChatPrimaryByAccess.mockResolvedValue(null);
    maxChatAdminRosterSyncService.scheduleChatAdminRosterSync.mockReset();
    maxChatAdminRosterSyncService.scheduleChatAdminRosterSync.mockResolvedValue(true);
  });

  it('stores new webhook event in RECEIVED state', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-1' }),
        updateMany: jest.fn(),
      },
    };

    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const result = await service.ingest(
      {
        updateId: 'u-1',
        type: 'message',
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
  });

  it('stores same logical update id separately for different webhook bots', async () => {
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'evt-shared' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const baseUpdate = {
      updateId: 'u-shared-1',
      type: 'message_created',
      message: {
        messageId: 'm-shared-1',
        chatId: '-100',
        chatTitle: 'Shared chat',
        senderId: 'user-1',
        text: 'hello',
        createdAt: '2026-06-20T12:00:00.000Z',
      },
    };

    await expect(
      service.ingest({ ...baseUpdate, botId: 'standby-bot' } as never, '127.0.0.1'),
    ).resolves.toEqual({ accepted: true, duplicate: false });
    await expect(
      service.ingest({ ...baseUpdate, botId: 'owner-bot' } as never, '127.0.0.1'),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.webhookEvent.create.mock.calls.map(([args]) => args.data.dedupKey)).toEqual([
      'standby-bot:u-shared-1',
      'owner-bot:u-shared-1',
    ]);
  });

  it('keeps one canonical execution and selects the stored owner when its receipt arrives late', async () => {
    const ownerBotId = 'id613002203036_bot';
    const standbyBotId = 'id613002203036_4_bot';
    const events = new Map([
      [
        'evt-standby-first',
        {
          id: 'evt-standby-first',
          dedupKey: `${standbyBotId}:u-standby-first`,
          botId: standbyBotId,
          status: 'RECEIVED',
          normalizedPayload: {
            updateId: 'u-standby-first',
            type: 'message_created',
            botId: standbyBotId,
            message: {
              chatId: '-100-owner-late',
              messageId: 'mid-owner-late',
              senderId: 'user-1',
              text: 'hello',
              createdAt: '2026-07-10T12:00:00.123Z',
            },
          },
        },
      ],
      [
        'evt-owner-late',
        {
          id: 'evt-owner-late',
          dedupKey: `${ownerBotId}:u-owner-late`,
          botId: ownerBotId,
          status: 'RECEIVED',
          normalizedPayload: {
            updateId: 'u-owner-late',
            type: 'message_created',
            botId: ownerBotId,
            message: {
              chatId: '-100-owner-late',
              messageId: 'mid-owner-late',
              senderId: 'user-1',
              text: 'hello',
              createdAt: '2026-07-10T12:00:00.123Z',
            },
          },
        },
      ],
    ]);
    const claims = new Map<string, Record<string, unknown>>();
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn(async ({ where }: { where: { id?: string } }) =>
          where.id ? (events.get(where.id) ?? null) : null,
        ),
        updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
          const event = events.get(where.id);
          if (!event) {
            return { count: 0 };
          }
          Object.assign(event, data);
          return { count: 1 };
        }),
      },
      webhookExecutionClaim: {
        createMany: jest.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
          const row = data[0]!;
          const key = `${row.kind}:${row.semanticKey}`;
          if (claims.has(key)) {
            return { count: 0 };
          }
          claims.set(key, {
            id: 'claim-owner-late',
            status: 'PENDING',
            executionBotId: null,
            leaseToken: null,
            leaseExpiresAt: null,
            preparedAt: null,
            ...row,
          });
          return { count: 1 };
        }),
        findUnique: jest.fn(
          async ({ where }: { where: Record<string, Record<string, string>> }) => {
            const key = where.kind_semanticKey!;
            return claims.get(`${key.kind}:${key.semanticKey}`) ?? null;
          },
        ),
        updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
          const claim = [...claims.values()].find((candidate) => candidate.id === where.id);
          if (!claim) {
            return { count: 0 };
          }
          Object.assign(claim, data);
          return { count: 1 };
        }),
      },
      chatBotMembership: {
        findUnique: jest.fn().mockResolvedValue({
          permissionsSnapshot: {
            checkedAt: '2026-07-10T11:59:00.000Z',
            isAdmin: true,
            isOwner: false,
            permissions: ['write'],
          },
        }),
      },
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValue(ownerBotId);
    const service = new WebhookService(
      prisma as never,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'WEBHOOK_CANONICAL_EXECUTION_MODE' ? 'on' : (fallback ?? 1),
        ),
      } as never,
      maxBotLinkService as never,
    );

    await expect(service.preparePersistedWebhookEvent('evt-standby-first')).resolves.toEqual(
      expect.objectContaining({
        canonical: true,
        prepared: true,
        executionBotId: ownerBotId,
      }),
    );
    await expect(service.preparePersistedWebhookEvent('evt-owner-late')).resolves.toEqual(
      expect.objectContaining({
        canonical: false,
        prepared: true,
        executionBotId: ownerBotId,
      }),
    );

    expect(events.get('evt-standby-first')?.normalizedPayload).toEqual(
      expect.objectContaining({ executionOwnerBotId: ownerBotId }),
    );
    expect(events.get('evt-owner-late')?.status).toBe('DUPLICATE');
    expect(events.get('evt-owner-late')).toEqual(
      expect.objectContaining({
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      }),
    );
    expect(maxBotLinkService.observeStoredChatBotWebhook).toHaveBeenCalledTimes(2);
  });

  it('keeps an enforced claim sticky on rollback and touches a route-gap mirrored membership', async () => {
    const update = {
      updateId: 'u-route-gap-mirror',
      type: 'message_created',
      botId: 'bot-5',
      message: {
        chatId: '-100-route-gap',
        messageId: 'mid-route-gap',
        senderId: 'user-1',
        text: 'hello',
        createdAt: '2026-07-10T12:00:00.123Z',
      },
    };
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'evt-route-gap-mirror',
          dedupKey: 'bot-5:u-route-gap-mirror',
          botId: 'bot-5',
          status: 'RECEIVED',
          normalizedPayload: update,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      webhookExecutionClaim: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'claim-route-gap',
          kind: 'EXECUTION',
          semanticKey: 'message:message_created:-100-route-gap:mid-route-gap',
          webhookEventId: 'evt-route-gap-canonical',
          executionBotId: null,
          enforced: true,
          status: 'READY',
          leaseToken: null,
          leaseExpiresAt: null,
          preparedAt: new Date(),
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValue(null);
    const service = new WebhookService(
      prisma as never,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'WEBHOOK_CANONICAL_EXECUTION_MODE' ? 'shadow' : (fallback ?? 1),
        ),
      } as never,
      maxBotLinkService as never,
    );

    await expect(service.preparePersistedWebhookEvent('evt-route-gap-mirror')).resolves.toEqual(
      expect.objectContaining({ canonical: false, prepared: true }),
    );

    expect(maxBotLinkService.observeStoredChatBotWebhook).toHaveBeenCalledWith({
      chatId: '-100-route-gap',
      primaryBotId: null,
      botId: 'bot-5',
      observedAt: expect.any(Date),
    });
  });

  it('does not publish READY after losing the webhook preparation lease', async () => {
    const update = {
      updateId: 'u-preparation-lease-lost',
      type: 'message_created',
      botId: 'bot-1',
      message: {
        chatId: '-100-preparation-lease',
        messageId: 'mid-preparation-lease',
        senderId: 'user-1',
        text: 'hello',
        createdAt: '2026-07-10T12:00:00.123Z',
      },
    };
    const claim = {
      id: 'claim-preparation-lease',
      kind: 'EXECUTION',
      semanticKey: 'message:message_created:-100-preparation-lease:mid-preparation-lease',
      webhookEventId: 'evt-preparation-lease',
      executionBotId: null,
      enforced: true,
      status: 'PENDING',
      leaseToken: null,
      leaseExpiresAt: null,
      preparedAt: null,
    };
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'evt-preparation-lease',
          dedupKey: 'bot-1:u-preparation-lease-lost',
          botId: 'bot-1',
          status: 'RECEIVED',
          normalizedPayload: update,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      webhookExecutionClaim: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue(claim),
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 0 }),
      },
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('bot-1');
    const service = new WebhookService(
      prisma as never,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'WEBHOOK_CANONICAL_EXECUTION_MODE' ? 'on' : (fallback ?? 1),
        ),
      } as never,
      maxBotLinkService as never,
    );

    await expect(service.preparePersistedWebhookEvent('evt-preparation-lease')).rejects.toThrow(
      'Webhook preparation lease was lost before READY',
    );
    expect(prisma.webhookExecutionClaim.updateMany).toHaveBeenCalledTimes(3);
  });

  it('treats a fresh same-bot legacy unscoped dedup key as duplicate for bot-scoped retries', async () => {
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'evt-legacy',
          createdAt: new Date(),
          botId: 'owner-bot',
        }),
        create: jest.fn().mockResolvedValue({ id: 'evt-new' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.storeReceipt(
        {
          updateId: 'u-legacy-cutover',
          botId: 'owner-bot',
          type: 'message_created',
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: true, webhookEventId: null });

    expect(prisma.webhookEvent.findUnique).toHaveBeenCalledWith({
      where: {
        dedupKey: 'u-legacy-cutover',
      },
      select: {
        id: true,
        createdAt: true,
        botId: true,
      },
    });
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('does not treat another bot legacy unscoped dedup row as duplicate', async () => {
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'evt-legacy-standby',
          createdAt: new Date(),
          botId: 'standby-bot',
        }),
        create: jest.fn().mockResolvedValue({ id: 'evt-owner' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-legacy-owner-delivery',
          botId: 'owner-bot',
          type: 'message_created',
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupKey: 'owner-bot:u-legacy-owner-delivery',
        }),
      }),
    );
  });

  it('defers the Старт handshake after storing the webhook event', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-start' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(0),
    };
    const handshake = {
      handleWebhookUpdate: jest.fn().mockResolvedValue('connected'),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      handshake as never,
    );
    const update = {
      updateId: 'u-start-1',
      botId: 'bot-1',
      type: 'message_created',
      message: {
        messageId: 'm-start-1',
        chatId: '-100',
        chatTitle: 'Команда MAX',
        senderId: 'admin-1',
        text: 'Старт',
        createdAt: '2026-06-20T12:00:00.000Z',
      },
    };

    await expect(service.ingest(update, '127.0.0.1')).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await flushDeferredWebhookWork();

    expect(handshake.handleWebhookUpdate).toHaveBeenCalledWith(update);
  });

  it('leaves forwarded recovery to the durable webhook worker', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-forwarded-recovery' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(0),
    };
    const handshake = {
      handleWebhookUpdate: jest.fn().mockResolvedValue('connected'),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      handshake as never,
    );
    const update: MaxUpdate = {
      updateId: 'u-forwarded-recovery-worker-1',
      botId: 'bot-1',
      type: 'message_created',
      message: {
        messageId: 'm-forwarded-recovery-worker-1',
        chatId: '152517912',
        senderId: '195714583',
        text: 'Исходная публикация',
        createdAt: '2026-08-01T10:00:00.000Z',
      },
      raw: {
        update_type: 'message_created',
        message: {
          sender: { user_id: 195714583 },
          recipient: { chat_id: 152517912, chat_type: 'dialog' },
          body: {
            mid: 'm-forwarded-recovery-worker-1',
            seq: 1,
            text: null,
            attachments: null,
          },
          link: {
            type: 'forward',
            chat_id: -70000000000001,
            message: { mid: 'mid-forwarded-source-worker-1' },
          },
        },
      },
    };

    await expect(service.ingest(update, '127.0.0.1')).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await flushDeferredWebhookWork();

    expect(handshake.handleWebhookUpdate).not.toHaveBeenCalled();
  });

  it('stages a user-scoped managed entity bootstrap for Старт messages asynchronously', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-start-bootstrap' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(0),
    };
    const chatContextCache = {
      upsertManagedEntitiesRecentBootstrap: jest.fn().mockResolvedValue(undefined),
    };
    const handshake = {
      handleWebhookUpdate: jest.fn().mockResolvedValue('connected'),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
      handshake as never,
    );
    const update: MaxUpdate = {
      updateId: 'u-start-bootstrap-1',
      botId: 'bot-1',
      type: 'message_created',
      message: {
        messageId: 'm-start-bootstrap-1',
        chatId: '-100',
        chatTitle: 'Команда MAX',
        entityType: 'chat',
        senderId: 'admin-1',
        text: 'Старт',
        createdAt: '2026-06-20T12:00:00.000Z',
      },
    };

    await expect(service.ingest(update, '127.0.0.1')).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });

    expect(chatContextCache.upsertManagedEntitiesRecentBootstrap).not.toHaveBeenCalled();
    expect(handshake.handleWebhookUpdate).not.toHaveBeenCalled();

    await flushDeferredWebhookWork();

    expect(chatContextCache.upsertManagedEntitiesRecentBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '-100',
        title: 'Команда MAX',
        entityType: 'chat',
        primaryBotId: 'bot-1',
      }),
      expect.any(Number),
      'admin-1',
    );
    expect(handshake.handleWebhookUpdate).toHaveBeenCalledWith(update);
  });

  it('accepts duplicate events without mutating the original webhook state', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const result = await service.ingest(
      {
        updateId: 'u-1',
        type: 'message',
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: true });
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('accepts duplicate events from skip-duplicates inserts without raising a database error', async () => {
    const prisma = {
      webhookEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const result = await service.ingest(
      {
        updateId: 'u-skip-duplicate',
        type: 'message',
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: true });
    expect(prisma.webhookEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          dedupKey: 'u-skip-duplicate',
          status: 'RECEIVED',
        }),
      ],
      skipDuplicates: true,
    });
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('retries webhook storage with sanitized payload when Prisma rejects malformed JSON input', async () => {
    const prisma = {
      webhookEvent: {
        create: jest
          .fn()
          .mockRejectedValueOnce({
            code: 'InvalidArg',
            message: 'unexpected end of hex escape at line 1 column 581',
          })
          .mockResolvedValueOnce({ id: 'evt-2' }),
        updateMany: jest.fn(),
      },
    };

    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const result = await service.ingest(
      {
        updateId: 'u-2',
        type: 'message_callback',
        message: {
          messageId: 'mid-1',
          chatId: 'chat-1',
          senderId: 'user-1',
          text: 'broken-\ud800-text',
          createdAt: new Date('2026-03-26T12:00:00.000Z').toISOString(),
        },
        raw: {
          callback: {
            callback_id: 'callback-1',
            payload: 'action|sample-1|1|0',
            user: {
              user_id: 'user-1',
            },
          },
          weird: 'broken-\ud800-text',
        },
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.webhookEvent.create.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            message: expect.objectContaining({
              text: 'broken-\ufffd-text',
            }),
            raw: expect.objectContaining({
              weird: 'broken-\ufffd-text',
            }),
          }),
        }),
      }),
    );
  });

  it('sanitizes normalized raw payload before the first webhook storage attempt', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-sanitized-first' }),
        updateMany: jest.fn(),
      },
    };

    const config = {
      get: jest.fn().mockReturnValue(0),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const result = await service.ingest(
      {
        updateId: 'u-sanitized-first',
        type: 'message_created',
        message: {
          messageId: 'mid-sanitized-first',
          chatId: 'chat-1',
          senderId: 'user-1',
          text: 'clean text',
          createdAt: new Date('2026-03-26T12:00:00.000Z').toISOString(),
        },
        raw: {
          message: {
            body: {
              text: 'bad-\ud800-json\u0000',
            },
          },
          weird: 'bad-\ud800-json\u0000',
        },
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rawPayload: {},
          normalizedPayload: expect.objectContaining({
            message: expect.objectContaining({
              text: 'clean text',
            }),
            raw: expect.objectContaining({
              message: expect.objectContaining({
                body: expect.objectContaining({
                  text: 'bad-\ufffd-json',
                }),
              }),
              weird: 'bad-\ufffd-json',
            }),
          }),
        }),
      }),
    );
  });

  it('retries webhook storage with sanitized payload on Prisma json syntax errors', async () => {
    const prisma = {
      webhookEvent: {
        create: jest
          .fn()
          .mockRejectedValueOnce({
            code: 'P2007',
            message: 'Invalid input value: invalid input syntax for type json',
          })
          .mockResolvedValueOnce({ id: 'evt-2b' }),
        updateMany: jest.fn(),
      },
    };

    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const result = await service.ingest(
      {
        updateId: 'u-2b',
        type: 'message_created',
        message: {
          messageId: 'mid-2',
          chatId: 'chat-1',
          senderId: 'user-1',
          text: 'bad-\ud800-json',
          createdAt: new Date('2026-03-26T12:00:00.000Z').toISOString(),
        },
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.webhookEvent.create.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            message: expect.objectContaining({
              text: 'bad-\ufffd-json',
            }),
          }),
        }),
      }),
    );
  });

  it('does not wait for deferred membership invalidation or secondary read models before accepting webhook events', async () => {
    const neverSettles = new Promise<never>(() => undefined);
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-3' }),
        updateMany: jest.fn(),
      },
      managedEntityLocalActivity: {
        upsert: jest.fn().mockReturnValue(neverSettles),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const membershipLookup = {
      invalidateMemberships: jest.fn().mockReturnValue(neverSettles),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      membershipLookup as never,
    );

    await expect(
      Promise.race([
        service
          .ingest(
            {
              updateId: 'u-join-1',
              type: 'user_added',
              botId: 'id613002203036_bot',
              message: {
                messageId: 'user_added:u-join-1',
                chatId: '-100200',
                chatTitle: 'Новый чат',
                entityType: 'chat',
                senderId: 'user-10',
                text: '',
                createdAt: new Date('2026-03-29T12:00:00.000Z').toISOString(),
              },
              membership: {
                action: 'added',
                memberUserIds: ['user-10'],
              },
            },
            '127.0.0.1',
          )
          .then((result) => ({ kind: 'accepted', result })),
        new Promise((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), 25);
        }),
      ]),
    ).resolves.toEqual({
      kind: 'accepted',
      result: { accepted: true, duplicate: false },
    });

    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
  });

  it('repairs membership activity projection when MAX redelivers a duplicate join event', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        updateMany: jest.fn(),
      },
      chatMembershipActivityEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-duplicate-join-1',
          type: 'user_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-duplicate-join-1',
            chatId: '-100200',
            chatTitle: 'Новый чат',
            entityType: 'channel',
            senderId: 'user-77',
            senderName: 'Пользователь',
            text: '',
            createdAt: new Date('2026-04-06T00:00:00.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['user-77'],
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: true });

    expect(prisma.chatMembershipActivityEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: 'u-duplicate-join-1',
          dedupeKey: 'membership:user_added:-100200:user-77:2026-04-06T00:00:00.000Z',
          chatId: '-100200',
          eventType: 'user_added',
          userId: 'user-77',
          senderName: 'Пользователь',
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('repairs blank membership names and snapshots service-event targets on duplicate delivery', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        updateMany: jest.fn(),
      },
      chatUserDisplayName: {},
      $executeRaw: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-duplicate-service-membership-name',
          type: 'message_created',
          message: {
            messageId: 'mid-duplicate-service-membership-name',
            chatId: '-100200',
            senderId: 'admin-1',
            senderName: 'Админ',
            text: '',
            createdAt: new Date('2026-07-14T10:00:00.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['user-1001'],
          },
          raw: {
            message: {
              new_members: [
                {
                  user_id: 'user-1001',
                  display_name: 'Первый участник',
                },
              ],
            },
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: true });

    const queries = prisma.$executeRaw.mock.calls.map(([query]) => query);
    const membershipQuery = queries.find((query) =>
      extractSqlText(query).includes('INSERT INTO "chat_membership_activity_events"'),
    );
    const snapshotQuery = queries.find((query) =>
      extractSqlText(query).includes('INSERT INTO "chat_user_display_names"'),
    );

    expect(membershipQuery).toBeDefined();
    expect(extractSqlText(membershipQuery)).toContain('WITH incoming');
    expect(extractSqlText(membershipQuery)).toContain('ON CONFLICT ("dedupe_key") DO UPDATE SET');
    expect(extractSqlText(membershipQuery)).toContain(
      "COALESCE(BTRIM(existing.\"sender_name\"), '') = ''",
    );
    expect(extractSqlText(membershipQuery)).toContain(
      'GREATEST(existing."event_at", EXCLUDED."event_at")',
    );
    expect(extractSqlText(membershipQuery)).toMatch(/::timestamp\(3\)[\s\S]*::timestamp\(3\)/u);
    expect(snapshotQuery).toBeDefined();
    expect(extractSqlValues(snapshotQuery)).toEqual(
      expect.arrayContaining([
        '-100200',
        'user-1001',
        'Первый участник',
        'u-duplicate-service-membership-name',
        'membership:added',
      ]),
    );
  });

  it('best-effort invalidates remote membership lookups for join and leave events', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-3b' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const membershipLookup = {
      invalidateMemberships: jest.fn().mockResolvedValue(undefined),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      membershipLookup as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-join-1',
          type: 'user_added',
          message: {
            messageId: 'user_added:u-join-1',
            chatId: 'chat-1',
            senderId: 'user-10',
            text: '',
            createdAt: new Date('2026-03-29T12:00:00.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['user-10'],
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });
    await expect(
      service.ingest(
        {
          updateId: 'u-leave-1',
          type: 'user_removed',
          message: {
            messageId: 'user_removed:u-leave-1',
            chatId: 'chat-1',
            senderId: 'user-10',
            text: '',
            createdAt: new Date('2026-03-29T12:00:01.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    await flushDeferredWebhookWork();

    expect(membershipLookup.invalidateMemberships).toHaveBeenNthCalledWith(1, 'chat-1', [
      'user-10',
    ]);
    expect(membershipLookup.invalidateMemberships).toHaveBeenNthCalledWith(2, 'chat-1', [
      'user-10',
    ]);
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(2);
  });

  it('commits membership activity, denial, and allowlist cleanup before publishing cache epochs', async () => {
    const fixture = createAtomicMembershipFixture();
    const eventAt = new Date('2026-07-20T10:00:00.123Z');
    const chatContextCache = {
      applyAdminAccessEpochMutation: jest.fn(async ({ userId }: { userId: string }) => {
        fixture.operations.push(`cache:${userId}`);
        return true;
      }),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );

    await expect(
      service.ingest(
        buildMembershipUpdate({
          updateId: 'u-atomic-remove',
          type: 'user_removed',
          createdAt: eventAt.toISOString(),
        }),
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(fixture.operations).toEqual([
      'transaction:start',
      'chat:create',
      'chat:lock',
      'activity:upsert',
      'edge:deny',
      'admin:delete',
      'edge:newer',
      'admin:newer',
      'allowlist:delete',
      'transaction:commit',
      'cache:user-1',
      'cache:iduser-1',
    ]);
    expect(fixture.tx.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100-membership',
        userId: { in: ['user-1', 'iduser-1'] },
        checkedAt: { lte: eventAt },
      },
      data: expect.objectContaining({
        state: 'USER_DENIED',
        checkedAt: eventAt,
        deniedReason: 'webhook_user_removed',
      }),
    });
    expect(fixture.tx.managedEntityAdminMember.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100-membership',
        userId: { in: ['user-1', 'iduser-1'] },
        checkedAt: { lte: eventAt },
      },
    });
    expect(fixture.tx.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100-membership',
        userId: { in: ['user-1', 'iduser-1'] },
      },
    });
    expect(chatContextCache.applyAdminAccessEpochMutation.mock.calls.map(([args]) => args)).toEqual(
      [
        {
          chatId: '-100-membership',
          userId: 'user-1',
          state: 'user_denied',
          eventAt,
        },
        {
          chatId: '-100-membership',
          userId: 'iduser-1',
          state: 'user_denied',
          eventAt,
        },
      ],
    );
  });

  it('preserves allowlist and cache state for every alias family with newer granted evidence', async () => {
    const fixture = createAtomicMembershipFixture({
      newerGrantedUserIds: ['iduser-1'],
      newerAdminUserIds: ['user-2'],
    });
    const eventAt = new Date('2026-07-20T10:01:00.000Z');
    const chatContextCache = {
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );

    await service.ingest(
      buildMembershipUpdate({
        updateId: 'u-old-remove',
        type: 'user_removed',
        createdAt: eventAt.toISOString(),
        userIds: ['user-1', 'user-2', 'user-3'],
      }),
      '127.0.0.1',
    );

    const allVariants = ['user-1', 'iduser-1', 'user-2', 'iduser-2', 'user-3', 'iduser-3'];
    expect(fixture.tx.managedEntityAccessEdge.findMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100-membership',
        userId: { in: allVariants },
        state: 'GRANTED',
        checkedAt: { gt: eventAt },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    expect(fixture.tx.managedEntityAdminMember.findMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100-membership',
        userId: { in: allVariants },
        checkedAt: { gt: eventAt },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    expect(fixture.tx.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100-membership',
        userId: { in: ['user-3', 'iduser-3'] },
      },
    });
    expect(
      chatContextCache.applyAdminAccessEpochMutation.mock.calls.map(([args]) => args.userId),
    ).toEqual(['user-3', 'iduser-3']);
  });

  it('keeps committed membership denial when cache epoch publication fails', async () => {
    const fixture = createAtomicMembershipFixture();
    const chatContextCache = {
      applyAdminAccessEpochMutation: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );

    await expect(
      service.ingest(
        buildMembershipUpdate({
          updateId: 'u-remove-cache-failure',
          type: 'user_removed',
          createdAt: '2026-07-20T10:02:00.000Z',
        }),
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(fixture.operations).toContain('transaction:commit');
    expect(fixture.tx.managedEntityAccessEdge.updateMany).toHaveBeenCalledTimes(1);
    expect(fixture.tx.chatAdminAllowlist.deleteMany).toHaveBeenCalledTimes(1);
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);
  });

  it('does not hold webhook preparation indefinitely on a pending cache epoch mutation', async () => {
    const fixture = createAtomicMembershipFixture();
    const neverSettles = new Promise<boolean>(() => undefined);
    const chatContextCache = {
      applyAdminAccessEpochMutation: jest.fn().mockReturnValue(neverSettles),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );

    let guardTimer: NodeJS.Timeout | null = null;
    const outcome = await Promise.race([
      service
        .ingest(
          buildMembershipUpdate({
            updateId: 'u-remove-pending-cache',
            type: 'user_removed',
            createdAt: '2026-07-20T10:02:01.000Z',
          }),
          '127.0.0.1',
        )
        .then((result) => ({ kind: 'accepted' as const, result })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        guardTimer = setTimeout(() => resolve({ kind: 'timeout' }), 750);
      }),
    ]);
    if (guardTimer) {
      clearTimeout(guardTimer);
    }

    expect(outcome).toEqual({
      kind: 'accepted',
      result: { accepted: true, duplicate: false },
    });
    expect(fixture.operations).toContain('transaction:commit');
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);
  });

  it('resets prior admin evidence when user_added starts a new membership session', async () => {
    const fixture = createAtomicMembershipFixture();
    const chatContextCache = {
      applyAdminAccessEpochMutation: jest.fn(async ({ userId }: { userId: string }) => {
        fixture.operations.push(`cache:${userId}`);
        return true;
      }),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );

    await service.ingest(
      buildMembershipUpdate({
        updateId: 'u-atomic-add',
        type: 'user_added',
        createdAt: '2026-07-20T10:03:00.000Z',
      }),
      '127.0.0.1',
    );

    expect(fixture.operations).toEqual([
      'transaction:start',
      'chat:create',
      'chat:lock',
      'activity:upsert',
      'edge:deny',
      'admin:delete',
      'edge:newer',
      'admin:newer',
      'allowlist:delete',
      'transaction:commit',
      'cache:user-1',
      'cache:iduser-1',
    ]);
    expect(fixture.tx.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'USER_DENIED',
          deniedReason: 'webhook_user_added',
          source: 'webhook_user_added',
        }),
      }),
    );
    expect(fixture.tx.managedEntityAdminMember.deleteMany).toHaveBeenCalledTimes(1);
    expect(fixture.tx.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100-membership',
        userId: { in: ['user-1', 'iduser-1'] },
      },
    });
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);
  });

  it('preserves a grant newer than user_added for the full MAX id alias family', async () => {
    const fixture = createAtomicMembershipFixture({
      newerGrantedUserIds: ['iduser-1'],
    });
    const chatContextCache = {
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );

    await service.ingest(
      buildMembershipUpdate({
        updateId: 'u-add-before-newer-grant',
        type: 'user_added',
        createdAt: '2026-07-20T10:03:01.000Z',
      }),
      '127.0.0.1',
    );

    expect(fixture.tx.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
    expect(chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });

  it('advances the shared semantic removal row across rapid remove-add-remove updates', async () => {
    const fixture = createAtomicMembershipFixture();
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
    );

    await service.ingest(
      buildMembershipUpdate({
        updateId: 'u-rapid-remove-1',
        type: 'user_removed',
        createdAt: '2026-07-20T10:04:00.100Z',
      }),
      '127.0.0.1',
    );
    await service.ingest(
      buildMembershipUpdate({
        updateId: 'u-rapid-add',
        type: 'user_added',
        createdAt: '2026-07-20T10:04:00.500Z',
      }),
      '127.0.0.1',
    );
    await service.ingest(
      buildMembershipUpdate({
        updateId: 'u-rapid-remove-2',
        type: 'user_removed',
        createdAt: '2026-07-20T10:04:00.900Z',
      }),
      '127.0.0.1',
    );

    const projectionQueries = fixture.tx.$executeRaw.mock.calls.map(([query]) => query);
    const projectionValues = projectionQueries.map(extractSqlValues);
    expect(projectionValues.map((values) => values[1])).toEqual([
      'membership:user_removed:-100-membership:user-1:2026-07-20T10:04:00.000Z',
      'membership:user_added:-100-membership:user-1:2026-07-20T10:04:00.000Z',
      'membership:user_removed:-100-membership:user-1:2026-07-20T10:04:00.000Z',
    ]);
    expect(projectionValues.map((values) => values[7])).toEqual([
      new Date('2026-07-20T10:04:00.100Z'),
      new Date('2026-07-20T10:04:00.500Z'),
      new Date('2026-07-20T10:04:00.900Z'),
    ]);
    expect(projectionQueries.every((query) => extractSqlText(query).includes('GREATEST'))).toBe(
      true,
    );
  });

  it('repairs duplicate user_removed receipts through the atomic denial transition', async () => {
    const fixture = createAtomicMembershipFixture();
    fixture.prisma.webhookEvent.create.mockRejectedValueOnce({ code: 'P2002' });
    const chatContextCache = {
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );

    await expect(
      service.ingest(
        buildMembershipUpdate({
          updateId: 'u-duplicate-remove',
          type: 'user_removed',
          createdAt: '2026-07-20T10:05:00.000Z',
        }),
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: true });

    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(fixture.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(fixture.tx.managedEntityAccessEdge.updateMany).toHaveBeenCalledTimes(1);
    expect(fixture.tx.chatAdminAllowlist.deleteMany).toHaveBeenCalledTimes(1);
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);
  });

  it('persists admin read models for membership and managed-entities activity when projection tables are available', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-read-models' }),
        updateMany: jest.fn(),
      },
      chatMembershipActivityEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedEntityLocalActivity: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-read-models-1',
          type: 'user_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-read-models-1',
            chatId: '-100200',
            chatTitle: 'Новый чат',
            entityType: 'channel',
            senderId: 'user-77',
            senderName: 'Пользователь',
            text: '',
            createdAt: new Date('2026-04-06T00:00:00.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['user-77'],
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });
    await expect(
      service.ingest(
        {
          updateId: 'u-read-models-2',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-read-models-2',
            chatId: '-100200',
            chatTitle: 'Новый чат',
            entityType: 'channel',
            senderId: 'user-77',
            senderName: 'Пользователь',
            text: 'hello',
            createdAt: new Date('2026-04-06T00:01:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    await flushDeferredWebhookWork();

    expect(prisma.chatMembershipActivityEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: 'u-read-models-1',
          dedupeKey: 'membership:user_added:-100200:user-77:2026-04-06T00:00:00.000Z',
          chatId: '-100200',
          eventType: 'user_added',
          userId: 'user-77',
          senderName: 'Пользователь',
        }),
      ],
      skipDuplicates: true,
    });
    expect(prisma.managedEntityLocalActivity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_chatId: {
            userId: 'user-77',
            chatId: '-100200',
          },
        },
        create: expect.objectContaining({
          sourceEventType: 'user_added',
        }),
      }),
    );
    expect(prisma.managedEntityLocalActivity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_chatId: {
            userId: 'user-77',
            chatId: '-100200',
          },
        },
        create: expect.objectContaining({
          sourceEventType: 'message_created',
        }),
      }),
    );
  });

  it('uses an atomic SQL upsert for managed-entities activity on real Prisma clients', async () => {
    const eventAt = new Date('2026-04-06T00:03:00.000Z');
    const prisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-managed-raw-upsert' }),
        updateMany: jest.fn(),
      },
      managedEntityLocalActivity: {
        updateMany: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-managed-raw-upsert-1',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-managed-raw-upsert-1',
            chatId: '-100201',
            chatTitle: 'Новый чат',
            entityType: 'channel',
            senderId: 'user-raw',
            senderName: 'Пользователь',
            text: 'hello',
            createdAt: eventAt.toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    await flushDeferredWebhookWork();

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.managedEntityLocalActivity.updateMany).not.toHaveBeenCalled();
    expect(prisma.managedEntityLocalActivity.create).not.toHaveBeenCalled();
    expect(prisma.managedEntityLocalActivity.upsert).not.toHaveBeenCalled();

    const rawQuery = prisma.$executeRaw.mock.calls[0]?.[0];
    const sql = extractSqlText(rawQuery).replace(/\s+/g, ' ');
    expect(sql).toContain('INSERT INTO managed_entity_local_activities');
    expect(sql).toContain('ON CONFLICT (user_id, chat_id) DO UPDATE SET');
    expect(sql).toContain(
      'chat_title = COALESCE(EXCLUDED.chat_title, managed_entity_local_activities.chat_title)',
    );
    expect(sql).toContain(
      'WHERE managed_entity_local_activities.last_event_at < EXCLUDED.last_event_at',
    );
    expect(extractSqlValues(rawQuery)).toEqual([
      'user-raw',
      '-100201',
      'CHANNEL',
      'Новый чат',
      'message_created',
      'id613002203036_bot',
      eventAt,
    ]);
  });

  it('persists managed-entities activity for chat_title_changed updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-title-activity' }),
        updateMany: jest.fn(),
      },
      managedEntityLocalActivity: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const eventAt = new Date('2026-04-06T00:02:00.000Z');

    await expect(
      service.ingest(
        {
          updateId: 'u-title-activity-1',
          type: 'chat_title_changed',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'chat_title_changed:u-title-activity-1',
            chatId: '-100200',
            chatTitle: 'Новое название',
            entityType: 'chat',
            senderId: 'user-title-77',
            senderName: 'Редактор',
            text: '',
            createdAt: eventAt.toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    await flushDeferredWebhookWork();

    expect(prisma.managedEntityLocalActivity.upsert).toHaveBeenCalledWith({
      where: {
        userId_chatId: {
          userId: 'user-title-77',
          chatId: '-100200',
        },
      },
      create: {
        userId: 'user-title-77',
        chatId: '-100200',
        entityType: 'CHAT',
        chatTitle: 'Новое название',
        sourceEventType: 'chat_title_changed',
        botId: 'id613002203036_bot',
        lastEventAt: eventAt,
      },
      update: {
        entityType: 'CHAT',
        chatTitle: 'Новое название',
        sourceEventType: 'chat_title_changed',
        botId: 'id613002203036_bot',
        lastEventAt: eventAt,
      },
    });
  });

  it('persists service message membership collections as per-member activity events', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-service-membership' }),
        updateMany: jest.fn(),
      },
      chatMembershipActivityEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      managedEntityLocalActivity: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-service-membership-1',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-service-membership-1',
            chatId: '-100200',
            chatTitle: 'Новый чат',
            entityType: 'chat',
            senderId: 'admin-1',
            senderName: 'Админ',
            text: '',
            createdAt: new Date('2026-04-06T02:00:00.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['user-1001', 'user-1002'],
          },
          raw: {
            update_type: 'message_created',
            message: {
              new_members: [
                {
                  user_id: 'user-1001',
                  display_name: 'Первый участник',
                  name: 'Первый',
                },
                {
                  user: {
                    user_id: 'user-1002',
                    first_name: 'Второй',
                    last_name: 'Участник',
                    name: 'Второй',
                  },
                },
              ],
            },
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.chatMembershipActivityEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: 'u-service-membership-1:user_added:user-1001',
          dedupeKey: 'membership:user_added:-100200:user-1001:2026-04-06T02:00:00.000Z',
          eventType: 'user_added',
          userId: 'user-1001',
          senderName: 'Первый участник',
        }),
        expect.objectContaining({
          id: 'u-service-membership-1:user_added:user-1002',
          dedupeKey: 'membership:user_added:-100200:user-1002:2026-04-06T02:00:00.000Z',
          eventType: 'user_added',
          userId: 'user-1002',
          senderName: 'Второй Участник',
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('persists service message removals as left membership activity events', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-service-membership-left' }),
        updateMany: jest.fn(),
      },
      chatMembershipActivityEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-service-membership-left-1',
          type: 'message_created',
          message: {
            messageId: 'mid-service-membership-left-1',
            chatId: '-100200',
            entityType: 'channel',
            senderId: 'admin-1',
            text: '',
            createdAt: new Date('2026-04-06T02:01:00.000Z').toISOString(),
          },
          membership: {
            action: 'removed',
            memberUserIds: ['user-1003'],
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.chatMembershipActivityEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: 'u-service-membership-left-1',
          dedupeKey: 'membership:user_removed:-100200:user-1003:2026-04-06T02:01:00.000Z',
          eventType: 'user_removed',
          userId: 'user-1003',
          senderName: null,
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('uses the same membership dedupe key for equivalent join events from different bots', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-membership-dedupe' }),
        updateMany: jest.fn(),
      },
      chatMembershipActivityEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedEntityLocalActivity: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await service.ingest(
      {
        updateId: 'u-membership-dedupe-1',
        type: 'user_added',
        botId: 'id613002203036_bot',
        message: {
          messageId: 'mid-membership-dedupe-1',
          chatId: '-100333',
          senderId: 'user-88',
          senderName: 'Ольга',
          text: '',
          createdAt: new Date('2026-04-06T01:00:00.000Z').toISOString(),
        },
        membership: {
          action: 'added',
          memberUserIds: ['user-88'],
        },
      },
      '127.0.0.1',
    );

    await flushDeferredWebhookWork();

    await service.ingest(
      {
        updateId: 'u-membership-dedupe-2',
        type: 'user_added',
        botId: 'id613002203036_4_bot',
        message: {
          messageId: 'mid-membership-dedupe-2',
          chatId: '-100333',
          senderId: 'user-88',
          senderName: 'Ольга',
          text: '',
          createdAt: new Date('2026-04-06T01:00:00.001Z').toISOString(),
        },
        membership: {
          action: 'added',
          memberUserIds: ['user-88'],
        },
      },
      '127.0.0.1',
    );

    await flushDeferredWebhookWork();

    const firstCall = prisma.chatMembershipActivityEvent.createMany.mock.calls[0]?.[0];
    const secondCall = prisma.chatMembershipActivityEvent.createMany.mock.calls[1]?.[0];

    expect(firstCall?.data?.[0]?.dedupeKey).toBe(
      'membership:user_added:-100333:user-88:2026-04-06T01:00:00.000Z',
    );
    expect(secondCall?.data?.[0]?.dedupeKey).toBe(
      'membership:user_added:-100333:user-88:2026-04-06T01:00:00.000Z',
    );
  });

  it('marks bot membership removed instead of rebinding it on bot_removed updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-4' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-removed-1',
          type: 'bot_removed',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'bot_removed:u-bot-removed-1',
            chatId: '-100123',
            chatTitle: 'Shared chat',
            entityType: 'channel',
            senderId: 'id613002203036_4_bot',
            text: '',
            createdAt: new Date('2026-03-30T12:00:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100123',
        title: 'Shared chat',
        entityType: 'CHANNEL',
        botId: 'id613002203036_4_bot',
      }),
    );
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100123',
        botId: 'id613002203036_4_bot',
      }),
    );
  });

  it('routes a trusted bot removal through access-loss cleanup without marking it twice', async () => {
    const lifecycleEventAt = new Date('2026-08-20T12:00:00.123Z');
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-removal-cleanup' }),
        updateMany: jest.fn(),
      },
    };
    const managedEntityAccessLossService = {
      recordManagedEntityAccessLost: jest.fn().mockResolvedValue({
        nextOwnerBotId: 'bot-2',
      }),
    };
    const service = new WebhookService(
      prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
      undefined,
      undefined,
      managedEntityAccessLossService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-removed-cleanup',
          type: 'bot_removed',
          botId: 'bot-1',
          eventTimestampSource: 'payload',
          message: {
            messageId: 'bot_removed:u-bot-removed-cleanup',
            chatId: '-100-removal-cleanup',
            chatTitle: 'Shared chat',
            entityType: 'chat',
            senderId: 'admin-1',
            text: '',
            createdAt: lifecycleEventAt.toISOString(),
          },
        } as MaxUpdate,
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(managedEntityAccessLossService.recordManagedEntityAccessLost).toHaveBeenCalledTimes(1);
    expect(managedEntityAccessLossService.recordManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: '-100-removal-cleanup',
      title: 'Shared chat',
      entityType: ChatEntityType.CHAT,
      botId: 'bot-1',
      reason: 'bot_removed',
      source: 'webhook_bot_removed',
      lifecycleEventAt,
      lifecycleEventType: 'bot_removed',
      lifecycleSource: 'webhook',
      cachePublicationWaitMs: 100,
    });
    expect(maxBotLinkService.markChatBotRemoved).not.toHaveBeenCalled();
    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100-removal-cleanup',
        botIds: ['bot-1'],
        source: 'webhook_bot_removed',
      }),
    );
  });

  it('keeps a lifecycle receipt retryable when removal persistence fails', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-removal-db-failure' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    maxBotLinkService.markChatBotRemoved.mockRejectedValueOnce(
      new Error('temporary membership write failure'),
    );
    const service = new WebhookService(
      prisma as never,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'WEBHOOK_CANONICAL_EXECUTION_MODE' ? 'off' : (fallback ?? 1),
        ),
      } as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-removal-db-failure',
          type: 'bot_removed',
          botId: 'bot-1',
          message: {
            messageId: 'bot_removed:u-removal-db-failure',
            chatId: '-100-removal-db-failure',
            chatTitle: 'Shared chat',
            entityType: 'chat',
            senderId: 'bot-1',
            text: '',
            createdAt: '2026-07-10T12:00:00.123Z',
          },
        },
        '127.0.0.1',
      ),
    ).rejects.toThrow('temporary membership write failure');

    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('does not apply a terminal lifecycle transition without a trusted event timestamp', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-untrusted-removal' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('owner-bot');
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-removed-without-event-time',
          type: 'bot_removed',
          botId: 'standby-bot',
          eventTimestampSource: 'ingress',
          message: {
            messageId: 'bot_removed:u-bot-removed-without-event-time',
            chatId: '-100-untrusted-removal',
            chatTitle: 'Shared chat',
            entityType: 'chat',
            senderId: 'standby-bot',
            text: '',
            createdAt: new Date().toISOString(),
          },
        } as MaxUpdate,
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.markChatBotRemoved).not.toHaveBeenCalled();
    expect(maxBotLinkService.getStoredChatPrimaryBotId).toHaveBeenCalledWith(
      '-100-untrusted-removal',
      { bypassCache: true },
    );
    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalled();
  });

  it('parses an official bot_removed actor payload and removes the authenticated ingress bot', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-4b' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    maxBotLinkService.markChatBotRemoved.mockResolvedValueOnce('id613002203036_bot');
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );
    const update = new WebhookParser().parse(
      {
        update_id: 'u-bot-removed-official-1',
        update_type: 'bot_removed',
        chat_id: -73729721862151,
        chat: {
          chat_id: -73729721862151,
          chat_type: 'chat',
          title: 'Пантера',
        },
        user: {
          user_id: 900001,
          first_name: 'Иван',
          last_name: 'Администратор',
        },
        timestamp: '2026-05-10T02:10:01.411Z',
      },
      { botId: 'id613002203036_bot' },
    );

    expect(update.message).toEqual(
      expect.objectContaining({
        senderId: '900001',
        senderName: 'Иван Администратор',
      }),
    );
    expect(update.membership).toEqual({
      action: 'removed',
      memberUserIds: ['id613002203036_bot'],
    });
    await expect(service.ingest(update, '127.0.0.1')).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });

    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        title: 'Пантера',
        entityType: 'CHAT',
        botId: 'id613002203036_bot',
      }),
    );
    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        botIds: ['id613002203036_bot'],
        source: 'webhook_bot_removed',
      }),
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            botId: 'id613002203036_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: expect.objectContaining({ senderId: '900001' }),
          }),
        }),
      }),
    );
  });

  it('does not let a bot-like human actor redirect bot_removed away from the ingress bot', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-4bb' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    maxBotLinkService.markChatBotRemoved.mockResolvedValueOnce(null);
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-removed-actor-looks-like-bot',
          type: 'bot_removed',
          botId: 'bot-1',
          message: {
            messageId: 'bot_removed:u-bot-removed-actor-looks-like-bot',
            chatId: '-73729721862152',
            chatTitle: 'Shared N-way chat',
            entityType: 'chat',
            senderId: '5005',
            senderName: 'Human actor',
            text: '',
            createdAt: new Date('2026-05-10T02:12:01.411Z').toISOString(),
          },
          raw: {
            update_type: 'bot_removed',
            chat_id: -73729721862152,
            user: {
              id: 'bot-5-contact',
              user_id: '5005',
              username: 'bot-5',
              name: 'Bot Five',
              is_bot: false,
            },
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862152',
        title: 'Shared N-way chat',
        entityType: 'CHAT',
        botId: 'bot-1',
      }),
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            botId: 'bot-1',
          }),
        }),
      }),
    );
  });

  it('uses the authenticated bot subject even when bot_removed actor details are sparse', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-4c' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-removed-ambiguous-1',
          type: 'bot_removed',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'bot_removed:u-bot-removed-ambiguous-1',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            entityType: 'chat',
            senderId: 'unknown-service-user',
            text: '',
            createdAt: new Date('2026-05-10T02:10:01.411Z').toISOString(),
          },
          raw: {
            update_type: 'bot_removed',
            chat_id: -73729721862151,
            user: {
              user_id: 999999,
              is_bot: true,
            },
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        title: 'Пантера',
        entityType: 'CHAT',
        botId: 'id613002203036_bot',
      }),
    );
  });

  it('observes extended terminal lifecycle updates without enforcing them in shadow mode', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-shadow-bot-stopped' }),
        updateMany: jest.fn(),
      },
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('bot-1');
    const service = new WebhookService(
      prisma as never,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE' ? 'shadow' : fallback,
        ),
      } as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-shadow-bot-stopped',
          type: 'bot_stopped',
          botId: 'bot-1',
          eventTimestampSource: 'payload',
          message: {
            messageId: 'bot_stopped:u-shadow-bot-stopped',
            chatId: '-100-shadow-lifecycle',
            entityType: 'chat',
            senderId: 'user-1',
            text: '',
            createdAt: '2026-07-10T12:00:00.123Z',
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.markChatBotRemoved).not.toHaveBeenCalled();
    expect(maxBotLinkService.getStoredChatPrimaryBotId).toHaveBeenCalledWith(
      '-100-shadow-lifecycle',
      { bypassCache: true },
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'evt-shadow-bot-stopped' }),
      }),
    );
  });

  it('requires fresh live probes before cached snapshots can fail over the execution owner', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-5' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['delete_messages'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');
    maxBotLinkService.bindChatToBot.mockResolvedValueOnce('id613002203036_4_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    (service as any).botSelfAccessCache.set('-100123:id613002203036_bot', {
      canHandleUserFacing: false,
      expiresAtMs: Date.now() + 60_000,
    });
    (service as any).botSelfAccessCache.set('-100123:id613002203036_4_bot', {
      canHandleUserFacing: true,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      service.ingest(
        {
          updateId: 'u-failover-1',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-1',
            chatId: '-100123',
            chatTitle: 'Тестовый чат',
            senderId: 'user-1',
            text: 'https://spam.example',
            createdAt: new Date('2026-03-31T20:00:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );

    await flushDeferredWebhookWork();

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.bindChatToBot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chatId: '-100123',
        botId: 'id613002203036_4_bot',
        allowReassign: true,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      }),
    );
  });

  it('runs a second accepted live probe after storing the binding lifecycle watermark', async () => {
    const chatId = '-100-live-probe-recovery';
    const botId = 'id613002203036_4_bot';
    const eventOrder: string[] = [];
    let confirmedAfterLifecycle = false;
    let routingState = 'NO_ELIGIBLE_BOT';
    let lifecycleEventAt: Date | null = null;
    let persistedAccessData: Record<string, unknown> | null = null;
    let probeCount = 0;
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-live-probe-recovery' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn(async () => {
        probeCount += 1;
        eventOrder.push(`probe-${probeCount}`);
        return {
          userId: botId,
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        };
      }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce(null);
    maxBotLinkService.bindChatToBot.mockImplementationOnce(async (params) => {
      eventOrder.push('bind-lifecycle');
      lifecycleEventAt = params.lifecycleEventAt;
      return botId;
    });
    maxBotLinkService.recordBotAccessProbe.mockImplementation(
      async ({ access, checkedAt, source }) => {
        eventOrder.push(lifecycleEventAt ? 'persist-confirmed-access' : 'persist-before-bind');
        if (lifecycleEventAt) {
          persistedAccessData = {
            botAccessState: access ? 'CONFIRMED_ADMIN' : 'DENIED',
            botAccessCheckedAt: checkedAt,
            botAccessExpiresAt: new Date(checkedAt.getTime() + 60_000),
            botAccessSource: source,
          };
          confirmedAfterLifecycle =
            access !== null &&
            lifecycleEventAt instanceof Date &&
            checkedAt.getTime() >= lifecycleEventAt.getTime();
        }
        return true;
      },
    );
    maxBotLinkService.reconcileChatPrimaryByAccess.mockImplementation(async () => {
      eventOrder.push('reconcile-route');
      if (confirmedAfterLifecycle) {
        routingState = 'READY';
        return botId;
      }
      return null;
    });

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-live-probe-recovery',
          type: 'message_created',
          botId,
          message: {
            messageId: 'mid-live-probe-recovery',
            chatId,
            chatTitle: 'Lifecycle recovery',
            entityType: 'chat',
            senderId: 'user-1',
            text: 'hello',
            createdAt: new Date('2026-07-10T12:00:00.123Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId,
        botId,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      }),
    );
    expect(eventOrder.slice(0, 6)).toEqual([
      'probe-1',
      'persist-before-bind',
      'bind-lifecycle',
      'probe-2',
      'persist-confirmed-access',
      'reconcile-route',
    ]);
    expect(persistedAccessData).toEqual(
      expect.objectContaining({
        botAccessState: 'CONFIRMED_ADMIN',
        botAccessCheckedAt: expect.any(Date),
        botAccessExpiresAt: expect.any(Date),
        botAccessSource: 'webhook_owner_failover',
      }),
    );
    expect(routingState).toBe('READY');
  });

  it('does not bind a stale successful probe when bot removal wins during the request', async () => {
    const chatId = '-100-live-probe-removal-race';
    const botId = 'id613002203036_4_bot';
    const probeStartedAt = new Date('2026-07-10T12:00:00.000Z');
    const probeCompletedAt = new Date('2026-07-10T12:00:30.000Z');
    let releaseProbe!: (access: {
      userId: string;
      isAdmin: boolean;
      isOwner: boolean;
      permissions: string[];
    }) => void;
    let reportProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      reportProbeStarted = resolve;
    });
    const probeResult = new Promise<{
      userId: string;
      isAdmin: boolean;
      isOwner: boolean;
      permissions: string[];
    }>((resolve) => {
      releaseProbe = resolve;
    });
    const prisma = {
      webhookEvent: {
        create: jest
          .fn()
          .mockResolvedValueOnce({ id: 'evt-live-probe-race-message' })
          .mockResolvedValueOnce({ id: 'evt-live-probe-race-removal' }),
        updateMany: jest.fn(),
      },
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn(() => {
        reportProbeStarted();
        return probeResult;
      }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce(null);
    maxBotLinkService.markChatBotRemoved.mockResolvedValueOnce(null);
    maxBotLinkService.recordBotAccessProbe.mockResolvedValueOnce(false);

    jest.useFakeTimers();
    try {
      jest.setSystemTime(probeStartedAt);
      const service = new WebhookService(
        prisma as never,
        { get: jest.fn().mockReturnValue(1) } as never,
        maxBotLinkService as never,
        undefined,
        maxClient as never,
      );
      const cacheKey = `${chatId}:${botId}`;
      (service as any).botSelfAccessCache.set(cacheKey, {
        canHandleUserFacing: true,
        checkedAtMs: probeStartedAt.getTime() - 1,
        expiresAtMs: probeCompletedAt.getTime() + 60_000,
      });

      const messageIngest = service.ingest(
        {
          updateId: 'u-live-probe-race-message',
          type: 'message_created',
          botId,
          message: {
            messageId: 'mid-live-probe-race-message',
            chatId,
            chatTitle: 'Lifecycle race',
            entityType: 'chat',
            senderId: 'user-1',
            text: 'hello',
            createdAt: probeStartedAt.toISOString(),
          },
        },
        '127.0.0.1',
      );
      await probeStarted;

      jest.setSystemTime(probeCompletedAt);
      await expect(
        service.ingest(
          {
            updateId: 'u-live-probe-race-removal',
            type: 'bot_removed',
            botId,
            eventTimestampSource: 'payload',
            message: {
              messageId: 'bot_removed:u-live-probe-race-removal',
              chatId,
              chatTitle: 'Lifecycle race',
              entityType: 'chat',
              senderId: 'admin-1',
              text: '',
              createdAt: probeCompletedAt.toISOString(),
            },
          },
          '127.0.0.1',
        ),
      ).resolves.toEqual({ accepted: true, duplicate: false });

      releaseProbe({
        userId: botId,
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      });
      await expect(messageIngest).resolves.toEqual({ accepted: true, duplicate: false });

      expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith({
        chatId,
        botId,
        access: expect.objectContaining({ isAdmin: true }),
        source: 'webhook_owner_failover',
        checkedAt: probeStartedAt,
        allowMembershipRecovery: true,
      });
      expect(maxBotLinkService.markChatBotRemoved.mock.invocationCallOrder[0]).toBeLessThan(
        maxBotLinkService.recordBotAccessProbe.mock.invocationCallOrder[0] ??
          Number.MAX_SAFE_INTEGER,
      );
      expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
      expect((service as any).botSelfAccessCache.has(cacheKey)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not return an old terminal denial when newer accepted evidence supersedes it', async () => {
    const chatId = '-100-live-probe-denial-race';
    const botId = 'id613002203036_4_bot';
    const denialStartedAt = new Date('2026-07-10T13:00:00.000Z');
    const newerEvidenceAt = new Date('2026-07-10T13:00:01.000Z');
    let rejectProbe!: (error: unknown) => void;
    let reportProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      reportProbeStarted = resolve;
    });
    const probeResult = new Promise<never>((_resolve, reject) => {
      rejectProbe = reject;
    });
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn(() => {
        reportProbeStarted();
        return probeResult;
      }),
    };
    maxBotLinkService.recordBotAccessProbe.mockResolvedValueOnce(false);

    jest.useFakeTimers();
    try {
      jest.setSystemTime(denialStartedAt);
      const service = new WebhookService(
        { webhookEvent: {} } as never,
        { get: jest.fn() } as never,
        maxBotLinkService as never,
        undefined,
        maxClient as never,
      );
      const cacheKey = `${chatId}:${botId}`;
      const refresh = (service as any).getBotSelfModerationAccessState(chatId, botId, {
        bypassCache: true,
      });
      await probeStarted;

      jest.setSystemTime(newerEvidenceAt);
      (service as any).cacheBotSelfAccessState(cacheKey, true, newerEvidenceAt.getTime());
      rejectProbe({ response: { status: 403 }, message: 'chat denied' });

      await expect(refresh).resolves.toBeNull();
      expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith({
        chatId,
        botId,
        access: null,
        source: 'webhook_owner_failover',
        checkedAt: denialStartedAt,
        allowMembershipRecovery: false,
      });
      expect((service as any).readCachedBotSelfAccess(cacheKey)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not cache or return live access when fenced persistence fails', async () => {
    const chatId = '-100-live-probe-persist-error';
    const botId = 'id613002203036_4_bot';
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: botId,
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      }),
    };
    maxBotLinkService.recordBotAccessProbe.mockRejectedValueOnce(new Error('database unavailable'));
    const service = new WebhookService(
      { webhookEvent: {} } as never,
      { get: jest.fn() } as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    const cacheKey = `${chatId}:${botId}`;
    (service as any).botSelfAccessCache.set(cacheKey, {
      canHandleUserFacing: true,
      checkedAtMs: Date.now() - 1,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      (service as any).getBotSelfModerationAccessState(chatId, botId, { bypassCache: true }),
    ).resolves.toBeNull();
    expect((service as any).botSelfAccessCache.has(cacheKey)).toBe(false);
  });

  it('defers ordinary message owner failover to an async live recheck when only the current owner snapshot is stale', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-5a' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['delete_messages'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');
    maxBotLinkService.bindChatToBot.mockResolvedValueOnce('id613002203036_4_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    (service as any).botSelfAccessCache.set('-100123:id613002203036_bot', {
      canHandleUserFacing: false,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      service.ingest(
        {
          updateId: 'u-failover-async-1',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-1a',
            chatId: '-100123',
            chatTitle: 'Тестовый чат',
            senderId: 'user-1',
            text: 'https://spam.example',
            createdAt: new Date('2026-03-31T20:00:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      2,
      '-100123',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chatId: '-100123',
        botId: 'id613002203036_4_bot',
        allowReassign: true,
      }),
    );
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(2);
  });

  it('defers execution owner live refresh for group admin moderation commands until after persist', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-command-failover' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_4_bot');
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-command-failover-1',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-command-ban-1',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            senderId: '98315271',
            text: 'Бан',
            createdAt: new Date('2026-05-10T03:00:26.996Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_4_bot',
          }),
        }),
      }),
    );
    const persistOrder = prisma.webhookEvent.create.mock.invocationCallOrder[0];

    await flushDeferredWebhookWork();

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(persistOrder).toBeLessThan(
      maxClient.getCurrentChatMemberAccess.mock.invocationCallOrder[0],
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      1,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      2,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_bot',
        bypassCache: true,
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        botId: 'id613002203036_bot',
        allowReassign: true,
      }),
    );
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(2);
  });

  it('defers execution owner live refresh for custom linked admin commands', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-custom-command-failover' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_4_bot');
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-custom-command-failover-1',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-custom-command-ban-1',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            senderId: '98315271',
            text: 'заблокировать',
            createdAt: new Date('2026-05-10T03:00:26.996Z').toISOString(),
          },
          raw: {
            message: {
              link: {
                type: 'reply',
                sender: {
                  user_id: 'user-2',
                },
              },
            },
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_4_bot',
          }),
        }),
      }),
    );

    await flushDeferredWebhookWork();

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        botId: 'id613002203036_bot',
        allowReassign: true,
      }),
    );
  });

  it('defers execution owner live refresh for developer super ban commands', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-super-ban-failover' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_4_bot');
    maxBotLinkService.bindChatToBot.mockResolvedValueOnce('id613002203036_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-super-ban-failover-1',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-command-super-ban-1',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            senderId: '98315271',
            text: 'Супер бан',
            createdAt: new Date('2026-05-10T03:00:26.996Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();

    await flushDeferredWebhookWork();

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        botId: 'id613002203036_bot',
        allowReassign: true,
      }),
    );
  });

  it('bypasses stale cached bot access states in deferred group admin command rechecks', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-command-cache-bypass' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');
    maxBotLinkService.bindChatToBot.mockResolvedValueOnce('id613002203036_4_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    (service as any).botSelfAccessCache.set('-73729721862151:id613002203036_bot', {
      canHandleUserFacing: true,
      expiresAtMs: Date.now() + 60_000,
    });
    (service as any).botSelfAccessCache.set('-73729721862151:id613002203036_4_bot', {
      canHandleUserFacing: false,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      service.ingest(
        {
          updateId: 'u-command-cache-bypass-1',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-command-ban-2',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            senderId: '98315271',
            text: 'Бан',
            createdAt: new Date('2026-05-10T03:11:32.471Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );

    await flushDeferredWebhookWork();

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      1,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      2,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        bypassCache: true,
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        botId: 'id613002203036_4_bot',
        allowReassign: true,
      }),
    );
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(2);
  });

  it('defers membership churn owner live refresh until after persist', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-membership-failover' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['delete_messages'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');
    maxBotLinkService.bindChatToBot.mockResolvedValueOnce('id613002203036_4_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    (service as any).botSelfAccessCache.set('-73729721862151:id613002203036_bot', {
      canHandleUserFacing: true,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      service.ingest(
        {
          updateId: 'u-membership-failover-1',
          type: 'user_added',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'user_added:u-membership-failover-1',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            entityType: 'chat',
            senderId: '98315271',
            senderName: 'Новый админ',
            text: '',
            createdAt: new Date('2026-05-10T03:21:00.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['98315271'],
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(maxBotLinkService.observeStoredChatBotWebhook).toHaveBeenCalledWith({
      chatId: '-73729721862151',
      primaryBotId: 'id613002203036_bot',
      botId: 'id613002203036_4_bot',
    });
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );

    await flushDeferredWebhookWork();

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      1,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      2,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        botId: 'id613002203036_4_bot',
        allowReassign: true,
      }),
    );
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(2);
  });

  it('keeps the current owner on ordinary message updates without running a live failover check', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-6' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: ['delete_messages'],
      }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-owner-ok-1',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-2',
            chatId: '-100124',
            chatTitle: 'Shared chat',
            senderId: 'user-2',
            text: 'hello',
            createdAt: new Date('2026-03-31T20:00:01.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );
  });

  it('reuses the stored chat binding for ordinary mirrored updates without rewriting chat ownership rows', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-6a' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-owner-stored-1',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-2a',
            chatId: '-100124',
            chatTitle: 'Shared chat',
            senderId: 'user-2',
            text: 'hello',
            createdAt: new Date('2026-03-31T20:00:01.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.getStoredChatPrimaryBotId).toHaveBeenCalledWith('-100124', {
      bypassCache: true,
    });
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(maxBotLinkService.observeStoredChatBotWebhook).toHaveBeenCalledWith({
      chatId: '-100124',
      primaryBotId: 'id613002203036_bot',
      botId: 'id613002203036_4_bot',
    });
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );
  });

  it('does not promote a stored standby from cached snapshots alone', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-6aa' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    (service as any).botSelfAccessCache.set('-100124:id613002203036_bot', {
      canHandleUserFacing: false,
      expiresAtMs: Date.now() + 60_000,
    });
    (service as any).botSelfAccessCache.set('-100124:id613002203036_4_bot', {
      canHandleUserFacing: true,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      service.ingest(
        {
          updateId: 'u-owner-stored-2',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-2b',
            chatId: '-100124',
            chatTitle: 'Shared chat',
            senderId: 'user-2',
            text: 'hello',
            createdAt: new Date('2026-03-31T20:00:02.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(maxBotLinkService.observeStoredChatBotWebhook).toHaveBeenCalledWith({
      chatId: '-100124',
      primaryBotId: 'id613002203036_bot',
      botId: 'id613002203036_4_bot',
    });
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );
  });

  it('does not fail over a stale stored primary from persisted snapshots alone', async () => {
    const checkedAt = new Date().toISOString();
    const membershipSnapshots = new Map([
      [
        'bot-1',
        {
          permissionsSnapshot: {
            checkedAt,
            isAdmin: false,
            isOwner: false,
            permissions: [],
          },
        },
      ],
      [
        'bot-5',
        {
          permissionsSnapshot: {
            checkedAt,
            isAdmin: true,
            isOwner: false,
            permissions: ['delete_messages'],
          },
        },
      ],
    ]);
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-6ab' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn(
          async (args: { where: { chatId_botId: { chatId: string; botId: string } } }) =>
            membershipSnapshots.get(args.where.chatId_botId.botId) ?? null,
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('bot-1');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-owner-stored-bot-5',
          type: 'message_created',
          botId: 'bot-5',
          message: {
            messageId: 'mid-owner-stored-bot-5',
            chatId: '-100125',
            chatTitle: 'Shared five-bot chat',
            senderId: 'user-5',
            text: 'hello',
            createdAt: new Date('2026-03-31T20:00:05.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.getStoredChatPrimaryBotId).toHaveBeenCalledWith('-100125', {
      bypassCache: true,
    });
    expect(
      prisma.chatBotMembership.findUnique.mock.calls.map(([args]) => args.where.chatId_botId),
    ).toEqual([{ chatId: '-100125', botId: 'bot-1' }]);
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(maxBotLinkService.observeStoredChatBotWebhook).toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            botId: 'bot-5',
            executionOwnerBotId: 'bot-1',
          }),
        }),
      }),
    );
  });

  it('defers execution owner live refresh on bot lifecycle updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-6b' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['can_call'],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['delete_messages'],
        }),
    };
    maxBotLinkService.bindChatToBot
      .mockResolvedValueOnce('id613002203036_bot')
      .mockResolvedValueOnce('id613002203036_4_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-added-failover-1',
          type: 'bot_added',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-bot-added-1',
            chatId: '-100140',
            chatTitle: 'Shared chat',
            entityType: 'channel',
            senderId: 'id613002203036_4_bot',
            text: '',
            createdAt: new Date('2026-04-06T00:10:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledTimes(1);
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );

    await flushDeferredWebhookWork();

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.bindChatToBot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chatId: '-100140',
        botId: 'id613002203036_4_bot',
        allowReassign: true,
      }),
    );
  });

  it('propagates webhook entity type into chat binding updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-entity-type-1',
          type: 'bot_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-entity-type-1',
            chatId: '-100125',
            chatTitle: 'Новости района',
            entityType: 'channel',
            senderId: 'user-3',
            text: 'hello',
            createdAt: new Date('2026-03-31T20:00:02.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100125',
        title: 'Новости района',
        entityType: 'CHANNEL',
        botId: 'id613002203036_bot',
        lifecycleEventType: 'bot_added',
        lifecycleSource: 'webhook',
      }),
    );
  });

  it('does not delay bot_added acknowledgement on a pending recent-bootstrap cache write', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7-cache' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    let releaseBootstrap: (() => void) | undefined;
    const pendingBootstrap = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const chatContextCache = {
      upsertManagedEntitiesRecentBootstrap: jest.fn().mockReturnValue(pendingBootstrap),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-added-cache-1',
          type: 'bot_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'bot_added:u-bot-added-cache-1',
            chatId: '-100128',
            chatTitle: 'Кэшируемый чат',
            entityType: 'channel',
            senderId: 'user-77',
            text: '',
            createdAt: new Date('2026-04-03T12:02:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(chatContextCache.upsertManagedEntitiesRecentBootstrap).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(chatContextCache.upsertManagedEntitiesRecentBootstrap).toHaveBeenCalledWith(
      {
        id: '-100128',
        title: 'Кэшируемый чат',
        createdAt: new Date('2026-04-03T12:02:00.000Z').toISOString(),
        entityType: 'channel',
        link: null,
        primaryBotId: 'id613002203036_bot',
        assignedBots: [],
        sharedMode: 'owned',
        channelOverview: null,
      },
      15 * 60,
      'user-77',
    );
    releaseBootstrap?.();
    await pendingBootstrap;
  });

  it('parses an official bot_added actor payload and sends the hint through the ingress bot', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-official-bot-added-hint' }),
        updateMany: jest.fn(),
      },
    };
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({ messageId: 'hint-1', url: null }),
    };
    const service = new WebhookService(
      prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    const update = new WebhookParser().parse(
      {
        update_id: 'u-official-bot-added-hint',
        update_type: 'bot_added',
        chat_id: -100129,
        chat: {
          chat_id: -100129,
          chat_type: 'chat',
          title: 'Чат с подсказкой',
        },
        user: {
          user_id: 900002,
          first_name: 'Анна',
          last_name: 'Администратор',
        },
        timestamp: '2026-04-03T12:03:00.000Z',
      },
      { botId: 'id613002203036_bot' },
    );

    expect(update.message).toEqual(
      expect.objectContaining({
        senderId: '900002',
        senderName: 'Анна Администратор',
      }),
    );
    expect(update.membership).toEqual({
      action: 'added',
      memberUserIds: ['id613002203036_bot'],
    });
    await expect(service.ingest(update, '127.0.0.1')).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await flushDeferredWebhookWork();

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '-100129',
      expect.stringContaining('Чат почти подключен'),
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Проверить подключение' })]],
      }),
      expect.objectContaining({ botId: 'id613002203036_bot' }),
    );
  });

  it('sends one durable Старт hint for multiple bot_added events in the same onboarding epoch', async () => {
    const claims = new Map<string, Record<string, unknown>>();
    const prisma = {
      webhookEvent: {
        create: jest
          .fn()
          .mockResolvedValueOnce({ id: 'evt-7-hint-1' })
          .mockResolvedValueOnce({ id: 'evt-7-hint-2' }),
        updateMany: jest.fn(),
      },
      webhookExecutionClaim: {
        createMany: jest.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
          const row = data[0]!;
          const key = `${row.kind}:${row.semanticKey}`;
          if (claims.has(key)) {
            return { count: 0 };
          }
          claims.set(key, {
            id: `claim-${claims.size + 1}`,
            status: 'PENDING',
            executionBotId: null,
            leaseToken: null,
            leaseExpiresAt: null,
            preparedAt: null,
            ...row,
          });
          return { count: 1 };
        }),
        findUnique: jest.fn(
          async ({ where }: { where: Record<string, Record<string, string>> }) => {
            const key = where.kind_semanticKey!;
            return claims.get(`${key.kind}:${key.semanticKey}`) ?? null;
          },
        ),
        updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
          const row = [...claims.values()].find((candidate) => candidate.id === where.id);
          if (!row) {
            return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({ messageId: 'hint-1', url: null }),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    const update = {
      updateId: 'u-bot-added-hint-1',
      type: 'bot_added',
      botId: 'id613002203036_bot',
      message: {
        messageId: 'bot_added:u-bot-added-hint-1',
        chatId: '-100129',
        chatTitle: 'Чат с подсказкой',
        entityType: 'chat',
        senderId: 'id613002203036_bot',
        text: '',
        createdAt: new Date('2026-04-03T12:03:00.000Z').toISOString(),
      },
    };

    await expect(service.ingest(update as never, '127.0.0.1')).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await flushDeferredWebhookWork();

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '-100129',
      'Чат почти подключен. Назначьте бота администратором, затем нажмите кнопку ниже. После проверки чат появится в мини-приложении.',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              text: 'Проверить подключение',
              type: 'callback',
              payload: 'managed_entity_handshake:start_hint',
            }),
          ],
        ],
      }),
      expect.objectContaining({
        botId: 'id613002203036_bot',
        ignoreFailureMetricStatuses: [403, 404],
        sourceTag: 'managed_handshake',
      }),
    );

    await expect(
      service.ingest(
        {
          ...update,
          updateId: 'u-bot-added-hint-2',
          botId: 'id613002203036_4_bot',
          message: {
            ...update.message,
            messageId: 'bot_added:u-bot-added-hint-2',
            senderId: 'id613002203036_4_bot',
            createdAt: new Date('2026-04-03T12:03:01.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['id613002203036_4_bot'],
          },
        } as never,
        '127.0.0.1',
      ),
    ).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await flushDeferredWebhookWork();

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
  });

  it('keeps bot_added Старт hint 403 failures quiet and releases the long backoff', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7-hint-denied' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const deniedError = Object.assign(new Error('chat denied'), {
      response: { status: 403 },
    });
    const maxClient = {
      sendMessageImmediateWithId: jest
        .fn()
        .mockRejectedValueOnce(deniedError)
        .mockResolvedValueOnce({ messageId: 'hint-2', url: null }),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    const logger = {
      debug: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
    };
    (service as unknown as { logger: typeof logger }).logger = logger;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const update = {
      updateId: 'u-bot-added-hint-denied-1',
      type: 'bot_added',
      botId: 'id613002203036_bot',
      message: {
        messageId: 'bot_added:u-bot-added-hint-denied-1',
        chatId: '-100132',
        chatTitle: 'Чат с временным отказом',
        entityType: 'chat',
        senderId: 'id613002203036_bot',
        text: '',
        createdAt: new Date('2026-04-03T12:06:00.000Z').toISOString(),
      },
    };

    try {
      await expect(service.ingest(update as never, '127.0.0.1')).resolves.toEqual({
        accepted: true,
        duplicate: false,
      });
      await flushDeferredWebhookWork();

      expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
        '-100132',
        expect.stringContaining('Чат почти подключен'),
        expect.anything(),
        expect.objectContaining({
          botId: 'id613002203036_bot',
          ignoreFailureMetricStatuses: [403, 404],
          sourceTag: 'managed_handshake',
        }),
      );
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: '-100132',
          status: 403,
        }),
        'Skipped managed entity start hint after bot_added webhook because chat is not yet reachable',
      );

      nowSpy.mockReturnValue(40_000);
      await expect(
        service.ingest({ ...update, updateId: 'u-bot-added-hint-denied-2' } as never, '127.0.0.1'),
      ).resolves.toEqual({
        accepted: true,
        duplicate: false,
      });
      await flushDeferredWebhookWork();

      expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps bot_added Старт hint terminal MAX code failures quiet', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7-hint-code-denied' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const deniedError = Object.assign(new Error('chat not found'), {
      response: { data: { code: 'chat.not.found' } },
    });
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockRejectedValue(deniedError),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    const logger = {
      debug: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
    };
    (service as unknown as { logger: typeof logger }).logger = logger;

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-added-hint-code-denied-1',
          type: 'bot_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'bot_added:u-bot-added-hint-code-denied-1',
            chatId: '-100133',
            chatTitle: 'Чат с code-only отказом',
            entityType: 'chat',
            senderId: 'id613002203036_bot',
            text: '',
            createdAt: new Date('2026-04-03T12:07:00.000Z').toISOString(),
          },
        } as never,
        '127.0.0.1',
      ),
    ).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await flushDeferredWebhookWork();

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100133',
        maxCode: 'chat.not.found',
      }),
      'Skipped managed entity start hint after bot_added webhook because chat is not yet reachable',
    );
  });

  it('keeps unexpected bot_added Старт hint send failures visible', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7-hint-server-error' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const serverError = Object.assign(new Error('server error'), {
      response: { status: 500 },
    });
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockRejectedValue(serverError),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    const logger = {
      debug: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
    };
    (service as unknown as { logger: typeof logger }).logger = logger;

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-added-hint-server-error-1',
          type: 'bot_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'bot_added:u-bot-added-hint-server-error-1',
            chatId: '-100134',
            chatTitle: 'Чат с ошибкой подсказки',
            entityType: 'chat',
            senderId: 'id613002203036_bot',
            text: '',
            createdAt: new Date('2026-04-03T12:08:00.000Z').toISOString(),
          },
        } as never,
        '127.0.0.1',
      ),
    ).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await flushDeferredWebhookWork();

    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100134',
      }),
      'Failed to send managed entity start hint after bot_added webhook',
    );
  });

  it('throttles Старт hints per bot when several bots are added together', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7-multi-bot-hint' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({ messageId: 'hint-1', url: null }),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    const update = {
      updateId: 'u-bot-added-multi-hint-1',
      type: 'bot_added',
      botId: 'id613070470872_5_bot',
      message: {
        messageId: 'bot_added:u-bot-added-multi-hint-1',
        chatId: '-100131',
        chatTitle: 'Чат с несколькими ботами',
        entityType: 'chat',
        senderId: 'id613070470872_5_bot',
        text: '',
        createdAt: new Date('2026-04-03T12:05:00.000Z').toISOString(),
      },
    };

    await expect(service.ingest(update as never, '127.0.0.1')).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await expect(
      service.ingest(
        {
          ...update,
          updateId: 'u-bot-added-multi-hint-2',
          botId: 'id613070470872_6_bot',
          message: {
            ...update.message,
            messageId: 'bot_added:u-bot-added-multi-hint-2',
            senderId: 'id613070470872_6_bot',
          },
        } as never,
        '127.0.0.1',
      ),
    ).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await flushDeferredWebhookWork();

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessageImmediateWithId.mock.calls.map((call) => call[3]?.botId)).toEqual([
      'id613070470872_5_bot',
      'id613070470872_6_bot',
    ]);
  });

  it('does not reinterpret a bot_added actor as a shared subject across ingress bots', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7-mirrored-bot-hint' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({ messageId: 'hint-1', url: null }),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    const baseUpdate = {
      updateId: 'u-bot-added-mirrored-hint-1',
      type: 'bot_added',
      botId: 'id613070470872_5_bot',
      message: {
        messageId: 'bot_added:u-bot-added-mirrored-hint-1',
        chatId: '-100132',
        chatTitle: 'Чат с зеркальной доставкой',
        entityType: 'chat',
        senderId: 'id613070470872_5_bot',
        text: '',
        createdAt: new Date('2026-04-03T12:05:00.000Z').toISOString(),
      },
      membership: {
        action: 'added',
        memberUserIds: ['id613070470872_5_bot'],
      },
    };

    await expect(service.ingest(baseUpdate as never, '127.0.0.1')).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await expect(
      service.ingest(
        {
          ...baseUpdate,
          updateId: 'u-bot-added-mirrored-hint-2',
          botId: 'id613070470872_6_bot',
          message: {
            ...baseUpdate.message,
            messageId: 'bot_added:u-bot-added-mirrored-hint-2',
          },
        } as never,
        '127.0.0.1',
      ),
    ).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await flushDeferredWebhookWork();

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessageImmediateWithId.mock.calls.map((call) => call[3]?.botId)).toEqual([
      'id613070470872_5_bot',
      'id613070470872_6_bot',
    ]);
  });

  it('uses channel wording in the Старт hint after channel bot_added webhooks', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7-channel-hint' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({ messageId: 'hint-1', url: null }),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-added-channel-hint-1',
          type: 'bot_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'bot_added:u-bot-added-channel-hint-1',
            chatId: '-100130',
            chatTitle: 'Канал с подсказкой',
            entityType: 'channel',
            senderId: 'id613002203036_bot',
            text: '',
            createdAt: new Date('2026-04-03T12:04:00.000Z').toISOString(),
          },
        } as never,
        '127.0.0.1',
      ),
    ).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await flushDeferredWebhookWork();

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '-100130',
      'Канал почти подключен. Назначьте бота администратором, затем нажмите кнопку ниже. После проверки канал появится в мини-приложении.',
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Проверить подключение' })]],
      }),
      expect.objectContaining({
        botId: 'id613002203036_bot',
        sourceTag: 'managed_handshake',
      }),
    );
  });

  it('enqueues chat admin roster sync for bot membership churn updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    const beforeIngestMs = Date.now();

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-added-1',
          type: 'bot_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'bot_added:u-bot-added-1',
            chatId: '-100126',
            chatTitle: 'Новый чат',
            entityType: 'channel',
            senderId: 'id613002203036_bot',
            text: '',
            createdAt: new Date('2026-04-03T12:00:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: '-100126',
      botIds: ['id613002203036_bot'],
      title: 'Новый чат',
      entityType: 'channel',
      source: 'webhook_bot_added',
      retryUntilMs: expect.any(Number),
    });
    const scheduledJob =
      maxChatAdminRosterSyncService.scheduleChatAdminRosterSync.mock.calls[0]?.[0];
    expect(scheduledJob.retryUntilMs).toBeGreaterThanOrEqual(beforeIngestMs + 120_000);
    expect(scheduledJob.retryUntilMs).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it('enqueues chat admin roster sync for chat_title_changed updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-title-changed' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-title-changed-1',
          type: 'chat_title_changed',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'chat_title_changed:u-title-changed-1',
            chatId: '-100129',
            chatTitle: 'Новое название',
            entityType: 'chat',
            senderId: 'user-title-1',
            text: '',
            createdAt: new Date('2026-07-06T09:00:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: '-100129',
      botIds: ['id613002203036_bot'],
      title: 'Новое название',
      entityType: 'chat',
      source: 'webhook_chat_title_changed',
      retryUntilMs: null,
    });
  });

  it('prewarms admin roster snapshots for webhook membership churn updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7a' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-user-added-1',
          type: 'user_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'user_added:u-user-added-1',
            chatId: '-100127',
            chatTitle: 'Новый участник',
            entityType: 'chat',
            senderId: 'user-10',
            text: '',
            createdAt: new Date('2026-04-03T12:05:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: '-100127',
      botIds: ['id613002203036_bot'],
      title: 'Новый участник',
      entityType: 'chat',
      source: 'webhook_membership_churn',
      retryUntilMs: null,
    });
  });

  it('does not enqueue admin roster sync for private direct membership updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-private-1' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-private-bot-started-1',
          type: 'bot_started',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'bot_started:u-private-bot-started-1',
            chatId: '214007512',
            senderId: '214007512',
            text: '',
            createdAt: new Date('2026-04-03T12:07:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).not.toHaveBeenCalled();
  });
});
