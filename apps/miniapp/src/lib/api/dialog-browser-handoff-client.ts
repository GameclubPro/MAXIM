import {
  channelDialogTypeSchema,
  createDialogBrowserHandoffRequestSchema,
  dialogBrowserHandoffResponseSchema,
  dialogBrowserHandoffSessionResponseSchema,
  submitDialogBrowserHandoffMessageRequestSchema,
  submitDialogBrowserHandoffMessageResponseSchema,
  type ChannelDialogType,
  type DialogBrowserHandoffResponse,
  type DialogBrowserHandoffSessionResponse,
  type SubmitDialogBrowserHandoffMessageResponse,
} from '@maxim/contracts';
import type {
  CreateDialogBrowserHandoffPayload,
  SubmitDialogBrowserHandoffMessagePayload,
} from './shared-types';
import type { ApiTransport } from './transport';
import type { LastEntityType } from '../last-chat';

function buildEntityDialogBrowserHandoffPath(
  entityType: LastEntityType,
  chatId: string,
  dialogType: ChannelDialogType,
): string {
  const parsedType = channelDialogTypeSchema.parse(dialogType);
  const entitySegment = entityType === 'channel' ? 'channels' : 'chats';
  return `/${entitySegment}/${chatId}/dialog/${parsedType}/browser-handoff`;
}

export async function createDialogBrowserHandoff(
  api: ApiTransport,
  entityType: LastEntityType,
  chatId: string,
  dialogType: ChannelDialogType,
  payload: CreateDialogBrowserHandoffPayload,
): Promise<DialogBrowserHandoffResponse> {
  const requestBody = createDialogBrowserHandoffRequestSchema.parse(payload);
  const response = await api.request(
    buildEntityDialogBrowserHandoffPath(entityType, chatId, dialogType),
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return dialogBrowserHandoffResponseSchema.parse(response);
}

export async function getDialogBrowserHandoffSession(
  api: ApiTransport,
  handoffId: string,
): Promise<DialogBrowserHandoffSessionResponse> {
  const response = await api.request(`/public/dialog-browser-handoff/${encodeURIComponent(handoffId)}`);
  return dialogBrowserHandoffSessionResponseSchema.parse(response);
}

export async function submitDialogBrowserHandoffMessage(
  api: ApiTransport,
  handoffId: string,
  payload: SubmitDialogBrowserHandoffMessagePayload,
): Promise<SubmitDialogBrowserHandoffMessageResponse> {
  const requestBody = submitDialogBrowserHandoffMessageRequestSchema.parse(payload);
  const response = await api.request(
    `/public/dialog-browser-handoff/${encodeURIComponent(handoffId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return submitDialogBrowserHandoffMessageResponseSchema.parse(response);
}
