import { describe, expect, it } from 'vitest';
import { meSchema } from '../src/core.js';
import { MAX_PUBLICATION_TARGETS } from '../src/publication.js';
import {
  MAX_PUBLISHER_BULK_REFRESH_TARGETS,
  MAX_PUBLISHER_ENTITY_RESOLVE_TARGETS,
  MAX_PUBLISHER_SUGGESTIONS_CURSOR_LENGTH,
  decodePublisherEntitiesCursor,
  encodePublisherEntitiesCursor,
  publisherEntitiesCursorQuerySchema,
  publisherEntitiesCursorResponseSchema,
  publisherEntitiesRefreshResponseSchema,
  publisherEntitiesResponseSchema,
  publisherEntityRefreshResponseSchema,
  publisherEntitySchema,
  publisherPostImportCreateRequestSchema,
  publisherPostImportCurrentResponseSchema,
  publisherPostImportSessionSchema,
  publisherSuggestionSchema,
  publisherSuggestionsQuerySchema,
  publisherSuggestionsResponseSchema,
  reviewPublisherSuggestionRequestSchema,
  resolvePublisherEntitiesRequestSchema,
  resolvePublisherEntitiesResponseSchema,
  updateManagedEntityPublicationPolicyRequestSchema,
  updatePublisherEntityModuleSettingsRequestSchema,
} from '../src/publisher.js';
import { systemRuntimeProfileSchema } from '../src/system-core.js';

describe('publisher contracts', () => {
  it('keeps draft hydration bounded to the publication target ceiling', () => {
    expect(MAX_PUBLISHER_ENTITY_RESOLVE_TARGETS).toBe(MAX_PUBLICATION_TARGETS);
  });

  it('projects a publisher mini app profile without bot identity details', () => {
    const me = meSchema.parse({
      userId: '42',
      username: null,
      displayName: null,
      profile: 'publisher',
      capabilities: ['publisher_workspace', 'publisher_entities', 'chat_comments'],
      homeRoute: '/',
    });

    expect(me).toMatchObject({
      profile: 'publisher',
      homeRoute: '/',
    });
    expect(me).not.toHaveProperty('launchBotId');
  });

  it('keeps readiness and policy explicit for every publisher target', () => {
    const response = publisherEntitiesResponseSchema.parse({
      items: [
        {
          id: 'channel-1',
          title: 'Новости',
          entityType: 'channel',
          policy: {
            publikEnabled: true,
            revision: 0,
            updatedAt: null,
          },
          readiness: {
            state: 'setup_required',
            canPublish: false,
            canUseChatComments: false,
            canPublishSuggestions: false,
            blockerCode: 'bot_not_connected',
            checkedAt: null,
            retryAt: null,
          },
        },
      ],
    });

    expect(response.items[0]?.readiness.blockerCode).toBe('bot_not_connected');
    expect(response.items[0]).toMatchObject({
      avatarUrl: null,
      entityUrl: null,
      moduleSettings: {
        revision: 0,
        chatComments: null,
        autoRepliesEnabled: null,
        channelCommentsEnabled: null,
        channelSuggestionsEnabled: null,
      },
    });
  });

  it('preserves the source text format for publisher suggestion previews', () => {
    const suggestion = publisherSuggestionSchema.parse({
      id: 'suggestion-1',
      text: '**Первая строка\n\nВторая строка**',
      textFormat: 'markdown',
      authorDisplayName: 'Читатель',
      createdAt: '2026-08-27T10:00:00.000Z',
      reviewStatus: 'pending',
      publicationId: null,
      reviewError: 'Маршрут Публика временно недоступен.',
    });

    expect(suggestion.textFormat).toBe('markdown');
    expect(suggestion.imageCount).toBe(0);
    expect(suggestion.reviewError).toBe('Маршрут Публика временно недоступен.');
    expect(publisherSuggestionSchema.safeParse({ ...suggestion, textFormat: 'html' }).success).toBe(
      false,
    );
    expect(publisherSuggestionSchema.safeParse({ ...suggestion, imageCount: 11 }).success).toBe(
      false,
    );
  });

  it('negotiates the versioned Publisher suggestion review response', () => {
    expect(reviewPublisherSuggestionRequestSchema.parse({ action: 'publish' })).toEqual({
      action: 'publish',
    });
    expect(
      reviewPublisherSuggestionRequestSchema.parse({ action: 'publish', responseVersion: 2 }),
    ).toEqual({ action: 'publish', responseVersion: 2 });
    expect(
      reviewPublisherSuggestionRequestSchema.parse({ action: 'draft', responseVersion: 2 }),
    ).toEqual({ action: 'draft', responseVersion: 2 });
    expect(reviewPublisherSuggestionRequestSchema.safeParse({ action: 'send' }).success).toBe(
      false,
    );
  });

  it('keeps drafted suggestions in an explicit terminal state with their Publication id', () => {
    expect(
      publisherSuggestionSchema.parse({
        id: 'suggestion-drafted',
        text: 'Материал для редактора',
        textFormat: 'plain',
        authorDisplayName: 'Читатель',
        createdAt: '2026-09-01T10:00:00.000Z',
        reviewStatus: 'drafted',
        publicationId: 'publication-draft-1',
      }),
    ).toEqual(
      expect.objectContaining({
        reviewStatus: 'drafted',
        publicationId: 'publication-draft-1',
      }),
    );
  });

  it('defaults publisher suggestions to a bounded pending page', () => {
    expect(publisherSuggestionsQuerySchema.parse({})).toEqual({
      view: 'pending',
      limit: 25,
    });
    expect(
      publisherSuggestionsQuerySchema.parse({
        view: 'history',
        limit: '100',
        cursor: ' next_cursor ',
      }),
    ).toEqual({
      view: 'history',
      limit: 100,
      cursor: 'next_cursor',
    });
    expect(publisherSuggestionsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(
      publisherSuggestionsQuerySchema.safeParse({
        cursor: 'x'.repeat(MAX_PUBLISHER_SUGGESTIONS_CURSOR_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(publisherSuggestionsQuerySchema.safeParse({ view: 'all' }).success).toBe(false);
  });

  it('requires exact server totals and a bounded next cursor for suggestion pages', () => {
    expect(
      publisherSuggestionsResponseSchema.parse({
        items: [],
        total: 121,
        nextCursor: 'next_cursor',
      }),
    ).toEqual({ items: [], total: 121, nextCursor: 'next_cursor' });
    expect(
      publisherSuggestionsResponseSchema.safeParse({ items: [], nextCursor: null }).success,
    ).toBe(false);
    expect(
      publisherSuggestionsResponseSchema.safeParse({
        items: [],
        total: 0,
        nextCursor: null,
        pendingTotal: 0,
      }).success,
    ).toBe(false);
  });

  it('keeps Publik-owned chat comment module settings separate from Major presentation data', () => {
    const entity = publisherEntitySchema.parse({
      id: 'chat-1',
      title: 'Команда',
      entityType: 'chat',
      policy: {
        publikEnabled: true,
        revision: 3,
        updatedAt: null,
      },
      moduleSettings: {
        revision: 2,
        chatComments: {
          commentsEnabled: true,
          commentsAdminsEnabled: false,
          commentsChatBroadcastsEnabled: true,
        },
        autoRepliesEnabled: true,
        channelCommentsEnabled: null,
        channelSuggestionsEnabled: null,
      },
      readiness: {
        state: 'ready',
        canPublish: true,
        canUseChatComments: true,
        canUseChannelComments: false,
        canPublishSuggestions: false,
        blockerCode: null,
        checkedAt: null,
        retryAt: null,
      },
    });

    expect(entity.moduleSettings.chatComments).toEqual({
      commentsEnabled: true,
      commentsAdminsEnabled: false,
      commentsChatBroadcastsEnabled: true,
    });
    expect(entity.moduleSettings.autoRepliesEnabled).toBe(true);
    expect(entity).not.toHaveProperty('settingsHandoffUrl');
    expect(entity).not.toHaveProperty('channelOverview');
  });

  it('accepts exact Publisher presentation links and rejects Major-owned fields', () => {
    const entity = {
      id: 'chat-1',
      title: 'Команда',
      entityType: 'chat',
      entityUrl: 'https://max.ru/team',
      policy: {
        publikEnabled: true,
        revision: 0,
        updatedAt: null,
      },
      readiness: {
        state: 'ready',
        canPublish: true,
        canUseChatComments: true,
        canPublishSuggestions: false,
        blockerCode: null,
        checkedAt: null,
        retryAt: null,
      },
    };

    expect(publisherEntitiesResponseSchema.parse({ items: [entity] }).items[0]).toMatchObject({
      entityUrl: entity.entityUrl,
    });
    expect(
      publisherEntitiesResponseSchema.safeParse({
        items: [{ ...entity, entityUrl: 'not-a-url' }],
      }).success,
    ).toBe(false);
    expect(
      publisherEntitiesResponseSchema.safeParse({
        items: [{ ...entity, settingsHandoffUrl: 'https://max.ru/major' }],
      }).success,
    ).toBe(false);
    expect(
      publisherEntitiesResponseSchema.safeParse({
        items: [{ ...entity, channelOverview: null }],
      }).success,
    ).toBe(false);
  });

  it('keeps entity-list cursor metadata without a Major setup handoff', () => {
    expect(publisherEntitiesResponseSchema.parse({ items: [] })).toEqual({ items: [] });

    const cursorResponse = publisherEntitiesCursorResponseSchema.parse({
      items: [],
      nextCursor: null,
      filteredTotal: 2,
      summary: {
        total: 4,
        chat: 3,
        channel: 1,
        ready: 2,
        attention: 2,
      },
    });

    expect(publisherEntitiesResponseSchema.parse(cursorResponse)).toEqual(cursorResponse);
  });

  it('validates and normalizes publisher entity cursor queries', () => {
    expect(
      publisherEntitiesCursorQuerySchema.parse({
        pagination: 'cursor',
        limit: '100',
        query: '  Новости  ',
        entityType: 'channel',
        readiness: 'attention',
      }),
    ).toEqual({
      pagination: 'cursor',
      limit: 100,
      query: 'Новости',
      entityType: 'channel',
      readiness: 'attention',
    });
    expect(publisherEntitiesCursorQuerySchema.parse({ pagination: 'cursor' })).toMatchObject({
      limit: 30,
      query: '',
    });
    expect(
      publisherEntitiesCursorQuerySchema.safeParse({ pagination: 'cursor', limit: 101 }).success,
    ).toBe(false);
    expect(
      publisherEntitiesCursorQuerySchema.safeParse({
        pagination: 'cursor',
        query: 'x'.repeat(121),
      }).success,
    ).toBe(false);
    expect(
      publisherEntitiesCursorQuerySchema.safeParse({
        pagination: 'cursor',
        readiness: 'disabled',
      }).success,
    ).toBe(false);
  });

  it('round-trips an opaque cursor bound to publisher entity filters', () => {
    const payload = {
      v: 1 as const,
      snapshotId: 'snapshot_42',
      offset: 30,
      query: 'новости',
      entityType: 'channel' as const,
      readiness: 'ready' as const,
    };
    const cursor = encodePublisherEntitiesCursor(payload);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(cursor).not.toContain('snapshot_42');
    expect(decodePublisherEntitiesCursor(cursor)).toEqual(payload);
    expect(decodePublisherEntitiesCursor('not-json')).toBeNull();
    expect(decodePublisherEntitiesCursor(`${cursor}!`)).toBeNull();
  });

  it('keeps Major policy and Publisher module mutations separate', () => {
    expect(
      updateManagedEntityPublicationPolicyRequestSchema.safeParse({ expectedRevision: 0 }).success,
    ).toBe(false);
    expect(
      updateManagedEntityPublicationPolicyRequestSchema.parse({
        expectedRevision: 2,
        publikEnabled: false,
      }),
    ).toEqual({ expectedRevision: 2, publikEnabled: false });
    expect(
      updatePublisherEntityModuleSettingsRequestSchema.parse({
        channelCommentsEnabled: true,
        expectedRevision: 4,
        chatComments: {
          commentsEnabled: true,
          commentsAdminsEnabled: true,
          commentsChatBroadcastsEnabled: false,
        },
      }),
    ).toEqual({
      channelCommentsEnabled: true,
      expectedRevision: 4,
      chatComments: {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsChatBroadcastsEnabled: false,
      },
    });
    expect(
      updateManagedEntityPublicationPolicyRequestSchema.safeParse({
        expectedRevision: 4,
        chatComments: {
          commentsEnabled: true,
          commentsAdminsEnabled: true,
          commentsChatBroadcastsEnabled: false,
        },
      }).success,
    ).toBe(false);
  });

  it('keeps an accepted publisher refresh response free of routing details', () => {
    expect(publisherEntityRefreshResponseSchema.parse({ accepted: true })).toEqual({
      accepted: true,
    });
    expect(
      publisherEntityRefreshResponseSchema.safeParse({
        accepted: true,
        publisherBotId: 'publik-bot',
      }).success,
    ).toBe(false);
  });

  it('bounds bulk publisher refresh without exposing entity or bot routing details', () => {
    expect(
      publisherEntitiesRefreshResponseSchema.parse({ accepted: true, queuedCount: 12 }),
    ).toEqual({ accepted: true, queuedCount: 12 });
    expect(
      publisherEntitiesRefreshResponseSchema.safeParse({
        accepted: true,
        queuedCount: MAX_PUBLISHER_BULK_REFRESH_TARGETS + 1,
      }).success,
    ).toBe(false);
    expect(
      publisherEntitiesRefreshResponseSchema.safeParse({
        accepted: true,
        queuedCount: 1,
        publisherBotId: 'publik-bot',
      }).success,
    ).toBe(false);
  });

  it('bounds exact publisher entity hydration without accepting extra routing data', () => {
    expect(
      resolvePublisherEntitiesRequestSchema.parse({
        targets: [{ id: 'chat-1', entityType: 'chat' }],
      }),
    ).toEqual({ targets: [{ id: 'chat-1', entityType: 'chat' }] });
    expect(
      resolvePublisherEntitiesRequestSchema.safeParse({
        targets: [{ id: 'chat-1', entityType: 'chat', botId: 'main-bot' }],
      }).success,
    ).toBe(false);
    expect(resolvePublisherEntitiesResponseSchema.parse({ items: [] })).toEqual({ items: [] });
  });

  it('accepts the isolated publisher runtime profile', () => {
    expect(
      systemRuntimeProfileSchema.parse({
        appRole: 'publisher',
        serviceName: 'api-publisher',
        queueProfile: 'publisher-dispatch',
        queuePriority: 'publisher-dispatch',
        httpEnabled: false,
        ingressEnabled: false,
        adminEnabled: false,
        enqueueEnabled: false,
        moderationEnabled: false,
        actionEnabled: false,
        publisherEnabled: true,
        enabledQueues: [],
        dynamicLeasesMode: 'off',
        dynamicLeasesWorkerGroup: null,
        canaryShardIds: [],
        targetWebhookP95Ms: 400,
        generatedAt: '2026-08-26T00:00:00.000Z',
      }).publisherEnabled,
    ).toBe(true);
  });

  it('keeps publisher post import identity and state responses bounded', () => {
    expect(publisherPostImportCreateRequestSchema.parse({ requestId: 'import_123456' })).toEqual({
      requestId: 'import_123456',
    });
    expect(publisherPostImportCreateRequestSchema.safeParse({ requestId: 'short' }).success).toBe(
      false,
    );

    const session = publisherPostImportSessionSchema.parse({
      id: 'session-1',
      status: 'ready',
      expiresAt: '2026-08-29T12:00:00.000Z',
      publicationId: 'publication-1',
      botUrl: null,
      failureCode: null,
      omissions: ['buttons_not_imported', 'attachments_not_imported'],
    });
    expect(session.status).toBe('ready');
    expect(session.omissions).toEqual(['buttons_not_imported', 'attachments_not_imported']);
    expect(publisherPostImportCurrentResponseSchema.parse({ session })).toEqual({ session });
    expect(publisherPostImportCurrentResponseSchema.parse({ session: null })).toEqual({
      session: null,
    });
    expect(
      publisherPostImportSessionSchema.safeParse({
        ...session,
        sourceMessageId: 'must-not-leak',
      }).success,
    ).toBe(false);
  });
});
