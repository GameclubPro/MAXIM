import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import {
  PublisherCandidateRefreshSupersededError,
  PublisherBindingRefreshSchedulerService,
  PublisherBindingRefreshService,
} from './publisher-binding-refresh.service';
import {
  PUBLISHER_FORWARDED_BINDING_SOURCE_PREFIX,
  buildPublisherForwardedBindingSource,
} from './publisher-entity-binding-lifecycle.service';

const createBackgroundWork = () => ({
  runExclusive: jest.fn((_lane: string, operation: () => Promise<unknown>) => operation()),
});
const createHistoricalRecovery = () => ({
  recoverHistoricalActorCandidates: jest.fn().mockResolvedValue(0),
});

describe('PublisherBindingRefreshService', () => {
  function createHarness(
    accessResult:
      | { isAdmin: boolean; isOwner: boolean; permissions: string[]; permissionsKnown: boolean }
      | Error,
    dispatchEnabled = true,
  ) {
    const bindingState = {
      botAccessCheckedAt: null as Date | null,
      botAccessState: ChatBotAccessState.UNKNOWN as ChatBotAccessState,
    };
    const edgeState = { sourceVersion: null as string | null };
    const prisma = {
      chat: {
        findUnique: jest.fn(async () => ({
          id: 'chat-1',
          entityType: ChatEntityType.CHAT,
          publicationPolicy: null,
          publisherBinding: {
            publisherBotId: 'publik_bot',
            status: ChatBotMembershipStatus.ACTIVE,
            botAccessState: ChatBotAccessState.CONFIRMED_ADMIN as ChatBotAccessState,
            botAccessSource: null as string | null,
            lastSeenAt: new Date('2026-08-26T11:55:00.000Z') as Date | null,
            lastWebhookAt: null as Date | null,
          },
        })),
      },
      managedBotChatCatalog: {
        findUnique: jest.fn().mockResolvedValue({ entityType: ChatEntityType.CHAT }),
      },
      publisherEntityBinding: {
        updateMany: jest.fn(
          async ({
            data,
          }: {
            data: { botAccessCheckedAt?: Date | null; botAccessState?: ChatBotAccessState };
          }) => {
            if (data.botAccessCheckedAt instanceof Date) {
              bindingState.botAccessCheckedAt = data.botAccessCheckedAt;
            }
            if (data.botAccessState) {
              bindingState.botAccessState = data.botAccessState;
            }
            return { count: 1 };
          },
        ),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn(async ({ data }: { data: { sourceVersion?: string | null } }) => {
          if (typeof data.sourceVersion === 'string') {
            edgeState.sourceVersion = data.sourceVersion;
          }
          return { count: 1 };
        }),
        findUnique: jest.fn().mockImplementation(async () => ({
          deniedReason: 'publisher_actor_verification_pending',
          sourceVersion: edgeState.sourceVersion,
        })),
      },
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'chat-1' }]),
      chat: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      managedBotChatCatalog: {
        upsert: jest.fn().mockResolvedValue({ id: 'catalog-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publisherEntityBinding: {
        findUnique: jest.fn(async () => ({
          publisherBotId: 'publik_bot',
          status: ChatBotMembershipStatus.ACTIVE,
          lifecycleEventAt: null,
          botAccessCheckedAt: bindingState.botAccessCheckedAt,
          botAccessState: bindingState.botAccessState,
          botAccessSource: null as string | null,
        })),
        update: jest.fn().mockResolvedValue({ chatId: 'chat-1' }),
      },
      managedEntityAccessEdge: {
        findUnique: jest
          .fn()
          .mockImplementation(async () => ({ sourceVersion: edgeState.sourceVersion })),
        upsert: jest.fn().mockResolvedValue({ chatId: 'chat-1' }),
      },
    };
    Object.assign(prisma, {
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    });
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn(async () => {
        if (accessResult instanceof Error) {
          throw accessResult;
        }
        return accessResult;
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        title: 'Publisher chat',
        entityType: 'chat',
        link: 'https://max.ru/publisher-chat',
        avatarUrl: 'https://cdn.example.com/publisher.png',
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        isBot: false,
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
        permissionsKnown: true,
      }),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue('reply-1'),
    };
    const credentials = {
      getBotId: jest.fn(() => 'publik_bot'),
      getRequiredActionToken: jest.fn(() => 'not-a-real-token'),
    };
    const dispatchHealth = {
      assertDispatchAllowed: jest.fn(async () => undefined),
      isGloballyPaused: jest.fn(async () => false),
      recordAuthenticatedSuccess: jest.fn(async () => undefined),
      recordGlobalAuthorizationFailure: jest.fn(async () => undefined),
    };
    const identityAttestation = {
      assertAttested: jest.fn(async () => undefined),
    };
    const runtimeBoundary = {
      dispatchEnabled,
      assertDispatchEnabled: jest.fn(() => {
        if (!dispatchEnabled) throw new Error('publisher disabled');
      }),
    };
    const maxBotLinkService = {
      buildMiniappStartUrlSync: jest.fn(() => 'https://max.ru/publik_bot?startapp=home'),
    };
    const service = new PublisherBindingRefreshService(
      prisma as never,
      maxClient as never,
      credentials as never,
      dispatchHealth as never,
      identityAttestation as never,
      runtimeBoundary as never,
      maxBotLinkService as never,
    );
    return {
      service,
      prisma,
      tx,
      maxClient,
      dispatchHealth,
      identityAttestation,
      bindingState,
      edgeState,
      maxBotLinkService,
      runtimeBoundary,
    };
  }

  const job = {
    version: 1,
    chatId: 'chat-1',
    publisherBotId: 'publik_bot',
    reason: 'bootstrap',
    requestedAt: '2026-08-26T12:00:00.000Z',
  } as const;

  it('probes only the exact publisher bot and persists fresh access behind a lifecycle fence', async () => {
    const { service, prisma, maxClient, dispatchHealth } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });

    await service.refresh(job);

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        botId: 'publik_bot',
        bypassCache: true,
        sourceTag: 'publisher_readiness',
      }),
    );
    expect(prisma.publisherEntityBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          publisherBotId: 'publik_bot',
          AND: expect.any(Array),
        }),
        data: expect.objectContaining({
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        }),
      }),
    );
    expect(dispatchHealth.recordAuthenticatedSuccess).toHaveBeenCalledTimes(1);
  });

  it('uses the publisher interactive lane for an explicit user recheck', async () => {
    const { service, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });

    await service.refresh({ ...job, reason: 'manual_recheck' });

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ trafficClass: 'interactive' }),
    );
  });

  it('maps a targeted 403 probe to LOST without retrying through a main bot', async () => {
    const error = Object.assign(new Error('denied'), { response: { status: 403 } });
    const { service, prisma, dispatchHealth } = createHarness(error);

    await expect(service.refresh(job)).resolves.toBeUndefined();
    expect(prisma.publisherEntityBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          publisherBotId: 'publik_bot',
          AND: expect.any(Array),
        }),
        data: expect.objectContaining({
          botAccessState: ChatBotAccessState.LOST,
          botAccessExpiresAt: null,
          botAccessLastErrorCode: 'HTTP_403',
        }),
      }),
    );
    expect(dispatchHealth.recordAuthenticatedSuccess).not.toHaveBeenCalled();
  });

  it('does not create or probe a binding from a Major-only bootstrap job', async () => {
    const { service, prisma, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    prisma.chat.findUnique.mockResolvedValueOnce({
      id: 'chat-1',
      entityType: ChatEntityType.CHAT,
      publicationPolicy: null,
      publisherBinding: {
        publisherBotId: 'publik_bot',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.UNKNOWN,
        botAccessSource: null,
        lastSeenAt: null,
        lastWebhookAt: null,
      },
    });

    await service.refresh(job);

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(prisma.publisherEntityBinding.updateMany).not.toHaveBeenCalled();
  });

  it('allows the first targeted probe after a publisher webhook observation', async () => {
    const { service, prisma, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    prisma.chat.findUnique.mockResolvedValueOnce({
      id: 'chat-1',
      entityType: ChatEntityType.CHAT,
      publicationPolicy: null,
      publisherBinding: {
        publisherBotId: 'publik_bot',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.UNKNOWN,
        botAccessSource: null,
        lastSeenAt: new Date('2026-08-26T11:59:00.000Z'),
        lastWebhookAt: new Date('2026-08-26T11:59:00.000Z'),
      },
    });

    await service.refresh({ ...job, reason: 'bot_added' });

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(prisma.publisherEntityBinding.updateMany).toHaveBeenCalledTimes(1);
  });

  it('hydrates exact Publisher metadata and grants a live-verified actor without Major membership', async () => {
    const { service, tx, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });

    await service.refresh({
      ...job,
      reason: 'bot_added',
      candidateUserId: 'admin-1',
    });

    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ botId: 'publik_bot', bypassCache: true }),
    );
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      expect.objectContaining({
        botId: 'publik_bot',
        bypassCache: true,
        trafficClass: 'interactive',
      }),
    );
    expect(tx.managedBotChatCatalog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { botId_chatId: { botId: 'publik_bot', chatId: 'chat-1' } },
      }),
    );
    expect(tx.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId_botId: {
            chatId: 'chat-1',
            userId: 'admin-1',
            botId: 'publik_bot',
          },
        },
        create: expect.objectContaining({ state: 'GRANTED', userRole: 'ADMIN' }),
      }),
    );
    expect(tx.chat.updateMany).not.toHaveBeenCalled();
  });

  it('verifies forwarded channel recovery with the exact Publisher bot and replies with root miniapp route', async () => {
    const { service, prisma, tx, edgeState, bindingState, maxClient, maxBotLinkService } =
      createHarness({
        isAdmin: true,
        isOwner: false,
        permissions: ['write', 'read_all_messages'],
        permissionsKnown: true,
      });
    const candidateVersion = 'forwarded:publisher-forward-1';
    const forwardedSource = buildPublisherForwardedBindingSource(candidateVersion);
    edgeState.sourceVersion = candidateVersion;
    prisma.chat.findUnique.mockResolvedValueOnce({
      id: 'chat-1',
      entityType: ChatEntityType.CHAT,
      publicationPolicy: null,
      publisherBinding: {
        publisherBotId: 'publik_bot',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.UNKNOWN,
        botAccessSource: forwardedSource,
        lastSeenAt: new Date('2026-08-26T11:55:00.000Z'),
        lastWebhookAt: null,
      },
    });
    tx.publisherEntityBinding.findUnique.mockImplementation(async () => ({
      publisherBotId: 'publik_bot',
      status: ChatBotMembershipStatus.ACTIVE,
      lifecycleEventAt: null,
      botAccessCheckedAt: bindingState.botAccessCheckedAt,
      botAccessState: bindingState.botAccessState,
      botAccessSource: forwardedSource,
    }));
    maxClient.getChatSnapshot.mockResolvedValueOnce({
      chatId: 'chat-1',
      title: 'Publisher channel',
      entityType: 'channel',
      link: 'https://max.ru/publisher-channel',
      avatarUrl: null,
    });

    await service.refresh({
      ...job,
      candidateUserId: 'admin-2',
      candidateVersion,
      replyChatId: 'private-2',
      requiresReadAccess: true,
      reason: 'forwarded_private',
    });

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ botId: 'publik_bot' }),
    );
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-2',
      expect.objectContaining({ botId: 'publik_bot', trafficClass: 'interactive' }),
    );
    expect(tx.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          botId: 'publik_bot',
          entityType: ChatEntityType.CHANNEL,
          state: 'GRANTED',
        }),
      }),
    );
    expect(prisma.publisherEntityBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ botAccessSource: forwardedSource }),
        data: { botAccessSource: 'publisher_refresh_forwarded_private' },
      }),
    );
    expect(maxBotLinkService.buildMiniappStartUrlSync).toHaveBeenCalledWith(
      expect.stringMatching(/^mr-[A-Za-z0-9_-]+$/u),
      'publik_bot',
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'private-2',
      expect.stringContaining('подключен к Публику'),
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Открыть Публик' })]],
      }),
      expect.objectContaining({ botId: 'publik_bot', sourceTag: 'managed_handshake' }),
    );
  });

  it('records a forwarded non-admin as terminal USER_DENIED and never grants access', async () => {
    const { service, tx, edgeState, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write', 'read_all_messages'],
      permissionsKnown: true,
    });
    edgeState.sourceVersion = 'forwarded:publisher-forward-2';
    maxClient.getChatMemberAccess.mockResolvedValueOnce({
      isAdmin: false,
      isOwner: false,
      permissions: [],
      permissionsKnown: true,
    });

    await service.refresh({
      ...job,
      candidateUserId: 'member-2',
      candidateVersion: 'forwarded:publisher-forward-2',
      replyChatId: 'private-2',
      requiresReadAccess: true,
      reason: 'forwarded_private',
    });

    expect(tx.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ state: 'USER_DENIED', userRole: 'MEMBER' }),
        update: expect.objectContaining({ state: 'USER_DENIED', userRole: 'MEMBER' }),
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'private-2',
      expect.stringContaining('только его владелец или администратор'),
      undefined,
      expect.objectContaining({ botId: 'publik_bot' }),
    );
  });

  it('denies forwarded recovery when the Publisher bot lacks read-all permission', async () => {
    const { service, prisma, tx, edgeState, bindingState, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    const candidateVersion = 'forwarded:publisher-read-denied';
    const forwardedSource = buildPublisherForwardedBindingSource(candidateVersion);
    edgeState.sourceVersion = candidateVersion;
    prisma.chat.findUnique.mockResolvedValueOnce({
      id: 'chat-1',
      entityType: ChatEntityType.CHAT,
      publicationPolicy: null,
      publisherBinding: {
        publisherBotId: 'publik_bot',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.UNKNOWN,
        botAccessSource: forwardedSource,
        lastSeenAt: new Date(),
        lastWebhookAt: null,
      },
    });
    tx.publisherEntityBinding.findUnique.mockResolvedValue({
      publisherBotId: 'publik_bot',
      status: ChatBotMembershipStatus.ACTIVE,
      botAccessSource: forwardedSource,
      lifecycleEventAt: null,
      botAccessCheckedAt: bindingState.botAccessCheckedAt,
      botAccessState: bindingState.botAccessState,
    });

    await service.refresh({
      ...job,
      candidateUserId: 'admin-3',
      candidateVersion,
      replyChatId: 'private-3',
      requiresReadAccess: true,
      reason: 'forwarded_private',
    });

    expect(prisma.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'admin-3',
          botId: 'publik_bot',
        }),
        data: expect.objectContaining({
          state: 'BOT_DENIED',
          deniedReason: 'publisher_bot_missing_read_all_messages',
        }),
      }),
    );
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(tx.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(tx.publisherEntityBinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ChatBotMembershipStatus.REMOVED }),
      }),
    );
    expect(tx.managedBotChatCatalog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { botId: 'publik_bot', chatId: 'chat-1' },
        data: expect.objectContaining({ status: 'MISSING' }),
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'private-3',
      expect.stringContaining('доступом ко всем сообщениям'),
      undefined,
      expect.objectContaining({ botId: 'publik_bot' }),
    );
  });

  it('records terminal denial and replies when the forwarded source is missing for Publisher', async () => {
    const missing = Object.assign(new Error('chat not found'), { response: { status: 404 } });
    const { service, prisma, tx, edgeState, maxClient } = createHarness(missing);
    const candidateVersion = 'forwarded:publisher-missing';
    const forwardedSource = buildPublisherForwardedBindingSource(candidateVersion);
    edgeState.sourceVersion = candidateVersion;
    prisma.chat.findUnique.mockResolvedValueOnce({
      id: 'chat-1',
      entityType: ChatEntityType.CHAT,
      publicationPolicy: null,
      publisherBinding: {
        publisherBotId: 'publik_bot',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.UNKNOWN,
        botAccessSource: forwardedSource,
        lastSeenAt: new Date(),
        lastWebhookAt: null,
      },
    });
    tx.publisherEntityBinding.findUnique.mockResolvedValue({
      publisherBotId: 'publik_bot',
      status: ChatBotMembershipStatus.ACTIVE,
      botAccessSource: forwardedSource,
      lifecycleEventAt: null,
      botAccessCheckedAt: null,
      botAccessState: ChatBotAccessState.UNKNOWN,
    });

    await service.refresh({
      ...job,
      candidateUserId: 'admin-5',
      candidateVersion,
      replyChatId: 'private-5',
      requiresReadAccess: true,
      reason: 'forwarded_private',
    });

    expect(prisma.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deniedReason: 'publisher_bot_access_lost',
          lastMaxStatusCode: 404,
        }),
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'private-5',
      expect.stringContaining('не может открыть'),
      undefined,
      expect.objectContaining({ botId: 'publik_bot' }),
    );
    expect(tx.publisherEntityBinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ChatBotMembershipStatus.REMOVED }),
      }),
    );
    expect(tx.managedBotChatCatalog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'MISSING' }) }),
    );
  });

  it('preserves forwarded cleanup and read-all fencing when pending recovery becomes stale_user_access', async () => {
    const { service, prisma, tx, edgeState, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    const candidateVersion = 'forwarded:publisher-scheduled-retry';
    const forwardedSource = buildPublisherForwardedBindingSource(candidateVersion);
    edgeState.sourceVersion = candidateVersion;
    prisma.chat.findUnique.mockResolvedValueOnce({
      id: 'chat-1',
      entityType: ChatEntityType.CHAT,
      publicationPolicy: null,
      publisherBinding: {
        publisherBotId: 'publik_bot',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.UNKNOWN,
        botAccessSource: forwardedSource,
        lastSeenAt: new Date(),
        lastWebhookAt: null,
      },
    });
    tx.publisherEntityBinding.findUnique.mockResolvedValue({
      publisherBotId: 'publik_bot',
      status: ChatBotMembershipStatus.ACTIVE,
      botAccessSource: forwardedSource,
      lifecycleEventAt: null,
      botAccessCheckedAt: null,
      botAccessState: ChatBotAccessState.UNKNOWN,
    });

    await service.refresh({
      ...job,
      candidateUserId: 'admin-scheduled',
      candidateVersion,
      reason: 'stale_user_access',
    });

    expect(prisma.publisherEntityBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botAccessSource: forwardedSource }),
      }),
    );
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(prisma.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deniedReason: 'publisher_bot_missing_read_all_messages',
        }),
      }),
    );
    expect(tx.publisherEntityBinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ChatBotMembershipStatus.REMOVED }),
      }),
    );
    expect(tx.managedBotChatCatalog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'MISSING' }) }),
    );
  });

  it('retries instead of overwriting a newer durable actor candidate', async () => {
    const { service, tx, edgeState } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    edgeState.sourceVersion = 'direct:newer-start';

    await expect(
      service.refresh({
        ...job,
        candidateUserId: 'admin-4',
        candidateVersion: 'direct:older-start',
        reason: 'webhook_observed',
      }),
    ).rejects.toBeInstanceOf(PublisherCandidateRefreshSupersededError);

    expect(tx.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
  });

  it('does not grant a Publisher access edge when the handshake actor is not an admin', async () => {
    const { service, tx, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    maxClient.getChatMemberAccess.mockResolvedValueOnce({
      isAdmin: false,
      isOwner: false,
      permissions: [],
      permissionsKnown: true,
    });

    await service.refresh({ ...job, reason: 'webhook_observed', candidateUserId: 'member-1' });

    expect(tx.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ state: 'USER_DENIED', userRole: 'MEMBER' }),
        update: expect.objectContaining({ state: 'USER_DENIED', userRole: 'MEMBER' }),
      }),
    );
  });

  it('never grants a Major bot actor recovered by the isolated Publisher runtime', async () => {
    const { service, tx, edgeState, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    const candidateVersion = 'historical:webhook-major-bot';
    edgeState.sourceVersion = candidateVersion;
    maxClient.getChatMemberAccess.mockResolvedValueOnce({
      userId: 'major-contact-id-not-in-publisher-registry',
      isBot: true,
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });

    await service.refresh({
      ...job,
      reason: 'historical_actor_recovery',
      candidateUserId: 'major-contact-id-not-in-publisher-registry',
      candidateVersion,
    });

    expect(tx.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: 'USER_DENIED',
          userRole: 'ADMIN',
          deniedReason: 'publisher_actor_is_bot',
        }),
        update: expect.objectContaining({
          state: 'USER_DENIED',
          userRole: 'ADMIN',
          deniedReason: 'publisher_actor_is_bot',
        }),
      }),
    );
  });

  it('fails closed when MAX omits the recovered admin actor bot marker', async () => {
    const { service, tx, edgeState, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    const candidateVersion = 'historical:webhook-untyped-admin';
    edgeState.sourceVersion = candidateVersion;
    maxClient.getChatMemberAccess.mockResolvedValueOnce({
      userId: 'untyped-admin',
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });

    await service.refresh({
      ...job,
      reason: 'historical_actor_recovery',
      candidateUserId: 'untyped-admin',
      candidateVersion,
    });

    expect(tx.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: 'USER_DENIED',
          deniedReason: 'publisher_actor_type_unverified',
        }),
        update: expect.objectContaining({
          state: 'USER_DENIED',
          deniedReason: 'publisher_actor_type_unverified',
        }),
      }),
    );
  });

  it('does not grant a Publisher access edge when the Publisher bot is not an admin', async () => {
    const { service, tx } = createHarness({
      isAdmin: false,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });

    await service.refresh({ ...job, reason: 'bot_added', candidateUserId: 'admin-1' });

    expect(tx.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: 'BOT_DENIED',
          userRole: 'ADMIN',
          botRole: 'MEMBER',
          deniedReason: 'publisher_bot_not_admin',
        }),
        update: expect.objectContaining({
          state: 'BOT_DENIED',
          userRole: 'ADMIN',
          botRole: 'MEMBER',
          deniedReason: 'publisher_bot_not_admin',
        }),
      }),
    );
  });

  it('does not commit a stale actor grant after a newer bot access check records LOST', async () => {
    const { service, tx, bindingState } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    let bindingReadCount = 0;
    tx.publisherEntityBinding.findUnique.mockImplementation(async () => {
      bindingReadCount += 1;
      const committedAt = bindingState.botAccessCheckedAt;
      return {
        publisherBotId: 'publik_bot',
        status: ChatBotMembershipStatus.ACTIVE,
        lifecycleEventAt: null,
        botAccessCheckedAt: committedAt,
        botAccessState:
          bindingReadCount === 1 ? bindingState.botAccessState : ChatBotAccessState.LOST,
        botAccessSource: null,
      };
    });

    await expect(
      service.refresh({ ...job, reason: 'bot_added', candidateUserId: 'admin-1' }),
    ).rejects.toBeInstanceOf(PublisherCandidateRefreshSupersededError);

    expect(tx.managedBotChatCatalog.upsert).toHaveBeenCalledTimes(1);
    expect(tx.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
  });

  it('globally pauses and rethrows an exact-token 401', async () => {
    const error = Object.assign(new Error('unauthorized'), { response: { status: 401 } });
    const { service, dispatchHealth } = createHarness(error);

    await expect(service.refresh(job)).rejects.toBe(error);
    expect(dispatchHealth.recordGlobalAuthorizationFailure).toHaveBeenCalledTimes(1);
  });

  it('does not probe MAX while the global exact-token pause is active', async () => {
    const { service, maxClient, dispatchHealth } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    dispatchHealth.isGloballyPaused.mockResolvedValueOnce(true);

    await service.refresh(job);

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('does not read candidates or probe MAX before action-token attestation', async () => {
    const { service, prisma, maxClient, identityAttestation } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    identityAttestation.assertAttested.mockRejectedValueOnce(new Error('not attested'));

    await expect(service.refresh(job)).rejects.toThrow('not attested');

    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('does not read candidates or probe MAX while dispatch is disabled', async () => {
    const { service, prisma, maxClient, identityAttestation } = createHarness(
      {
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
        permissionsKnown: true,
      },
      false,
    );

    await service.refresh(job);

    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('does not start binding refresh scans while dispatch is disabled', async () => {
    jest.useFakeTimers();
    try {
      const prisma = {
        $queryRaw: jest.fn(),
        publisherEntityBinding: { findMany: jest.fn() },
        managedEntityAccessEdge: { findMany: jest.fn() },
      };
      const identityAttestation = { assertAttested: jest.fn() };
      const dispatchHealth = { isGloballyPaused: jest.fn() };
      const scheduler = new PublisherBindingRefreshSchedulerService(
        prisma as never,
        { enqueue: jest.fn() } as never,
        { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
        dispatchHealth as never,
        identityAttestation as never,
        { dispatchEnabled: false } as never,
        createBackgroundWork() as never,
        createHistoricalRecovery() as never,
      );

      await scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(120_000);
      await scheduler.scan('scheduled');

      expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
      expect(dispatchHealth.isGloballyPaused).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.publisherEntityBinding.findMany).not.toHaveBeenCalled();
      scheduler.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('refreshes only existing evidenced bindings at startup', async () => {
    const prisma = {
      $queryRaw: jest.fn(),
      publisherEntityBinding: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ chatId: 'chat-ready' }])
          .mockResolvedValueOnce([{ chatId: 'chat-discovery' }]),
      },
      managedEntityAccessEdge: {
        findMany: jest.fn().mockResolvedValue([{ chatId: 'chat-user', userId: 'admin-1' }]),
      },
    };
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const dispatchHealth = { isGloballyPaused: jest.fn().mockResolvedValue(false) };
    const identityAttestation = { assertAttested: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new PublisherBindingRefreshSchedulerService(
      prisma as never,
      refreshQueue as never,
      { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
      dispatchHealth as never,
      identityAttestation as never,
      { dispatchEnabled: true } as never,
      createBackgroundWork() as never,
      createHistoricalRecovery() as never,
    );

    const scan = jest.spyOn(scheduler, 'scan');
    scheduler.onModuleInit();
    await scan.mock.results[0]?.value;

    expect(identityAttestation.assertAttested).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.publisherEntityBinding.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        take: 200,
        where: expect.objectContaining({
          botAccessState: {
            in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
          },
        }),
      }),
    );
    expect(prisma.publisherEntityBinding.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        take: 25,
        where: expect.objectContaining({
          publisherBotId: 'publik_bot',
          status: ChatBotMembershipStatus.ACTIVE,
          OR: expect.arrayContaining([
            { lastWebhookAt: { not: null } },
            { lastSeenAt: { not: null } },
          ]),
        }),
      }),
    );
    expect(refreshQueue.enqueue).toHaveBeenCalledTimes(3);
    expect(refreshQueue.enqueue.mock.calls.map(([request]) => request.chatId)).toEqual([
      'chat-ready',
      'chat-discovery',
      'chat-user',
    ]);
    expect(refreshQueue.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        chatId: 'chat-user',
        candidateUserId: 'admin-1',
        reason: 'stale_user_access',
      }),
    );
    scheduler.onModuleDestroy();
  });

  it('keeps generic discovery off a forwarded-only binding while its candidate is in backoff', async () => {
    const now = new Date('2026-08-27T12:10:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const forwardedBinding = {
        chatId: 'forwarded-backoff',
        botAccessState: ChatBotAccessState.UNKNOWN,
        botAccessSource: buildPublisherForwardedBindingSource('forwarded:candidate-backoff'),
        updatedAt: new Date('2026-08-27T12:00:00.000Z'),
      };
      const findMany = jest.fn(
        async (query: {
          where: {
            botAccessState?: { in?: ChatBotAccessState[] };
            AND?: Array<{
              OR?: Array<{
                botAccessState?: ChatBotAccessState;
                botAccessSource?: null;
                NOT?: { botAccessSource?: { startsWith?: string } };
                OR?: Array<{ updatedAt?: { lte?: Date } }>;
              }>;
            }>;
          };
        }) => {
          if (query.where.botAccessState) {
            return [];
          }
          const retryBefore = query.where.AND?.[1]?.OR?.find(
            (branch) => branch.botAccessState === ChatBotAccessState.UNKNOWN,
          )?.OR?.find((branch) => branch.updatedAt)?.updatedAt?.lte;
          const excludedPrefix = query.where.AND?.[0]?.OR?.find((branch) => branch.NOT)?.NOT
            ?.botAccessSource?.startsWith;
          const excluded = Boolean(
            excludedPrefix && forwardedBinding.botAccessSource.startsWith(excludedPrefix),
          );
          return retryBefore && forwardedBinding.updatedAt <= retryBefore && !excluded
            ? [{ chatId: forwardedBinding.chatId }]
            : [];
        },
      );
      const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
      const scheduler = new PublisherBindingRefreshSchedulerService(
        {
          publisherEntityBinding: { findMany },
          managedEntityAccessEdge: { findMany: jest.fn().mockResolvedValue([]) },
        } as never,
        refreshQueue as never,
        { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
        { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
        { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
        { dispatchEnabled: true } as never,
        createBackgroundWork() as never,
        createHistoricalRecovery() as never,
      );

      await scheduler.scan('scheduled');

      expect(findMany).toHaveBeenCalledTimes(2);
      expect(findMany.mock.calls[1]?.[0].where.AND?.[0]).toEqual({
        OR: [
          { botAccessSource: null },
          {
            NOT: {
              botAccessSource: { startsWith: PUBLISHER_FORWARDED_BINDING_SOURCE_PREFIX },
            },
          },
        ],
      });
      expect(refreshQueue.enqueue).not.toHaveBeenCalled();
      expect(forwardedBinding.updatedAt.getTime()).toBeLessThan(now.getTime() - 5 * 60_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never scans the Major chat catalog or creates candidate bindings', async () => {
    const userEdgeFindMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      $queryRaw: jest.fn(),
      publisherEntityBinding: { findMany: jest.fn().mockResolvedValue([]) },
      managedEntityAccessEdge: { findMany: userEdgeFindMany },
    };
    const scheduler = new PublisherBindingRefreshSchedulerService(
      prisma as never,
      { enqueue: jest.fn() } as never,
      { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
      { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true } as never,
      createBackgroundWork() as never,
      createHistoricalRecovery() as never,
    );

    await scheduler.scan('scheduled');

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.publisherEntityBinding.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledTimes(1);
    expect(userEdgeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: 'publik_bot',
          OR: expect.arrayContaining([
            expect.objectContaining({ state: ManagedEntityAccessState.GRANTED }),
            expect.objectContaining({
              state: {
                in: [ManagedEntityAccessState.USER_DENIED, ManagedEntityAccessState.BOT_DENIED],
              },
              deniedReason: 'publisher_actor_verification_pending',
              checkedAt: { lte: expect.any(Date) },
              expiresAt: { gt: expect.any(Date) },
            }),
          ]),
          chat: expect.objectContaining({
            publisherBinding: {
              is: expect.objectContaining({ publisherBotId: 'publik_bot' }),
            },
          }),
        }),
        select: { chatId: true, userId: true, sourceVersion: true },
        take: 25,
      }),
    );
  });

  it('prioritizes an expiring ready binding and cools down 2500 fresh LOST rows', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    try {
      const checkedAt = new Date('2026-08-26T11:59:30.000Z');
      const freshLost = Array.from({ length: 2_500 }, (_, index) => ({
        chatId: `lost-${String(index).padStart(4, '0')}`,
        botAccessCheckedAt: checkedAt,
      }));
      const ready = {
        chatId: 'ready-expiring',
        botAccessExpiresAt: new Date('2026-08-26T12:01:00.000Z'),
      };
      const findMany = jest.fn(
        async (query: {
          where: {
            chatId?: { gt?: string };
            botAccessState?: { in?: ChatBotAccessState[] };
            OR?: Array<{
              botAccessExpiresAt?: { lte?: Date } | null;
              botAccessState?: { in?: ChatBotAccessState[] };
              OR?: Array<{ botAccessCheckedAt?: { lte?: Date } | null }>;
            }>;
            AND?: Array<{
              OR?: Array<{
                botAccessState?: { in?: ChatBotAccessState[] };
                OR?: Array<{ botAccessCheckedAt?: { lte?: Date } | null }>;
              }>;
            }>;
          };
          take: number;
        }) => {
          if (query.where.botAccessState?.in?.includes(ChatBotAccessState.CONFIRMED_ADMIN)) {
            const refreshBefore = query.where.OR?.find(
              (branch) => branch.botAccessExpiresAt && 'lte' in branch.botAccessExpiresAt,
            )?.botAccessExpiresAt?.lte;
            return refreshBefore && ready.botAccessExpiresAt <= refreshBefore
              ? [{ chatId: ready.chatId }]
              : [];
          }

          const lostBranch = query.where.AND?.flatMap((group) => group.OR ?? []).find((branch) =>
            branch.botAccessState?.in?.includes(ChatBotAccessState.LOST),
          );
          const retryBefore = lostBranch?.OR?.find(
            (branch) => branch.botAccessCheckedAt && 'lte' in branch.botAccessCheckedAt,
          )?.botAccessCheckedAt?.lte;
          return freshLost
            .filter(
              (row) =>
                retryBefore !== undefined &&
                row.botAccessCheckedAt <= retryBefore &&
                (!query.where.chatId?.gt || row.chatId > query.where.chatId.gt),
            )
            .slice(0, query.take)
            .map(({ chatId }) => ({ chatId }));
        },
      );
      const prisma = {
        publisherEntityBinding: { findMany },
        managedEntityAccessEdge: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
      const scheduler = new PublisherBindingRefreshSchedulerService(
        prisma as never,
        refreshQueue as never,
        { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
        { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
        { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
        { dispatchEnabled: true } as never,
        createBackgroundWork() as never,
        createHistoricalRecovery() as never,
      );

      await scheduler.scan('scheduled');
      jest.advanceTimersByTime(60_000);
      await scheduler.scan('scheduled');

      expect(refreshQueue.enqueue).toHaveBeenCalledTimes(2);
      expect(refreshQueue.enqueue.mock.calls.map(([request]) => request.chatId)).toEqual([
        'ready-expiring',
        'ready-expiring',
      ]);
      const discoveryQueries = findMany.mock.calls
        .map(([query]) => query)
        .filter((query) => query.where.botAccessState === undefined);
      expect(discoveryQueries).toHaveLength(2);
      const lostRetryCutoffs = discoveryQueries.map((query) => {
        expect(query.where.OR).toEqual(
          expect.arrayContaining([{ lastWebhookAt: { not: null } }, { lastSeenAt: { not: null } }]),
        );
        const lostBranch = query.where.AND?.flatMap((group) => group.OR ?? []).find((branch) =>
          branch.botAccessState?.in?.includes(ChatBotAccessState.LOST),
        );
        expect(lostBranch).toEqual(
          expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                botAccessCheckedAt: { lte: expect.any(Date) },
              }),
            ]),
          }),
        );
        return lostBranch?.OR?.find(
          (branch) => branch.botAccessCheckedAt && 'lte' in branch.botAccessCheckedAt,
        )?.botAccessCheckedAt?.lte;
      });
      expect(lostRetryCutoffs).toEqual([
        new Date('2026-08-26T06:00:00.000Z'),
        new Date('2026-08-26T06:01:00.000Z'),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('advances the disconnected discovery cursor across repeated scans', async () => {
    const eligible = Array.from({ length: 60 }, (_, index) => ({
      chatId: `lost-${String(index).padStart(3, '0')}`,
    }));
    const discoveryCursors: Array<string | null> = [];
    const findMany = jest.fn(
      async (query: {
        where: {
          chatId?: { gt?: string };
          botAccessState?: { in?: ChatBotAccessState[] };
        };
        take: number;
      }) => {
        if (query.where.botAccessState) {
          return [];
        }
        const cursor = query.where.chatId?.gt ?? null;
        discoveryCursors.push(cursor);
        return eligible.filter((row) => !cursor || row.chatId > cursor).slice(0, query.take);
      },
    );
    const prisma = {
      publisherEntityBinding: { findMany },
      managedEntityAccessEdge: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new PublisherBindingRefreshSchedulerService(
      prisma as never,
      refreshQueue as never,
      { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
      { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true } as never,
      createBackgroundWork() as never,
      createHistoricalRecovery() as never,
    );

    await scheduler.scan('scheduled');
    await scheduler.scan('scheduled');
    await scheduler.scan('scheduled');

    expect(discoveryCursors).toEqual([null, 'lost-024', 'lost-049']);
    expect(new Set(refreshQueue.enqueue.mock.calls.map(([request]) => request.chatId))).toEqual(
      new Set(eligible.map((row) => row.chatId)),
    );
  });

  it('keeps enabled refresh timers idle before identity, DB, or queue work while paused', async () => {
    jest.useFakeTimers();
    try {
      const prisma = {
        publisherEntityBinding: { findMany: jest.fn().mockResolvedValue([]) },
        managedEntityAccessEdge: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const refreshQueue = { enqueue: jest.fn() };
      let globallyPaused = true;
      const dispatchHealth = {
        isGloballyPaused: jest.fn(async () => globallyPaused),
      };
      const identityAttestation = { assertAttested: jest.fn() };
      const scheduler = new PublisherBindingRefreshSchedulerService(
        prisma as never,
        refreshQueue as never,
        { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
        dispatchHealth as never,
        identityAttestation as never,
        { dispatchEnabled: true } as never,
        createBackgroundWork() as never,
        createHistoricalRecovery() as never,
      );

      await scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(60_000);

      expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
      expect(prisma.publisherEntityBinding.findMany).not.toHaveBeenCalled();
      expect(refreshQueue.enqueue).not.toHaveBeenCalled();

      globallyPaused = false;
      await jest.advanceTimersByTimeAsync(60_000);

      expect(dispatchHealth.isGloballyPaused).toHaveBeenCalledTimes(3);
      expect(identityAttestation.assertAttested).toHaveBeenCalledTimes(1);
      expect(prisma.publisherEntityBinding.findMany).toHaveBeenCalledTimes(2);
      expect(prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledTimes(1);
      scheduler.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
