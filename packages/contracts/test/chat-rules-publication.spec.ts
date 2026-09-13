import { describe, expect, it } from 'vitest';
import { publishChatRulesRequestSchema, publishChatRulesResultSchema } from '../src/settings';

describe('rules publication commands and receipts', () => {
  it('keeps legacy requests distinct from explicit new-message and edit commands', () => {
    expect(publishChatRulesRequestSchema.parse({})).toEqual({});
    expect(publishChatRulesRequestSchema.parse({ mode: 'new_message' })).toEqual({
      mode: 'new_message',
    });
    expect(publishChatRulesRequestSchema.parse({ mode: 'update' })).toEqual({ mode: 'update' });
    expect(publishChatRulesRequestSchema.safeParse({ mode: 'force_delete' }).success).toBe(false);
    expect(publishChatRulesRequestSchema.safeParse({ messageId: 'foreign-post' }).success).toBe(
      false,
    );
  });

  it('does not invent an operation for an older server response', () => {
    const receipt = {
      chatId: 'chat-1',
      messageId: 'message-1',
      url: null,
      publishedAt: '2026-09-13T05:52:00.000Z',
    };
    expect(publishChatRulesResultSchema.parse(receipt)).not.toHaveProperty('operation');
    expect(publishChatRulesResultSchema.parse({ ...receipt, operation: 'updated' }).operation).toBe(
      'updated',
    );
    expect(publishChatRulesResultSchema.parse({ ...receipt, operation: 'created' }).operation).toBe(
      'created',
    );
    expect(
      publishChatRulesResultSchema.safeParse({ ...receipt, operation: 'queued' }).success,
    ).toBe(false);
  });
});
