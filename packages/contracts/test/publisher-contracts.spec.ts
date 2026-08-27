import { describe, expect, it } from 'vitest';
import { meSchema } from '../src/core.js';
import { MAX_PUBLICATION_TARGETS } from '../src/publication.js';
import {
  MAX_PUBLISHER_BULK_REFRESH_TARGETS,
  MAX_PUBLISHER_ENTITY_RESOLVE_TARGETS,
  decodePublisherEntitiesCursor,
  encodePublisherEntitiesCursor,
  publisherEntitiesCursorQuerySchema,
  publisherEntitiesCursorResponseSchema,
  publisherEntitiesRefreshResponseSchema,
  publisherEntitiesResponseSchema,
  publisherEntityRefreshResponseSchema,
  resolvePublisherEntitiesRequestSchema,
  resolvePublisherEntitiesResponseSchema,
  updateManagedEntityPublicationPolicyRequestSchema,
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
      homeRoute: '/publications',
    });

    expect(me).toMatchObject({
      profile: 'publisher',
      homeRoute: '/publications',
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
            suggestionsViaPublik: false,
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
      settingsHandoffUrl: null,
    });
  });

  it('accepts nullable publisher navigation links and validates URL values', () => {
    const entity = {
      id: 'chat-1',
      title: 'Команда',
      entityType: 'chat',
      entityUrl: 'https://max.ru/team',
      settingsHandoffUrl: 'https://max.ru/entry_bot?startapp=mr-route',
      policy: {
        publikEnabled: true,
        suggestionsViaPublik: false,
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
      settingsHandoffUrl: entity.settingsHandoffUrl,
    });
    expect(
      publisherEntitiesResponseSchema.safeParse({
        items: [{ ...entity, entityUrl: 'not-a-url' }],
      }).success,
    ).toBe(false);
  });

  it('keeps the legacy entity-list response compatible while retaining cursor metadata', () => {
    expect(publisherEntitiesResponseSchema.parse({ items: [] })).toEqual({
      items: [],
      setupHandoffUrl: null,
    });

    const cursorResponse = publisherEntitiesCursorResponseSchema.parse({
      items: [],
      setupHandoffUrl: 'https://max.ru/entry-bot?startapp=mr-home',
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

  it('requires an optimistic revision and at least one policy change', () => {
    expect(
      updateManagedEntityPublicationPolicyRequestSchema.safeParse({ expectedRevision: 0 }).success,
    ).toBe(false);
    expect(
      updateManagedEntityPublicationPolicyRequestSchema.parse({
        expectedRevision: 2,
        publikEnabled: false,
      }),
    ).toEqual({ expectedRevision: 2, publikEnabled: false });
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
});
