import {
  broadcastHandoffResponseSchema,
  profileMentionHandoffRequestSchema,
  type BroadcastHandoffResponse,
  type ProfileMentionHandoffRequest,
} from '@maxim/contracts';
import type { LastEntityType } from '../last-chat';
import type { ApiTransport } from './transport';

function buildMemberProfileHandoffApiPath(
  entityType: LastEntityType,
  chatId: string,
  userId: string,
): string {
  const entitySegment = entityType === 'channel' ? 'channels' : 'chats';
  return `/${entitySegment}/${chatId}/members/${encodeURIComponent(userId)}/profile/handoff`;
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
