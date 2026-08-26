import {
  managedEntityPublicationPolicySchema,
  publisherEntitiesResponseSchema,
  publisherEntitySchema,
  updateManagedEntityPublicationPolicyRequestSchema,
  type ManagedEntityPublicationPolicy,
  type ManagedEntityType,
  type PublisherEntity,
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
      suggestionsViaPublik: false,
      revision: 0,
      updatedAt: null,
    });
  const checkedAt = state.clock.now().toISOString();
  const setupBlocker =
    state.publisherPolicyVariant === 'setup' && entityId === PREVIEW_CHAT_ID
      ? 'bot_not_admin'
      : entityId === 'preview-chat-2'
        ? 'bot_not_connected'
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
            canUseChatComments: entityType === 'chat',
            canPublishSuggestions: entityType === 'channel' && policy.suggestionsViaPublik,
            blockerCode: null,
            checkedAt,
            retryAt: null,
          };
  return publisherEntitySchema.parse({
    id: source.id,
    title: source.title,
    entityType,
    avatarUrl: source.avatarUrl ?? null,
    channelOverview: entityType === 'channel' ? (source.channelOverview ?? null) : null,
    policy,
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
    return publisherEntitiesResponseSchema.parse({ items: listPreviewPublisherEntities(state) });
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
  if (state.publisherPolicyVariant === 'error' && segments.length === 4 && method === 'GET') {
    throw new ApiRequestError(503, '', 'Preview publisher policy unavailable');
  }
  const entity = buildPreviewPublisherEntity(state, entityType, entityId);
  if (!entity) {
    throw new ApiRequestError(404, '', 'Preview publisher entity not found');
  }
  if (segments.length === 4 && method === 'GET') {
    return entity;
  }
  if (segments[4] === 'policy' && method === 'PATCH') {
    const request = updateManagedEntityPublicationPolicyRequestSchema.parse(parseJsonBody(init));
    const policy = managedEntityPublicationPolicySchema.parse({
      ...entity.policy,
      ...(request.publikEnabled !== undefined ? { publikEnabled: request.publikEnabled } : {}),
      ...(entityType === 'channel' && request.suggestionsViaPublik !== undefined
        ? { suggestionsViaPublik: request.suggestionsViaPublik }
        : {}),
      revision: entity.policy.revision + 1,
      updatedAt: state.clock.now().toISOString(),
    });
    getPreviewPublisherPolicies(state)[`${entityType}:${entityId}`] = policy;
    return policy;
  }
  return PREVIEW_NOT_HANDLED;
};
