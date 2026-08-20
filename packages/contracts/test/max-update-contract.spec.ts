import { describe, expect, it } from 'vitest';

import { maxUpdateSchema, type MaxUpdate } from '../src/core';

describe('MAX update contract', () => {
  it('preserves an optional normalized parent post id without changing ordinary posts', () => {
    const nativeComment = {
      updateId: 'update-comment-1',
      type: 'message_created',
      message: {
        messageId: 'comment-1',
        postId: 'channel-post-1',
        chatId: 'channel-1',
        entityType: 'channel',
        senderId: 'user-1',
        text: 'Native comment',
        createdAt: '2026-08-20T10:00:00.000Z',
      },
    } satisfies MaxUpdate;

    const { postId, ...ordinaryPostMessage } = nativeComment.message;
    expect(maxUpdateSchema.parse(nativeComment).message?.postId).toBe(postId);
    expect(
      maxUpdateSchema.parse({ ...nativeComment, message: ordinaryPostMessage }).message?.postId,
    ).toBeUndefined();
  });

  it('preserves a normalized parent post id for an official message_removed update', () => {
    const removedComment = {
      updateId: 'update-removed-comment-1',
      type: 'message_removed',
      message: {
        messageId: 'removed-comment-1',
        postId: 'channel-post-1',
        chatId: 'channel-1',
        entityType: 'channel',
        senderId: 'user-1',
        text: '',
        createdAt: '2026-08-20T10:00:00.000Z',
      },
    } satisfies MaxUpdate;

    expect(maxUpdateSchema.parse(removedComment).message?.postId).toBe('channel-post-1');
  });
});
