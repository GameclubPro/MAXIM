import { describe, expect, it } from 'vitest';

import {
  supportRequestAttachmentSchema as rootSupportRequestAttachmentSchema,
  supportRequestDecisionResponseSchema as rootSupportRequestDecisionResponseSchema,
  supportRequestItemSchema as rootSupportRequestItemSchema,
  supportRequestQueueResponseSchema as rootSupportRequestQueueResponseSchema,
  supportRequestStatusSchema as rootSupportRequestStatusSchema,
} from '@maxim/contracts';
import {
  supportRequestAttachmentSchema,
  supportRequestDecisionResponseSchema,
  supportRequestItemSchema,
  supportRequestQueueResponseSchema,
  supportRequestStatusSchema,
} from '@maxim/contracts/support-requests';

describe('support request contract exports', () => {
  it('keeps root and subpath schema identity aligned', () => {
    expect(rootSupportRequestStatusSchema).toBe(supportRequestStatusSchema);
    expect(rootSupportRequestAttachmentSchema).toBe(supportRequestAttachmentSchema);
    expect(rootSupportRequestItemSchema).toBe(supportRequestItemSchema);
    expect(rootSupportRequestQueueResponseSchema).toBe(supportRequestQueueResponseSchema);
    expect(rootSupportRequestDecisionResponseSchema).toBe(supportRequestDecisionResponseSchema);
  });

  it('parses queue items with stable nullable and collection defaults', () => {
    expect(
      supportRequestQueueResponseSchema.parse({
        generatedAt: '2026-07-19T10:00:00.000Z',
        items: [
          {
            id: 'support-1',
            status: 'NEW',
            privateChatId: 'private-chat-1',
            userId: 'user-1',
            text: 'Не открывается экран публикаций',
            attachments: [{ type: 'image' }],
            createdAt: '2026-07-19T09:55:00.000Z',
            updatedAt: '2026-07-19T09:55:00.000Z',
          },
        ],
        summary: {},
      }),
    ).toEqual({
      generatedAt: '2026-07-19T10:00:00.000Z',
      items: [
        {
          id: 'support-1',
          status: 'NEW',
          botId: null,
          privateChatId: 'private-chat-1',
          userId: 'user-1',
          userName: null,
          messageId: null,
          text: 'Не открывается экран публикаций',
          attachments: [
            {
              type: 'image',
              fileName: null,
              mimeType: null,
              url: null,
              payload: null,
            },
          ],
          createdAt: '2026-07-19T09:55:00.000Z',
          updatedAt: '2026-07-19T09:55:00.000Z',
          closedAt: null,
        },
      ],
      summary: { new: 0, closed: 0 },
    });
  });

  it('rejects malformed attachment URLs', () => {
    expect(
      supportRequestAttachmentSchema.safeParse({ type: 'image', url: 'not-a-url' }).success,
    ).toBe(false);
  });
});
