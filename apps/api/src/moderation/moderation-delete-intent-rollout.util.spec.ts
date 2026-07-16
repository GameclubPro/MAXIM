import {
  normalizeModerationDeleteIntentMode,
  parseModerationDeleteIntentCanaryChatIds,
  resolveModerationDeleteIntentRollout,
} from './moderation-delete-intent-rollout.util';

describe('moderation delete intent rollout', () => {
  it('defaults invalid configuration to off', () => {
    expect(normalizeModerationDeleteIntentMode(undefined)).toBe('off');
    expect(normalizeModerationDeleteIntentMode('invalid')).toBe('off');
  });

  it('never executes shadow traffic and scopes canary traffic to explicit chats', () => {
    const canaryChatIds = parseModerationDeleteIntentCanaryChatIds('chat-1, chat-2');

    expect(
      resolveModerationDeleteIntentRollout({ mode: 'shadow', canaryChatIds, chatId: 'chat-1' }),
    ).toBe('observed');
    expect(
      resolveModerationDeleteIntentRollout({ mode: 'canary', canaryChatIds, chatId: 'chat-1' }),
    ).toBe('execute');
    expect(
      resolveModerationDeleteIntentRollout({ mode: 'canary', canaryChatIds, chatId: 'chat-3' }),
    ).toBe('observed');
  });
});
