import {
  addVkParsingSourceRequestSchema,
  bulkUpdateVkParsingSourcesRequestSchema,
  publishVkParsingPostRequestSchema,
  publishVkParsingPostResultSchema,
  rollbackVkParsingRequestSchema,
  rollbackVkParsingResultSchema,
  retryVkParsingPostResultSchema,
  scheduleVkParsingPostRequestSchema,
  updateVkParsingSettingsRequestSchema,
  updateVkParsingSourceRequestSchema,
  vkParsingCapabilitySchema,
  vkParsingDryRunResultSchema,
  vkParsingFeedSchema,
  vkParsingRefreshResultSchema,
  type BulkUpdateVkParsingSourcesRequest,
  type PublishVkParsingPostRequest,
  type PublishVkParsingPostResult,
  type RollbackVkParsingRequest,
  type RollbackVkParsingResult,
  type RetryVkParsingPostResult,
  type ScheduleVkParsingPostRequest,
  type UpdateVkParsingSettingsRequest,
  type UpdateVkParsingSourceRequest,
  type VkParsingCapability,
  type VkParsingDryRunResult,
  type VkParsingFeed,
  type VkParsingFeedQuery,
  type VkParsingRefreshResult,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

export type VkParsingEntityType = 'chat' | 'channel';

function buildVkParsingPath(entityType: VkParsingEntityType, chatId: string): string {
  const prefix = entityType === 'channel' ? 'channels' : 'chats';
  return `/${prefix}/${chatId}/vk-parsing`;
}

function buildVkParsingQuery(query: Partial<VkParsingFeedQuery> | undefined): string {
  const status = query?.status ?? 'ALL';
  const sourceId = query?.sourceId?.trim();
  const rawLimit = Number(query?.limit ?? 50);
  const rawOffset = Number(query?.offset ?? 0);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.trunc(rawLimit))) : 50;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  const params = new URLSearchParams();
  if (status !== 'ALL') {
    params.set('status', status);
  }
  if (sourceId) {
    params.set('sourceId', sourceId);
  }
  if (limit !== 50) {
    params.set('limit', String(limit));
  }
  if (offset > 0) {
    params.set('offset', String(offset));
  }

  const value = params.toString();
  return value ? `?${value}` : '';
}

export async function getVkParsing(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
  query?: Partial<VkParsingFeedQuery>,
): Promise<VkParsingFeed> {
  const response = await api.request(
    `${buildVkParsingPath(entityType, chatId)}${buildVkParsingQuery(query)}`,
  );
  return vkParsingFeedSchema.parse(response);
}

export async function getVkParsingCapability(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
): Promise<VkParsingCapability> {
  const response = await api.request(`${buildVkParsingPath(entityType, chatId)}/capability`);
  return vkParsingCapabilitySchema.parse(response);
}

export async function updateVkParsingSettings(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
  payload: UpdateVkParsingSettingsRequest,
): Promise<VkParsingFeed> {
  const requestBody = updateVkParsingSettingsRequestSchema.parse(payload);
  const response = await api.request(`${buildVkParsingPath(entityType, chatId)}/settings`, {
    method: 'PATCH',
    body: JSON.stringify(requestBody),
  });
  return vkParsingFeedSchema.parse(response);
}

export async function addVkParsingSource(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
  url: string,
): Promise<VkParsingRefreshResult> {
  const requestBody = addVkParsingSourceRequestSchema.parse({ url });
  const response = await api.request(`${buildVkParsingPath(entityType, chatId)}/sources`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return vkParsingRefreshResultSchema.parse(response);
}

export async function removeVkParsingSource(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
  sourceId: string,
): Promise<VkParsingFeed> {
  const response = await api.request(
    `${buildVkParsingPath(entityType, chatId)}/sources/${sourceId}`,
    {
      method: 'DELETE',
    },
  );
  return vkParsingFeedSchema.parse(response);
}

export async function updateVkParsingSource(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
  sourceId: string,
  payload: UpdateVkParsingSourceRequest,
): Promise<VkParsingFeed> {
  const requestBody = updateVkParsingSourceRequestSchema.parse(payload);
  const response = await api.request(
    `${buildVkParsingPath(entityType, chatId)}/sources/${sourceId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(requestBody),
    },
  );
  return vkParsingFeedSchema.parse(response);
}

export async function applyVkParsingSourcePreset(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
  payload: BulkUpdateVkParsingSourcesRequest,
): Promise<VkParsingFeed> {
  const requestBody = bulkUpdateVkParsingSourcesRequestSchema.parse(payload);
  const response = await api.request(`${buildVkParsingPath(entityType, chatId)}/sources/bulk`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return vkParsingFeedSchema.parse(response);
}

export async function refreshVkParsing(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
): Promise<VkParsingRefreshResult> {
  const response = await api.request(`${buildVkParsingPath(entityType, chatId)}/refresh`, {
    method: 'POST',
  });
  return vkParsingRefreshResultSchema.parse(response);
}

export async function refreshVkParsingSource(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
  sourceId: string,
): Promise<VkParsingRefreshResult> {
  const response = await api.request(
    `${buildVkParsingPath(entityType, chatId)}/sources/${sourceId}/refresh`,
    {
      method: 'POST',
    },
  );
  return vkParsingRefreshResultSchema.parse(response);
}

export async function publishVkParsingPost(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
  postId: string,
  payload: PublishVkParsingPostRequest,
): Promise<PublishVkParsingPostResult> {
  const requestBody = publishVkParsingPostRequestSchema.parse(payload);
  const response = await api.request(
    `${buildVkParsingPath(entityType, chatId)}/posts/${postId}/publish`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return publishVkParsingPostResultSchema.parse(response);
}

export async function retryVkParsingPost(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
  postId: string,
): Promise<RetryVkParsingPostResult> {
  const response = await api.request(
    `${buildVkParsingPath(entityType, chatId)}/posts/${postId}/retry`,
    {
      method: 'POST',
    },
  );
  return retryVkParsingPostResultSchema.parse(response);
}

export async function scheduleVkParsingPost(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
  postId: string,
  payload: ScheduleVkParsingPostRequest,
): Promise<RetryVkParsingPostResult> {
  const requestBody = scheduleVkParsingPostRequestSchema.parse(payload);
  const response = await api.request(
    `${buildVkParsingPath(entityType, chatId)}/posts/${postId}/schedule`,
    {
      method: 'PATCH',
      body: JSON.stringify(requestBody),
    },
  );
  return retryVkParsingPostResultSchema.parse(response);
}

export async function cancelVkParsingPost(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
  postId: string,
): Promise<RetryVkParsingPostResult> {
  const response = await api.request(
    `${buildVkParsingPath(entityType, chatId)}/posts/${postId}/cancel`,
    {
      method: 'POST',
    },
  );
  return retryVkParsingPostResultSchema.parse(response);
}

export async function publishVkParsingPostNow(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
  postId: string,
): Promise<RetryVkParsingPostResult> {
  const response = await api.request(
    `${buildVkParsingPath(entityType, chatId)}/posts/${postId}/publish-now`,
    {
      method: 'POST',
    },
  );
  return retryVkParsingPostResultSchema.parse(response);
}

export async function dryRunVkParsingAutopublish(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
  sourceId?: string | null,
): Promise<VkParsingDryRunResult> {
  const params = new URLSearchParams();
  if (sourceId) {
    params.set('sourceId', sourceId);
  }
  const query = params.toString();
  const response = await api.request(
    `${buildVkParsingPath(entityType, chatId)}/autopublish/dry-run${query ? `?${query}` : ''}`,
  );
  return vkParsingDryRunResultSchema.parse(response);
}

export async function rollbackVkParsingAutopublish(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
  payload: RollbackVkParsingRequest,
): Promise<RollbackVkParsingResult> {
  const requestBody = rollbackVkParsingRequestSchema.parse(payload);
  const response = await api.request(`${buildVkParsingPath(entityType, chatId)}/rollback`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return rollbackVkParsingResultSchema.parse(response);
}
