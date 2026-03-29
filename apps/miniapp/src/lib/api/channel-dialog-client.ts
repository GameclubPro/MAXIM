import {
  channelDialogResponseSchema,
  channelDialogTypeSchema,
  createChannelDialogMessageRequestSchema,
  createChannelDialogMessageResponseSchema,
  deleteChannelDialogMessageRequestSchema,
  deleteChannelDialogMessageResponseSchema,
  type ChannelDialogResponse,
  type ChannelDialogType,
  type CreateChannelDialogMessageResponse,
  type DeleteChannelDialogMessageResponse,
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

export async function getChannelDialog(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  token: string,
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ChannelDialogResponse> {
  return getEntityDialog(api, 'channel', chatId, dialogType, token, request);
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
