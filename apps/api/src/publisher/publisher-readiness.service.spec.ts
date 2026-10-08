import { ConfigService } from '@nestjs/config';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';
import {
  PublisherReadinessService,
  type PublisherReadinessSource,
} from './publisher-readiness.service';

function createService(
  options: {
    source?: PublisherReadinessSource | null;
    runtimeAvailable?: boolean;
    enqueue?: jest.Mock;
  } = {},
) {
  return new PublisherReadinessService(
    {
      chat: { findUnique: jest.fn().mockResolvedValue(options.source ?? null) },
    } as never,
    {
      read: jest.fn().mockResolvedValue({
        dispatchEnabled: options.runtimeAvailable ?? true,
      }),
    } as never,
    {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'MAX_PUBLISHER_BOT_ID') return 'publik-bot';
        if (key === 'MAX_PUBLISHER_DISPATCH_ENABLED') return true;
        return fallback;
      }),
    } as unknown as ConfigService,
    options.enqueue ? ({ enqueue: options.enqueue } as never) : undefined,
  );
}

function readySource(overrides: Partial<PublisherReadinessSource> = {}): PublisherReadinessSource {
  const now = Date.now();
  return {
    id: 'chat-1',
    entityType: ChatEntityType.CHAT,
    publicationPolicy: null,
    publisherSettings: {
      chatCommentsEnabled: true,
      channelCommentsEnabled: false,
      channelSuggestionsEnabled: false,
      autoRepliesEnabled: true,
    },
    publisherBinding: {
      publisherBotId: 'publik-bot',
      status: ChatBotMembershipStatus.ACTIVE,
      lastWebhookAt: new Date(now - 1_000),
      permissionsSnapshot: {
        checkedAt: new Date(now - 1_000).toISOString(),
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
        permissionsKnown: true,
      },
      botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
      botAccessCheckedAt: new Date(now - 1_000),
      botAccessExpiresAt: new Date(now + 60_000),
      sendRouteQuarantinedUntil: null,
    },
    ...overrides,
  };
}

describe('PublisherReadinessService', () => {
  it.each(['write', ' \tCaN\tWrItE\n ', 'Post-Edit-Delete-Messages'])(
    'accepts confirmed Publisher admin write permission %j without legacy snapshot role flags',
    (permission) => {
      const source = readySource();
      source.publisherBinding!.permissionsSnapshot = {
        permissionsKnown: true,
        permissions: [permission],
      };
      expect(createService().resolveReadiness(source, { runtimeAvailable: true })).toMatchObject({
        state: 'ready',
        canPublish: true,
      });
    },
  );

  it('does not let a write-only legacy snapshot promote a confirmed member', () => {
    const source = readySource();
    source.publisherBinding!.botAccessState = ChatBotAccessState.CONFIRMED_MEMBER;
    source.publisherBinding!.permissionsSnapshot = {
      permissionsKnown: true,
      permissions: ['write'],
    };
    expect(createService().resolveReadiness(source, { runtimeAvailable: true })).toMatchObject({
      state: 'setup_required',
      canPublish: false,
      blockerCode: 'bot_not_admin',
    });
  });

  it('keeps known missing write dormant after snapshot expiry without nominating renewal', async () => {
    const source = readySource();
    source.publisherBinding!.permissionsSnapshot = {
      isAdmin: true,
      isOwner: false,
      permissionsKnown: true,
      permissions: ['read_all_messages'],
    };
    source.publisherBinding!.botAccessExpiresAt = new Date(Date.now() - 60_000);
    const enqueue = jest.fn();
    const service = createService({ source, enqueue });
    const result = await service.getEntityReadiness(source.id);
    expect(result.readiness.blockerCode).toBe('write_permission_missing');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('nominates one exact-bot refresh while an expired positive snapshot still blocks send', async () => {
    const source = readySource();
    source.publisherBinding!.botAccessExpiresAt = new Date(Date.now() - 1);
    const enqueue = jest.fn().mockResolvedValue('refresh-1');
    const service = createService({ source, enqueue });
    await expect(service.assertEntityReady(source.id, 'publication')).rejects.toMatchObject({
      blockerCode: 'bot_access_expired',
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: source.id,
        publisherBotId: 'publik-bot',
        reason: 'publication_due',
      }),
    );
    expect(service.resolveReadiness(source, { runtimeAvailable: true })).toMatchObject({
      state: 'temporarily_unavailable',
      canPublish: false,
      blockerCode: 'bot_access_expired',
      retryAt: expect.any(String),
    });
  });

  it.each(['denied', 'removed', 'disabled', 'quarantined', 'runtime_down'] as const)(
    'never nominates a stale positive probe across %s boundary',
    async (boundary) => {
      const source = readySource();
      source.publisherBinding!.botAccessExpiresAt = new Date(Date.now() - 1);
      if (boundary === 'denied')
        source.publisherBinding!.botAccessState = ChatBotAccessState.DENIED;
      if (boundary === 'removed') source.publisherBinding!.status = ChatBotMembershipStatus.REMOVED;
      if (boundary === 'disabled')
        source.publicationPolicy = { publikEnabled: false, revision: 1, updatedAt: new Date() };
      if (boundary === 'quarantined')
        source.publisherBinding!.sendRouteQuarantinedUntil = new Date(Date.now() + 60_000);
      const enqueue = jest.fn();
      const service = createService({
        source,
        enqueue,
        runtimeAvailable: boundary !== 'runtime_down',
      });
      await expect(service.assertEntityReady(source.id, 'publication')).rejects.toThrow();
      expect(enqueue).not.toHaveBeenCalled();
      if (boundary === 'denied')
        expect(service.resolveReadiness(source)).toMatchObject({
          state: 'setup_required',
          blockerCode: 'bot_not_admin',
          retryAt: null,
        });
    },
  );

  it('preserves the stale blocker when Redis nomination fails', async () => {
    const source = readySource();
    source.publisherBinding!.botAccessExpiresAt = new Date(Date.now() - 1);
    const service = createService({
      source,
      enqueue: jest.fn().mockRejectedValue(new Error('redis offline')),
    });
    await expect(service.assertEntityReady(source.id, 'publication')).rejects.toMatchObject({
      blockerCode: 'bot_access_expired',
    });
  });

  it('does not promise automatic renewal for an expired unknown access verdict', async () => {
    const source = readySource();
    source.publisherBinding!.botAccessState = ChatBotAccessState.UNKNOWN;
    source.publisherBinding!.botAccessExpiresAt = new Date(Date.now() - 1);
    const enqueue = jest.fn();
    const service = createService({ source, enqueue });
    await expect(service.assertEntityReady(source.id, 'publication')).rejects.toMatchObject({
      blockerCode: 'bot_access_unconfirmed',
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(service.resolveReadiness(source)).toMatchObject({
      state: 'setup_required',
      blockerCode: 'bot_access_unconfirmed',
      retryAt: null,
    });
  });

  it('reports ready only with fresh access and a live runtime', () => {
    expect(
      createService().resolveReadiness(readySource(), { runtimeAvailable: true }),
    ).toMatchObject({ state: 'ready', canPublish: true, canUseChatComments: true });
  });

  it('can evaluate an enablement against transport readiness without circular policy blocking', () => {
    const source = readySource({
      publicationPolicy: {
        publikEnabled: false,
        revision: 2,
        updatedAt: new Date(),
      },
    });
    const service = createService();

    expect(service.resolveReadiness(source, { runtimeAvailable: true })).toMatchObject({
      state: 'disabled',
      canPublish: false,
    });
    expect(
      service.resolveReadiness(source, {
        runtimeAvailable: true,
        assumePolicyEnabled: true,
      }),
    ).toMatchObject({ state: 'ready', canPublish: true });
  });

  it('does not let the enablement override bypass a missing write permission', () => {
    const source = readySource({
      publicationPolicy: {
        publikEnabled: false,
        revision: 2,
        updatedAt: new Date(),
      },
    });
    if (source.publisherBinding) {
      source.publisherBinding.permissionsSnapshot = {
        checkedAt: new Date().toISOString(),
        isAdmin: true,
        isOwner: false,
        permissions: [],
        permissionsKnown: true,
      };
    }

    expect(
      createService().resolveReadiness(source, {
        runtimeAvailable: true,
        assumePolicyEnabled: true,
      }),
    ).toMatchObject({
      state: 'setup_required',
      canPublish: false,
      blockerCode: 'write_permission_missing',
    });
  });

  it('does not accept partial admin permissions when MAX marks them unknown', () => {
    const source = readySource();
    if (source.publisherBinding) {
      source.publisherBinding.permissionsSnapshot = {
        checkedAt: new Date().toISOString(),
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
        permissionsKnown: false,
      };
    }

    expect(createService().resolveReadiness(source, { runtimeAvailable: true })).toMatchObject({
      state: 'setup_required',
      canPublish: false,
      blockerCode: 'bot_access_unconfirmed',
    });
  });

  it('does not accept a legacy admin snapshot without explicit permission completeness', () => {
    const source = readySource();
    if (source.publisherBinding) {
      source.publisherBinding.permissionsSnapshot = {
        checkedAt: new Date().toISOString(),
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      };
    }

    expect(createService().resolveReadiness(source, { runtimeAvailable: true })).toMatchObject({
      state: 'setup_required',
      canPublish: false,
      blockerCode: 'bot_access_unconfirmed',
    });
  });

  it('keeps a confirmed owner ready when granular permissions are unknown', () => {
    const source = readySource();
    if (source.publisherBinding) {
      source.publisherBinding.botAccessState = ChatBotAccessState.CONFIRMED_OWNER;
      source.publisherBinding.permissionsSnapshot = {
        checkedAt: new Date().toISOString(),
        isAdmin: true,
        isOwner: true,
        permissions: [],
        permissionsKnown: false,
      };
    }

    expect(createService().resolveReadiness(source, { runtimeAvailable: true })).toMatchObject({
      state: 'ready',
      canPublish: true,
    });
  });

  it('fails closed when the publisher runtime is unavailable', () => {
    expect(
      createService().resolveReadiness(readySource(), { runtimeAvailable: false }),
    ).toMatchObject({
      state: 'temporarily_unavailable',
      blockerCode: 'publisher_runtime_unavailable',
      canPublish: false,
    });
  });

  it('does not accept confirmed access without an expiry', () => {
    const source = readySource();
    if (source.publisherBinding) source.publisherBinding.botAccessExpiresAt = null;
    expect(createService().resolveReadiness(source, { runtimeAvailable: true })).toMatchObject({
      state: 'setup_required',
      blockerCode: 'bot_access_unconfirmed',
    });
  });

  it('keeps approved suggestion publishing opt-in and channel-only', () => {
    const source = readySource({
      entityType: ChatEntityType.CHANNEL,
      publicationPolicy: {
        publikEnabled: true,
        revision: 2,
        updatedAt: new Date(),
      },
      publisherSettings: {
        chatCommentsEnabled: false,
        channelCommentsEnabled: true,
        channelSuggestionsEnabled: true,
        autoRepliesEnabled: false,
      },
    });
    expect(createService().resolveReadiness(source, { runtimeAvailable: true })).toMatchObject({
      canPublish: true,
      canUseChatComments: false,
      canUseChannelComments: true,
      canPublishSuggestions: true,
    });
  });

  it('checks the maximum publication audience with one database query and one heartbeat read', async () => {
    const sources = Array.from({ length: 500 }, (_, index) => readySource({ id: `chat-${index}` }));
    const findMany = jest.fn().mockResolvedValue(sources);
    const findUnique = jest.fn();
    const read = jest.fn().mockResolvedValue({ dispatchEnabled: true });
    const service = new PublisherReadinessService(
      { chat: { findMany, findUnique } } as never,
      { read } as never,
      {
        get: jest.fn((key: string, fallback?: unknown) => {
          if (key === 'MAX_PUBLISHER_BOT_ID') return 'publik-bot';
          if (key === 'MAX_PUBLISHER_DISPATCH_ENABLED') return true;
          return fallback;
        }),
      } as unknown as ConfigService,
    );

    const routes = await service.assertTargetsReady(
      sources.map((source) => ({ chatId: source.id, entityType: 'chat' })),
    );

    expect(routes).toHaveLength(500);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: sources.map((source) => source.id) } },
      }),
    );
    expect(findUnique).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'chat comments',
      'chat_comments' as const,
      readySource({
        publisherSettings: {
          chatCommentsEnabled: false,
          channelCommentsEnabled: false,
          channelSuggestionsEnabled: false,
          autoRepliesEnabled: false,
        },
      }),
    ],
    [
      'auto replies',
      'auto_replies' as const,
      readySource({
        publisherSettings: {
          chatCommentsEnabled: false,
          channelCommentsEnabled: false,
          channelSuggestionsEnabled: false,
          autoRepliesEnabled: false,
        },
      }),
    ],
    [
      'channel suggestions',
      'suggestion_publish' as const,
      readySource({
        entityType: ChatEntityType.CHANNEL,
        publisherSettings: {
          chatCommentsEnabled: false,
          channelCommentsEnabled: false,
          channelSuggestionsEnabled: false,
          autoRepliesEnabled: false,
        },
      }),
    ],
    [
      'channel comments',
      'channel_comments' as const,
      readySource({
        entityType: ChatEntityType.CHANNEL,
        publisherSettings: {
          chatCommentsEnabled: false,
          channelCommentsEnabled: false,
          channelSuggestionsEnabled: true,
          autoRepliesEnabled: false,
        },
      }),
    ],
  ])('rejects disabled %s without disabling Publisher posting', async (_label, feature, source) => {
    const service = createService({ source, runtimeAvailable: true });

    expect(service.resolveReadiness(source, { runtimeAvailable: true })).toMatchObject({
      state: 'ready',
      canPublish: true,
    });
    await expect(service.assertEntityReady(source.id, feature)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'PUBLISHER_SETUP_REQUIRED',
        blockerCode: 'module_disabled',
      }),
    });
    await expect(service.assertEntityReady(source.id, 'publication')).resolves.toMatchObject({
      chatId: source.id,
      requiredBotId: 'publik-bot',
    });
  });
});
