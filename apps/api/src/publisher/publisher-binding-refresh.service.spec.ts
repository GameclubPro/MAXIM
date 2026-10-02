import { buildBotAccessSnapshotPersistence } from '../max/bot-access-snapshot.util';
import { PublisherBotProofSupersededError } from './publisher-fresh-bot-proof';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import {
  PublisherCandidateRefreshSupersededError,
  PublisherBindingMaintenanceSupersededError,
  PublisherBindingRefreshSchedulerService,
  PublisherBindingRefreshService,
} from './publisher-binding-refresh.service';
import { buildPublisherForwardedBindingSource } from './publisher-entity-binding-lifecycle.service';
import { PublisherReadinessService } from './publisher-readiness.service';
import type { PublisherBindingRefreshJob } from './publisher-binding-refresh.queue';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PublisherAccessRefreshPolicy } from './publisher-access-refresh-policy';

const createBackgroundWork = () => ({
  runExclusive: jest.fn((_lane: string, operation: () => Promise<unknown>) => operation()),
});
const createHistoricalRecovery = () => ({
  recoverHistoricalActorCandidates: jest.fn().mockResolvedValue(0),
});

describe('PublisherBindingRefreshService', () => {
  type HarnessBinding = {
    publisherBotId: string;
    status: ChatBotMembershipStatus;
    botAccessState: ChatBotAccessState;
    botAccessSource: string | null;
    botAccessCheckedAt: Date | null;
    botAccessExpiresAt?: Date | null;
    lifecycleEventAt: Date | null;
    lifecycleEventType?: string | null;
    lastSeenAt?: Date | null;
    lastWebhookAt: Date | null;
  };

  function createHarness(
    accessResult:
      | { isAdmin: boolean; isOwner: boolean; permissions: string[]; permissionsKnown: boolean }
      | Error,
    dispatchEnabled = true,
    publikEnabled: boolean | null = null,
    policy = new PublisherAccessRefreshPolicy(),
  ) {
    const bindingState = {
      botAccessCheckedAt: null as Date | null,
      botAccessState: ChatBotAccessState.CONFIRMED_ADMIN as ChatBotAccessState,
    };
    const edgeState = {
      checkedAt: null as Date | null,
      deniedReason: 'publisher_actor_verification_pending' as string | null,
      source: 'publisher_actor_candidate_webhook',
      sourceVersion: null as string | null,
    };
    const prisma = {
      chat: {
        findUnique: jest.fn(
          async (): Promise<{
            id: string;
            entityType?: ChatEntityType;
            publicationPolicy: { publikEnabled: boolean } | null;
            publisherBinding: HarnessBinding | null;
          }> => ({
            id: 'chat-1',
            entityType: ChatEntityType.CHAT,
            publicationPolicy: publikEnabled === null ? null : { publikEnabled },
            publisherBinding: {
              publisherBotId: 'publik_bot',
              status: ChatBotMembershipStatus.ACTIVE,
              botAccessState: ChatBotAccessState.CONFIRMED_ADMIN as ChatBotAccessState,
              botAccessSource: null as string | null,
              botAccessCheckedAt: bindingState.botAccessCheckedAt,
              botAccessExpiresAt: bindingState.botAccessCheckedAt
                ? new Date(bindingState.botAccessCheckedAt.getTime() + 15 * 60_000)
                : null,
              lifecycleEventAt: null,
              lastSeenAt: new Date('2026-08-26T11:55:00.000Z') as Date | null,
              lastWebhookAt: null as Date | null,
            },
          }),
        ),
      },
      managedBotChatCatalog: {
        findUnique: jest
          .fn<
            Promise<{
              entityType: ChatEntityType;
              title?: string | null;
              source?: string;
              status?: string;
              lastSeenAt?: Date;
            } | null>,
            []
          >()
          .mockResolvedValue({ entityType: ChatEntityType.CHAT }),
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
          checkedAt: edgeState.checkedAt,
          deniedReason: edgeState.deniedReason,
          source:
            edgeState.source === 'publisher_actor_candidate_webhook' &&
            edgeState.sourceVersion?.startsWith('forwarded:')
              ? 'publisher_actor_candidate_forwarded'
              : edgeState.source,
          sourceVersion: edgeState.sourceVersion,
        })),
      },
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'chat-1' }]),
      chat: {
        findUnique: jest
          .fn<
            Promise<{
              title: string;
              publicationPolicy: { publikEnabled: boolean } | null;
            } | null>,
            []
          >()
          .mockResolvedValue({
            title: 'Publisher chat',
            publicationPolicy: null,
          }),
        update: jest.fn().mockResolvedValue({ id: 'chat-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBotChatCatalog: {
        upsert: jest.fn().mockResolvedValue({ id: 'catalog-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publisherEntityBinding: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(
          async (): Promise<HarnessBinding | null> => ({
            publisherBotId: 'publik_bot',
            status: ChatBotMembershipStatus.ACTIVE,
            lifecycleEventAt: null,
            botAccessCheckedAt: bindingState.botAccessCheckedAt,
            botAccessState: bindingState.botAccessState,
            botAccessExpiresAt: new Date(Date.now() + 15 * 60_000),
            botAccessSource: null as string | null,
            lastWebhookAt: null,
          }),
        ),
        update: jest.fn().mockResolvedValue({ chatId: 'chat-1' }),
        upsert: jest.fn().mockResolvedValue({ chatId: 'chat-1' }),
      },
      managedEntityAccessEdge: {
        findUnique: jest.fn().mockImplementation(async () => ({
          checkedAt: edgeState.checkedAt,
          deniedReason: edgeState.deniedReason,
          source:
            edgeState.source === 'publisher_actor_candidate_webhook' &&
            edgeState.sourceVersion?.startsWith('forwarded:')
              ? 'publisher_actor_candidate_forwarded'
              : edgeState.source,
          sourceVersion: edgeState.sourceVersion,
        })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({ chatId: 'chat-1' }),
      },
    };
    Object.assign(prisma, {
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    });
    const maxClient = {
      getChatAdminAccesses: jest.fn().mockResolvedValue([]),
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
      sendMessage: jest.fn().mockResolvedValue({ messageId: 'start-reply-1' }),
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
      buildMiniappStartUrlSync: jest.fn<string | null, [string, string?]>(
        () => 'https://max.ru/publik_bot?startapp=home',
      ),
    };
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue('maintenance-1') };
    const service = new PublisherBindingRefreshService(
      prisma as never,
      maxClient as never,
      credentials as never,
      dispatchHealth as never,
      identityAttestation as never,
      runtimeBoundary as never,
      maxBotLinkService as never,
      refreshQueue as never,
      policy,
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
      refreshQueue,
    };
  }

  const job = {
    version: 1,
    chatId: 'chat-1',
    publisherBotId: 'publik_bot',
    reason: 'bootstrap',
    requestedAt: '2026-08-26T12:00:00.000Z',
  } as const;

  const adminAccess = {
    isAdmin: true,
    isOwner: false,
    permissions: ['write'],
    permissionsKnown: true,
  };

  it('includes late admission before enqueue in urgent latency', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const f = createHarness(adminAccess);
      await f.service.refresh({
        ...job,
        reason: 'publication_due',
        publicationRequested: true,
        requestedAt: new Date().toISOString(),
        publicationRequestedAt: new Date().toISOString(),
        publicationUrgentAt: new Date(Date.now() - 30_000).toISOString(),
      });
      f.service.onModuleDestroy();
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: 'publisher_refresh_v1',
          workClass: 'urgent',
          queueAgeHistogram: [0, 0, 0, 1, 0, 0, 0, 0],
        }),
        'Publisher refresh window',
      );
    } finally {
      log.mockRestore();
    }
  });

  it('counts every refresh attempt in bounded identifier-free histograms', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-30T12:00:00Z'));
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const f = createHarness(adminAccess);
      for (const age of [500, 10_000, 400_000])
        await f.service.refresh({
          ...job,
          reason: 'publication_due',
          requestedAt: new Date(Date.now() - age).toISOString(),
        });
      f.service.onModuleDestroy();
      const rows = log.mock.calls
        .filter(([, label]) => label === 'Publisher refresh window')
        .map(
          ([row]) =>
            row as unknown as { attempts: number; queueAgeHistogram: number[]; reason: string },
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        metric: 'publisher_refresh_v1',
        attempts: 3,
        returned: 3,
        thrown: 0,
        reason: 'publication_due',
      });
      expect(rows[0].queueAgeHistogram.reduce((sum, count) => sum + count, 0)).toBe(3);
      expect(JSON.stringify(rows)).not.toContain(job.chatId);
      expect(JSON.stringify(rows)).not.toContain(job.publisherBotId);
    } finally {
      log.mockRestore();
      jest.useRealTimers();
    }
  });

  it('keeps a committed bot permission probe successful when telemetry fails', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    try {
      const f = createHarness(adminAccess);
      await expect(
        f.service.refresh({ ...job, reason: 'publication_due' }),
      ).resolves.toBeUndefined();
      expect(f.prisma.publisherEntityBinding.updateMany).toHaveBeenCalled();
      expect(() => f.service.onModuleDestroy()).not.toThrow();
    } finally {
      log.mockRestore();
    }
  });

  it('measures the committed bot proof before slow catalog and roster work finishes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-02T12:00:00Z'));
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const f = createHarness(adminAccess);
      const snapshot = await f.maxClient.getChatSnapshot();
      f.maxClient.getChatSnapshot.mockImplementation(async () => {
        jest.setSystemTime(new Date('2026-10-02T12:00:10Z'));
        return snapshot;
      });
      await f.service.refresh({
        ...job,
        requestedAt: new Date().toISOString(),
        requiredBefore: '2026-10-02T12:00:05Z',
      });
      f.service.onModuleDestroy();
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ deadlineProbes: 1, confirmedBeforeDeadline: 1 }),
        'Publisher refresh window',
      );
    } finally {
      log.mockRestore();
      jest.useRealTimers();
    }
  });

  it('does not count a fast remote response whose SQL commit finishes after the deadline', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-02T12:00:00Z'));
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const f = createHarness(adminAccess);
      f.prisma.publisherEntityBinding.updateMany.mockImplementation(async () => {
        jest.setSystemTime(new Date('2026-10-02T12:00:10Z'));
        return { count: 1 };
      });
      await f.service.refresh({
        ...job,
        reason: 'publication_due',
        requestedAt: new Date().toISOString(),
        requiredBefore: '2026-10-02T12:00:05Z',
      });
      f.service.onModuleDestroy();
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ deadlineProbes: 1, confirmedBeforeDeadline: 0 }),
        'Publisher refresh window',
      );
    } finally {
      log.mockRestore();
      jest.useRealTimers();
    }
  });

  it.each(['scheduled_bot_access', 'publication_due'] as const)(
    'keeps %s lightweight and independently queues fenced roster maintenance',
    async (reason) => {
      const f = createHarness(adminAccess);
      await f.service.refresh({ ...job, reason });
      expect(f.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
      expect(f.maxClient.getChatSnapshot).not.toHaveBeenCalled();
      expect(f.maxClient.getChatAdminAccesses).not.toHaveBeenCalled();
      expect(f.refreshQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'binding_maintenance',
          chatId: job.chatId,
          publisherBotId: job.publisherBotId,
        }),
      );
      await f.service.refresh({ ...job, reason: 'binding_maintenance' });
      expect(f.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
      expect(f.maxClient.getChatAdminAccesses).toHaveBeenCalledTimes(1);
      expect(f.tx.managedEntityAccessEdge.updateMany).toHaveBeenCalled();
    },
  );

  it('separates bot refresh from roster maintenance while keeping manual checks immediate', async () => {
    const policy = new PublisherAccessRefreshPolicy(
      new ConfigService({ MAX_PUBLISHER_ACCESS_REFRESH_MODE: 'on' }),
    );
    const f = createHarness(adminAccess, true, null, policy);
    await f.service.refresh({ ...job, reason: 'scheduled_bot_access' });
    expect(f.refreshQueue.enqueue).not.toHaveBeenCalled();
    expect(f.maxClient.getChatAdminAccesses).not.toHaveBeenCalled();
    const source = await f.prisma.chat.findUnique();
    f.prisma.chat.findUnique.mockResolvedValue({
      ...source,
      publisherBinding: {
        ...source.publisherBinding!,
        rosterRefreshAfter: new Date(Date.now() + 1800000),
      },
    } as never);
    await f.service.refresh({ ...job, reason: 'binding_maintenance' });
    expect(f.maxClient.getChatAdminAccesses).not.toHaveBeenCalled();
    await f.service.refresh({ ...job, reason: 'manual_recheck' });
    expect(f.maxClient.getChatAdminAccesses).toHaveBeenCalledTimes(1);
  });

  it('refreshes an actor promoted after its previous proof has become too old for publication', async () => {
    const f = createHarness(adminAccess);
    f.edgeState.sourceVersion = 'actor-version';
    f.edgeState.checkedAt = new Date(Date.now() - 20 * 60_000);
    await f.service.refresh({
      ...job,
      reason: 'stale_user_access',
      candidateUserId: 'admin-1',
      candidateVersion: 'actor-version',
      publicationRequested: true,
      requestedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      publicationRequestedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    expect(f.maxClient.getChatMemberAccess).toHaveBeenCalled();
    expect(f.tx.managedEntityAccessEdge.upsert).toHaveBeenCalled();
  });

  it('persists maintenance backoff without granting access after a transient MAX failure', async () => {
    const policy = new PublisherAccessRefreshPolicy(
      new ConfigService({ MAX_PUBLISHER_ACCESS_REFRESH_MODE: 'on' }),
    );
    const f = createHarness(adminAccess, true, null, policy);
    f.bindingState.botAccessCheckedAt = new Date();
    f.maxClient.getChatAdminAccesses.mockRejectedValueOnce(
      Object.assign(new Error('MAX rate limit'), { retryAfterMs: 120000 }),
    );
    const before = Date.now();
    await expect(f.service.refresh({ ...job, reason: 'binding_maintenance' })).rejects.toThrow(
      'MAX rate limit',
    );
    const write = f.prisma.publisherEntityBinding.updateMany.mock.calls.find(
      ([call]) => 'rosterRefreshAfter' in call.data,
    )!;
    expect(
      (write[0].data as { rosterRefreshAfter: Date }).rosterRefreshAfter.getTime(),
    ).toBeGreaterThanOrEqual(before + 120000);
    expect(f.tx.managedEntityAccessEdge.createMany).not.toHaveBeenCalled();
  });

  it('recovers failed maintenance enqueue without repeating a newer successful bot probe', async () => {
    const f = createHarness(adminAccess);
    f.refreshQueue.enqueue.mockRejectedValueOnce(new Error('redis unavailable'));
    const scheduled = {
      ...job,
      reason: 'scheduled_bot_access' as const,
      requestedAt: new Date(Date.now() - 10_000).toISOString(),
    };
    await expect(f.service.refresh(scheduled)).rejects.toThrow('redis unavailable');
    await f.service.refresh(scheduled, { retrying: true });
    expect(f.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(f.refreshQueue.enqueue).toHaveBeenCalledTimes(2);
  });

  it('maintenance requests a bot refresh instead of using an expired proof', async () => {
    const f = createHarness(adminAccess);
    f.bindingState.botAccessCheckedAt = new Date(Date.now() - 16 * 60_000);
    await f.service.refresh({ ...job, reason: 'binding_maintenance' });
    expect(f.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(f.maxClient.getChatAdminAccesses).not.toHaveBeenCalled();
    expect(f.refreshQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'scheduled_bot_access' }),
    );
  });

  it('retries a superseded active roster handoff with the newer bot proof', async () => {
    const f = createHarness(adminAccess);
    f.bindingState.botAccessCheckedAt = new Date(Date.now() - 1_000);
    f.prisma.managedBotChatCatalog.findUnique.mockResolvedValue({
      entityType: ChatEntityType.CHAT,
      title: 'Chat',
      status: 'ACTIVE',
      source: 'publisher_targeted_snapshot',
      lastSeenAt: new Date(),
    });
    f.tx.publisherEntityBinding.findUnique.mockImplementationOnce(async () => {
      f.bindingState.botAccessCheckedAt = new Date();
      return {
        publisherBotId: 'publik_bot',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessSource: null,
        botAccessCheckedAt: f.bindingState.botAccessCheckedAt,
        lifecycleEventAt: null,
        lastWebhookAt: null,
      };
    });
    await expect(
      f.service.refresh({ ...job, reason: 'binding_maintenance' }),
    ).rejects.toBeInstanceOf(PublisherBindingMaintenanceSupersededError);
    await f.service.refresh({ ...job, reason: 'binding_maintenance' }, { retrying: true });
    expect(f.maxClient.getChatAdminAccesses).toHaveBeenCalledTimes(2);
    expect(f.tx.managedEntityAccessEdge.updateMany).toHaveBeenCalled();
    expect(f.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  const recentCatalog = () => ({
    entityType: ChatEntityType.CHANNEL,
    title: 'Publisher channel',
    source: 'publisher_targeted_snapshot',
    status: 'ACTIVE',
    lastSeenAt: new Date(Date.now() - 11 * 60_000),
  });

  const startJob = {
    ...job,
    reason: 'webhook_observed',
    candidateUserId: 'admin-1',
    candidateVersion: 'start-update-1',
    replyToStartCommand: true,
  } as const;

  it('confirms an explicit Start only after bot and actor admin access is committed', async () => {
    const { service, maxClient, edgeState, maxBotLinkService, tx } = createHarness(adminAccess);
    edgeState.sourceVersion = startJob.candidateVersion;
    await service.refresh(startJob);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('подключен к Публику'),
      {
        buttons: [
          [
            {
              type: 'link',
              text: 'Открыть Публик',
              url: 'https://max.ru/publik_bot?startapp=home',
            },
          ],
        ],
      },
      expect.objectContaining({
        immediate: true,
        botId: 'publik_bot',
        idempotencyKey: 'publisher-handshake-start:chat-1:start-update-1',
        autoDeleteDelayMs: 180_000,
      }),
    );
    expect(maxClient.sendMessage.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.managedEntityAccessEdge.upsert.mock.invocationCallOrder[0],
    );
    const [startParam, botId] = maxBotLinkService.buildMiniappStartUrlSync.mock.calls[0];
    expect(botId).toBe('publik_bot');
    expect(JSON.parse(Buffer.from(startParam.slice(3), 'base64url').toString('utf8'))).toEqual({
      v: 1,
      k: 'route',
      r: '/',
    });
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });

  it.each(['bot', 'user', 'unknown', 'timeout', 'superseded'])(
    'keeps an explicit Start silent when %s access is unconfirmed',
    async (denial) => {
      const { service, maxClient, edgeState } = createHarness(
        denial === 'bot' ? { ...adminAccess, isAdmin: false } : adminAccess,
      );
      edgeState.sourceVersion =
        denial === 'superseded' ? 'newer-update' : startJob.candidateVersion;
      if (denial === 'user')
        maxClient.getChatMemberAccess.mockResolvedValueOnce({
          isBot: false,
          isAdmin: false,
          isOwner: false,
          permissions: [],
          permissionsKnown: true,
        });
      if (denial === 'unknown')
        maxClient.getChatMemberAccess.mockResolvedValueOnce({
          isBot: undefined,
          isAdmin: true,
          isOwner: false,
          permissions: [],
          permissionsKnown: true,
        } as never);
      if (denial === 'timeout')
        maxClient.getCurrentChatMemberAccess.mockRejectedValueOnce(new Error('timeout'));
      if (denial === 'timeout') {
        await expect(service.refresh(startJob)).rejects.toThrow('timeout');
      } else if (denial === 'superseded') {
        await expect(service.refresh(startJob)).rejects.toBeInstanceOf(
          PublisherCandidateRefreshSupersededError,
        );
      } else {
        await expect(service.refresh(startJob)).resolves.toBeUndefined();
      }
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    },
  );

  it.each(['bot_added', 'webhook_observed', 'manual_recheck', 'stale_user_access'] as const)(
    'keeps %s access refresh silent without an explicit Start request',
    async (reason) => {
      const { service, maxClient, edgeState } = createHarness(adminAccess);
      edgeState.sourceVersion = startJob.candidateVersion;
      await service.refresh({ ...startJob, reason, replyToStartCommand: undefined });
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('preserves the ledger reply identity on retries and contains ambiguous send errors', async () => {
    const { service, maxClient, edgeState } = createHarness(adminAccess);
    edgeState.sourceVersion = startJob.candidateVersion;
    maxClient.sendMessage.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.refresh(startJob)).resolves.toBeUndefined();
    await service.refresh(startJob, { retrying: true });
    expect(maxClient.sendMessage.mock.calls.map((call) => call[3]?.idempotencyKey)).toEqual([
      'publisher-handshake-start:chat-1:start-update-1',
      'publisher-handshake-start:chat-1:start-update-1',
    ]);
  });

  it('reuses recent scheduled metadata without extending its age or reusing permissions', async () => {
    const { service, prisma, maxClient, tx } = createHarness(adminAccess);
    prisma.managedBotChatCatalog.findUnique.mockResolvedValue(recentCatalog());
    await service.refresh({ ...job, reason: 'stale_access' });
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
    expect(tx.managedBotChatCatalog.upsert).not.toHaveBeenCalled();
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ botId: 'publik_bot', bypassCache: true }),
    );
    expect(maxClient.getChatAdminAccesses).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ botId: 'publik_bot', bypassCache: true }),
    );
  });

  it.each([
    { source: 'publisher_webhook_chat_title_changed' },
    { status: 'MISSING' },
    { title: '  ' },
    { lastSeenAt: new Date(Date.now() - 31 * 60_000) },
    { lastSeenAt: new Date(Date.now() + 60_000) },
  ])('hydrates scheduled metadata when its proof is unsuitable: %j', async (override) => {
    const { service, prisma, maxClient } = createHarness(adminAccess);
    prisma.managedBotChatCatalog.findUnique.mockResolvedValue({ ...recentCatalog(), ...override });
    await service.refresh({ ...job, reason: 'stale_access' });
    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each(['manual_recheck', 'policy_enablement_recheck', 'webhook_observed'] as const)(
    'always hydrates metadata for %s',
    async (reason) => {
      const { service, prisma, maxClient } = createHarness(adminAccess);
      prisma.managedBotChatCatalog.findUnique.mockResolvedValue(recentCatalog());
      await service.refresh({ ...job, reason });
      expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
    },
  );

  it('always hydrates metadata when refreshing a specific actor', async () => {
    const { service, prisma, maxClient } = createHarness(adminAccess);
    prisma.managedBotChatCatalog.findUnique.mockResolvedValue(recentCatalog());
    await service.refresh({ ...job, reason: 'stale_user_access', candidateUserId: 'user-1' });
    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ botId: 'publik_bot', bypassCache: true }),
    );
  });

  it('keeps fresh metadata from bypassing lifecycle fencing on roster persistence', async () => {
    const { service, prisma, maxClient, tx } = createHarness(adminAccess);
    prisma.managedBotChatCatalog.findUnique.mockResolvedValue(recentCatalog());
    tx.publisherEntityBinding.findUnique.mockResolvedValue(null);
    await expect(service.refresh({ ...job, reason: 'stale_access' })).rejects.toBeInstanceOf(
      PublisherCandidateRefreshSupersededError,
    );
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
    expect(tx.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(tx.managedEntityAccessEdge.createMany).not.toHaveBeenCalled();
  });

  it('overlaps independent catalog and roster probes after confirming bot access', async () => {
    const f = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    const snapshot = await f.maxClient.getChatSnapshot();
    f.maxClient.getChatSnapshot.mockClear();
    let release!: () => void;
    f.maxClient.getChatSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(snapshot);
        }),
    );
    const running = f.service.refresh({ ...job, reason: 'stale_access' });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.maxClient.getChatAdminAccesses).toHaveBeenCalledTimes(1);
      expect(f.tx.managedEntityAccessEdge.createMany).not.toHaveBeenCalled();
    } finally {
      release();
      await running;
    }
  });

  it('retries incomplete roster work even after the bot access snapshot was committed', async () => {
    const f = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    const scheduled = { ...job, reason: 'stale_access' as const };
    f.maxClient.getChatAdminAccesses.mockRejectedValueOnce(new Error('roster unavailable'));
    await expect(f.service.refresh(scheduled)).rejects.toThrow('roster unavailable');
    expect(f.bindingState.botAccessCheckedAt).not.toBeNull();
    await f.service.refresh(scheduled, { retrying: true });
    expect(f.maxClient.getChatAdminAccesses).toHaveBeenCalledTimes(2);
  });

  it('drains the catalog operation before exposing a parallel roster failure', async () => {
    const f = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    const snapshot = await f.maxClient.getChatSnapshot();
    let release!: () => void;
    f.maxClient.getChatSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(snapshot);
        }),
    );
    const failure = new Error('roster unavailable');
    f.maxClient.getChatAdminAccesses.mockRejectedValueOnce(failure);
    let settled = false;
    const running = f.service.refresh({ ...job, reason: 'stale_access' }).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.maxClient.getChatAdminAccesses).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(f.tx.managedEntityAccessEdge.updateMany).not.toHaveBeenCalled();
    } finally {
      release();
    }
    expect(await running).toBe(failure);
    expect(f.tx.managedBotChatCatalog.upsert).toHaveBeenCalledTimes(1);
    expect(f.tx.managedEntityAccessEdge.updateMany).not.toHaveBeenCalled();
  });

  it('does not revive a removed binding when recovering a partially completed refresh', async () => {
    const f = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    const chat = await f.prisma.chat.findUnique();
    f.prisma.chat.findUnique.mockResolvedValue({
      ...chat,
      publisherBinding: { ...chat.publisherBinding!, status: ChatBotMembershipStatus.REMOVED },
    });
    await f.service.refresh({ ...job, reason: 'stale_access' }, { retrying: true });
    expect(f.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(f.tx.managedEntityAccessEdge.updateMany).not.toHaveBeenCalled();
  });

  it('reuses a fresh exact SQL bot proof for an actor without another bot MAX call', async () => {
    const f = createHarness(adminAccess);
    const checkedAt = new Date(Date.now() - 60_000);
    const chat = await f.prisma.chat.findUnique();
    f.bindingState.botAccessCheckedAt = checkedAt;
    f.prisma.chat.findUnique.mockResolvedValue({
      ...chat,
      publisherBinding: {
        ...chat.publisherBinding!,
        ...buildBotAccessSnapshotPersistence(adminAccess, { source: 'probe', now: checkedAt }),
      },
    });
    await f.service.refresh({
      ...job,
      reason: 'publication_actor_due',
      candidateUserId: 'admin-1',
    });
    expect(f.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(f.maxClient.getChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(f.tx.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(1);
    expect(f.prisma.publisherEntityBinding.updateMany).not.toHaveBeenCalled();
  });

  it('retries a candidate after losing the exact bot CAS instead of acknowledging unperformed work', async () => {
    const f = createHarness(adminAccess);
    f.prisma.publisherEntityBinding.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      f.service.refresh({ ...job, reason: 'manual_recheck', candidateUserId: 'admin-1' }),
    ).rejects.toBeInstanceOf(PublisherBotProofSupersededError);
    expect(f.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(f.tx.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
  });

  it('stages a missing publication actor edge before a version-fenced MAX verification', async () => {
    const f = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    let edge: Record<string, unknown> | null = null;
    const readEdge = async () => edge;
    f.prisma.managedEntityAccessEdge.findUnique.mockImplementation(readEdge);
    f.tx.managedEntityAccessEdge.findUnique.mockImplementation(readEdge);
    f.tx.managedEntityAccessEdge.createMany.mockImplementation(async (args: any) => {
      if (edge) return { count: 0 };
      edge = args.data[0];
      return { count: 1 };
    });
    const findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'chat-1', entityType: ChatEntityType.CHAT, accessEdges: [] }]);
    const findFirst = jest
      .fn()
      .mockResolvedValue({ id: 'chat-1', entityType: ChatEntityType.CHAT });
    Object.assign(f.prisma.chat, { findMany });
    Object.assign(f.tx.chat, { findFirst });
    const enqueue = jest.fn();
    const readiness = new PublisherReadinessService(
      f.prisma as never,
      {} as never,
      {
        get: (key: string, fallback: unknown) =>
          key === 'MAX_PUBLISHER_BOT_ID'
            ? 'publik_bot'
            : key === 'MAX_PUBLISHER_DISPATCH_ENABLED'
              ? true
              : fallback,
      } as never,
      { enqueue } as never,
    );
    await readiness.requestActorAccessRefresh(
      [{ chatId: 'chat-1', entityType: 'chat' }],
      'actor-1',
      'publik_bot',
    );
    expect(f.tx.managedEntityAccessEdge.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          chatId: 'chat-1',
          userId: 'actor-1',
          botId: 'publik_bot',
          state: ManagedEntityAccessState.BOT_DENIED,
          userRole: ManagedEntityAccessRole.UNKNOWN,
          source: 'publisher_actor_candidate_publication',
          sourceVersion: expect.stringMatching(/^publication:/u),
        }),
      ],
      skipDuplicates: true,
    });
    const nominated = enqueue.mock.calls[0][0];
    expect(nominated.candidateVersion).toBe(edge!.sourceVersion);
    expect(nominated.requestedAt).toEqual(edge!.checkedAt);
    await expect(
      f.service.refresh({
        version: 1,
        ...nominated,
        requestedAt: nominated.requestedAt.toISOString(),
      } as PublisherBindingRefreshJob),
    ).resolves.toBeUndefined();
    expect(f.maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'actor-1',
      expect.objectContaining({ botId: 'publik_bot', bypassCache: true }),
    );
    expect(f.tx.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ state: ManagedEntityAccessState.GRANTED }),
      }),
    );
  });

  it.each(['bootstrap', 'bot_added', 'manual_recheck'] as const)(
    'synchronizes all Publisher admins on %s even while publishing is disabled',
    async (reason) => {
      const f = createHarness(
        { isAdmin: true, isOwner: false, permissions: ['write'], permissionsKnown: true },
        true,
        false,
      );
      f.maxClient.getChatAdminAccesses.mockResolvedValue([
        { userId: 'other-admin', isBot: false, isAdmin: true, isOwner: false },
      ]);
      await f.service.refresh({
        ...job,
        reason,
        ...(reason === 'bootstrap' ? {} : { candidateUserId: 'installer' }),
      });
      expect(f.tx.managedEntityAccessEdge.createMany).toHaveBeenCalledWith({
        skipDuplicates: true,
        data: [
          expect.objectContaining({ userId: 'other-admin', botId: 'publik_bot', state: 'GRANTED' }),
        ],
      });
    },
  );

  it('keeps user renewal targeted instead of fetching a roster per user', async () => {
    const f = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    await f.service.refresh({ ...job, reason: 'stale_user_access', candidateUserId: 'installer' });
    expect(f.maxClient.getChatMemberAccess).toHaveBeenCalled();
    expect(f.maxClient.getChatAdminAccesses).not.toHaveBeenCalled();
  });

  it('renews bot, catalog and user access despite concurrent ordinary messages', async () => {
    const f = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    const readBinding = f.tx.publisherEntityBinding.findUnique.getMockImplementation()!;
    f.tx.publisherEntityBinding.findUnique.mockImplementation(
      async () =>
        ({
          ...(await readBinding()),
          lifecycleEventType: 'message_created',
          lifecycleEventAt: new Date(Date.now() + 1_000),
        }) as HarnessBinding,
    );
    await f.service.refresh({ ...job, reason: 'manual_recheck', candidateUserId: 'admin-1' });
    expect(f.tx.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ state: 'GRANTED' }),
      }),
    );
    expect(f.tx.managedBotChatCatalog.upsert).toHaveBeenCalled();
    expect(f.maxClient.getChatAdminAccesses).toHaveBeenCalled();
    expect(f.prisma.publisherEntityBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              OR: expect.arrayContaining([
                { lifecycleEventType: { in: expect.arrayContaining(['message_created']) } },
              ]),
            },
            {
              OR: [{ botAccessCheckedAt: null }, { botAccessCheckedAt: { lte: expect.any(Date) } }],
            },
          ]),
        }),
      }),
    );
  });

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

  it('drains legacy scheduled binding duplicates without another MAX probe after a newer check', async () => {
    const { service, bindingState, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    bindingState.botAccessCheckedAt = new Date('2026-08-26T12:01:00.000Z');

    await service.refresh({ ...job, reason: 'stale_access' });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('drains legacy actor duplicates without another MAX probe after a newer edge check', async () => {
    const { service, edgeState, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    edgeState.checkedAt = new Date('2026-08-26T12:01:00.000Z');
    edgeState.sourceVersion = 'edge-v1';

    await service.refresh({
      ...job,
      candidateUserId: 'admin-1',
      candidateVersion: 'edge-v1',
      reason: 'stale_user_access',
    });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
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

  it('refreshes the exact binding and catalog while publishing stays disabled', async () => {
    const { service, prisma, maxClient, dispatchHealth } = createHarness(
      {
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
        permissionsKnown: true,
      },
      true,
      false,
    );

    await service.refresh({ ...job, reason: 'policy_enablement_recheck' });

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        botId: 'publik_bot',
        bypassCache: true,
        trafficClass: 'interactive',
      }),
    );
    expect(prisma.publisherEntityBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
          botAccessSource: 'publisher_refresh_policy_enablement_recheck',
        }),
      }),
    );
    expect(dispatchHealth.recordAuthenticatedSuccess).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
  });

  it('refreshes a disabled Publisher admin access edge without Major or enabling posts', async () => {
    const { service, maxClient, tx } = createHarness(
      {
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
        permissionsKnown: true,
      },
      true,
      false,
    );

    await service.refresh({ ...job, reason: 'manual_recheck', candidateUserId: 'admin-disabled' });

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-disabled',
      expect.objectContaining({ botId: 'publik_bot', bypassCache: true }),
    );
    expect(tx.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: ManagedEntityAccessState.GRANTED,
          userRole: ManagedEntityAccessRole.ADMIN,
        }),
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(tx.chat.updateMany).not.toHaveBeenCalled();
  });

  it('does not let a policy enablement recheck bypass missing Publisher evidence', async () => {
    const { service, prisma, maxClient } = createHarness(
      {
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
        permissionsKnown: true,
      },
      true,
      false,
    );
    prisma.chat.findUnique.mockResolvedValueOnce({
      id: 'chat-1',
      entityType: ChatEntityType.CHAT,
      publicationPolicy: { publikEnabled: false },
      publisherBinding: {
        publisherBotId: 'publik_bot',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.UNKNOWN,
        botAccessSource: null,
        botAccessCheckedAt: null,
        lifecycleEventAt: null,
        lastSeenAt: null,
        lastWebhookAt: null,
      },
    });

    await service.refresh({ ...job, reason: 'policy_enablement_recheck' });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('does not lose a policy enablement probe when dispatch changes after dequeue', async () => {
    const { service, maxClient, runtimeBoundary, dispatchHealth } = createHarness(
      {
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
        permissionsKnown: true,
      },
      false,
      false,
    );

    await expect(service.refresh({ ...job, reason: 'policy_enablement_recheck' })).rejects.toThrow(
      'publisher disabled',
    );
    expect(runtimeBoundary.assertDispatchEnabled).toHaveBeenCalledTimes(1);
    expect(dispatchHealth.assertDispatchAllowed).not.toHaveBeenCalled();
    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('propagates a dispatch pause that races with a policy enablement probe', async () => {
    const { service, maxClient, dispatchHealth } = createHarness(
      {
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
        permissionsKnown: true,
      },
      true,
      false,
    );
    const paused = new Error('publisher dispatch paused');
    dispatchHealth.assertDispatchAllowed.mockRejectedValueOnce(paused);

    await expect(service.refresh({ ...job, reason: 'policy_enablement_recheck' })).rejects.toBe(
      paused,
    );
    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
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
        botAccessCheckedAt: null,
        lifecycleEventAt: null,
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
        botAccessCheckedAt: null,
        lifecycleEventAt: null,
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

  it('materializes a provisional forwarded channel atomically and replies with root miniapp route', async () => {
    const { service, prisma, tx, edgeState, maxClient, maxBotLinkService } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write', 'read_all_messages'],
      permissionsKnown: true,
    });
    const candidateVersion = 'forwarded:publisher-forward-1';
    edgeState.sourceVersion = candidateVersion;
    prisma.chat.findUnique.mockResolvedValueOnce({
      id: 'chat-1',
      entityType: ChatEntityType.CHAT,
      publicationPolicy: null,
      publisherBinding: null,
    });
    prisma.managedBotChatCatalog.findUnique.mockResolvedValueOnce(null);
    tx.publisherEntityBinding.findUnique.mockResolvedValue(null);
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
    expect(prisma.publisherEntityBinding.updateMany).not.toHaveBeenCalled();
    expect(tx.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'admin-2',
          botId: 'publik_bot',
          source: 'publisher_actor_candidate_forwarded',
          sourceVersion: candidateVersion,
        }),
        data: expect.objectContaining({
          entityType: ChatEntityType.CHANNEL,
          state: 'GRANTED',
          source: 'publisher_targeted_user_access',
        }),
      }),
    );
    expect(tx.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'chat-1' },
        data: expect.objectContaining({
          entityType: ChatEntityType.CHANNEL,
          title: 'Publisher channel',
        }),
      }),
    );
    expect(tx.publisherEntityBinding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          publisherBotId: 'publik_bot',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        }),
      }),
    );
    expect(tx.managedBotChatCatalog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          entityType: ChatEntityType.CHANNEL,
          status: 'ACTIVE',
          title: 'Publisher channel',
        }),
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

  it('can establish an authorized Publisher binding while its publication policy stays off', async () => {
    const { service, prisma, tx, edgeState } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write', 'read_all_messages'],
      permissionsKnown: true,
    });
    const candidateVersion = 'forwarded:policy-disabled-race';
    edgeState.sourceVersion = candidateVersion;
    prisma.chat.findUnique.mockResolvedValueOnce({
      id: 'chat-1',
      publicationPolicy: null,
      publisherBinding: null,
    });
    prisma.managedBotChatCatalog.findUnique.mockResolvedValueOnce(null);
    tx.chat.findUnique.mockResolvedValueOnce({
      title: 'Publisher chat',
      publicationPolicy: { publikEnabled: false },
    });
    tx.publisherEntityBinding.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.refresh({
        ...job,
        candidateUserId: 'admin-policy-race',
        candidateVersion,
        reason: 'forwarded_private',
      }),
    ).resolves.toBeUndefined();

    expect(tx.managedEntityAccessEdge.updateMany).toHaveBeenCalled();
    expect(tx.publisherEntityBinding.upsert).toHaveBeenCalled();
    expect(tx.managedBotChatCatalog.upsert).toHaveBeenCalled();
    expect(JSON.stringify(tx.chat.updateMany.mock.calls)).not.toContain('publikEnabled');
  });

  it.each([
    [
      'a concurrent binding creation',
      null,
      {
        publisherBotId: 'publik_bot',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessSource: 'publisher_bot_added',
        botAccessCheckedAt: new Date('2026-08-26T12:00:00.000Z'),
        lastWebhookAt: new Date('2026-08-26T12:00:00.000Z'),
        lifecycleEventAt: new Date('2026-08-26T12:00:00.000Z'),
      },
    ],
    [
      'a concurrent bot removal',
      {
        publisherBotId: 'publik_bot',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.UNKNOWN,
        botAccessSource: null,
        botAccessCheckedAt: null,
        lastWebhookAt: null,
        lifecycleEventAt: null,
      },
      {
        publisherBotId: 'publik_bot',
        status: ChatBotMembershipStatus.REMOVED,
        botAccessState: ChatBotAccessState.LOST,
        botAccessSource: 'publisher_bot_removed',
        botAccessCheckedAt: null,
        lastWebhookAt: null,
        lifecycleEventAt: null,
      },
    ],
  ] as const)(
    'aborts provisional materialization after %s',
    async (_label, initialBinding, committedBinding) => {
      const { service, prisma, tx, edgeState } = createHarness({
        isAdmin: true,
        isOwner: false,
        permissions: ['write', 'read_all_messages'],
        permissionsKnown: true,
      });
      const candidateVersion = 'forwarded:binding-race';
      edgeState.sourceVersion = candidateVersion;
      prisma.chat.findUnique.mockResolvedValueOnce({
        id: 'chat-1',
        publicationPolicy: null,
        publisherBinding: initialBinding,
      });
      prisma.managedBotChatCatalog.findUnique.mockResolvedValueOnce(null);
      tx.publisherEntityBinding.findUnique.mockResolvedValueOnce(committedBinding);

      await expect(
        service.refresh({
          ...job,
          candidateUserId: 'admin-binding-race',
          candidateVersion,
          reason: 'forwarded_private',
        }),
      ).rejects.toBeInstanceOf(PublisherCandidateRefreshSupersededError);

      expect(tx.managedEntityAccessEdge.updateMany).not.toHaveBeenCalled();
      expect(tx.publisherEntityBinding.upsert).not.toHaveBeenCalled();
      expect(tx.managedBotChatCatalog.upsert).not.toHaveBeenCalled();
    },
  );

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
    const { service, prisma, tx, edgeState, maxClient } = createHarness({
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
        botAccessCheckedAt: null,
        lifecycleEventAt: null,
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
      lastWebhookAt: null,
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
        botAccessCheckedAt: null,
        lifecycleEventAt: null,
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
      lastWebhookAt: null,
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

  it.each([400, 422])(
    'treats forwarded provisional HTTP %s as terminal without creating routing state',
    async (statusCode) => {
      const failure = Object.assign(new Error(`HTTP ${statusCode}`), {
        response: { status: statusCode },
      });
      const { service, prisma, tx, edgeState } = createHarness(failure);
      const candidateVersion = `forwarded:terminal-${statusCode}`;
      edgeState.sourceVersion = candidateVersion;
      prisma.chat.findUnique.mockResolvedValueOnce({
        id: 'chat-1',
        publicationPolicy: null,
        publisherBinding: null,
      });
      prisma.managedBotChatCatalog.findUnique.mockResolvedValueOnce(null);
      tx.publisherEntityBinding.findUnique.mockResolvedValueOnce(null);

      await service.refresh({
        ...job,
        candidateUserId: `admin-${statusCode}`,
        candidateVersion,
        reason: 'forwarded_private',
      });

      expect(prisma.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deniedReason: 'publisher_bot_access_lost',
            lastMaxStatusCode: statusCode,
          }),
        }),
      );
      expect(tx.publisherEntityBinding.upsert).not.toHaveBeenCalled();
      expect(tx.managedBotChatCatalog.upsert).not.toHaveBeenCalled();
    },
  );

  it('does not classify a routine HTTP 400 binding probe as terminal access loss', async () => {
    const failure = Object.assign(new Error('bad request'), { response: { status: 400 } });
    const { service, prisma } = createHarness(failure);

    await expect(service.refresh(job)).rejects.toBe(failure);

    expect(prisma.managedEntityAccessEdge.updateMany).not.toHaveBeenCalled();
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
        botAccessCheckedAt: null,
        lifecycleEventAt: null,
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
      lastWebhookAt: null,
    });

    await service.refresh({
      ...job,
      candidateUserId: 'admin-scheduled',
      candidateVersion,
      reason: 'stale_user_access',
    });

    expect(prisma.publisherEntityBinding.updateMany).not.toHaveBeenCalled();
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

  it('refreshes an established forwarded-version edge without permanently requiring read-all', async () => {
    const { service, prisma, tx, edgeState, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    const candidateVersion = 'forwarded:already-established';
    edgeState.sourceVersion = candidateVersion;
    edgeState.source = 'publisher_targeted_user_access';
    edgeState.deniedReason = null;

    await service.refresh({
      ...job,
      candidateUserId: 'admin-established',
      candidateVersion,
      reason: 'stale_user_access',
    });

    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-established',
      expect.objectContaining({ botId: 'publik_bot', trafficClass: 'background' }),
    );
    expect(tx.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          state: ManagedEntityAccessState.GRANTED,
          source: 'publisher_targeted_user_access',
          sourceVersion: candidateVersion,
        }),
      }),
    );
    expect(prisma.managedEntityAccessEdge.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deniedReason: 'publisher_bot_missing_read_all_messages',
        }),
      }),
    );
  });

  it.each([true, false])(
    'does not overwrite a newer access verdict with a delayed MAX admin=%s result',
    async (isAdmin) => {
      const { service, tx, edgeState, maxClient } = createHarness({
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
        permissionsKnown: true,
      });
      edgeState.sourceVersion = 'edge-v1';
      edgeState.source = 'publisher_targeted_user_access';
      edgeState.deniedReason = null;
      maxClient.getChatMemberAccess.mockImplementationOnce(async () => {
        edgeState.checkedAt = new Date(Date.now() + 1_000);
        return { isBot: false, isAdmin, isOwner: false, permissions: [], permissionsKnown: true };
      });
      await expect(
        service.refresh({
          ...job,
          candidateUserId: 'admin-1',
          candidateVersion: 'edge-v1',
          reason: 'stale_user_access',
        }),
      ).rejects.toThrow(PublisherCandidateRefreshSupersededError);
      expect(tx.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    },
  );

  it.each([403, 404])(
    'terminalizes user-access HTTP %s only after a complete roster confirms absence',
    async (statusCode) => {
      const { service, tx, edgeState, maxClient, bindingState } = createHarness({
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
        permissionsKnown: true,
      });
      const candidateVersion = `publisher-edge-${statusCode}`;
      edgeState.source = 'publisher_targeted_user_access';
      edgeState.sourceVersion = candidateVersion;
      const failure = Object.assign(new Error(`HTTP ${statusCode}`), {
        response: { status: statusCode },
      });
      maxClient.getChatMemberAccess.mockRejectedValueOnce(failure);

      await expect(
        service.refresh({
          ...job,
          candidateUserId: `admin-${statusCode}`,
          candidateVersion,
          reason: 'stale_user_access',
        }),
      ).resolves.toBeUndefined();

      expect(tx.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            state: ManagedEntityAccessState.USER_DENIED,
            userRole: ManagedEntityAccessRole.UNKNOWN,
            botRole: ManagedEntityAccessRole.ADMIN,
            deniedReason: 'publisher_user_access_unavailable',
            lastMaxErrorCode: `HTTP_${statusCode}`,
            lastMaxErrorMessage: null,
            lastMaxStatusCode: statusCode,
          }),
          update: expect.objectContaining({
            state: ManagedEntityAccessState.USER_DENIED,
            userRole: ManagedEntityAccessRole.UNKNOWN,
            botRole: ManagedEntityAccessRole.ADMIN,
            deniedReason: 'publisher_user_access_unavailable',
            lastMaxErrorCode: `HTTP_${statusCode}`,
            lastMaxErrorMessage: null,
            lastMaxStatusCode: statusCode,
          }),
        }),
      );
      expect(bindingState.botAccessState).toBe(ChatBotAccessState.CONFIRMED_ADMIN);
      expect(maxClient.getChatAdminAccesses).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({ botId: 'publik_bot', bypassCache: true }),
      );
    },
  );

  it.each([403, 404])(
    'recovers an administrator from the exact roster after member HTTP %s',
    async (statusCode) => {
      const f = createHarness({
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
        permissionsKnown: true,
      });
      f.maxClient.getChatMemberAccess.mockRejectedValueOnce(
        Object.assign(new Error('member lookup unavailable'), { response: { status: statusCode } }),
      );
      f.maxClient.getChatAdminAccesses.mockResolvedValue([
        { userId: 'admin-1', isBot: false, isAdmin: true, isOwner: false },
      ]);
      await f.service.refresh({ ...job, reason: 'stale_user_access', candidateUserId: 'admin-1' });
      expect(f.tx.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            state: 'GRANTED',
            deniedReason: null,
            lastMaxStatusCode: null,
          }),
        }),
      );
    },
  );

  it('does not turn two unavailable authorization endpoints into a persisted user denial', async () => {
    const f = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    f.maxClient.getChatMemberAccess.mockRejectedValueOnce(
      Object.assign(new Error('member lookup unavailable'), { response: { status: 403 } }),
    );
    f.maxClient.getChatAdminAccesses.mockRejectedValueOnce(new Error('roster unavailable'));
    await expect(
      f.service.refresh({ ...job, reason: 'stale_user_access', candidateUserId: 'admin-1' }),
    ).rejects.toThrow('roster unavailable');
    expect(f.tx.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
  });

  it('keeps retryable stale user-access failures in the queue retry path', async () => {
    const { service, edgeState, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    const candidateVersion = 'publisher-edge-retryable';
    edgeState.source = 'publisher_targeted_user_access';
    edgeState.sourceVersion = candidateVersion;
    const failure = Object.assign(new Error('MAX unavailable'), { response: { status: 503 } });
    maxClient.getChatMemberAccess.mockRejectedValueOnce(failure);

    await expect(
      service.refresh({
        ...job,
        candidateUserId: 'admin-retryable',
        candidateVersion,
        reason: 'stale_user_access',
      }),
    ).rejects.toBe(failure);
  });

  it('replays the original forwarded job as an ordinary refresh after the staged edge was granted', async () => {
    const { service, tx, edgeState, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    const candidateVersion = 'forwarded:completed-replay';
    edgeState.sourceVersion = candidateVersion;
    edgeState.source = 'publisher_targeted_user_access';
    edgeState.deniedReason = null;

    await service.refresh({
      ...job,
      candidateUserId: 'admin-replay',
      candidateVersion,
      requiresReadAccess: true,
      reason: 'forwarded_private',
    });

    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-replay',
      expect.objectContaining({ botId: 'publik_bot', trafficClass: 'interactive' }),
    );
    expect(tx.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ state: ManagedEntityAccessState.GRANTED }),
      }),
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

  it('records proven bot denial against an exact restaged granted candidate', async () => {
    const { service, prisma, edgeState } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    const candidateVersion = 'forwarded:restaged-granted';
    edgeState.sourceVersion = candidateVersion;
    edgeState.deniedReason = null;

    await service.refresh({
      ...job,
      candidateUserId: 'admin-restaged',
      candidateVersion,
      reason: 'forwarded_private',
    });

    expect(prisma.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceVersion: candidateVersion,
          source: { startsWith: 'publisher_actor_candidate_' },
        }),
        data: expect.objectContaining({
          state: ManagedEntityAccessState.BOT_DENIED,
          deniedReason: 'publisher_bot_missing_read_all_messages',
        }),
      }),
    );
  });

  it('does not overwrite or reply after a concurrent candidate grant wins a terminal race', async () => {
    const failure = Object.assign(new Error('missing'), { response: { status: 404 } });
    const { service, prisma, edgeState, maxClient } = createHarness(failure);
    const candidateVersion = 'forwarded:terminal-lost-race';
    edgeState.sourceVersion = candidateVersion;
    const stagedEdge = {
      deniedReason: 'publisher_actor_verification_pending',
      source: 'publisher_actor_candidate_forwarded',
      sourceVersion: candidateVersion,
    };
    prisma.managedEntityAccessEdge.findUnique
      .mockReset()
      .mockResolvedValueOnce(stagedEdge)
      .mockResolvedValueOnce(stagedEdge)
      .mockResolvedValueOnce({
        deniedReason: null,
        source: 'publisher_targeted_user_access',
        sourceVersion: candidateVersion,
      });
    prisma.managedEntityAccessEdge.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.refresh({
        ...job,
        candidateUserId: 'admin-terminal-race',
        candidateVersion,
        replyChatId: 'private-terminal-race',
        reason: 'forwarded_private',
      }),
    ).rejects.toBeInstanceOf(PublisherCandidateRefreshSupersededError);

    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
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
        lastWebhookAt: null,
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
      managedBotChatCatalog: {
        findMany: jest.fn().mockResolvedValue([{ chatId: 'chat-discovery' }]),
      },
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
    const compactScheduledBacklog = jest.fn().mockResolvedValue({
      scannedCount: 0,
      scheduledCount: 0,
      duplicateCount: 0,
      removedCount: 0,
      racedCount: 0,
      truncated: false,
    });
    const refreshQueue = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      compactScheduledBacklog,
    };
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
    await scheduler.onModuleInit();

    expect(compactScheduledBacklog).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith('startup');
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
          chatId: { in: ['chat-discovery'] },
          OR: expect.arrayContaining([
            {
              botAccessState: {
                in: [
                  ChatBotAccessState.CONFIRMED_MEMBER,
                  ChatBotAccessState.CONFIRMED_ADMIN,
                  ChatBotAccessState.CONFIRMED_OWNER,
                ],
              },
            },
            { lastWebhookAt: { not: null } },
          ]),
        }),
      }),
    );
    expect(prisma.managedBotChatCatalog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { botId: 'publik_bot', status: 'ACTIVE' },
        select: { chatId: true },
        take: 25,
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

  it('never discovers catalog-less UNKNOWN or LOST ghost bindings', async () => {
    const bindingFindMany = jest.fn().mockResolvedValue([]);
    const catalogFindMany = jest.fn().mockResolvedValue([]);
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new PublisherBindingRefreshSchedulerService(
      {
        publisherEntityBinding: { findMany: bindingFindMany },
        managedBotChatCatalog: { findMany: catalogFindMany },
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

    expect(catalogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { botId: 'publik_bot', status: 'ACTIVE' } }),
    );
    expect(bindingFindMany).toHaveBeenCalledTimes(1);
    expect(refreshQueue.enqueue).not.toHaveBeenCalled();
  });

  it('discovers confirmed and authenticated-webhook bindings only through exact active catalog rows', async () => {
    const catalogRows = [{ chatId: 'confirmed-chat' }, { chatId: 'webhook-chat' }];
    const bindingFindMany = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(catalogRows);
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new PublisherBindingRefreshSchedulerService(
      {
        managedBotChatCatalog: { findMany: jest.fn().mockResolvedValue(catalogRows) },
        publisherEntityBinding: { findMany: bindingFindMany },
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

    expect(bindingFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: { in: ['confirmed-chat', 'webhook-chat'] },
          OR: [
            {
              botAccessState: {
                in: [
                  ChatBotAccessState.CONFIRMED_MEMBER,
                  ChatBotAccessState.CONFIRMED_ADMIN,
                  ChatBotAccessState.CONFIRMED_OWNER,
                ],
              },
            },
            { lastWebhookAt: { not: null } },
          ],
        }),
      }),
    );
    expect(refreshQueue.enqueue.mock.calls.map(([request]) => request.chatId)).toEqual([
      'confirmed-chat',
      'webhook-chat',
    ]);
  });

  it('scans only the exact Publisher catalog and never creates candidate bindings', async () => {
    const userEdgeFindMany = jest.fn().mockResolvedValue([]);
    const catalogFindMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      $queryRaw: jest.fn(),
      managedBotChatCatalog: { findMany: catalogFindMany },
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
    expect(catalogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { botId: 'publik_bot', status: 'ACTIVE' },
        select: { chatId: true },
      }),
    );
    expect(prisma.publisherEntityBinding.findMany).toHaveBeenCalledTimes(1);
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
              OR: expect.arrayContaining([
                expect.objectContaining({
                  deniedReason: 'publisher_actor_verification_pending',
                  checkedAt: { lte: expect.any(Date) },
                  expiresAt: { gt: expect.any(Date) },
                }),
                expect.objectContaining({
                  createdAt: { gt: expect.any(Date) },
                  checkedAt: { lte: expect.any(Date) },
                  OR: [{ expiresAt: null }, { expiresAt: { lte: expect.any(Date) } }],
                }),
              ]),
            }),
          ]),
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({
                  chat: expect.objectContaining({
                    publisherBinding: {
                      is: expect.objectContaining({ publisherBotId: 'publik_bot' }),
                    },
                  }),
                }),
                expect.objectContaining({
                  source: 'publisher_actor_candidate_forwarded',
                  sourceVersion: { startsWith: 'forwarded:' },
                }),
              ]),
            }),
          ]),
        }),
        select: { chatId: true, userId: true, sourceVersion: true },
        take: 25,
      }),
    );
  });

  it('starts refresh early and bounds denied recovery by immutable actor evidence', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    try {
      const bindingFindMany = jest.fn().mockResolvedValue([]);
      const userEdgeFindMany = jest.fn().mockResolvedValue([]);
      const scheduler = new PublisherBindingRefreshSchedulerService(
        {
          managedBotChatCatalog: { findMany: jest.fn().mockResolvedValue([]) },
          publisherEntityBinding: { findMany: bindingFindMany },
          managedEntityAccessEdge: { findMany: userEdgeFindMany },
        } as never,
        { enqueue: jest.fn() } as never,
        { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
        { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
        { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
        { dispatchEnabled: true } as never,
        createBackgroundWork() as never,
        createHistoricalRecovery() as never,
      );

      await scheduler.scan('scheduled');

      const readyQuery = bindingFindMany.mock.calls[0]?.[0];
      expect(readyQuery.where.OR).toContainEqual({
        botAccessExpiresAt: { lte: new Date('2026-08-26T12:05:00.000Z') },
      });
      const edgeQuery = userEdgeFindMany.mock.calls[0]?.[0];
      const grantedBranch = edgeQuery.where.OR.find(
        (branch: { state?: ManagedEntityAccessState }) =>
          branch.state === ManagedEntityAccessState.GRANTED,
      );
      expect(grantedBranch.OR).toContainEqual({
        expiresAt: { lte: new Date('2026-08-27T00:00:00.000Z') },
      });
      const deniedBranch = edgeQuery.where.OR.find(
        (branch: { state?: { in?: ManagedEntityAccessState[] } }) =>
          branch.state?.in?.includes(ManagedEntityAccessState.USER_DENIED),
      );
      expect(deniedBranch.OR).toContainEqual(
        expect.objectContaining({
          createdAt: { gt: new Date('2026-07-27T12:00:00.000Z') },
          checkedAt: { lte: new Date('2026-08-26T06:00:00.000Z') },
        }),
      );
      expect(deniedBranch.OR).not.toContainEqual(
        expect.objectContaining({
          checkedAt: expect.objectContaining({ gt: expect.any(Date) }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('advances ready-binding and actor cursors across full pages under backlog', async () => {
    const readyPages = [
      Array.from({ length: 200 }, (_, index) => ({
        chatId: `ready-${String(index).padStart(3, '0')}`,
      })),
      Array.from({ length: 200 }, (_, index) => ({
        chatId: `ready-${String(index + 200).padStart(3, '0')}`,
      })),
      Array.from({ length: 5 }, (_, index) => ({
        chatId: `ready-${String(index + 400).padStart(3, '0')}`,
      })),
    ];
    const actorPages = [
      Array.from({ length: 25 }, (_, index) => ({
        chatId: `actor-${String(index).padStart(3, '0')}`,
        userId: 'admin-1',
        sourceVersion: 'edge-v1',
      })),
      Array.from({ length: 25 }, (_, index) => ({
        chatId: `actor-${String(index + 25).padStart(3, '0')}`,
        userId: 'admin-1',
        sourceVersion: 'edge-v1',
      })),
      Array.from({ length: 5 }, (_, index) => ({
        chatId: `actor-${String(index + 50).padStart(3, '0')}`,
        userId: 'admin-1',
        sourceVersion: 'edge-v1',
      })),
    ];
    const bindingFindMany = jest
      .fn()
      .mockResolvedValueOnce(readyPages[0])
      .mockResolvedValueOnce(readyPages[1])
      .mockResolvedValueOnce(readyPages[2]);
    const userEdgeFindMany = jest
      .fn()
      .mockResolvedValueOnce(actorPages[0])
      .mockResolvedValueOnce(actorPages[1])
      .mockResolvedValueOnce(actorPages[2]);
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new PublisherBindingRefreshSchedulerService(
      {
        managedBotChatCatalog: { findMany: jest.fn().mockResolvedValue([]) },
        publisherEntityBinding: { findMany: bindingFindMany },
        managedEntityAccessEdge: { findMany: userEdgeFindMany },
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
    await scheduler.scan('scheduled');
    await scheduler.scan('scheduled');

    expect(bindingFindMany.mock.calls.map(([query]) => query.where.chatId ?? null)).toEqual([
      null,
      { gt: 'ready-199' },
      { gt: 'ready-399' },
    ]);
    const actorCursorGroups = userEdgeFindMany.mock.calls.map(([query]) => query.where.AND[1]);
    expect(actorCursorGroups).toEqual([
      undefined,
      {
        OR: [{ chatId: { gt: 'actor-024' } }, { chatId: 'actor-024', userId: { gt: 'admin-1' } }],
      },
      {
        OR: [{ chatId: { gt: 'actor-049' } }, { chatId: 'actor-049', userId: { gt: 'admin-1' } }],
      },
    ]);
    expect(new Set(refreshQueue.enqueue.mock.calls.map(([request]) => request.chatId))).toEqual(
      new Set([
        ...readyPages.flat().map((row) => row.chatId),
        ...actorPages.flat().map((row) => row.chatId),
      ]),
    );
  });

  it('prioritizes an expiring ready binding and cools down 2500 fresh LOST rows', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    try {
      const freshLost = Array.from({ length: 2_500 }, (_, index) => ({
        chatId: `lost-${String(index).padStart(4, '0')}`,
      }));
      const ready = {
        chatId: 'ready-expiring',
        botAccessExpiresAt: new Date('2026-08-26T12:01:00.000Z'),
      };
      const findMany = jest.fn(
        async (query: {
          where: {
            chatId?: { in?: string[] };
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
          expect(lostBranch?.OR).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ botAccessCheckedAt: { lte: expect.any(Date) } }),
            ]),
          );
          return [];
        },
      );
      const catalogFindMany = jest
        .fn()
        .mockResolvedValue(freshLost.slice(0, 25).map(({ chatId }) => ({ chatId })));
      const prisma = {
        managedBotChatCatalog: { findMany: catalogFindMany },
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
        expect(query.where.OR).toEqual(expect.arrayContaining([{ lastWebhookAt: { not: null } }]));
        expect(query.where.OR).not.toContainEqual({ lastSeenAt: { not: null } });
        expect(query.where.chatId?.in).toEqual(freshLost.slice(0, 25).map((row) => row.chatId));
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
      expect(catalogFindMany).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('advances the disconnected discovery cursor across repeated scans', async () => {
    const eligible = Array.from({ length: 60 }, (_, index) => ({
      chatId: `lost-${String(index).padStart(3, '0')}`,
    }));
    const discoveryCursors: Array<string | null> = [];
    const catalogFindMany = jest.fn(
      async (query: {
        where: {
          chatId?: { gt?: string };
        };
        take: number;
      }) => {
        const cursor = query.where.chatId?.gt ?? null;
        discoveryCursors.push(cursor);
        return eligible.filter((row) => !cursor || row.chatId > cursor).slice(0, query.take);
      },
    );
    const bindingFindMany = jest.fn(
      async (query: { where: { chatId?: { in?: string[] } } }) =>
        query.where.chatId?.in?.map((chatId) => ({ chatId })) ?? [],
    );
    const prisma = {
      managedBotChatCatalog: { findMany: catalogFindMany },
      publisherEntityBinding: { findMany: bindingFindMany },
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
    expect(bindingFindMany).toHaveBeenCalledTimes(6);
  });

  it('keeps enabled refresh timers idle before identity, DB, or queue work while paused', async () => {
    jest.useFakeTimers();
    try {
      const prisma = {
        managedBotChatCatalog: { findMany: jest.fn().mockResolvedValue([]) },
        publisherEntityBinding: { findMany: jest.fn().mockResolvedValue([]) },
        managedEntityAccessEdge: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const refreshQueue = {
        enqueue: jest.fn(),
        compactScheduledBacklog: jest.fn().mockResolvedValue({
          scannedCount: 0,
          scheduledCount: 0,
          duplicateCount: 0,
          removedCount: 0,
          racedCount: 0,
          truncated: false,
        }),
      };
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
      expect(prisma.publisherEntityBinding.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.managedBotChatCatalog.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledTimes(1);
      scheduler.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
