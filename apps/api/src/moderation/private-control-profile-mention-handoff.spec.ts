import { createDefaultPrivateControlSession } from './private-control-session-normalizer';
import {
  deliverPrivateProfileMentionHandoffToKnownPrivateChat,
  renderPrivateProfileMentionMessage,
  type PrivateProfileMentionDeliveryAdapters,
} from './private-control-profile-mention-handoff';
import { markPrivateHandoffDelivered } from './private-control-handoff-state';
import type { PrivateSession } from './private-control.types';

function createSession(): PrivateSession {
  return createDefaultPrivateControlSession();
}

function createAdapters(
  overrides: Partial<PrivateProfileMentionDeliveryAdapters> = {},
): PrivateProfileMentionDeliveryAdapters {
  return {
    send: jest.fn().mockResolvedValue(undefined),
    saveSession: jest.fn().mockResolvedValue(undefined),
    onFailure: jest.fn(),
    ...overrides,
  };
}

describe('private control profile mention handoff', () => {
  it('renders html profile mention message with escaped label and encoded user link', () => {
    const message = renderPrivateProfileMentionMessage({
      displayName: 'Анна <Admin> & Co',
      userId: 'user 55/тест',
    });

    expect(message).toEqual({
      text:
        '<strong>Профиль пользователя</strong>\n' +
        '<a href="max://user/user%2055%2F%D1%82%D0%B5%D1%81%D1%82">Анна &lt;Admin&gt; &amp; Co</a>',
      options: {
        textFormat: 'html',
      },
    });
  });

  it('clears delivered state and skips sending when no private chat is known', async () => {
    const session = createSession();
    markPrivateHandoffDelivered(session, 'profileMention', 'old-private-chat', 1_000);
    const adapters = createAdapters();

    await deliverPrivateProfileMentionHandoffToKnownPrivateChat(
      session,
      { displayName: 'Мария', userId: 'user-1' },
      adapters,
    );

    expect(session.lastProfileMentionHandoffDeliveredChatId).toBeNull();
    expect(session.lastProfileMentionHandoffDeliveredAt).toBeNull();
    expect(adapters.send).not.toHaveBeenCalled();
    expect(adapters.saveSession).not.toHaveBeenCalled();
    expect(adapters.onFailure).not.toHaveBeenCalled();
  });

  it('sends, marks delivered, and saves for known private chats', async () => {
    const session = createSession();
    session.lastPrivateChatId = 'private-chat-1';
    const adapters = createAdapters();

    await deliverPrivateProfileMentionHandoffToKnownPrivateChat(
      session,
      { displayName: 'Мария', userId: 'user-1' },
      adapters,
    );

    expect(adapters.send).toHaveBeenCalledWith(
      'private-chat-1',
      expect.objectContaining({
        text: expect.stringContaining('<a href="max://user/user-1">Мария</a>'),
        options: {
          textFormat: 'html',
        },
      }),
    );
    expect(session.lastProfileMentionHandoffDeliveredChatId).toBe('private-chat-1');
    expect(typeof session.lastProfileMentionHandoffDeliveredAt).toBe('number');
    expect(adapters.saveSession).toHaveBeenCalledWith(session);
    expect(adapters.onFailure).not.toHaveBeenCalled();
  });

  it('uses the current session private chat when marking after send mutations', async () => {
    const session = createSession();
    session.lastPrivateChatId = 'private-chat-1';
    const adapters = createAdapters({
      send: jest.fn(async () => {
        session.lastPrivateChatId = 'private-chat-2';
      }),
    });

    await deliverPrivateProfileMentionHandoffToKnownPrivateChat(
      session,
      { displayName: 'Мария', userId: 'user-1' },
      adapters,
    );

    expect(adapters.send).toHaveBeenCalledWith('private-chat-1', expect.anything());
    expect(session.lastProfileMentionHandoffDeliveredChatId).toBe('private-chat-2');
  });

  it('clears delivered state and reports failures with current private chat', async () => {
    const session = createSession();
    session.lastPrivateChatId = 'private-chat-1';
    markPrivateHandoffDelivered(session, 'profileMention', 'old-private-chat', 1_000);
    const error = new Error('send failed');
    const adapters = createAdapters({
      send: jest.fn(async () => {
        session.lastPrivateChatId = 'private-chat-2';
        throw error;
      }),
    });

    await deliverPrivateProfileMentionHandoffToKnownPrivateChat(
      session,
      { displayName: 'Мария', userId: 'user-1' },
      adapters,
    );

    expect(session.lastProfileMentionHandoffDeliveredChatId).toBeNull();
    expect(session.lastProfileMentionHandoffDeliveredAt).toBeNull();
    expect(adapters.saveSession).not.toHaveBeenCalled();
    expect(adapters.onFailure).toHaveBeenCalledWith(error, 'private-chat-2');
  });

  it('clears delivered state when saving the delivered marker fails', async () => {
    const session = createSession();
    session.lastPrivateChatId = 'private-chat-1';
    const error = new Error('save failed');
    const adapters = createAdapters({
      saveSession: jest.fn().mockRejectedValue(error),
    });

    await deliverPrivateProfileMentionHandoffToKnownPrivateChat(
      session,
      { displayName: 'Мария', userId: 'user-1' },
      adapters,
    );

    expect(adapters.send).toHaveBeenCalledTimes(1);
    expect(session.lastProfileMentionHandoffDeliveredChatId).toBeNull();
    expect(session.lastProfileMentionHandoffDeliveredAt).toBeNull();
    expect(adapters.onFailure).toHaveBeenCalledWith(error, 'private-chat-1');
  });
});
