import {
  commentModerationStateSchema,
  commentRestrictionSchema,
  commentRestrictionsPageSchema,
  updateCommentRestrictionRequestSchema,
  type UpdateCommentRestrictionRequest,
} from '@maxim/contracts/channel-dialog';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import type { ApiTransport } from './transport';
import type { LastEntityType } from '../last-chat';

export type CommentModerationContext = {
  api: ApiTransport;
  profile: MiniappProfile;
  entityType: LastEntityType;
  chatId: string;
  token: string;
};

export const commentModerationKey = (context: CommentModerationContext) =>
  [
    'comment-moderation',
    context.profile,
    context.entityType,
    context.chatId,
    context.token,
  ] as const;
const path = (context: CommentModerationContext) =>
  `/${context.entityType === 'channel' ? 'channels' : 'chats'}/${encodeURIComponent(context.chatId)}/dialog/comments/moderation`;

export async function getCommentModerationState(
  context: CommentModerationContext,
  signal?: AbortSignal,
) {
  return commentModerationStateSchema.parse(
    await context.api.request(`${path(context)}?${new URLSearchParams({ token: context.token })}`, {
      signal,
    }),
  );
}

export async function getCommentRestrictions(
  context: CommentModerationContext,
  cursor: string | null,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ token: context.token });
  if (cursor) query.set('cursor', cursor);
  return commentRestrictionsPageSchema.parse(
    await context.api.request(`${path(context)}/restrictions?${query}`, { signal }),
  );
}

export async function getCommentRestriction(
  context: CommentModerationContext,
  userId: string,
  signal?: AbortSignal,
) {
  return commentRestrictionSchema.parse(
    await context.api.request(
      `${path(context)}/users/${encodeURIComponent(userId)}?${new URLSearchParams({ token: context.token })}`,
      { signal },
    ),
  );
}

export async function updateCommentRestriction(
  context: CommentModerationContext,
  userId: string,
  request: Omit<UpdateCommentRestrictionRequest, 'token'>,
) {
  const body = updateCommentRestrictionRequestSchema.parse({ ...request, token: context.token });
  return commentRestrictionSchema.parse(
    await context.api.request(`${path(context)}/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  );
}
