import { createDefaultPrivateControlSession } from './private-control-session-normalizer';
import {
  deliverPrivateScreenHandoffToKnownPrivateChat,
  preparePrivateHandoffBot,
  type PrivateScreenHandoffDeliveryAdapters,
} from './private-control-handoff-delivery';
import { markPrivateHandoffDelivered } from './private-control-handoff-state';
import type { PrivateContext, PrivateSession, PrivateView } from './private-control.types';

function createSession(): PrivateSession {
  return createDefaultPrivateControlSession();
}

function createContext(chatId: string): PrivateContext {
  return {
    update: {
      updateId: 'handoff-delivery-test',
      type: 'message_created',
      message: {
        messageId: 'handoff-delivery-test',
        chatId,
        senderId: 'user-1',
        senderName: 'Test User',
        text: '',
        createdAt: new Date(0).toISOString(),
      },
    },
    chatId,
    actor: {
      userId: 'user-1',
      username: null,
      displayName: 'Test User',
      chatId,
      chatTitle: null,
    },
    text: '',
    callbackId: null,
    callbackPayload: null,
  };
}

function createAdapters(
  overrides: Partial<PrivateScreenHandoffDeliveryAdapters> = {},
): PrivateScreenHandoffDeliveryAdapters {
  const view: PrivateView = {
    text: 'handoff view',
  };

  return {
    createContext: jest.fn(createContext),
    render: jest.fn().mockResolvedValue(view),
    respond: jest.fn().mockResolvedValue(undefined),
    saveSession: jest.fn().mockResolvedValue(undefined),
    onFailure: jest.fn(),
    ...overrides,
  };
}

describe('private control handoff delivery', () => {
  it('chooses a fresh bot scope without changing the pending draft', () => {
    const session = createSession();
    session.selectedChatId = 'source-chat';
    session.pendingInput = { kind: 'rules_text' };

    expect(preparePrivateHandoffBot(session, ' bot-b ')).toBe('bot-b');
    expect(session.selectedChatId).toBe('source-chat');
    expect(session.pendingInput).toEqual({ kind: 'rules_text' });
    expect(session.lastPrivateChatId).toBeNull();
  });

  it('discards a migrated foreign dialog and its delivery receipts while preserving drafts', () => {
    const session = createSession();
    session.lastPrivateBotId = 'bot-a';
    session.lastPrivateChatId = 'private-a';
    session.managedGiveawayId = 'giveaway-1';
    session.pendingInput = { kind: 'giveaway_content' };
    session.pendingProfileMentionDisplayName = 'Имя пользователя';
    for (const kind of ['broadcast', 'giveaway', 'rules', 'profileMention'] as const) {
      markPrivateHandoffDelivered(session, kind, 'private-a');
    }

    expect(preparePrivateHandoffBot(session, 'bot-b')).toBe('bot-b');
    expect(session.lastPrivateChatId).toBeNull();
    expect(session.lastPrivateBotId).toBeNull();
    expect(session.lastGiveawayHandoffDeliveredAt).toBeNull();
    expect(session.lastRulesHandoffDeliveredAt).toBeNull();
    expect(session.lastProfileMentionHandoffDeliveredAt).toBeNull();
    expect(session.lastBroadcastHandoffDeliveredAt).toBeNull();
    expect(session.managedGiveawayId).toBe('giveaway-1');
    expect(session.pendingInput).toEqual({ kind: 'giveaway_content' });
    expect(session.pendingProfileMentionDisplayName).toBe('Имя пользователя');
  });

  it.each(['bot-a', null, undefined])('keeps a known dialog when scope is %s', (scope) => {
    const session = createSession();
    session.lastPrivateBotId = 'bot-a';
    session.lastPrivateChatId = 'private-a';
    markPrivateHandoffDelivered(session, 'rules', 'private-a', 1_000);

    expect(preparePrivateHandoffBot(session, scope)).toBe('bot-a');
    expect(session.lastPrivateChatId).toBe('private-a');
    expect(session.lastRulesHandoffDeliveredAt).toBe(1_000);
  });

  it('clears delivered state and skips delivery when no private chat is known', async () => {
    const session = createSession();
    markPrivateHandoffDelivered(session, 'broadcast', 'old-private-chat', 1_000);
    const adapters = createAdapters();

    await deliverPrivateScreenHandoffToKnownPrivateChat(session, 'broadcast', adapters);

    expect(session.lastBroadcastHandoffDeliveredChatId).toBeNull();
    expect(session.lastBroadcastHandoffDeliveredAt).toBeNull();
    expect(adapters.createContext).not.toHaveBeenCalled();
    expect(adapters.render).not.toHaveBeenCalled();
    expect(adapters.respond).not.toHaveBeenCalled();
    expect(adapters.saveSession).not.toHaveBeenCalled();
    expect(adapters.onFailure).not.toHaveBeenCalled();
  });

  it('renders, responds, marks delivered, and saves in order', async () => {
    const session = createSession();
    session.lastPrivateChatId = 'private-chat-1';
    const order: string[] = [];
    const view: PrivateView = {
      text: 'ready',
    };
    const adapters = createAdapters({
      createContext: jest.fn((privateChatId) => {
        order.push(`context:${privateChatId}`);
        return createContext(privateChatId);
      }),
      render: jest.fn(async () => {
        order.push('render');
        return view;
      }),
      respond: jest.fn(async () => {
        order.push('respond');
      }),
      saveSession: jest.fn(async (currentSession) => {
        order.push(`save:${currentSession.lastRulesHandoffDeliveredChatId}`);
      }),
    });

    await deliverPrivateScreenHandoffToKnownPrivateChat(session, 'rules', adapters);

    expect(order).toEqual(['context:private-chat-1', 'render', 'respond', 'save:private-chat-1']);
    expect(session.lastRulesHandoffDeliveredChatId).toBe('private-chat-1');
    expect(typeof session.lastRulesHandoffDeliveredAt).toBe('number');
    expect(adapters.onFailure).not.toHaveBeenCalled();
  });

  it('uses the current session private chat when marking after render mutations', async () => {
    const session = createSession();
    session.lastPrivateChatId = 'private-chat-1';
    const adapters = createAdapters({
      render: jest.fn(async () => {
        session.lastPrivateChatId = 'private-chat-2';
        return {
          text: 'ready',
        };
      }),
    });

    await deliverPrivateScreenHandoffToKnownPrivateChat(session, 'broadcast', adapters);

    expect(adapters.createContext).toHaveBeenCalledWith('private-chat-1');
    expect(session.lastBroadcastHandoffDeliveredChatId).toBe('private-chat-2');
  });

  it('clears delivered state and reports render failures', async () => {
    const session = createSession();
    session.lastPrivateChatId = 'private-chat-1';
    markPrivateHandoffDelivered(session, 'giveaway', 'old-private-chat', 1_000);
    const error = new Error('render failed');
    const adapters = createAdapters({
      render: jest.fn().mockRejectedValue(error),
    });

    await deliverPrivateScreenHandoffToKnownPrivateChat(session, 'giveaway', adapters);

    expect(session.lastGiveawayHandoffDeliveredChatId).toBeNull();
    expect(session.lastGiveawayHandoffDeliveredAt).toBeNull();
    expect(adapters.respond).not.toHaveBeenCalled();
    expect(adapters.saveSession).not.toHaveBeenCalled();
    expect(adapters.onFailure).toHaveBeenCalledWith(error, 'private-chat-1');
  });

  it('reports failures with the current session private chat', async () => {
    const session = createSession();
    session.lastPrivateChatId = 'private-chat-1';
    const error = new Error('respond failed');
    const adapters = createAdapters({
      render: jest.fn(async () => {
        session.lastPrivateChatId = 'private-chat-2';
        return {
          text: 'ready',
        };
      }),
      respond: jest.fn().mockRejectedValue(error),
    });

    await deliverPrivateScreenHandoffToKnownPrivateChat(session, 'rules', adapters);

    expect(adapters.createContext).toHaveBeenCalledWith('private-chat-1');
    expect(adapters.onFailure).toHaveBeenCalledWith(error, 'private-chat-2');
  });

  it('clears delivered state and reports respond failures before saving markers', async () => {
    const session = createSession();
    session.lastPrivateChatId = 'private-chat-1';
    const error = new Error('respond failed');
    const adapters = createAdapters({
      respond: jest.fn().mockRejectedValue(error),
    });

    await deliverPrivateScreenHandoffToKnownPrivateChat(session, 'broadcast', adapters);

    expect(session.lastBroadcastHandoffDeliveredChatId).toBeNull();
    expect(session.lastBroadcastHandoffDeliveredAt).toBeNull();
    expect(adapters.saveSession).not.toHaveBeenCalled();
    expect(adapters.onFailure).toHaveBeenCalledWith(error, 'private-chat-1');
  });

  it('clears delivered state when saving the delivered marker fails', async () => {
    const session = createSession();
    session.lastPrivateChatId = 'private-chat-1';
    const error = new Error('save failed');
    const adapters = createAdapters({
      saveSession: jest.fn().mockRejectedValue(error),
    });

    await deliverPrivateScreenHandoffToKnownPrivateChat(session, 'broadcast', adapters);

    expect(adapters.saveSession).toHaveBeenCalledTimes(1);
    expect(session.lastBroadcastHandoffDeliveredChatId).toBeNull();
    expect(session.lastBroadcastHandoffDeliveredAt).toBeNull();
    expect(adapters.onFailure).toHaveBeenCalledWith(error, 'private-chat-1');
  });
});
