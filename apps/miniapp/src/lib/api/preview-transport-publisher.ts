import {
  decodePublisherEntitiesCursor,
  encodePublisherEntitiesCursor,
  MAX_PUBLISHER_BULK_REFRESH_TARGETS,
  managedEntityPublicationPolicySchema,
  PUBLISHER_ENTITIES_CURSOR_INVALID_CODE,
  publisherEntitiesCursorQuerySchema,
  publisherEntitiesCursorResponseSchema,
  publisherEntitiesRefreshResponseSchema,
  publisherEntitiesResponseSchema,
  publisherEntitySchema,
  publisherEntityModuleSettingsSchema,
  publisherEntityRefreshResponseSchema,
  publisherSuggestionSchema,
  publisherSuggestionsResponseSchema,
  reviewPublisherSuggestionRequestSchema,
  reviewPublisherSuggestionResponseSchema,
  resolvePublisherEntitiesRequestSchema,
  resolvePublisherEntitiesResponseSchema,
  updateManagedEntityPublicationPolicyRequestSchema,
  updatePublisherEntityModuleSettingsRequestSchema,
  type ManagedEntityPublicationPolicy,
  type ManagedEntityType,
  type PublisherChatCommentSettings,
  type PublisherEntity,
  type PublisherSuggestion,
} from '@maxim/contracts/publisher';
import { PREVIEW_CHAT_ID } from '../design-preview';
import { ApiRequestError } from '../api-request-error';
import { PREVIEW_NOT_HANDLED, type PreviewRequestHandler } from './preview-transport-runtime';
import { parseJsonBody } from './preview-transport-shared';
import type { PreviewState } from './preview-transport-state';

function getPreviewPublisherPolicies(
  state: PreviewState,
): Record<string, ManagedEntityPublicationPolicy> {
  const extended = state as PreviewState & {
    publisherPolicies?: Record<string, ManagedEntityPublicationPolicy>;
  };
  extended.publisherPolicies ??= {};
  return extended.publisherPolicies;
}

function getPreviewPublisherRefreshes(state: PreviewState): Record<string, string> {
  const extended = state as PreviewState & {
    publisherRefreshes?: Record<string, string>;
  };
  extended.publisherRefreshes ??= {};
  return extended.publisherRefreshes;
}

function getPreviewPublisherChatComments(
  state: PreviewState,
): Record<string, PublisherChatCommentSettings> {
  const extended = state as PreviewState & {
    publisherChatComments?: Record<string, PublisherChatCommentSettings>;
  };
  extended.publisherChatComments ??= {};
  return extended.publisherChatComments;
}

function getPreviewPublisherModuleRevisions(state: PreviewState): Record<string, number> {
  const extended = state as PreviewState & { publisherModuleRevisions?: Record<string, number> };
  extended.publisherModuleRevisions ??= {};
  return extended.publisherModuleRevisions;
}

function getPreviewPublisherChannelSuggestions(state: PreviewState): Record<string, boolean> {
  const extended = state as PreviewState & {
    publisherChannelSuggestions?: Record<string, boolean>;
  };
  extended.publisherChannelSuggestions ??= {};
  return extended.publisherChannelSuggestions;
}

function getPreviewPublisherSuggestionReviews(
  state: PreviewState,
): Record<string, PublisherSuggestion['reviewStatus']> {
  const extended = state as PreviewState & {
    publisherSuggestionReviews?: Record<string, PublisherSuggestion['reviewStatus']>;
  };
  extended.publisherSuggestionReviews ??= {};
  return extended.publisherSuggestionReviews;
}

function listPreviewPublisherSuggestions(
  state: PreviewState,
  entityId: string,
): PublisherSuggestion[] {
  const count =
    state.publisherSuggestionsVariant === 'large'
      ? 100
      : state.publisherSuggestionsVariant === 'mixed'
        ? 8
        : 0;
  const reviews = getPreviewPublisherSuggestionReviews(state);
  return Array.from({ length: count }, (_, index) => {
    const id = `preview-suggestion-${entityId}-${String(index + 1).padStart(3, '0')}`;
    const initialStatus: PublisherSuggestion['reviewStatus'] =
      index < Math.ceil(count * 0.35)
        ? 'pending'
        : index < Math.ceil(count * 0.4)
          ? 'publishing'
          : index % 2 === 0
            ? 'published'
            : 'cancelled';
    const reviewStatus = reviews[id] ?? initialStatus;
    return publisherSuggestionSchema.parse({
      id,
      text: `Идея для публикации №${index + 1}: важная новость сообщества с проверенными деталями.`,
      authorDisplayName: index % 4 === 0 ? null : `Автор ${index + 1}`,
      createdAt: new Date(state.clock.now().getTime() - index * 12 * 60_000).toISOString(),
      reviewStatus,
      publicationId: reviewStatus === 'published' ? `preview-publication-${index + 1}` : null,
    });
  });
}

function buildPreviewPublisherEntity(
  state: PreviewState,
  entityType: ManagedEntityType,
  entityId: string,
): PublisherEntity | null {
  const source = (entityType === 'channel' ? state.channels : state.chats).find(
    (item) => item.id === entityId,
  );
  if (!source) {
    return null;
  }
  const policy =
    getPreviewPublisherPolicies(state)[`${entityType}:${entityId}`] ??
    managedEntityPublicationPolicySchema.parse({
      publikEnabled: true,
      revision: 0,
      updatedAt: null,
    });
  const entityKey = `${entityType}:${entityId}`;
  const refreshedAt = getPreviewPublisherRefreshes(state)[entityKey] ?? null;
  const checkedAt = refreshedAt ?? state.clock.now().toISOString();
  const setupBlocker =
    !refreshedAt && state.publisherPolicyVariant === 'setup' && entityId === PREVIEW_CHAT_ID
      ? 'bot_not_admin'
      : !refreshedAt && entityId === 'preview-chat-2'
        ? 'write_permission_missing'
        : null;
  const runtimeUnavailable = entityId === 'preview-channel-2';
  const readiness = !policy.publikEnabled
    ? {
        state: 'disabled' as const,
        canPublish: false,
        canUseChatComments: false,
        canPublishSuggestions: false,
        blockerCode: 'policy_disabled' as const,
        checkedAt,
        retryAt: null,
      }
    : setupBlocker
      ? {
          state: 'setup_required' as const,
          canPublish: false,
          canUseChatComments: false,
          canPublishSuggestions: false,
          blockerCode: setupBlocker,
          checkedAt: null,
          retryAt: null,
        }
      : runtimeUnavailable
        ? {
            state: 'temporarily_unavailable' as const,
            canPublish: false,
            canUseChatComments: false,
            canPublishSuggestions: false,
            blockerCode: 'publisher_runtime_unavailable' as const,
            checkedAt,
            retryAt: null,
          }
        : {
            state: 'ready' as const,
            canPublish: true,
            canUseChatComments:
              entityType === 'chat' &&
              getPreviewPublisherChatComments(state)[entityId]?.commentsEnabled === true,
            canPublishSuggestions:
              entityType === 'channel' &&
              getPreviewPublisherChannelSuggestions(state)[entityId] === true,
            blockerCode: null,
            checkedAt,
            retryAt: null,
          };
  return publisherEntitySchema.parse({
    id: source.id,
    title: source.title,
    entityType,
    avatarUrl: source.avatarUrl ?? null,
    entityUrl: `https://max.ru/join/${encodeURIComponent(source.id)}`,
    policy,
    moduleSettings: {
      revision: getPreviewPublisherModuleRevisions(state)[entityKey] ?? 0,
      chatComments:
        entityType === 'chat'
          ? (getPreviewPublisherChatComments(state)[entityId] ?? {
              commentsEnabled: false,
              commentsAdminsEnabled: false,
              commentsChatBroadcastsEnabled: false,
            })
          : null,
      channelSuggestionsEnabled:
        entityType === 'channel'
          ? (getPreviewPublisherChannelSuggestions(state)[entityId] ?? false)
          : null,
    },
    readiness,
  });
}

function listPreviewPublisherEntities(state: PreviewState): PublisherEntity[] {
  const baseItems = [
    ...state.chats.map((item) => buildPreviewPublisherEntity(state, 'chat', item.id)),
    ...state.channels.map((item) => buildPreviewPublisherEntity(state, 'channel', item.id)),
  ].filter((item): item is PublisherEntity => item !== null);
  if (state.publisherEntitiesVariant === 'empty') {
    return [];
  }
  if (state.publisherEntitiesVariant === 'channel-only') {
    return baseItems.filter((item) => item.entityType === 'channel');
  }
  if (state.publisherEntitiesVariant !== 'large') {
    return baseItems;
  }
  return Array.from({ length: 400 }, (_, index) => {
    const source = baseItems[index % baseItems.length]!;
    return {
      ...source,
      id: `${source.id}-large-${String(index + 1).padStart(3, '0')}`,
      title: `${source.title} ${index + 1}`,
    };
  });
}

function summarizePreviewPublisherEntities(entities: readonly PublisherEntity[]) {
  const chat = entities.filter((entity) => entity.entityType === 'chat').length;
  const ready = entities.filter((entity) => entity.readiness.canPublish).length;
  return {
    total: entities.length,
    chat,
    channel: entities.length - chat,
    ready,
    attention: entities.length - ready,
  };
}

function listPreviewPublisherEntitiesPage(state: PreviewState, url: URL) {
  const query = publisherEntitiesCursorQuerySchema.parse(
    Object.fromEntries(url.searchParams.entries()),
  );
  const entities = listPreviewPublisherEntities(state);
  const normalizedQuery = query.query.toLocaleLowerCase('ru-RU');
  const filtered = entities.filter(
    (entity) =>
      (!query.entityType || entity.entityType === query.entityType) &&
      (!query.readiness ||
        (query.readiness === 'ready'
          ? entity.readiness.canPublish
          : !entity.readiness.canPublish)) &&
      (!normalizedQuery ||
        `${entity.title} ${entity.id}`.toLocaleLowerCase('ru-RU').includes(normalizedQuery)),
  );
  const cursor = query.cursor ? decodePublisherEntitiesCursor(query.cursor) : null;
  if (
    query.cursor &&
    (!cursor ||
      cursor.query !== query.query ||
      cursor.entityType !== (query.entityType ?? null) ||
      cursor.readiness !== (query.readiness ?? null))
  ) {
    throw new ApiRequestError(
      400,
      JSON.stringify({ code: PUBLISHER_ENTITIES_CURSOR_INVALID_CODE }),
      'Invalid publisher entities cursor',
    );
  }
  const startIndex = cursor?.offset ?? 0;
  if (cursor && startIndex >= filtered.length) {
    throw new ApiRequestError(
      400,
      JSON.stringify({ code: PUBLISHER_ENTITIES_CURSOR_INVALID_CODE }),
      'Invalid publisher entities cursor',
    );
  }
  const items = filtered.slice(startIndex, startIndex + query.limit);
  const hasMore = startIndex + items.length < filtered.length;
  const last = items.at(-1);

  return publisherEntitiesCursorResponseSchema.parse({
    items,
    nextCursor:
      hasMore && last
        ? encodePublisherEntitiesCursor({
            v: 1,
            snapshotId: cursor?.snapshotId ?? 'preview_snapshot',
            offset: startIndex + items.length,
            query: query.query,
            entityType: query.entityType ?? null,
            readiness: query.readiness ?? null,
          })
        : null,
    filteredTotal: filtered.length,
    summary: summarizePreviewPublisherEntities(entities),
  });
}

export const handlePublisherPreviewRequest: PreviewRequestHandler = ({
  state,
  url,
  segments,
  method,
  init,
}) => {
  if (url.pathname === '/publisher/entities' && method === 'GET') {
    if (state.publisherEntitiesVariant === 'error') {
      throw new ApiRequestError(503, '', 'Preview publisher entities unavailable');
    }
    return url.searchParams.get('pagination') === 'cursor'
      ? listPreviewPublisherEntitiesPage(state, url)
      : publisherEntitiesResponseSchema.parse({
          items: listPreviewPublisherEntities(state),
        });
  }
  if (url.pathname === '/publisher/entities/refresh' && method === 'POST') {
    const entities = listPreviewPublisherEntities(state).slice(
      0,
      MAX_PUBLISHER_BULK_REFRESH_TARGETS,
    );
    const refreshedAt = new Date(state.clock.now().getTime() + 1).toISOString();
    const refreshes = getPreviewPublisherRefreshes(state);
    for (const entity of entities) {
      refreshes[`${entity.entityType}:${entity.id}`] = refreshedAt;
    }
    return publisherEntitiesRefreshResponseSchema.parse({
      accepted: true,
      queuedCount: entities.length,
    });
  }
  if (url.pathname === '/publisher/entities/resolve' && method === 'POST') {
    const request = resolvePublisherEntitiesRequestSchema.parse(parseJsonBody(init));
    const entitiesByKey = new Map(
      listPreviewPublisherEntities(state).map((entity) => [
        `${entity.entityType}:${entity.id}`,
        entity,
      ]),
    );
    return resolvePublisherEntitiesResponseSchema.parse({
      items: [
        ...new Map(
          request.targets.map((target) => [`${target.entityType}:${target.id}`, target]),
        ).values(),
      ].flatMap((target) => {
        const entity = entitiesByKey.get(`${target.entityType}:${target.id}`);
        return entity ? [entity] : [];
      }),
    });
  }
  if (
    segments[0] !== 'publisher' ||
    segments[1] !== 'entities' ||
    (segments[2] !== 'chat' && segments[2] !== 'channel') ||
    !segments[3]
  ) {
    return PREVIEW_NOT_HANDLED;
  }

  const entityType = segments[2];
  const entityId = decodeURIComponent(segments[3]);
  if (
    state.publisherPolicyVariant === 'error' &&
    method === 'GET' &&
    (segments.length === 4 || (segments.length === 5 && segments[4] === 'policy'))
  ) {
    throw new ApiRequestError(503, '', 'Preview publisher policy unavailable');
  }
  const entity = buildPreviewPublisherEntity(state, entityType, entityId);
  if (!entity) {
    throw new ApiRequestError(404, '', 'Preview publisher entity not found');
  }
  if (segments.length === 4 && method === 'GET') {
    return entity;
  }
  if (segments.length === 5 && segments[4] === 'policy' && method === 'GET') {
    return entity.policy;
  }
  if (segments.length === 5 && segments[4] === 'refresh' && method === 'POST') {
    const refreshes = getPreviewPublisherRefreshes(state);
    const entityKey = `${entityType}:${entityId}`;
    const previousRefreshMs = Date.parse(refreshes[entityKey] ?? '');
    const requestedAtMs = state.clock.now().getTime();
    refreshes[entityKey] = new Date(
      Math.max(
        requestedAtMs + 1,
        Number.isFinite(previousRefreshMs) ? previousRefreshMs + 1 : requestedAtMs + 1,
      ),
    ).toISOString();
    return publisherEntityRefreshResponseSchema.parse({ accepted: true });
  }
  if (
    entityType === 'channel' &&
    segments.length === 5 &&
    segments[4] === 'suggestions' &&
    method === 'GET'
  ) {
    return publisherSuggestionsResponseSchema.parse({
      items: listPreviewPublisherSuggestions(state, entityId),
    });
  }
  if (
    entityType === 'channel' &&
    segments.length === 7 &&
    segments[4] === 'suggestions' &&
    segments[5] &&
    segments[6] === 'review' &&
    method === 'POST'
  ) {
    const request = reviewPublisherSuggestionRequestSchema.parse(parseJsonBody(init));
    const suggestionId = decodeURIComponent(segments[5]);
    const suggestion = listPreviewPublisherSuggestions(state, entityId).find(
      (item) => item.id === suggestionId,
    );
    if (!suggestion) {
      throw new ApiRequestError(404, '', 'Preview publisher suggestion not found');
    }
    const reviewStatus = request.action === 'publish' ? 'published' : 'cancelled';
    getPreviewPublisherSuggestionReviews(state)[suggestionId] = reviewStatus;
    return reviewPublisherSuggestionResponseSchema.parse({
      suggestion: {
        ...suggestion,
        reviewStatus,
        publicationId:
          reviewStatus === 'published'
            ? `preview-publication-${encodeURIComponent(suggestionId)}`
            : null,
      },
    });
  }
  if (segments[4] === 'policy' && method === 'PATCH') {
    const request = updateManagedEntityPublicationPolicyRequestSchema.parse(parseJsonBody(init));
    const policy = managedEntityPublicationPolicySchema.parse({
      ...entity.policy,
      ...(request.publikEnabled !== undefined ? { publikEnabled: request.publikEnabled } : {}),
      revision: entity.policy.revision + 1,
      updatedAt: state.clock.now().toISOString(),
    });
    getPreviewPublisherPolicies(state)[`${entityType}:${entityId}`] = policy;
    return policy;
  }
  if (segments[4] === 'modules' && method === 'PATCH') {
    const request = updatePublisherEntityModuleSettingsRequestSchema.parse(parseJsonBody(init));
    if (entityType === 'chat' && request.chatComments) {
      getPreviewPublisherChatComments(state)[entityId] = request.chatComments;
    }
    if (entityType === 'channel' && request.channelSuggestionsEnabled !== undefined) {
      getPreviewPublisherChannelSuggestions(state)[entityId] = request.channelSuggestionsEnabled;
    }
    const revision = entity.moduleSettings.revision + 1;
    getPreviewPublisherModuleRevisions(state)[`${entityType}:${entityId}`] = revision;
    return publisherEntityModuleSettingsSchema.parse({
      revision,
      chatComments:
        entityType === 'chat'
          ? (getPreviewPublisherChatComments(state)[entityId] ?? entity.moduleSettings.chatComments)
          : null,
      channelSuggestionsEnabled:
        entityType === 'channel'
          ? (getPreviewPublisherChannelSuggestions(state)[entityId] ?? false)
          : null,
    });
  }
  return PREVIEW_NOT_HANDLED;
};
