import { createDefaultPrivateControlSession } from './private-control-session-normalizer';
import {
  clearPendingPrivateProfileMentionHandoff,
  clearPrivateHandoffDelivery,
  markPrivateHandoffDelivered,
  readPendingPrivateProfileMentionDisplayName,
  rememberPendingPrivateProfileMentionHandoff,
  wasPrivateHandoffRecentlyDelivered,
  type PrivateHandoffKind,
} from './private-control-handoff-state';

function createSession() {
  return createDefaultPrivateControlSession();
}

describe('private control handoff state', () => {
  it.each([
    ['broadcast', 'lastBroadcastHandoffDeliveredChatId', 'lastBroadcastHandoffDeliveredAt'],
    ['giveaway', 'lastGiveawayHandoffDeliveredChatId', 'lastGiveawayHandoffDeliveredAt'],
    ['rules', 'lastRulesHandoffDeliveredChatId', 'lastRulesHandoffDeliveredAt'],
    [
      'profileMention',
      'lastProfileMentionHandoffDeliveredChatId',
      'lastProfileMentionHandoffDeliveredAt',
    ],
  ] as const)(
    'marks, checks, and clears %s delivered state',
    (kind, deliveredChatIdKey, deliveredAtKey) => {
      const session = createSession();

      markPrivateHandoffDelivered(session, kind, 'private-chat-1', 1_000);

      expect(session[deliveredChatIdKey]).toBe('private-chat-1');
      expect(session[deliveredAtKey]).toBe(1_000);
      expect(wasPrivateHandoffRecentlyDelivered(session, kind, 'private-chat-1', 20_000, 20_999))
        .toBe(true);
      expect(wasPrivateHandoffRecentlyDelivered(session, kind, 'private-chat-1', 20_000, 21_000))
        .toBe(false);
      expect(wasPrivateHandoffRecentlyDelivered(session, kind, 'other-chat', 20_000, 20_999))
        .toBe(false);

      clearPrivateHandoffDelivery(session, kind);

      expect(session[deliveredChatIdKey]).toBeNull();
      expect(session[deliveredAtKey]).toBeNull();
      expect(wasPrivateHandoffRecentlyDelivered(session, kind, 'private-chat-1', 20_000, 1_001))
        .toBe(false);
    },
  );

  it('rejects missing chat ids and malformed delivered timestamps', () => {
    const session = createSession();
    session.lastBroadcastHandoffDeliveredChatId = null;
    session.lastBroadcastHandoffDeliveredAt = 1_000;

    expect(
      wasPrivateHandoffRecentlyDelivered(session, 'broadcast', 'private-chat-1', 20_000, 1_001),
    ).toBe(false);

    session.lastBroadcastHandoffDeliveredChatId = 'private-chat-1';
    session.lastBroadcastHandoffDeliveredAt = null;

    expect(
      wasPrivateHandoffRecentlyDelivered(session, 'broadcast', 'private-chat-1', 20_000, 1_000),
    ).toBe(false);

    (session as { lastBroadcastHandoffDeliveredAt: unknown }).lastBroadcastHandoffDeliveredAt =
      '1_000';

    expect(
      wasPrivateHandoffRecentlyDelivered(session, 'broadcast', 'private-chat-1', 20_000, 1_001),
    ).toBe(false);
  });

  it('keeps pending profile mention handoff state normalized and scoped', () => {
    const session = createSession();

    rememberPendingPrivateProfileMentionHandoff(session, {
      chatId: ' source-chat ',
      userId: ' user-1 ',
      displayName: ' User One ',
    });

    expect(session.pendingProfileMentionChatId).toBe('source-chat');
    expect(session.pendingProfileMentionUserId).toBe('user-1');
    expect(session.pendingProfileMentionDisplayName).toBe('User One');
    expect(readPendingPrivateProfileMentionDisplayName(session, 'source-chat', 'user-1')).toBe(
      'User One',
    );
    expect(readPendingPrivateProfileMentionDisplayName(session, 'source-chat', 'user-2')).toBeNull();
    expect(readPendingPrivateProfileMentionDisplayName(session, 'other-chat', 'user-1')).toBeNull();

    clearPendingPrivateProfileMentionHandoff(session);

    expect(session.pendingProfileMentionChatId).toBeNull();
    expect(session.pendingProfileMentionUserId).toBeNull();
    expect(session.pendingProfileMentionDisplayName).toBeNull();
  });

  it('stores empty pending profile mention payload fields as null', () => {
    const session = createSession();

    rememberPendingPrivateProfileMentionHandoff(session, {
      chatId: ' ',
      userId: '',
      displayName: '  ',
    });

    expect(session.pendingProfileMentionChatId).toBeNull();
    expect(session.pendingProfileMentionUserId).toBeNull();
    expect(session.pendingProfileMentionDisplayName).toBeNull();
  });

  it('stays compatible with normalized persisted sessions', () => {
    const session = createDefaultPrivateControlSession();
    const kind: PrivateHandoffKind = 'profileMention';

    markPrivateHandoffDelivered(session, kind, 'private-chat-2', 50);

    expect(wasPrivateHandoffRecentlyDelivered(session, kind, 'private-chat-2', 100, 149)).toBe(
      true,
    );
  });
});
