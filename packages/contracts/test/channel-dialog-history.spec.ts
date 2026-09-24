import { describe, expect, it } from 'vitest';
import { channelDialogResponseSchema } from '../src/channel-dialog';

describe('comment history coverage', () => {
  const legacy = { chatId: 'channel-1', type: 'comments', messages: [] };
  it('keeps old responses readable without inventing a completeness claim', () => {
    expect(channelDialogResponseSchema.parse(legacy).hasMoreMessages).toBeUndefined();
  });
  it.each([true, false])('preserves the explicit lookahead result %s', (hasMoreMessages) => {
    expect(channelDialogResponseSchema.parse({ ...legacy, hasMoreMessages }).hasMoreMessages).toBe(
      hasMoreMessages,
    );
  });
  it('rejects non-boolean completeness flags', () => {
    expect(
      channelDialogResponseSchema.safeParse({ ...legacy, hasMoreMessages: 'false' }).success,
    ).toBe(false);
  });
});
