import {
  addVkParsingSourceRequestSchema,
  publishVkParsingPostRequestSchema,
  publishVkParsingPostResultSchema,
  updateVkParsingSettingsRequestSchema,
  vkParsingCapabilitySchema,
  vkParsingFeedSchema,
  vkParsingRefreshResultSchema,
  type PublishVkParsingPostRequest,
  type PublishVkParsingPostResult,
  type UpdateVkParsingSettingsRequest,
  type VkParsingCapability,
  type VkParsingFeed,
  type VkParsingRefreshResult,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

export type VkParsingEntityType = 'chat' | 'channel';

function buildVkParsingPath(entityType: VkParsingEntityType, chatId: string): string {
  const prefix = entityType === 'channel' ? 'channels' : 'chats';
  return `/${prefix}/${chatId}/vk-parsing`;
}

export async function getVkParsing(
  api: ApiTransport,
  entityType: VkParsingEntityType,
  chatId: string,
): Promise<VkParsingFeed> {
  const response = await api.request(buildVkParsingPath(entityType, chatId));
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
