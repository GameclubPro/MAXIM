import { createDefaultPrivateControlSession } from './private-control-session-normalizer';
import {
  deliverPrivateScreenHandoffToKnownPrivateChat,
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
