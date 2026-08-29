import type { MaxUpdate } from '@maxim/contracts';
import { WebhookParser } from '../webhook/webhook.parser';
import {
  extractPublisherAutoReplyMessageCandidate,
  normalizePublisherAutoReplyTrigger,
} from './publisher-auto-reply-normalization';

function buildUpdate(overrides: Partial<MaxUpdate> = {}): MaxUpdate {
  return {
    updateId: 'update-1',
    botId: 'publisher-bot',
    type: 'message_created',
    message: {
      messageId: 'message-1',
      chatId: '-100',
      entityType: 'chat',
      senderId: 'user-1',
      text: '  ПРАЙС\tна   сегодня  ',
      createdAt: '2026-08-29T12:00:00.000Z',
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: { mid: 'message-1', text: '  ПРАЙС\tна   сегодня  ' },
        sender: { user_id: 'user-1' },
        recipient: { chat_id: '-100', chat_type: 'chat' },
      },
    },
    ...overrides,
  };
}

const options = {
  publisherBotId: 'publisher-bot',
  isKnownRuntimeBotUserId: (userId: string) => userId.startsWith('bot-'),
};

describe('Publisher auto-reply normalization', () => {
  it('normalizes compatibility forms, Russian case and whitespace', () => {
    expect(normalizePublisherAutoReplyTrigger('  ＰРАЙС\n\tЁЖ  ')).toBe('pрайс ёж');
  });

  it('extracts a direct authored group-chat text candidate', () => {
    expect(extractPublisherAutoReplyMessageCandidate(buildUpdate(), options)).toEqual({
      chatId: '-100',
      sourceMessageId: 'message-1',
      senderUserId: 'user-1',
      normalizedTrigger: 'прайс на сегодня',
    });
  });

  it('matches parser-normalized surrounding and repeated whitespace', () => {
    const parsed = new WebhookParser().parse(
      {
        update_id: 'parsed-whitespace-1',
        update_type: 'message_created',
        message: {
          body: { mid: 'message-parsed-1', text: '  ПРАЙС\tна   сегодня  ' },
          sender: { user_id: 'user-1' },
          recipient: { chat_id: '-100', chat_type: 'chat' },
          timestamp: Date.parse('2026-08-29T12:00:00.000Z'),
        },
      },
      { botId: 'publisher-bot' },
    );

    expect(parsed.message?.text).toBe('ПРАЙС на сегодня');
    expect(extractPublisherAutoReplyMessageCandidate(parsed, options)).toEqual({
      chatId: '-100',
      sourceMessageId: 'message-parsed-1',
      senderUserId: 'user-1',
      normalizedTrigger: 'прайс на сегодня',
    });
  });

  it('rejects known runtime bot messages', () => {
    const update = buildUpdate({
      message: { ...buildUpdate().message!, senderId: 'bot-major' },
    });
    expect(extractPublisherAutoReplyMessageCandidate(update, options)).toBeNull();
  });

  it.each([
    ['sender.is_bot', 'sender', 'is_bot'],
    ['from.isBot', 'from', 'isBot'],
  ] as const)('rejects an unknown external bot marked by %s', (_label, authorKey, markerKey) => {
    const update = buildUpdate({
      message: { ...buildUpdate().message!, senderId: 'external-automation-1' },
    });
    const rawMessage = update.raw?.message as Record<string, unknown>;
    rawMessage.sender = undefined;
    rawMessage[authorKey] = { user_id: 'external-automation-1', [markerKey]: true };

    expect(extractPublisherAutoReplyMessageCandidate(update, options)).toBeNull();
  });

  it('rejects an external bot marker on the webhook envelope', () => {
    const parsed = new WebhookParser().parse(
      {
        update_id: 'root-bot-marker-1',
        update_type: 'message_created',
        sender: { user_id: 'external-bot-1', is_bot: true },
        message: {
          body: { mid: 'root-bot-message-1', text: 'ПРАЙС' },
          recipient: { chat_id: '-100', chat_type: 'chat' },
          timestamp: Date.parse('2026-08-29T12:00:00.000Z'),
        },
      },
      { botId: 'publisher-bot' },
    );

    expect(parsed.message?.senderId).toBe('external-bot-1');
    expect(extractPublisherAutoReplyMessageCandidate(parsed, options)).toBeNull();
  });

  it.each([
    ['message.user', { messageAuthorKey: 'user' }],
    ['message.actor', { messageAuthorKey: 'actor' }],
    ['root.actor', { rootAuthorKey: 'actor' }],
    ['message direct marker', { directMessage: true }],
    ['root direct marker', { directRoot: true }],
  ] as const)('rejects parser-supported external automation from %s', (_label, shape) => {
    const payload: Record<string, unknown> = {
      update_id: `author-shape-${_label}`,
      update_type: 'message_created',
      message: {
        body: { mid: `message-${_label}`, text: 'ПРАЙС' },
        recipient: { chat_id: '-100', chat_type: 'chat' },
        timestamp: Date.parse('2026-08-29T12:00:00.000Z'),
      },
    };
    const rawMessage = payload.message as Record<string, unknown>;
    if ('messageAuthorKey' in shape) {
      rawMessage[shape.messageAuthorKey] = { user_id: 'external-bot-1', is_bot: true };
    }
    if ('rootAuthorKey' in shape) {
      payload[shape.rootAuthorKey] = { user_id: 'external-bot-1', is_bot: true };
    }
    if ('directMessage' in shape) {
      rawMessage.sender_id = 'external-bot-1';
      rawMessage.is_bot = true;
    }
    if ('directRoot' in shape) {
      payload.sender_id = 'external-bot-1';
      payload.is_bot = true;
    }
    const parsed = new WebhookParser().parse(payload, { botId: 'publisher-bot' });

    expect(parsed.message?.senderId).toBe('external-bot-1');
    expect(extractPublisherAutoReplyMessageCandidate(parsed, options)).toBeNull();
  });

  it('accepts an explicitly human sender and remains compatible when the bot marker is absent', () => {
    const explicitHuman = buildUpdate();
    (explicitHuman.raw?.message as Record<string, unknown>).sender = {
      user_id: 'user-1',
      is_bot: false,
    };

    expect(extractPublisherAutoReplyMessageCandidate(explicitHuman, options)).not.toBeNull();
    expect(extractPublisherAutoReplyMessageCandidate(buildUpdate(), options)).not.toBeNull();
  });

  it('rejects forwarded messages even with supplemental authored text', () => {
    const update = buildUpdate();
    const rawMessage = (update.raw?.message ?? {}) as Record<string, unknown>;
    rawMessage.link = { type: 'forward', message: { mid: 'source-1', text: 'ПРАЙС' } };
    expect(extractPublisherAutoReplyMessageCandidate(update, options)).toBeNull();
  });

  it.each(['dialog', 'channel'] as const)('rejects %s recipients', (chatType) => {
    const update = buildUpdate({
      message: {
        ...buildUpdate().message!,
        entityType: chatType === 'channel' ? 'channel' : undefined,
      },
    });
    const rawMessage = (update.raw?.message ?? {}) as Record<string, unknown>;
    rawMessage.recipient = { chat_id: chatType === 'dialog' ? '100' : '-100', chat_type: chatType };
    expect(extractPublisherAutoReplyMessageCandidate(update, options)).toBeNull();
  });

  it('rejects service and attachment-bearing messages', () => {
    const service = buildUpdate();
    (
      (service.raw?.message as Record<string, unknown>).body as Record<string, unknown>
    ).new_members = [{ user_id: '2' }];
    expect(extractPublisherAutoReplyMessageCandidate(service, options)).toBeNull();

    const media = buildUpdate();
    ((media.raw?.message as Record<string, unknown>).body as Record<string, unknown>).attachments =
      [{ type: 'image' }];
    expect(extractPublisherAutoReplyMessageCandidate(media, options)).toBeNull();
  });

  it('rejects edited events', () => {
    expect(
      extractPublisherAutoReplyMessageCandidate(buildUpdate({ type: 'message_edited' }), options),
    ).toBeNull();
  });
});
