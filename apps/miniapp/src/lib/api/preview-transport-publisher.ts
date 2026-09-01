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
  publisherPostImportCreateRequestSchema,
  publisherPostImportCurrentResponseSchema,
  publisherPostImportSessionSchema,
  publisherSuggestionSchema,
  publisherSuggestionsQuerySchema,
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
import {
  archivePublisherAutoReplyRequestSchema,
  archivePublisherAutoReplyResponseSchema,
  createPublisherAutoReplyAuthoringSessionRequestSchema,
  createPublisherAutoReplyRequestSchema,
  publisherAutoReplyAuthoringSessionCurrentResponseSchema,
  publisherAutoReplyAuthoringSessionResponseSchema,
  publisherAutoReplyListResponseSchema,
  publisherAutoReplyRuleSchema,
  updatePublisherAutoReplyRequestSchema,
  type PublisherAutoReplyAuthoringSession,
  type PublisherAutoReplyContentInput,
  type PublisherAutoReplyRule,
} from '@maxim/contracts/publisher-auto-replies';
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

function getPreviewPublisherAutoRepliesEnabled(state: PreviewState): Record<string, boolean> {
  const extended = state as PreviewState & {
    publisherAutoRepliesEnabled?: Record<string, boolean>;
  };
  extended.publisherAutoRepliesEnabled ??= {};
  return extended.publisherAutoRepliesEnabled;
}

function getPreviewPublisherAutoReplies(
  state: PreviewState,
): Record<string, PublisherAutoReplyRule[]> {
  const extended = state as PreviewState & {
    publisherAutoReplies?: Record<string, PublisherAutoReplyRule[]>;
  };
  extended.publisherAutoReplies ??= {};
  return extended.publisherAutoReplies;
}

function getPreviewPublisherAutoReplyAuthoring(
  state: PreviewState,
): Record<string, PublisherAutoReplyAuthoringSession | null> {
  const extended = state as PreviewState & {
    publisherAutoReplyAuthoring?: Record<string, PublisherAutoReplyAuthoringSession | null>;
  };
  extended.publisherAutoReplyAuthoring ??= {};
  return extended.publisherAutoReplyAuthoring;
}

function buildPreviewAutoReplyAssetBlob(): Blob {
  const binary = globalThis.atob(
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwAgMAAAAqbBEUAAAADFBMVEXC6f6k0/Oz3/iTx+5Xsu0OAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABbElEQVQoz2NgYGB6wAABsgxIIAxMMs0AU7PAJH8ImDIHk3t0gASvgzzDBKCqgyJAjtiOKwxXGBhYhTIYChjMt+cxbGBg0PsiwOjCILv1GEiLMU8AUwgD49VckFmPeQ4wRDAwsM8DcnYeuuwAUsB+HUg8buAGWyDqxMDAuFZFBcyxBcpz51qYgDnqQA4ne9IVhGN/p6vA2YzuoRIMDAkQDr9f0wYGJg8IR7/h9AEGpgCojJY3kFSAcPTWNiAMY70H9BGMY+sBZa8A4h1QQfZwB4Rys1UTwCEFVheUsQUiytvAwHRAKx3C4WRgYL4mwgnhAJWJNzBog5gcIOJyU/MNBj2o2xvjby1n2M3AwAVSeG3p0nugSNkKcrJ6bdQUkGAQOAxkF4LEuFWlwMbXgkhuhygkPzClIXEkvBEcZj9giC+AcpiuTUFwGEQTGJi7kJIAUwZyggD5khFZgBWhEOxFBmQ+wlSQthQIrcDAAADorEXVKBtnwAAAAABJRU5ErkJggg==',
  );
  return new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], {
    type: 'image/png',
  });
}

function listPreviewPublisherAutoReplies(
  state: PreviewState,
  chatId: string,
): PublisherAutoReplyRule[] {
  const store = getPreviewPublisherAutoReplies(state);
  store[chatId] ??= [
    publisherAutoReplyRuleSchema.parse({
      id: `preview-auto-reply-${chatId}-1`,
      chatId,
      phrase: 'Прайс',
      enabled: true,
      cooldownSeconds: 30,
      version: 1,
      currentContentRevisionId: `preview-auto-reply-content-${chatId}-1`,
      content: {
        id: `preview-auto-reply-content-${chatId}-1`,
        revision: 1,
        text: '**Актуальный прайс** уже готов. Напишите администратору, если нужна помощь.',
        textFormat: 'markdown',
        images: [
          {
            id: `preview-auto-reply-asset-${chatId}-1`,
            mimeType: 'image/png',
            fileName: 'price.png',
            sizeBytes: 68,
            previewUrl: `/publisher/entities/chat/${encodeURIComponent(chatId)}/auto-replies/preview-auto-reply-${encodeURIComponent(chatId)}-1/assets/preview-auto-reply-asset-${encodeURIComponent(chatId)}-1`,
          },
        ],
        buttons: [
          {
            text: 'Открыть прайс',
            url: 'https://max.ru/publik_preview_bot',
            row: 0,
          },
        ],
        createdAt: state.clock.now().toISOString(),
      },
      createdByUserId: 'preview-user',
      updatedByUserId: 'preview-user',
      createdAt: state.clock.now().toISOString(),
      updatedAt: state.clock.now().toISOString(),
      archivedAt: null,
    }),
  ];
  return store[chatId];
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
    const textFormat: PublisherSuggestion['textFormat'] = index === 0 ? 'markdown' : 'plain';
    return publisherSuggestionSchema.parse({
      id,
      text:
        textFormat === 'markdown'
          ? `**Идея для публикации №${index + 1}\n\nВажная новость сообщества с проверенными деталями.**`
          : `Идея для публикации №${index + 1}: важная новость сообщества с проверенными деталями.`,
      textFormat,
      authorDisplayName: index % 4 === 0 ? null : `Автор ${index + 1}`,
      createdAt: new Date(state.clock.now().getTime() - index * 12 * 60_000).toISOString(),
      reviewStatus,
      publicationId: reviewStatus === 'published' ? `preview-publication-${index + 1}` : null,
    });
  });
}

const PREVIEW_PUBLISHER_SUGGESTIONS_CURSOR_PATTERN = /^preview_(pending|history)_([1-9]\d*)$/u;

function encodePreviewPublisherSuggestionsCursor(
  view: 'pending' | 'history',
  offset: number,
): string {
  return `preview_${view}_${offset}`;
}

function decodePreviewPublisherSuggestionsCursor(
  value: string,
): { view: 'pending' | 'history'; offset: number } | null {
  const match = PREVIEW_PUBLISHER_SUGGESTIONS_CURSOR_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const offset = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isSafeInteger(offset) || offset < 1) {
    return null;
  }
  return { view: match[1] as 'pending' | 'history', offset };
}

function listPreviewPublisherSuggestionsPage(state: PreviewState, entityId: string, url: URL) {
  const query = publisherSuggestionsQuerySchema.parse(
    Object.fromEntries(url.searchParams.entries()),
  );
  const suggestions = listPreviewPublisherSuggestions(state, entityId).filter((suggestion) => {
    const pending =
      suggestion.reviewStatus === 'pending' || suggestion.reviewStatus === 'publishing';
    return query.view === 'pending' ? pending : !pending;
  });
  const cursor = query.cursor ? decodePreviewPublisherSuggestionsCursor(query.cursor) : null;
  if (
    query.cursor &&
    (!cursor || cursor.view !== query.view || cursor.offset >= suggestions.length)
  ) {
    throw new ApiRequestError(400, '', 'Invalid preview publisher suggestions cursor');
  }
  const startIndex = cursor?.offset ?? 0;
  const items = suggestions.slice(startIndex, startIndex + query.limit);
  const nextOffset = startIndex + items.length;

  return publisherSuggestionsResponseSchema.parse({
    items,
    total: suggestions.length,
    nextCursor:
      nextOffset < suggestions.length
        ? encodePreviewPublisherSuggestionsCursor(query.view, nextOffset)
        : null,
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
      publikEnabled: state.publisherPolicyVariant !== 'permission',
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
  const channelSuggestionsEnabled =
    entityType === 'channel' &&
    (getPreviewPublisherChannelSuggestions(state)[entityId] ??
      state.publisherSuggestionsVariant !== 'empty');
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
            canPublishSuggestions: channelSuggestionsEnabled,
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
      autoRepliesEnabled:
        entityType === 'chat'
          ? (getPreviewPublisherAutoRepliesEnabled(state)[entityId] ?? true)
          : null,
      channelSuggestionsEnabled: entityType === 'channel' ? channelSuggestionsEnabled : null,
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

function buildPreviewPublisherAutoReplyContent(
  state: PreviewState,
  chatId: string,
  ruleId: string,
  revision: number,
  input: PublisherAutoReplyContentInput,
  previous: PublisherAutoReplyRule['content'] | null,
): PublisherAutoReplyRule['content'] {
  const previousAssets = new Map(previous?.images.map((asset) => [asset.id, asset]) ?? []);
  const images = input.images.map((image, index) => {
    if (image.type === 'image-ref') {
      const retained = previousAssets.get(image.assetId);
      if (!retained) {
        throw new ApiRequestError(400, '', 'Preview auto-reply asset not found');
      }
      return retained;
    }
    const id = `preview-auto-reply-asset-${ruleId}-${revision}-${index + 1}`;
    return {
      id,
      mimeType: image.mimeType,
      fileName: image.fileName,
      sizeBytes: Math.max(1, Math.floor((image.base64.length * 3) / 4)),
      previewUrl: `/publisher/entities/chat/${encodeURIComponent(chatId)}/auto-replies/${encodeURIComponent(ruleId)}/assets/${encodeURIComponent(id)}`,
    };
  });
  return {
    id: `preview-auto-reply-content-${ruleId}-${revision}`,
    revision,
    text: input.text,
    textFormat: input.textFormat,
    images,
    buttons: input.buttons,
    createdAt: state.clock.now().toISOString(),
  };
}

export const handlePublisherPreviewRequest: PreviewRequestHandler = ({
  state,
  url,
  segments,
  method,
  init,
}) => {
  if (url.pathname === '/publisher/post-imports' && method === 'POST') {
    publisherPostImportCreateRequestSchema.parse(parseJsonBody(init));
    const session = publisherPostImportSessionSchema.parse({
      id: 'preview-import-session-123456',
      status: 'waiting',
      expiresAt: new Date(state.clock.now().getTime() + 10 * 60_000).toISOString(),
      publicationId: null,
      botUrl: 'https://max.ru/se14088825_bot?start=pi_preview_import_token_123456',
      failureCode: null,
      omissions: [],
    });
    state.publisherPostImportSession = session;
    return session;
  }
  if (
    (url.pathname === '/publisher/post-imports/active' ||
      url.pathname === '/publisher/post-imports') &&
    method === 'GET'
  ) {
    return publisherPostImportCurrentResponseSchema.parse({
      session: state.publisherPostImportSession,
    });
  }
  if (
    segments[0] === 'publisher' &&
    segments[1] === 'post-imports' &&
    segments[2] === 'by-token' &&
    segments[3] &&
    segments.length === 4 &&
    method === 'GET'
  ) {
    return publisherPostImportCurrentResponseSchema.parse({
      session:
        decodeURIComponent(segments[3]) === 'preview_import_token_123456'
          ? state.publisherPostImportSession
          : null,
    });
  }
  if (url.pathname === '/publisher/post-imports' && method === 'DELETE') {
    if (!state.publisherPostImportSession) {
      throw new ApiRequestError(404, '', 'Preview publisher import not found');
    }
    const session = publisherPostImportSessionSchema.parse({
      ...state.publisherPostImportSession,
      status: 'canceled',
      publicationId: null,
      botUrl: null,
      failureCode: null,
    });
    state.publisherPostImportSession = null;
    return session;
  }
  if (
    segments[0] === 'publisher' &&
    segments[1] === 'post-imports' &&
    segments[2] &&
    segments[3] === 'assets' &&
    segments[4] &&
    segments.length === 5 &&
    method === 'GET'
  ) {
    const session = state.publisherPostImportSession;
    const publication = session?.publicationId
      ? state.publications.find((item) => item.id === session.publicationId)
      : null;
    const assetId = decodeURIComponent(segments[4]);
    if (
      !session ||
      session.status !== 'ready' ||
      session.id !== decodeURIComponent(segments[2]) ||
      !publication?.content.media.some((asset) => asset.id === assetId && asset.type === 'image')
    ) {
      throw new ApiRequestError(404, '', 'Preview publisher import asset not found');
    }
    const binary = globalThis.atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    );
    return new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], {
      type: 'image/png',
    });
  }
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
  if (entityType === 'chat' && segments[4] === 'auto-replies') {
    const rules = listPreviewPublisherAutoReplies(state, entityId);
    if (segments.length === 5 && method === 'GET') {
      return publisherAutoReplyListResponseSchema.parse({ items: rules, total: rules.length });
    }
    if (segments.length === 5 && method === 'POST') {
      const request = createPublisherAutoReplyRequestSchema.parse(parseJsonBody(init));
      const ruleId = `preview-auto-reply-${entityId}-${rules.length + 1}`;
      const content = buildPreviewPublisherAutoReplyContent(
        state,
        entityId,
        ruleId,
        1,
        request.content,
        null,
      );
      const rule = publisherAutoReplyRuleSchema.parse({
        id: ruleId,
        chatId: entityId,
        phrase: request.phrase,
        enabled: request.enabled,
        cooldownSeconds: request.cooldownSeconds,
        version: 1,
        currentContentRevisionId: content.id,
        content,
        createdByUserId: 'preview-user',
        updatedByUserId: 'preview-user',
        createdAt: state.clock.now().toISOString(),
        updatedAt: state.clock.now().toISOString(),
        archivedAt: null,
      });
      rules.unshift(rule);
      return rule;
    }
    if (segments[5] === 'authoring-sessions') {
      const sessions = getPreviewPublisherAutoReplyAuthoring(state);
      if (segments.length === 6 && method === 'POST') {
        createPublisherAutoReplyAuthoringSessionRequestSchema.parse(parseJsonBody(init));
        const session = {
          id: `preview-auto-reply-authoring-${entityId}`,
          state: 'awaiting_start' as const,
          targetChatId: entityId,
          phrase: null,
          ruleId: null,
          contentRevisionId: null,
          expiresAt: new Date(state.clock.now().getTime() + 15 * 60_000).toISOString(),
        };
        sessions[entityId] = session;
        return publisherAutoReplyAuthoringSessionResponseSchema.parse({
          session,
          botUrl: `https://max.ru/publik_preview_bot?start=ar_${encodeURIComponent(entityId)}`,
        });
      }
      if (segments.length === 7 && segments[6] === 'current' && method === 'GET') {
        const session = sessions[entityId] ?? null;
        return publisherAutoReplyAuthoringSessionCurrentResponseSchema.parse({
          session,
          botUrl: session
            ? `https://max.ru/publik_preview_bot?start=ar_${encodeURIComponent(entityId)}`
            : null,
        });
      }
      if (segments.length === 7 && segments[6] === 'current' && method === 'DELETE') {
        sessions[entityId] = null;
        return publisherAutoReplyAuthoringSessionCurrentResponseSchema.parse({
          session: null,
          botUrl: null,
        });
      }
    }
    if (
      segments.length === 8 &&
      segments[5] &&
      segments[6] === 'assets' &&
      segments[7] &&
      method === 'GET'
    ) {
      const rule = rules.find((item) => item.id === decodeURIComponent(segments[5]));
      const assetId = decodeURIComponent(segments[7]);
      if (!rule?.content.images.some((asset) => asset.id === assetId)) {
        throw new ApiRequestError(404, '', 'Preview auto-reply asset not found');
      }
      return buildPreviewAutoReplyAssetBlob();
    }
    if (segments.length === 6 && segments[5] && method === 'PATCH') {
      const ruleId = decodeURIComponent(segments[5]);
      const index = rules.findIndex((item) => item.id === ruleId);
      const current = rules[index];
      if (!current) {
        throw new ApiRequestError(404, '', 'Preview auto-reply not found');
      }
      const request = updatePublisherAutoReplyRequestSchema.parse(parseJsonBody(init));
      if (request.expectedVersion !== current.version) {
        throw new ApiRequestError(409, '', 'Preview auto-reply version conflict');
      }
      const version = current.version + 1;
      const content = request.content
        ? buildPreviewPublisherAutoReplyContent(
            state,
            entityId,
            ruleId,
            current.content.revision + 1,
            request.content,
            current.content,
          )
        : current.content;
      const updated = publisherAutoReplyRuleSchema.parse({
        ...current,
        ...(request.phrase !== undefined ? { phrase: request.phrase } : {}),
        ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
        ...(request.cooldownSeconds !== undefined
          ? { cooldownSeconds: request.cooldownSeconds }
          : {}),
        version,
        currentContentRevisionId: content.id,
        content,
        updatedAt: state.clock.now().toISOString(),
      });
      rules[index] = updated;
      return updated;
    }
    if (segments.length === 6 && segments[5] && method === 'DELETE') {
      const ruleId = decodeURIComponent(segments[5]);
      const index = rules.findIndex((item) => item.id === ruleId);
      const current = rules[index];
      if (!current) {
        throw new ApiRequestError(404, '', 'Preview auto-reply not found');
      }
      const request = archivePublisherAutoReplyRequestSchema.parse(parseJsonBody(init));
      if (request.expectedVersion !== current.version) {
        throw new ApiRequestError(409, '', 'Preview auto-reply version conflict');
      }
      rules.splice(index, 1);
      return archivePublisherAutoReplyResponseSchema.parse({
        id: current.id,
        archived: true,
        version: current.version + 1,
        archivedAt: state.clock.now().toISOString(),
      });
    }
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
    return listPreviewPublisherSuggestionsPage(state, entityId, url);
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
    const reviewStatus = request.action === 'publish' ? 'publishing' : 'cancelled';
    getPreviewPublisherSuggestionReviews(state)[suggestionId] = reviewStatus;
    return reviewPublisherSuggestionResponseSchema.parse({
      suggestion: {
        ...suggestion,
        reviewStatus,
        publicationId: null,
      },
    });
  }
  if (segments[4] === 'policy' && method === 'PATCH') {
    const request = updateManagedEntityPublicationPolicyRequestSchema.parse(parseJsonBody(init));
    if (state.publisherPolicyVariant === 'permission' && request.publikEnabled === true) {
      throw new ApiRequestError(
        409,
        JSON.stringify({
          statusCode: 409,
          code: 'BOT_CAPABILITY_REQUIRED',
          missingPermissions: [],
          featureKeys: ['publikEnabled'],
          checkedAt: null,
          blockerCode: 'bot_access_unconfirmed',
          stale: true,
          canRecheck: true,
        }),
        'Права Публика пока не подтверждены.',
      );
    }
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
    if (entityType === 'chat' && request.autoRepliesEnabled !== undefined) {
      getPreviewPublisherAutoRepliesEnabled(state)[entityId] = request.autoRepliesEnabled;
    }
    const revision = entity.moduleSettings.revision + 1;
    getPreviewPublisherModuleRevisions(state)[`${entityType}:${entityId}`] = revision;
    return publisherEntityModuleSettingsSchema.parse({
      revision,
      chatComments:
        entityType === 'chat'
          ? (getPreviewPublisherChatComments(state)[entityId] ?? entity.moduleSettings.chatComments)
          : null,
      autoRepliesEnabled:
        entityType === 'chat'
          ? (getPreviewPublisherAutoRepliesEnabled(state)[entityId] ??
            entity.moduleSettings.autoRepliesEnabled)
          : null,
      channelSuggestionsEnabled:
        entityType === 'channel'
          ? (getPreviewPublisherChannelSuggestions(state)[entityId] ?? false)
          : null,
    });
  }
  return PREVIEW_NOT_HANDLED;
};
