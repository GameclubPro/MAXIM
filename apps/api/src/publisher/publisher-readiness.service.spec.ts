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
      channelSuggestionsEnabled: false,
      autoRepliesEnabled: true,
    },
    publisherBinding: {
      publisherBotId: 'publik-bot',
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: new Date(now - 1_000).toISOString(),
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
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
  it('reports ready only with fresh access and a live runtime', () => {
    expect(
      createService().resolveReadiness(readySource(), { runtimeAvailable: true }),
    ).toMatchObject({ state: 'ready', canPublish: true, canUseChatComments: true });
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
        channelSuggestionsEnabled: true,
        autoRepliesEnabled: false,
      },
    });
    expect(createService().resolveReadiness(source, { runtimeAvailable: true })).toMatchObject({
      canPublish: true,
      canUseChatComments: false,
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
          channelSuggestionsEnabled: false,
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
  });
});
