import { describe, expect, it } from 'vitest';
import { publisherChatCommentSettingsSchema } from '../src/publisher';

describe('Publisher chat comment delivery mode', () => {
  const legacy = {
    commentsEnabled: true,
    commentsAdminsEnabled: true,
    commentsChatBroadcastsEnabled: false,
  };
  it('accepts old clients without implicitly enabling destructive replacement', () => {
    expect(
      publisherChatCommentSettingsSchema.parse(legacy).commentsReplaceOriginalEnabled,
    ).toBeUndefined();
  });
  it.each([true, false])('round-trips explicit replacement mode %s', (enabled) => {
    expect(
      publisherChatCommentSettingsSchema.parse({
        ...legacy,
        commentsReplaceOriginalEnabled: enabled,
      }),
    ).toEqual({ ...legacy, commentsReplaceOriginalEnabled: enabled });
  });
  it('rejects ambiguous non-boolean mode values', () => {
    expect(
      publisherChatCommentSettingsSchema.safeParse({
        ...legacy,
        commentsReplaceOriginalEnabled: 'true',
      }).success,
    ).toBe(false);
  });
});
