import { ChatBotAccessState, ChatBotMembershipStatus } from '../prisma/prisma-client';
import {
  PublisherBindingBootstrapSchedulerService,
  PublisherBindingRefreshService,
} from './publisher-binding-refresh.service';

describe('PublisherBindingRefreshService', () => {
  function createHarness(
    accessResult:
      | { isAdmin: boolean; isOwner: boolean; permissions: string[]; permissionsKnown: boolean }
      | Error,
    dispatchEnabled = true,
  ) {
    const prisma = {
      chat: {
        findUnique: jest.fn(async () => ({
          id: 'chat-1',
          publicationPolicy: null,
          botMemberships: [{ id: 'main-membership' }],
        })),
      },
      publisherEntityBinding: {
        createMany: jest.fn(async () => ({ count: 1 })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn(async () => {
        if (accessResult instanceof Error) {
          throw accessResult;
        }
        return accessResult;
      }),
    };
    const credentials = {
      getBotId: jest.fn(() => 'publik_bot'),
      getRequiredActionToken: jest.fn(() => 'not-a-real-token'),
    };
    const dispatchHealth = {
      isGloballyPaused: jest.fn(async () => false),
      recordAuthenticatedSuccess: jest.fn(async () => undefined),
      recordGlobalAuthorizationFailure: jest.fn(async () => undefined),
    };
    const identityAttestation = {
      assertAttested: jest.fn(async () => undefined),
    };
    const service = new PublisherBindingRefreshService(
      prisma as never,
      maxClient as never,
      credentials as never,
      dispatchHealth as never,
      identityAttestation as never,
      { dispatchEnabled } as never,
    );
    return { service, prisma, maxClient, dispatchHealth, identityAttestation };
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

  it('does not start binding bootstrap scans while dispatch is disabled', async () => {
    jest.useFakeTimers();
    try {
      const prisma = {
        $queryRaw: jest.fn(),
        publisherEntityBinding: { findMany: jest.fn() },
      };
      const identityAttestation = { assertAttested: jest.fn() };
      const scheduler = new PublisherBindingBootstrapSchedulerService(
        prisma as never,
        { ensureBinding: jest.fn() } as never,
        { enqueue: jest.fn() } as never,
        { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
        identityAttestation as never,
        { dispatchEnabled: false } as never,
      );

      await scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(120_000);
      await scheduler.scan('scheduled');

      expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.publisherEntityBinding.findMany).not.toHaveBeenCalled();
      scheduler.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the bounded startup binding bootstrap while dispatch is enabled', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'chat-bootstrap' }]),
      publisherEntityBinding: {
        findMany: jest.fn().mockResolvedValue([{ chatId: 'chat-stale' }]),
      },
    };
    const refreshService = { ensureBinding: jest.fn().mockResolvedValue(undefined) };
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const identityAttestation = { assertAttested: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new PublisherBindingBootstrapSchedulerService(
      prisma as never,
      refreshService as never,
      refreshQueue as never,
      { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
      identityAttestation as never,
      { dispatchEnabled: true } as never,
    );

    await scheduler.onModuleInit();

    expect(identityAttestation.assertAttested).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.publisherEntityBinding.findMany).toHaveBeenCalledTimes(1);
    expect(refreshService.ensureBinding).toHaveBeenCalledWith('chat-bootstrap');
    expect(refreshQueue.enqueue).toHaveBeenCalledTimes(2);
    scheduler.onModuleDestroy();
  });
});
