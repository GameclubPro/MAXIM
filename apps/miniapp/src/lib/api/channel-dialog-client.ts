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

export async function getChannelDialog(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  token: string,
): Promise<ChannelDialogResponse> {
  const parsedType = channelDialogTypeSchema.parse(dialogType);
  const response = await api.request(
    `/channels/${chatId}/dialog/${parsedType}?token=${encodeURIComponent(token)}`,
  );
  return channelDialogResponseSchema.parse(response);
}

export async function createChannelDialogMessage(
  api: ApiTransport,
  chatId: string,
  dialogType: ChannelDialogType,
  payload: CreateChannelDialogMessagePayload,
): Promise<CreateChannelDialogMessageResponse> {
  const parsedType = channelDialogTypeSchema.parse(dialogType);
  const requestBody = createChannelDialogMessageRequestSchema.parse(payload);
  const response = await api.request(`/channels/${chatId}/dialog/${parsedType}/messages`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return createChannelDialogMessageResponseSchema.parse(response);
}
