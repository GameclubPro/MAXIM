import {
  channelDialogResponseSchema,
  channelSuggestionRedirectResponseSchema,
  channelDialogTypeSchema,
  createChannelDialogMessageRequestSchema,
  createChannelDialogMessageResponseSchema,
  deleteChannelDialogMessageRequestSchema,
  deleteChannelDialogMessageResponseSchema,
  broadcastHandoffResponseSchema,
  profileMentionHandoffRequestSchema,
  updateChannelDialogNotificationsRequestSchema,
  updateChannelDialogNotificationsResponseSchema,
  type BroadcastHandoffResponse,
  type ChannelDialogResponse,
  type ChannelSuggestionRedirectResponse,
  type ChannelDialogType,
  type CreateChannelDialogMessageResponse,
  type DeleteChannelDialogMessageResponse,
  type ProfileMentionHandoffRequest,
  type UpdateChannelDialogNotificationsResponse,
  toggleChannelDialogReactionRequestSchema,
  toggleChannelDialogReactionResponseSchema,
  type ToggleChannelDialogReactionResponse,
  updateChannelDialogMessageRequestSchema,
  updateChannelDialogMessageResponseSchema,
  type UpdateChannelDialogMessageResponse,
} from '@maxim/contracts';
import type {
  CreateChannelDialogMessagePayload,
  DeleteChannelDialogMessagePayload,
  ToggleChannelDialogReactionPayload,
  UpdateChannelDialogNotificationsPayload,
  UpdateChannelDialogMessagePayload,
} from './shared-types';
import type { ApiTransport } from './transport';
import type { LastEntityType } from '../last-chat';

function buildDialogApiPath(
  entityType: LastEntityType,
  chatId: string,
  dialogType: ChannelDialogType,
  token?: string,
): string {
  const parsedType = channelDialogTypeSchema.parse(dialogType);
  const entitySegment = entityType === 'channel' ? 'channels' : 'chats';
  const basePath = `/${entitySegment}/${chatId}/dialog/${parsedType}`;
  return token ? `${basePath}?token=${encodeURIComponent(token)}` : basePath;
}

function buildDialogMessagesApiPath(
  entityType: LastEntityType,
  chatId: string,
  dialogType: ChannelDialogType,
): string {
  return `${buildDialogApiPath(entityType, chatId, dialogType)}/messages`;
}

function buildDialogMessageApiPath(
  entityType: LastEntityType,
  chatId: string,
  dialogType: ChannelDialogType,
  messageId: string,
): string {
  return `${buildDialogMessagesApiPath(entityType, chatId, dialogType)}/${encodeURIComponent(messageId)}`;
}

function buildDialogReactionsApiPath(
  entityType: LastEntityType,
  chatId: string,
  dialogType: ChannelDialogType,
  messageId: string,
): string {
  return `${buildDialogMessageApiPath(entityType, chatId, dialogType, messageId)}/reactions`;
}

function buildDialogNotificationsApiPath(
  entityType: LastEntityType,
  chatId: string,
  dialogType: ChannelDialogType,
): string {
  return `${buildDialogApiPath(entityType, chatId, dialogType)}/notifications`;
}

function buildMemberProfileHandoffApiPath(
  entityType: LastEntityType,
  chatId: string,
  userId: string,
): string {
  const entitySegment = entityType === 'channel' ? 'channels' : 'chats';
  return `/${entitySegment}/${chatId}/members/${encodeURIComponent(userId)}/profile/handoff`;
}

export async function getEntityDialog(
  api: ApiTransport,
  entityType: LastEntityType,
  chatId: string,
  dialogType: ChannelDialogType,
  token: string,
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ChannelDialogResponse> {
  const response = await api.request(
    buildDialogApiPath(entityType, chatId, dialogType, token),
    request,
  );
  return channelDialogResponseSchema.parse(response);
}

export async function createEntityDialogMessage(
  api: ApiTransport,
  entityType: LastEntityType,
  chatId: string,
  dialogType: ChannelDialogType,
  payload: CreateChannelDialogMessagePayload,
): Promise<CreateChannelDialogMessageResponse> {
  const requestBody = createChannelDialogMessageRequestSchema.parse(payload);
  const response = await api.request(buildDialogMessagesApiPath(entityType, chatId, dialogType), {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return createChannelDialogMessageResponseSchema.parse(response);
}

export async function toggleEntityDialogReaction(
  api: ApiTransport,
  entityType: LastEntityType,
  chatId: string,
  dialogType: ChannelDialogType,
  messageId: string,
  payload: ToggleChannelDialogReactionPayload,
): Promise<ToggleChannelDialogReactionResponse> {
  const requestBody = toggleChannelDialogReactionRequestSchema.parse(payload);
  const response = await api.request(
    buildDialogReactionsApiPath(entityType, chatId, dialogType, messageId),
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return toggleChannelDialogReactionResponseSchema.parse(response);
}

export async function updateEntityDialogNotifications(
  api: ApiTransport,
  entityType: LastEntityType,
  chatId: string,
  dialogType: ChannelDialogType,
  payload: UpdateChannelDialogNotificationsPayload,
): Promise<UpdateChannelDialogNotificationsResponse> {
  const requestBody = updateChannelDialogNotificationsRequestSchema.parse(payload);
  const response = await api.request(
    buildDialogNotificationsApiPath(entityType, chatId, dialogType),
    {
      method: 'PUT',
      body: JSON.stringify(requestBody),
    },
  );
  return updateChannelDialogNotificationsResponseSchema.parse(response);
}

export async function updateEntityDialogMessage(
  api: ApiTransport,
  entityType: LastEntityType,
  chatId: string,
  dialogType: ChannelDialogType,
  messageId: string,
  payload: UpdateChannelDialogMessagePayload,
): Promise<UpdateChannelDialogMessageResponse> {
  const requestBody = updateChannelDialogMessageRequestSchema.parse(payload);
  const response = await api.request(
    buildDialogMessageApiPath(entityType, chatId, dialogType, messageId),
    {
      method: 'PATCH',
      body: JSON.stringify(requestBody),
    },
  );
  return updateChannelDialogMessageResponseSchema.parse(response);
}

export async function deleteEntityDialogMessage(
  api: ApiTransport,
  entityType: LastEntityType,
  chatId: string,
  dialogType: ChannelDialogType,
  messageId: string,
  payload: DeleteChannelDialogMessagePayload,
): Promise<DeleteChannelDialogMessageResponse> {
  const requestBody = deleteChannelDialogMessageRequestSchema.parse(payload);
  const response = await api.request(
    buildDialogMessageApiPath(entityType, chatId, dialogType, messageId),
    {
      method: 'DELETE',
      body: JSON.stringify(requestBody),
    },
  );
  return deleteChannelDialogMessageResponseSchema.parse(response);
}

export async function handoffEntityMemberProfile(
  api: ApiTransport,
  entityType: LastEntityType,
  chatId: string,
  userId: string,
  payload: ProfileMentionHandoffRequest,
): Promise<BroadcastHandoffResponse> {
  const requestBody = profileMentionHandoffRequestSchema.parse(payload);
  const response = await api.request(buildMemberProfileHandoffApiPath(entityType, chatId, userId), {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return broadcastHandoffResponseSchema.parse(response);
}

export async function getChannelDialog(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  token: string,
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ChannelDialogResponse> {
  return getEntityDialog(api, 'channel', chatId, dialogType, token, request);
}

export async function getChannelSuggestionRedirect(
  api: ApiTransport,
  chatId: string,
  token: string,
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ChannelSuggestionRedirectResponse> {
  const response = await api.request(
    `/channels/${chatId}/dialog/suggest/redirect?token=${encodeURIComponent(token)}`,
    request,
  );
  return channelSuggestionRedirectResponseSchema.parse(response);
}

export async function createChannelDialogMessage(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  payload: CreateChannelDialogMessagePayload,
): Promise<CreateChannelDialogMessageResponse> {
  return createEntityDialogMessage(api, 'channel', chatId, dialogType, payload);
}

export async function toggleChannelDialogReaction(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  messageId: string,
  payload: ToggleChannelDialogReactionPayload,
): Promise<ToggleChannelDialogReactionResponse> {
  return toggleEntityDialogReaction(api, 'channel', chatId, dialogType, messageId, payload);
}

export async function updateChannelDialogNotifications(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  payload: UpdateChannelDialogNotificationsPayload,
): Promise<UpdateChannelDialogNotificationsResponse> {
  return updateEntityDialogNotifications(api, 'channel', chatId, dialogType, payload);
}

export async function updateChannelDialogMessage(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  messageId: string,
  payload: UpdateChannelDialogMessagePayload,
): Promise<UpdateChannelDialogMessageResponse> {
  return updateEntityDialogMessage(api, 'channel', chatId, dialogType, messageId, payload);
}

export async function deleteChannelDialogMessage(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  messageId: string,
  payload: DeleteChannelDialogMessagePayload,
): Promise<DeleteChannelDialogMessageResponse> {
  return deleteEntityDialogMessage(api, 'channel', chatId, dialogType, messageId, payload);
}

export async function getChatDialog(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  token: string,
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ChannelDialogResponse> {
  return getEntityDialog(api, 'chat', chatId, dialogType, token, request);
}

export async function createChatDialogMessage(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  payload: CreateChannelDialogMessagePayload,
): Promise<CreateChannelDialogMessageResponse> {
  return createEntityDialogMessage(api, 'chat', chatId, dialogType, payload);
}

export async function toggleChatDialogReaction(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  messageId: string,
  payload: ToggleChannelDialogReactionPayload,
): Promise<ToggleChannelDialogReactionResponse> {
  return toggleEntityDialogReaction(api, 'chat', chatId, dialogType, messageId, payload);
}

export async function updateChatDialogNotifications(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  payload: UpdateChannelDialogNotificationsPayload,
): Promise<UpdateChannelDialogNotificationsResponse> {
  return updateEntityDialogNotifications(api, 'chat', chatId, dialogType, payload);
}

export async function updateChatDialogMessage(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  messageId: string,
  payload: UpdateChannelDialogMessagePayload,
): Promise<UpdateChannelDialogMessageResponse> {
  return updateEntityDialogMessage(api, 'chat', chatId, dialogType, messageId, payload);
}

export async function deleteChatDialogMessage(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  messageId: string,
  payload: DeleteChannelDialogMessagePayload,
): Promise<DeleteChannelDialogMessageResponse> {
  return deleteEntityDialogMessage(api, 'chat', chatId, dialogType, messageId, payload);
}
