import {
  channelDialogResponseSchema,
  channelDialogTypeSchema,
  createChannelDialogMessageRequestSchema,
  createChannelDialogMessageResponseSchema,
  type ChannelDialogResponse,
  type ChannelDialogType,
  type CreateChannelDialogMessageResponse,
} from '@maxim/contracts';
import type { CreateChannelDialogMessagePayload } from './shared-types';
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

export async function getEntityDialog(
  api: ApiTransport,
  entityType: LastEntityType,
  chatId: string,
  dialogType: ChannelDialogType,
  token: string,
): Promise<ChannelDialogResponse> {
  const response = await api.request(buildDialogApiPath(entityType, chatId, dialogType, token));
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

export async function getChannelDialog(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  token: string,
): Promise<ChannelDialogResponse> {
  return getEntityDialog(api, 'channel', chatId, dialogType, token);
}

export async function createChannelDialogMessage(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  payload: CreateChannelDialogMessagePayload,
): Promise<CreateChannelDialogMessageResponse> {
  return createEntityDialogMessage(api, 'channel', chatId, dialogType, payload);
}

export async function getChatDialog(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  token: string,
): Promise<ChannelDialogResponse> {
  return getEntityDialog(api, 'chat', chatId, dialogType, token);
}

export async function createChatDialogMessage(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  payload: CreateChannelDialogMessagePayload,
): Promise<CreateChannelDialogMessageResponse> {
  return createEntityDialogMessage(api, 'chat', chatId, dialogType, payload);
}
