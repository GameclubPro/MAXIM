import { describe, expect, it } from 'vitest';

import {
  channelDialogMessageSchema as rootChannelDialogMessageSchema,
  createChannelDialogMessageRequestSchema as rootCreateChannelDialogMessageRequestSchema,
  publishChannelEngagementRequestSchema as rootPublishChannelEngagementRequestSchema,
} from '@maxim/contracts';
import {
  channelDialogMessageSchema,
  channelSuggestionDeliverySummarySchema,
  createChannelDialogMessageRequestSchema,
  publishChannelEngagementRequestSchema,
} from '@maxim/contracts/channel-dialog';

describe('channel dialog contract exports', () => {
  it('keeps root and subpath exports aligned', () => {
    expect(rootCreateChannelDialogMessageRequestSchema).toBe(
      createChannelDialogMessageRequestSchema,
    );
    expect(rootChannelDialogMessageSchema).toBe(channelDialogMessageSchema);
    expect(rootPublishChannelEngagementRequestSchema).toBe(publishChannelEngagementRequestSchema);
  });

  it('strips legacy button selection fields from engagement publish requests', () => {
    const result = publishChannelEngagementRequestSchema.parse({
      text: 'Пост с системными кнопками',
      includeCommentsButton: false,
      includeSuggestButton: false,
    });

    expect(result).not.toHaveProperty('includeCommentsButton');
    expect(result).not.toHaveProperty('includeSuggestButton');
  });

  it('normalizes legacy image payloads into dialog images and attachments', () => {
    const result = createChannelDialogMessageRequestSchema.parse({
      token: '1234567890abcdef',
      text: 'Предложка',
      imageBase64: ' image-data ',
      imageMimeType: ' image/png ',
      imageFileName: ' post.png ',
    });

    expect(result.images).toEqual([
      {
        base64: 'image-data',
        mimeType: 'image/png',
        fileName: 'post.png',
      },
    ]);
    expect(result.attachments).toEqual([
      {
        type: 'image',
        base64: 'image-data',
        mimeType: 'image/png',
        fileName: 'post.png',
        width: undefined,
        height: undefined,
      },
    ]);
  });

  it('keeps aggregate delivery counts internal and exposes only public state', () => {
    const result = channelSuggestionDeliverySummarySchema.parse({
      state: 'partially_delivered',
      deliveredCount: 1,
      targetCount: 3,
      pendingCount: 0,
      unreachableCount: 2,
      adminUserIds: ['private-admin-id'],
      botId: 'private-route-bot',
      error: 'dialog.not.found',
    });

    expect(result).toEqual({
      state: 'partially_delivered',
      deliveredCount: 1,
      targetCount: 3,
      pendingCount: 0,
      unreachableCount: 2,
    });

    expect(() =>
      channelDialogMessageSchema.parse({
        id: 'suggestion-private-summary',
        type: 'suggest',
        text: 'Идея',
        authorUserId: 'author-1',
        authorDisplayName: 'Автор',
        createdAt: '2026-08-24T10:00:00.000Z',
        suggestionDelivery: {
          ...result,
          adminUserIds: ['private-admin-id'],
        },
      }),
    ).toThrow();

    const message = channelDialogMessageSchema.parse({
      id: 'suggestion-1',
      type: 'suggest',
      text: 'Идея',
      authorUserId: 'author-1',
      authorDisplayName: 'Автор',
      isAdmin: false,
      avatarUrl: null,
      createdAt: '2026-08-24T10:00:00.000Z',
      attachments: [],
      reactionGroups: [],
      canEdit: false,
      canDelete: false,
      canDeleteAsAdmin: false,
      delivered: true,
      deliveredToUserId: 'private-admin-id',
      suggestionDelivery: result,
    });

    expect(message).not.toHaveProperty('deliveredToUserId');
    expect(message.suggestionDelivery).toEqual({
      state: 'partially_delivered',
      deliveredCount: 0,
      targetCount: 0,
      pendingCount: 0,
      unreachableCount: 0,
    });
  });
});
